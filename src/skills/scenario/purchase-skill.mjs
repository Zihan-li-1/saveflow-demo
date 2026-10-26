import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validatePurchaseAction } from './purchase-contract.mjs';
import { reserveBudget, amendBudget, allocateOrder, recordOrderOutcome, cancelBudget } from './purchase-budget.mjs';
import { validCalendarDate } from '../../lib/calendar.mjs';
import { matchesGiftPreferences } from '../commerce/gift-filters.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a, b) => hash(a) === hash(b);
const addressSchema = z.strictObject({ recipient: z.string().trim().min(1).max(80), phone: z.string().regex(/^1\d{10}$/),
  address: z.string().trim().min(1).max(256), region: z.literal('demo-shanghai') });
const manualSchema = z.strictObject({ available_minor: z.number().int().min(0).max(1e9), obligations_minor: z.number().int().min(0).max(1e9) });
function workflow(state, id, version) {
  if (!Object.hasOwn(state.workflows, id)) fail('WORKFLOW_NOT_FOUND');
  const wf = state.workflows[id];
  if (version !== undefined && wf.version !== version) fail('VERSION_CONFLICT');
  return wf;
}
function timing(slots, nowMs) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(slots.date_expression ?? '');
  if (!m || !validCalendarDate(m[1])) fail('DATE_AMBIGUOUS');
  const starts_at = `${m[1]}T${m[2]}:00+08:00`, ends_at = `${m[1]}T${m[3]}:00+08:00`;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(m[2]) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(m[3]) || Date.parse(ends_at) <= Date.parse(starts_at)) fail('DATE_AMBIGUOUS');
  if (Date.parse(starts_at) <= nowMs) fail('DATE_IN_PAST');
  return { starts_at, ends_at, timezone: 'Asia/Shanghai' };
}
const missing = slots => ['budget', 'budget_month', 'funding_account_ref', 'date_expression', 'date_meaning', 'items'].filter(key => slots[key] === undefined);
function safeWorkflow(state, wf) {
  const { workflow_ref, version, status, slots, window, selected_candidate_refs = [], address_ref } = wf;
  const orders = Object.values(state.operations).filter(op => op.workflow_ref === workflow_ref).map(op => ({
    operation_ref: op.operation_ref, status: op.status, amount_minor: op.amount_minor, category: op.category, receipt: op.receipt,
  }));
  return { workflow_ref, version, status, slots, window, selected_candidate_refs,
    selected_candidates: selected_candidate_refs.map(ref => wf.candidates[ref]).filter(Boolean), address_ref,
    missing_slots: missing(slots), reservation: state.reservations[workflow_ref], orders,
    financial_basis: wf.financial_context ? { source: wf.financial_context.source, as_of: wf.financial_context.as_of,
      available_minor: wf.financial_context.available_minor, obligations_minor: wf.financial_context.obligations_minor, repository_as_of: wf.financial_context.repository_as_of } : undefined,
    pending_tasks: Object.values(state.events).filter(event => event.workflow_ref === workflow_ref) };
}
function findPreview(state, operation_ref) {
  for (const wf of Object.values(state.workflows)) if (Object.hasOwn(wf.previews, operation_ref)) return { wf, p: wf.previews[operation_ref] };
  fail('OPERATION_NOT_FOUND');
}
const summary = op => ({ operation_ref: op.operation_ref, status: op.status, receipt: op.receipt });

export function createPurchaseSkill({ store, commerce, financialContext, now = Date.now, schedulerEnabled = false } = {}) {
  if (!store?.transaction) fail('PERSISTENCE_UNAVAILABLE');
  const stamped = data => ({ ...data, as_of: new Date(now()).toISOString(), context_snapshot_id: hash([data.workflow_ref, data.version, data.operation_ref]),
    evidence: [{ source: 'purchase_workflow', synthetic_demo_only: true }], execution_environment: 'mock', synthetic_demo_only: true });
  const read = async (owner, id) => store.transaction(owner, state => stamped(safeWorkflow(state, workflow(state, id))));
  async function finance(owner, wf, manual) {
    let context;
    const observed = await financialContext?.(owner, wf.slots.funding_account_ref);
    if (manual !== undefined) {
      const result = manualSchema.safeParse(manual); if (!result.success) fail('VALIDATION_ERROR');
      // Explicit user statement, for planning only; not a verified bank balance.
      context = { ...result.data, account_ref: observed?.account_ref ?? `user_${hash(wf.slots.funding_account_ref).slice(0, 24)}`,
        source: 'user_provided', as_of: new Date(now()).toISOString(),
        ...(observed ? { repository_as_of: observed.as_of, bill_summary: observed.bill_summary, evidence: observed.evidence } : {}) };
    } else context = observed;
    if (!context || !Number.isSafeInteger(context.available_minor) || context.available_minor < 0 || !Number.isSafeInteger(context.obligations_minor) || context.obligations_minor < 0 ||
        !context.account_ref || typeof context.source !== 'string' || !Number.isFinite(Date.parse(context.as_of)) || Math.abs(now() - Date.parse(context.as_of)) > 86400000) fail('FINANCIAL_DATA_REQUIRED');
    return context;
  }
  async function previewPlan(owner, id, version, manual) {
    if (!schedulerEnabled) fail('SCHEDULER_UNAVAILABLE');
    const original = await store.transaction(owner, s => workflow(s, id, version));
    const wf = { ...original, slots: original.amendment?.slots ?? original.slots };
    if (missing(wf.slots).length) fail('MISSING_SLOTS');
    if (wf.status !== 'draft' && !(wf.status === 'active' && wf.amendment)) fail('INVALID_TRANSITION');
    const window = timing(wf.slots, now()), context = await finance(owner, wf, manual);
    const token = randomUUID(), preview_ref = randomUUID();
    return store.transaction(owner, state => {
      const current = workflow(state, id, version);
      const preview = { action: 'scenario.purchase.save', workflow_version: version, slots: current.amendment?.slots ?? current.slots, window, context };
      current.plan_preview = { preview_ref, token_hash: hash(token), preview_hash: hash(preview), preview, expires: now() + 300000 };
      return stamped({ plan_preview_ref: preview_ref, plan_confirmation_token: token, preview,
        bank_balance_changed: false, notice: '仅预留应用内购物预算；银行余额不变，提醒不要挪用。' });
    });
  }
  async function saveAddress(owner, id, version, input) {
    const result = addressSchema.safeParse(input); if (!result.success) fail('VALIDATION_ERROR');
    return store.transaction(owner, state => {
      const wf = workflow(state, id, version); if (wf.status !== 'active') fail('INVALID_TRANSITION');
      const address_ref = randomUUID(); wf.addresses[address_ref] = result.data; wf.address_ref = address_ref; wf.version++;
      return stamped({ address_ref, workflow: safeWorkflow(state, wf) });
    });
  }
  async function reviseDraft(owner, id, version, slots) {
    slots = validatePurchaseAction('scenario.plan_purchase', slots);
    return store.transaction(owner, state => {
      const wf = workflow(state, id, version);
      if (!['draft', 'active'].includes(wf.status)) fail('INVALID_TRANSITION');
      if (wf.status === 'draft') wf.slots = slots;
      else wf.amendment = { slots };
      wf.version++; delete wf.plan_preview;
      return stamped(safeWorkflow(state, wf));
    });
  }
  async function previewCancel(owner, id, version) {
    return store.transaction(owner, state => {
      const wf = workflow(state, id, version), token = randomUUID(), preview_ref = randomUUID();
      wf.cancel_preview = { preview_ref, token_hash: hash(token), version, expires: now() + 300000 };
      return stamped({ plan_preview_ref: preview_ref, plan_confirmation_token: token,
        notice: '取消计划将释放未占用预算；已有订单和结果待核实订单需分别处理。' });
    });
  }
  async function perform(owner, action, input) {
    input = validatePurchaseAction(action, input);
    if (action === 'scenario.plan_purchase') return store.transaction(owner, state => {
      const id = randomUUID(); state.workflows[id] = { workflow_ref: id, created_at: new Date(now()).toISOString(), version: 1, status: 'draft', slots: input,
        candidates: {}, quotes: {}, previews: {}, addresses: {} };
      return stamped(safeWorkflow(state, state.workflows[id]));
    });
    if (action === 'scenario.purchase.save') {
      if (!schedulerEnabled) fail('SCHEDULER_UNAVAILABLE');
      // Re-read bank facts outside the transaction; user-stated figures stay
      // explicitly user-provided and are bound to the confirmed preview.
      const existing = await store.transaction(owner, s => workflow(s, input.draft_ref));
      const prior = existing.plan_preview;
      if (existing.status === 'active' && prior?.used && prior.preview_ref === input.plan_preview_ref && prior.token_hash === hash(input.plan_confirmation_token)) return read(owner, existing.workflow_ref);
      const context = prior?.preview.context.source === 'user_provided' ? prior.preview.context : await finance(owner, { ...existing, slots: existing.amendment?.slots ?? existing.slots });
      return store.transaction(owner, state => {
        const wf = workflow(state, input.draft_ref), p = wf.plan_preview;
        if (!p || p.preview_ref !== input.plan_preview_ref || p.token_hash !== hash(input.plan_confirmation_token)) fail('CONFIRMATION_INVALID');
        if (wf.status === 'active' && p.used) return stamped(safeWorkflow(state, wf));
        if (wf.version !== input.expected_version || p.preview.workflow_version !== wf.version || p.expires <= now() || !same(context, p.preview.context)) fail('PREVIEW_STALE');
        const slots = wf.amendment?.slots ?? wf.slots;
        timing(slots, now());
        if (!same(slots, p.preview.slots)) fail('PREVIEW_STALE');
        const budgetInput = { workflow_ref: wf.workflow_ref, amount_minor: slots.budget.amount_minor, ...context };
        if (wf.status === 'active') amendBudget(state, budgetInput); else reserveBudget(state, budgetInput);
        wf.slots = slots; wf.financial_context = context; delete wf.amendment;
        for (const job of Object.values(state.jobs)) if (job.workflow_ref === wf.workflow_ref) job.status = 'cancelled';
        wf.window = p.preview.window; wf.status = 'active'; wf.version++; p.used = true;
        const job_ref = `${wf.workflow_ref}_v${wf.version}`;
        state.jobs[job_ref] = { job_ref, workflow_ref: wf.workflow_ref, due_at: wf.window.starts_at, ends_at: wf.window.ends_at, status: 'scheduled' };
        return stamped({ ...safeWorkflow(state, wf), bank_balance_changed: false, scheduler_enabled: true, financial_source: context.source });
      });
    }
    if (action === 'scenario.purchase.update') return store.transaction(owner, state => {
      const wf = workflow(state, input.workflow_ref, input.expected_version); if (wf.status !== 'active') fail('INVALID_TRANSITION');
      const changes = input.changes;
      if (changes.selected_candidate_refs?.some(ref => !Object.hasOwn(wf.candidates, ref))) fail('CANDIDATE_NOT_FOUND');
      if (changes.address_ref && !Object.hasOwn(wf.addresses, changes.address_ref)) fail('FORBIDDEN');
      if (changes.preferences) wf.slots.preferences = { ...wf.slots.preferences, ...changes.preferences };
      if (changes.selection_mode) wf.slots.selection_mode = changes.selection_mode;
      if (changes.selected_candidate_refs) wf.selected_candidate_refs = changes.selected_candidate_refs;
      if (changes.address_ref) wf.address_ref = changes.address_ref;
      wf.version++; return stamped(safeWorkflow(state, wf));
    });
    if (action === 'scenario.purchase.cancel') return store.transaction(owner, state => {
      const wf = workflow(state, input.workflow_ref, input.expected_version), p = wf.cancel_preview;
      if (!p || p.preview_ref !== input.plan_preview_ref || p.token_hash !== hash(input.plan_confirmation_token) || p.version !== wf.version || p.expires <= now()) fail('CONFIRMATION_INVALID');
      if (state.reservations[wf.workflow_ref]) cancelBudget(state, wf.workflow_ref);
      wf.status = 'cancelled'; wf.version++;
      for (const job of Object.values(state.jobs)) if (job.workflow_ref === wf.workflow_ref) job.status = 'cancelled';
      return stamped(safeWorkflow(state, wf));
    });
    if (!commerce) fail('PLATFORM_NOT_CONNECTED');
    if (action === 'commerce.search') {
      const wf = await store.transaction(owner, s => workflow(s, input.workflow_ref));
      if (wf.status !== 'active') fail('INVALID_TRANSITION');
      if (!wf.slots.items.some(item => item.category === input.category)) fail('UNSUPPORTED_CATEGORY');
      const found = await commerce.search({ category: input.category, preferences: wf.slots.preferences ?? {}, region: 'demo-shanghai',
        budget_minor: wf.slots.budget.amount_minor, ...(input.cursor ? { cursor: input.cursor } : {}) });
      return store.transaction(owner, state => {
        const current = workflow(state, wf.workflow_ref, wf.version);
        const candidates = found.candidates.map(p => {
          const previous = Object.values(current.candidates).find(c => c.product_ref === p.product_ref && c.sku_ref === p.sku_ref);
          const c = { ...p, candidate_ref: previous?.candidate_ref ?? randomUUID() }; current.candidates[c.candidate_ref] = c; return c;
        });
        return stamped({ workflow_ref: wf.workflow_ref, version: wf.version, candidates, next_cursor: found.next_cursor });
      });
    }
    if (action === 'commerce.quote') {
      const wf = await store.transaction(owner, s => workflow(s, input.workflow_ref, input.expected_version));
      if (wf.status !== 'active') fail('INVALID_TRANSITION');
      if (wf.slots.date_meaning === 'deliver_on' && !same(input.delivery_window, wf.window)) fail('PREVIEW_STALE');
      if (wf.slots.date_meaning === 'order_on' && (now() < Date.parse(wf.window.starts_at) || now() >= Date.parse(wf.window.ends_at))) fail('OUTSIDE_ORDER_WINDOW');
      const address = wf.addresses[input.address_ref]; if (!address) fail('ADDRESS_REQUIRED');
      const selected = input.selections.map(s => {
        const p = wf.candidates[s.candidate_ref]; if (!p || p.sku_ref !== s.sku_ref) fail('CANDIDATE_NOT_FOUND');
        if (!matchesGiftPreferences(p, wf.slots.preferences)) fail('PREFERENCES_CHANGED');
        if (s.quantity !== wf.slots.items.find(i => i.category === p.category)?.quantity) fail('VALIDATION_ERROR');
        return { ...s, product: p };
      });
      if (new Set(selected.map(s => s.product.category)).size !== selected.length) fail('VALIDATION_ERROR');
      const quotes = await Promise.all(selected.map(async s => ({ ...(await commerce.quote({ product_ref: s.product.product_ref, sku_ref: s.sku_ref,
        quantity: s.quantity, address_ref: input.address_ref, region: address.region,
        delivery_window: { starts_at: input.delivery_window.starts_at, ends_at: input.delivery_window.ends_at } })), category: s.product.category, product_name: s.product.name })));
      return store.transaction(owner, state => {
        const current = workflow(state, wf.workflow_ref, wf.version), reservation = state.reservations[wf.workflow_ref];
        if (quotes.reduce((sum, q) => sum + q.total.amount_minor, 0) > reservation.unallocated_minor) fail('BUDGET_EXCEEDED');
        for (const q of quotes) current.quotes[q.quote_ref] = { ...q, workflow_version: current.version };
        return stamped({ quotes, workflow_ref: current.workflow_ref, version: current.version });
      });
    }
    if (action === 'commerce.order.prepare') return store.transaction(owner, state => {
      const wf = workflow(state, input.workflow_ref, input.expected_version), q = wf.quotes[input.quote_ref];
      if (!q || q.workflow_version !== wf.version || wf.status !== 'active') fail('PREVIEW_STALE');
      if (Date.parse(q.expires_at) <= now()) fail('QUOTE_EXPIRED');
      if (Object.values(state.operations).some(op => op.workflow_ref === wf.workflow_ref && op.category === q.category && op.allocation !== 'released')) fail('ORDER_EXISTS');
      const address = wf.addresses[q.address_ref], operation_ref = randomUUID(), token = randomUUID();
      // Private UI response only. This exact delivery snapshot is hash-bound;
      // it is never included in LLM context or safeWorkflow/read responses.
      const preview = { ...q, delivery: { ...address } };
      const preview_hash = hash(preview);
      wf.previews[operation_ref] = { operation_ref, preview_hash, preview, quote_ref: q.quote_ref, workflow_version: wf.version,
        token_hash: hash(token), expires: Math.min(Date.parse(q.expires_at), now() + 300000) };
      return stamped({ operation_ref, preview_hash, preview, confirmation_token: token, workflow_version: wf.version });
    });
    if (action === 'commerce.order.execute') {
      const prepared = await store.transaction(owner, state => {
        const { wf, p } = findPreview(state, input.operation_ref);
        if (p.preview_hash !== input.preview_hash || p.token_hash !== hash(input.confirmation_token)) fail('CONFIRMATION_INVALID');
        if (state.operations[input.operation_ref]) return { existing: summary(state.operations[input.operation_ref]) };
        if (p.expires <= now()) fail('PREVIEW_EXPIRED');
        if (p.workflow_version !== wf.version || wf.status !== 'active') fail('PREVIEW_STALE');
        if (wf.slots.date_meaning === 'order_on' && (now() < Date.parse(wf.window.starts_at) || now() >= Date.parse(wf.window.ends_at))) fail('OUTSIDE_ORDER_WINDOW');
        if (Object.values(state.operations).some(op => op.workflow_ref === wf.workflow_ref && op.category === p.preview.category && op.allocation !== 'released')) fail('ORDER_EXISTS');
        const op = allocateOrder(state, { workflow_ref: wf.workflow_ref, operation_ref: p.operation_ref, amount_minor: p.preview.total.amount_minor });
        Object.assign(op, { quote_ref: p.quote_ref, category: p.preview.category }); wf.version++;
        return { request: { quote_ref: p.quote_ref, idempotency_key: p.operation_ref } };
      });
      if (prepared.existing) return stamped(prepared.existing);
      let receipt, failure;
      try { receipt = await commerce.execute(prepared.request); }
      catch (error) { failure = error.code; }
      return store.transaction(owner, state => {
        // An uncertain transport/server failure never releases allocation.
        const definite = ['PRODUCT_UNAVAILABLE', 'QUOTE_EXPIRED', 'PREVIEW_STALE', 'QUOTE_NOT_FOUND', 'DELIVERY_UNAVAILABLE'].includes(failure);
        const op = recordOrderOutcome(state, input.operation_ref, receipt?.status ?? (definite ? 'failed' : 'unknown'));
        if (receipt) op.receipt = receipt;
        if (failure) op.failure_code = failure;
        return stamped(summary(op));
      });
    }
    if (action === 'commerce.order.status') {
      const op = await store.transaction(owner, state => { if (!Object.hasOwn(state.operations, input.operation_ref)) fail('OPERATION_NOT_FOUND'); return state.operations[input.operation_ref]; });
      let receipt;
      try { receipt = await commerce.status({ idempotency_key: op.operation_ref }); }
      catch { return stamped(summary(op)); }
      return store.transaction(owner, state => {
        const current = recordOrderOutcome(state, op.operation_ref, receipt.status); current.receipt = receipt;
        return stamped(summary(current));
      });
    }
    fail('CAPABILITY_UNAVAILABLE');
  }
  const list = owner => store.transaction(owner, state => stamped({ workflows: Object.values(state.workflows)
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')).slice(0, 100).map(wf => safeWorkflow(state, wf)) }));
  return { perform, read, list, previewPlan, saveAddress, reviseDraft, previewCancel };
}

/** No external calls: the atomic due event is a request for fresh user review. */
export async function runDuePurchases({ store, now = Date.now }) {
  let count = 0;
  for (const owner of await store.owners()) count += await store.transaction(owner, state => {
    let added = 0;
    for (const job of Object.values(state.jobs)) {
      if (job.status !== 'scheduled' || Date.parse(job.due_at) > now()) continue;
      if (!state.events[job.job_ref]) { state.events[job.job_ref] = { event_ref: job.job_ref, workflow_ref: job.workflow_ref,
        status: now() >= Date.parse(job.ends_at) ? 'missed_window' : 'awaiting_user_review', as_of: new Date(now()).toISOString() }; added++; }
      job.status = 'delivered';
    }
    return added;
  });
  return { events_created: count };
}

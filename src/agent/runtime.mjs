import { validateParsedIntent } from './validate-parsed-intent.mjs';
import { transferFromResolvedIntent } from '../banking-core/wire.mjs';
import { handleCard } from './handlers/card-handler.mjs';
import { handleBillSummary } from './handlers/bill-handler.ts';
import { handleSubscriptionList } from './handlers/subscription-handler.ts';
import { agentErrorPolicy } from '../lib/agent-error-policy.mjs';

export { handleBillSummary, handleSubscriptionList };

function clarification(intent) {
  return { ok: false, kind: 'needs_clarification', action: intent.action, source: 'parser', ...(intent.missingSlots.length ? { missingSlots: [...intent.missingSlots] } : {}) };
}

export async function dispatchParsedIntent(value, dependencies) {
  const intent = validateParsedIntent(value);
  if (intent.status === 'needs_clarification') return clarification(intent);
  if (intent.status === 'unsupported') return { ok: false, kind: 'unsupported' };
  try {
    if (intent.action === 'transfer.create') return await dependencies.transferHandler(intent);
    if (intent.action === 'bill.summary') return await dependencies.billHandler(intent);
    if (intent.action === 'subscription.list') return dependencies.subscriptionHandler ? await dependencies.subscriptionHandler(intent) : { ok: false, kind: 'unsupported' };
    if (intent.action.startsWith('card.')) return dependencies.cardHandler ? await dependencies.cardHandler(intent) : { ok: false, kind: 'unsupported' };
    if (intent.action.startsWith('wealth.')) return dependencies.wealthHandler ? await dependencies.wealthHandler({ action: intent.action, ...intent.slots }) : { ok: false, kind: 'unsupported' };
    if (intent.action === 'scenario.plan_purchase') return { ok: true, kind: 'purchase_request', action: intent.action, data: { slots: intent.slots, synthetic_demo_only: true } };
    if (intent.action.startsWith('scenario.')) return dependencies.scenarioHandler ? await dependencies.scenarioHandler({ action: intent.action, ...intent.slots }) : { ok: false, kind: 'unsupported' };
    if (intent.action === 'orchestrator.goal') return dependencies.goalHandler ? await dependencies.goalHandler(intent) : { ok: false, kind: 'unsupported' };
    return { ok: false, kind: 'unsupported' };
  } catch (error) {
    if (agentErrorPolicy(error?.code).category !== 'internal') return { ok: false, kind: 'core_error', action: intent.action,
      error: { code: error.code, message: typeof error.message === 'string' ? error.message : '当前请求未满足业务条件。', uncertain: error.uncertain === true } };
    return { ok: false, kind: 'skill_error', action: intent.action, error: { code: 'SKILL_ERROR', message: error instanceof Error && error.message.trim() ? error.message : 'Skill 处理失败，请稍后重试。' } };
  }
}

function transferRepository(repository, selections = {}) {
  const normalize = value => value.trim().replace(/^模拟/, '').replace(/账户$/, '');
  return {
    async queryAccount(reference) {
      const query = reference.trim();
      const selected = selections.source_account_ref;
      if (selected?.entityId) {
        const account = await repository.getAccount(selected.entityId);
        if (!account || account.status !== 'active') return null;
        return { id: account.id, currency: account.currency, availableBalanceFen: account.availableBalanceFen };
      }
      const normalized = normalize(query);
      const account = (await repository.getAccounts()).find(candidate => {
        const name = normalize(candidate.name);
        return candidate.id === query || candidate.name === query || name === normalized ||
          (normalized === '活期' && candidate.type === 'checking') || (normalized === '储蓄' && candidate.type === 'saving');
      });
      return account ? { id: account.id, currency: account.currency, availableBalanceFen: account.availableBalanceFen } : null;
    },
    // 本人账户互转用：按原始称谓解析“本人可用账户”候选，仅保留 active；返回全部匹配（供歧义判断）。
    async queryOwnAccounts(reference, selectionKey = 'target_account_ref') {
      const query = reference.trim();
      const selected = selections[selectionKey];
      if (selected?.entityId) {
        const account = await repository.getAccount(selected.entityId);
        if (!account || account.status !== 'active') return [];
        return [{ id: account.id, name: account.name, currency: account.currency, availableBalanceFen: account.availableBalanceFen }];
      }
      const normalized = normalize(query);
      const accounts = await repository.getAccounts();
      return accounts.filter(candidate => candidate.status === 'active' && (
        candidate.id === query || candidate.name === query || normalize(candidate.name) === normalized ||
        (normalized === '活期' && candidate.type === 'checking') || (normalized === '储蓄' && candidate.type === 'saving')
      )).map(account => ({ id: account.id, name: account.name, currency: account.currency, availableBalanceFen: account.availableBalanceFen }));
    },
    async queryPayeesByName(name) {
      const query = name.trim();
      const selected = selections.payee_ref;
      if (selected?.entityId) {
        const payee = await repository.getPayee(selected.entityId);
        if (!payee || payee.status !== 'active') return [];
        return [{ id: payee.id, name: payee.name, aliases: [...payee.aliases], accountNoMasked: payee.accountNoMasked }];
      }
      return (await repository.getPayees()).filter(payee => payee.status === 'active' && (payee.name === query || payee.aliases.includes(query))).map(payee => ({ id: payee.id, name: payee.name, aliases: [...payee.aliases], accountNoMasked: payee.accountNoMasked }));
    },
  };
}

async function resolveTransferIntent(repository, slots) {
  const amount = slots.amount;
  if (!amount) return { state: 'needs_clarification', clarification: { reason: 'missing_slot', slot: 'amount', question: '请告诉我转账金额。' } };
  if (!Number.isSafeInteger(amount.amount_minor) || amount.amount_minor <= 0) return { state: 'needs_clarification', clarification: { reason: 'invalid_amount', slot: 'amount', question: '转账金额必须是大于 0 的整数分。' } };
  if (amount.currency !== 'CNY') return { state: 'needs_clarification', clarification: { reason: 'invalid_amount', slot: 'amount', question: '目前仅支持人民币（CNY）转账。' } };
  const targetRef = typeof slots.target_account_ref === 'string' ? slots.target_account_ref.trim() : '';
  if (targetRef) return resolveInternalTransfer(repository, amount, slots, targetRef);
  // —— 对外转账（既有路径，保持不变）——
  const source = typeof slots.source_account_ref === 'string' ? slots.source_account_ref.trim() : '';
  if (!source) return { state: 'needs_clarification', clarification: { reason: 'missing_slot', slot: 'source_account_ref', question: '请确认从哪个账户转出。' } };
  const payeeRef = typeof slots.payee_ref === 'string' ? slots.payee_ref.trim() : '';
  if (!payeeRef) return { state: 'needs_clarification', clarification: { reason: 'missing_slot', slot: 'payee_ref', question: '请告诉我转给谁。' } };
  const candidates = await repository.queryPayeesByName(payeeRef);
  if (!candidates.length) return { state: 'needs_clarification', clarification: { reason: 'payee_not_found', slot: 'payee_ref', question: `没有找到收款人「${payeeRef}」。` } };
  if (candidates.length > 1) return { state: 'needs_clarification', clarification: { reason: 'ambiguous_payee', slot: 'payee_ref', question: `「${payeeRef}」匹配到多位收款人，请确认。`, candidates } };
  const account = await repository.queryAccount(source);
  if (!account) return { state: 'needs_clarification', clarification: { reason: 'source_account_not_found', slot: 'source_account_ref', question: `转出账户 ${source} 不存在。` } };
  return {
    action: 'transfer.create', state: 'ready_for_planning', resolved_slots: { amount: { amount_minor: amount.amount_minor, currency: amount.currency } },
    references: [
      { slot: 'source_account_ref', entity_id: account.id, source: 'financial_context' },
      { slot: 'payee_ref', entity_id: candidates[0].id, source: 'financial_context' },
    ],
    preview: { source_account_id: account.id, payee_id: candidates[0].id, amount_minor: amount.amount_minor, currency: amount.currency, available_balance_minor: account.availableBalanceFen, estimated_balance_after_minor: account.availableBalanceFen - amount.amount_minor },
  };
}

  // 本人账户互转与对外转账共用正式 Core 流程；此处只解析本人账户并校验方向与余额，
  // 随后由统一 transfer.create 路径生成预览并按同一确认、执行边界处理。
async function resolveInternalTransfer(repository, amount, slots, targetRef) {
  const source = typeof slots.source_account_ref === 'string' ? slots.source_account_ref.trim() : '';
  if (!source) return { state: 'needs_clarification', clarification: { reason: 'missing_slot', slot: 'source_account_ref', question: '请确认从哪个账户转出。' } };

  const sourceMatches = await repository.queryOwnAccounts(source, 'source_account_ref');
  if (!sourceMatches.length) return { state: 'needs_clarification', clarification: { reason: 'source_account_not_found', slot: 'source_account_ref', question: `转出账户「${source}」不存在或不可用。` } };
  if (sourceMatches.length > 1) return { state: 'needs_clarification', clarification: { reason: 'ambiguous_account', slot: 'source_account_ref', question: `「${source}」匹配到多个本人账户，请确认。` } };

  const targetMatches = await repository.queryOwnAccounts(targetRef, 'target_account_ref');
  if (!targetMatches.length) return { state: 'needs_clarification', clarification: { reason: 'target_account_not_found', slot: 'target_account_ref', question: `转入账户「${targetRef}」不存在或不是本人可用账户。` } };
  if (targetMatches.length > 1) return { state: 'needs_clarification', clarification: { reason: 'ambiguous_account', slot: 'target_account_ref', question: `「${targetRef}」匹配到多个本人账户，请确认。` } };

  const sourceAccount = sourceMatches[0];
  const targetAccount = targetMatches[0];
  if (sourceAccount.id === targetAccount.id) return { state: 'needs_clarification', clarification: { reason: 'same_account', slot: 'target_account_ref', question: '转出账户与转入账户不能是同一个账户，请重新指定。' } };
  if (sourceAccount.availableBalanceFen < amount.amount_minor) return { state: 'needs_clarification', clarification: { reason: 'insufficient_balance', slot: 'amount', question: `转出账户可用余额不足，无法转出 ¥${(amount.amount_minor / 100).toFixed(2)}。` } };

  return {
    action: 'transfer.create',
    state: 'ready_for_planning',
    resolved_slots: { amount: { amount_minor: amount.amount_minor, currency: amount.currency } },
    references: [
      { slot: 'source_account_ref', entity_id: sourceAccount.id, source: 'financial_context' },
      { slot: 'target_account_ref', entity_id: targetAccount.id, source: 'financial_context' },
    ],
    preview: {
      kind: 'internal_transfer',
      source_account_id: sourceAccount.id,
      source_account_name: sourceAccount.name,
      target_account_id: targetAccount.id,
      target_account_name: targetAccount.name,
      amount_minor: amount.amount_minor,
      currency: amount.currency,
      source_available_balance_minor: sourceAccount.availableBalanceFen,
      source_estimated_balance_after_minor: sourceAccount.availableBalanceFen - amount.amount_minor,
      target_available_balance_minor: targetAccount.availableBalanceFen,
      target_estimated_balance_after_minor: targetAccount.availableBalanceFen + amount.amount_minor,
    },
  };
}

export async function handleTransfer(intent, repository) {
  const resolved = await resolveTransferIntent(repository, intent.slots);
  if (resolved.state === 'needs_clarification') return { ok: false, kind: 'needs_clarification', action: 'transfer.create', source: 'resolver', question: resolved.clarification.question, slot: resolved.clarification.slot, reason: resolved.clarification.reason, ...(resolved.clarification.candidates ? { candidates: resolved.clarification.candidates } : {}) };
  return { ok: true, kind: 'transfer_resolution', action: 'transfer.create', data: resolved };
}

export async function handleGoal(intent, repository) {
  const [context, accounts, subscriptions, cards, products] = await Promise.all([
    repository.getContextInfo(), repository.getAccounts(), repository.getSubscriptions(), repository.getCards(), repository.getInvestmentProducts(),
  ]);
  const activeSubscriptions = subscriptions.filter(item => item.status === 'active');
  const potentiallyUnused = activeSubscriptions.filter(item => item.isPotentiallyUnused);
  const availableBalanceFen = accounts.filter(item => item.status === 'active').reduce((sum, item) => sum + item.availableBalanceFen, 0);
  const steps = [
    { action: 'bill.analyze', origin: 'agent_suggested', reason: '先核对目标期间的收入、支出和异常交易。', requires_confirmation: false },
    ...(potentiallyUnused.length ? [{ action: 'subscription.list', origin: 'agent_suggested', reason: `发现 ${potentiallyUnused.length} 项可能闲置订阅，建议先核实；不会自动取消。`, requires_confirmation: false }] : []),
    ...(cards.length ? [{ action: 'card.get', origin: 'agent_suggested', reason: '查看现有卡片预算和消费情况；不会自动调整预算。', requires_confirmation: false }] : []),
    ...(products.length && availableBalanceFen > 0 ? [{ action: 'wealth.recommend', origin: 'agent_suggested', reason: '如有明确风险、期限和流动性约束，可进行只读产品筛选。', requires_confirmation: false }] : []),
  ];
  return { ok: true, kind: 'goal_plan', action: 'orchestrator.goal', data: { goal_text: intent.slots.goal_text, horizon: intent.slots.horizon ?? null, targetAmountFen: intent.slots.amount?.amount_minor ?? null, deadline: intent.slots.deadline ?? null, constraints: intent.slots.constraints ?? null, steps, snapshot: { available_balance_minor: availableBalanceFen, active_subscription_count: activeSubscriptions.length, potentially_unused_subscription_count: potentiallyUnused.length, card_count: cards.length }, execution_allowed: false }, evidence: [{ source: context.dataSource, asOf: context.asOf, entityIds: [...accounts.map(item => item.id), ...activeSubscriptions.map(item => item.id), ...cards.map(item => item.id), ...products.map(item => item.id)] }] };
}

function orchestratorError(error) {
  return { ok: false, kind: 'skill_error', action: 'transfer.create', error: { code: 'SKILL_ERROR', message: error instanceof Error && error.message.trim() ? error.message : '转账解析结果无效，请重新发起请求。' } };
}

export async function prepareTransferPreview(dispatched, core) {
  if (!dispatched.ok || dispatched.kind !== 'transfer_resolution' || dispatched.action !== 'transfer.create') return dispatched;
  const resolved = dispatched.data;
  if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved) || resolved.state !== 'ready_for_planning') return orchestratorError(new Error('转账解析结果尚未达到 ready_for_planning。'));
  let request;
  try { request = transferFromResolvedIntent(resolved); } catch (error) { return orchestratorError(error); }
  const prepared = await core.prepare(request);
  if (!prepared.ok) return { ok: false, kind: 'core_error', action: 'transfer.create', error: prepared.error, ...(prepared.operationId ? { operationId: prepared.operationId } : {}) };
  return { ok: true, kind: 'transfer_preview', action: 'transfer.create', data: prepared.data };
}

export async function orchestrateTransferPreview(intent, dependencies, core) {
  return prepareTransferPreview(await dispatchParsedIntent(intent, dependencies), core);
}

export { handleCard, transferRepository };

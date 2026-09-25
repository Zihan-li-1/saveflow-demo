import { validateParsedIntent } from './validate-parsed-intent.mjs';
import { transferFromResolvedIntent } from '../banking-core/wire.mjs';

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
    return { ok: false, kind: 'unsupported' };
  } catch (error) {
    return { ok: false, kind: 'skill_error', action: intent.action, error: { code: 'SKILL_ERROR', message: error instanceof Error && error.message.trim() ? error.message : 'Skill 处理失败，请稍后重试。' } };
  }
}

export async function handleBillSummary(intent, repository) {
  const month = intent.slots.month;
  if (!month) throw new Error('bill.summary requires month before dispatch');
  const transactions = repository.getTransactions({ month });
  const summary = transactions.reduce((result, transaction) => {
    if (transaction.type === 'income') result.totalIncomeFen += transaction.amountFen;
    if (transaction.type === 'expense') {
      result.totalExpenseFen += transaction.amountFen;
      result.categoryTotals[transaction.category] = (result.categoryTotals[transaction.category] ?? 0) + transaction.amountFen;
    }
    return result;
  }, { totalIncomeFen: 0, totalExpenseFen: 0, transactionCount: transactions.length, categoryTotals: {} });
  const context = repository.getContextInfo();
  return { ok: true, kind: 'bill_result', action: 'bill.summary', data: summary, evidence: [{ source: context.dataSource, asOf: context.asOf, entityIds: transactions.map(transaction => transaction.id) }] };
}

function transferRepository(repository, selections = {}) {
  const normalize = value => value.trim().replace(/^模拟/, '').replace(/账户$/, '');
  return {
    queryAccount(reference) {
      const query = reference.trim();
      const selected = selections.source_account_ref;
      if (selected?.entityId) {
        const account = repository.getAccount(selected.entityId);
        if (!account || account.status !== 'active') return null;
        return { id: account.id, currency: account.currency, availableBalanceFen: account.availableBalanceFen };
      }
      const normalized = normalize(query);
      const account = repository.getAccounts().find(candidate => {
        const name = normalize(candidate.name);
        return candidate.id === query || candidate.name === query || name === normalized ||
          (normalized === '活期' && candidate.type === 'checking') || (normalized === '储蓄' && candidate.type === 'saving');
      });
      return account ? { id: account.id, currency: account.currency, availableBalanceFen: account.availableBalanceFen } : null;
    },
    queryPayeesByName(name) {
      const query = name.trim();
      const selected = selections.payee_ref;
      if (selected?.entityId) {
        const payee = repository.getPayee(selected.entityId);
        if (!payee || payee.status !== 'active') return [];
        return [{ id: payee.id, name: payee.name, aliases: [...payee.aliases], accountNoMasked: payee.accountNoMasked }];
      }
      return repository.getPayees().filter(payee => payee.status === 'active' && (payee.name === query || payee.aliases.includes(query))).map(payee => ({ id: payee.id, name: payee.name, aliases: [...payee.aliases], accountNoMasked: payee.accountNoMasked }));
    },
  };
}

async function resolveTransferIntent(repository, slots) {
  const amount = slots.amount;
  if (!amount) return { state: 'needs_clarification', clarification: { reason: 'missing_slot', slot: 'amount', question: '请告诉我转账金额。' } };
  if (!Number.isSafeInteger(amount.amount_minor) || amount.amount_minor <= 0) return { state: 'needs_clarification', clarification: { reason: 'invalid_amount', slot: 'amount', question: '转账金额必须是大于 0 的整数分。' } };
  if (amount.currency !== 'CNY') return { state: 'needs_clarification', clarification: { reason: 'invalid_amount', slot: 'amount', question: '目前仅支持人民币（CNY）转账。' } };
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

export async function handleTransfer(intent, repository) {
  const resolved = await resolveTransferIntent(repository, intent.slots);
  if (resolved.state === 'needs_clarification') return { ok: false, kind: 'needs_clarification', action: 'transfer.create', source: 'resolver', question: resolved.clarification.question, slot: resolved.clarification.slot, reason: resolved.clarification.reason, ...(resolved.clarification.candidates ? { candidates: resolved.clarification.candidates } : {}) };
  return { ok: true, kind: 'transfer_resolution', action: 'transfer.create', data: resolved };
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

export { transferRepository };

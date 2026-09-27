// @ts-check
import { bankingCore } from './core.mjs';
import { BankingError, assertId } from './errors.mjs';

/** This protocol is used identically by the browser Mock and HTTP adapters.
 * @param {string} action @param {unknown} value @param {ReturnType<import('./core.mjs').createBankingCore>} [core]
 * @returns {Promise<import('./contracts').ActionResult<unknown>>} */
export async function dispatchBanking(action, value, core = bankingCore) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BankingError('VALIDATION_ERROR', '参数必须是 JSON 对象');
    const input = /** @type {Record<string, unknown>} */(value);
    /** @type {Record<string, string[]>} */
    const fields = {
      'context.get': [], 'account.list': [], 'account.get': ['id'], 'payee.list': [], 'payee.get': ['id'],
      'transaction.list': ['accountId', 'month'], 'product.list': [], 'card.list': [], 'subscription.list': [],
      'transfer.prepare': ['fromAccountId', 'payeeId', 'amountFen', 'currency', 'memo'],
      'action.decide': ['operationId', 'previewHash', 'decision', 'confirmedStepIds'],
      'action.execute': ['operationId', 'previewHash'], 'action.status': ['operationId'],
    };
    if (!Object.hasOwn(fields, action)) throw new BankingError('UNKNOWN_ACTION', '未注册的 Banking Core 动作');
    if (Object.keys(input).some(k => !fields[action].includes(k))) throw new BankingError('VALIDATION_ERROR', '请求包含未注册字段');
    if (action.startsWith('action.')) assertId(input.operationId);
    const repo = core.repository;
    let data;
    switch (action) {
      case 'context.get': data = await repo.getContextInfo(); break;
      case 'account.list': data = await repo.getAccounts(); break;
      case 'account.get':
        assertId(input.id); data = await repo.getAccount(input.id);
        if (!data) throw new BankingError('ACCOUNT_NOT_FOUND', '找不到可访问的付款账户'); break;
      case 'payee.list': data = await repo.getPayees(); break;
      case 'payee.get':
        assertId(input.id); data = await repo.getPayee(input.id);
        if (!data) throw new BankingError('PAYEE_NOT_FOUND', '找不到收款人'); break;
      case 'transaction.list':
        if (input.accountId !== undefined) { assertId(input.accountId); if (!await repo.getAccount(input.accountId)) throw new BankingError('ACCOUNT_NOT_FOUND', '找不到可访问的账户'); }
        if (input.month !== undefined && (typeof input.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month))) throw new BankingError('VALIDATION_ERROR', '月份须为 YYYY-MM');
        data = await repo.getTransactions(/** @type {{accountId?: string, month?: string}} */(input)); break;
      case 'product.list': data = await repo.getInvestmentProducts(); break;
      case 'card.list': data = await repo.getCards(); break;
      case 'subscription.list': data = await repo.getSubscriptions(); break;
      case 'transfer.prepare': return core.prepare({ action: 'transfer_money', input: /** @type {import('./contracts').TransferInput} */(input) });
      case 'action.decide': return core.decide(/** @type {string} */(input.operationId), /** @type {import('./contracts').DecisionInput} */({ previewHash: input.previewHash, decision: input.decision, confirmedStepIds: input.confirmedStepIds }));
      case 'action.execute': return core.execute(/** @type {string} */(input.operationId), /** @type {string} */(input.previewHash));
      case 'action.status': return core.getOperation(/** @type {string} */(input.operationId));
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error instanceof BankingError ? error.toJSON() : new BankingError('INTERNAL_ERROR', 'Banking Core 未取得可靠结果', true).toJSON() };
  }
}

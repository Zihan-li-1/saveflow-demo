// @ts-check
import { bankingCore } from './core.mjs';
import { BankingError } from './errors.mjs';

/** Compatibility summaries derived from repository transactions, never analysisFixtures totals.
 * C can implement richer analysis using getTransactions without changing this old UI contract.
 * @param {import('./contracts').FinancialContextRepository} [repository] */
export function getLegacyContext(repository = bankingCore.repository) {
  const info = repository.getContextInfo();
  const settings = repository.getDemoSettings();
  /** @param {string} month */
  const expenseRows = month => repository.getTransactions({ month }).filter(t => t.type === 'expense');
  const current = expenseRows(info.currentMonth), previous = expenseRows(info.previousMonth);
  /** @param {import('./contracts').Transaction[]} rows */
  const total = rows => rows.reduce((sum, t) => sum + t.amountFen, 0);
  const names = [...new Set([...current, ...previous].map(t => t.category))];
  const categoryChanges = names.map(name => ({ name, changeAmountFen: total(current.filter(t => t.category === name)) - total(previous.filter(t => t.category === name)) })).sort((a, b) => b.changeAmountFen - a.changeAmountFen).slice(0, 2);
  return { ...info, dataType: info.dataSource, ...settings, totalExpenseFen: total(current), previousExpenseFen: total(previous), expenseIncreaseFen: total(current) - total(previous), categoryChanges, subscriptionCount: repository.getSubscriptions().length, subscriptions: repository.getSubscriptions().map(s => ({ name: s.name, monthlyFee: s.monthlyFeeFen / 100, lastUsedDate: s.lastUsedDate, isPotentiallyUnused: s.isPotentiallyUnused })), savedAmountFen: repository.getSavingGoal().currentAmountFen };
}
/** @param {string} action @param {Record<string, unknown>} input @param {string} operationId @param {ReturnType<import('./core.mjs').createBankingCore>} [core] */
export function legacyRequest(action, input, operationId, core = bankingCore) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BankingError('VALIDATION_ERROR', '请求参数无效');
  if (action === 'analyze') {
    if (input.consent !== true || typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 500) throw new BankingError('VALIDATION_ERROR', '请授权模拟账单分析，并输入 1–500 字的目标');
    const context = getLegacyContext(core.repository);
    return { totalExpenseFen: context.totalExpenseFen, subscriptionCount: context.subscriptionCount, momIncreaseFen: context.expenseIncreaseFen, categories: context.categoryChanges, asOf: context.asOf, currentMonth: context.currentMonth, previousMonth: context.previousMonth, dataSource: context.dataSource };
  }
  if (action === 'create-plan') {
    const receipt = core.createLegacyPlan(operationId, input);
    return { operationId, status: receipt.status, message: receipt.message };
  }
  if (action === 'operation-status') {
    if (typeof input.operationId !== 'string') throw new BankingError('VALIDATION_ERROR', '缺少操作编号');
    const result = core.getOperation(input.operationId);
    if (!result.ok) throw new BankingError(result.error.code, result.error.message, result.error.uncertain);
    const receipt = result.data.receipt;
    if (receipt && receipt.action === 'legacy.create-plan') return { operationId: input.operationId, status: receipt.status, message: receipt.message };
    return { operationId: input.operationId, status: 'pending', message: '尚未取得本计划的最终结果，请稍后继续查询。' };
  }
  throw new BankingError('UNKNOWN_ACTION', '未知 action');
}

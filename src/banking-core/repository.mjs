// @ts-check
import seed from '../data/saveflow_mock_data.json' with { type: 'json' };
import { assertFen, BankingError, seedYuanToFen } from './errors.mjs';

/** Only this module reads seed JSON. Returns a read repository plus a private engine write port.
 * Every query returns a defensive copy. Seed balances are snapshots, not a replay of history.
 * @param {typeof seed} [source] */
export function createFinancialContext(source = seed) {
  const raw = structuredClone(source);
  /** @type {import('./contracts').Account[]} */
  const accounts = raw.accounts.map(a => ({ id: a.id, name: a.name, type: a.type === 'savings' ? 'saving' : 'checking', currency: 'CNY', balanceFen: seedYuanToFen(a.availableBalance), availableBalanceFen: seedYuanToFen(a.availableBalance), version: 0, status: 'active' }));
  /** @type {import('./contracts').Payee[]} */
  const payees = [
    { id: 'payee_001', name: '张三', aliases: ['张三'], accountNoMasked: '****1001', currency: 'CNY', status: 'active' },
    { id: 'payee_002', name: '李四', aliases: ['李四'], accountNoMasked: '****1002', currency: 'CNY', status: 'active' },
    { id: 'payee_003', name: '房东王先生', aliases: ['房东', '王先生', '王先生房东'], accountNoMasked: '****1003', currency: 'CNY', status: 'active' },
    { id: 'payee_004', name: '王强', aliases: ['王强', '王先生'], accountNoMasked: '****1004', currency: 'CNY', status: 'active' },
  ];
  /** @type {import('./contracts').Transaction[]} */
  const transactions = raw.transactions.map(t => ({ id: t.id, accountId: t.accountId, occurredAt: `${t.date}T00:00:00+08:00`, type: t.type === 'income' ? 'income' : 'expense', category: t.category, merchant: t.merchant, amountFen: seedYuanToFen(t.amount), currency: 'CNY', status: 'posted', source: 'synthetic_seed' }));
  /** @type {import('./contracts').InvestmentProduct[]} */
  const products = [
    { id: 'product_001', name: '模拟灵活现金 A', riskLevel: 'R1', expectedYield: 150, liquidity: 'T+0', minimumAmountFen: 100, durationDays: 0, currency: 'CNY', isSynthetic: true },
    { id: 'product_002', name: '模拟稳健现金 B', riskLevel: 'R2', expectedYield: 210, liquidity: 'T+1', minimumAmountFen: 10000, durationDays: 0, currency: 'CNY', isSynthetic: true },
    { id: 'product_003', name: '模拟定期组合 C', riskLevel: 'R3', expectedYield: 300, liquidity: 'AT_MATURITY', minimumAmountFen: 100000, durationDays: 30, currency: 'CNY', isSynthetic: true },
  ];
  let revision = 0;
  /** @type {import('./contracts').FinancialContextRepository} */
  const repository = {
    getContextInfo: () => ({ datasetId: raw.datasetId, asOf: `${raw.snapshotDate}T00:00:00+08:00`, currentMonth: raw.analysisFixtures.currentMonth, previousMonth: raw.analysisFixtures.previousMonth, snapshotId: `${raw.datasetId}:${revision}`, dataSource: 'synthetic_demo_only', currency: 'CNY' }),
    getAccounts: () => structuredClone(accounts),
    getAccount: id => structuredClone(accounts.find(a => a.id === id)),
    getPayees: () => structuredClone(payees),
    getPayee: id => structuredClone(payees.find(p => p.id === id)),
    getTransactions: (filter = {}) => structuredClone(transactions.filter(t => (!filter.accountId || t.accountId === filter.accountId) && (!filter.month || t.occurredAt.startsWith(`${filter.month}-`)))),
    getCards: () => raw.cards.map(c => ({ id: c.id, name: c.name, accountId: c.linkedAccountId, status: c.status === 'active' ? 'active' : 'frozen', monthlyLimitFen: seedYuanToFen(c.monthlyLimit), monthlySpentFen: seedYuanToFen(c.monthlySpent) })),
    getSubscriptions: () => raw.subscriptions.map(s => ({ id: s.id, name: s.name, monthlyFeeFen: seedYuanToFen(s.monthlyFee), status: s.status === 'active' ? 'active' : 'cancelled', lastUsedDate: s.lastUsedDate, isPotentiallyUnused: s.isPotentiallyUnused, mandateId: null })),
    getInvestmentProducts: () => structuredClone(products),
    getSavingGoal: () => ({ id: raw.savingGoals[0].id, targetAmountFen: seedYuanToFen(raw.savingGoals[0].targetAmount), currentAmountFen: seedYuanToFen(raw.savingGoals[0].currentAmount), targetDate: raw.savingGoals[0].targetDate, proposedMonthlySavingFen: seedYuanToFen(raw.savingGoals[0].proposedMonthlySaving) }),
    // Original goal requires 5000/month, above demo cap: expose it honestly; draft defaults to 2500.
    getDemoSettings: () => ({ monthlyIncomeFen: seedYuanToFen(raw.user.monthlyIncome), defaultMonthlySavingFen: 250000, monthlySavingCapFen: 300000 }),
  };
  /** Synchronous compare-and-swap: no await between checks, debit and transaction append.
   * @param {import('./contracts').TransferEffect} effect @param {string} operationId @param {string} at */
  function commitTransfer(effect, operationId, at) {
    const existing = transactions.find(t => t.operationId === operationId);
    if (existing) throw new BankingError('IDEMPOTENCY_CONFLICT', '账务已存在此操作，请查询回执', true);
    const account = accounts.find(a => a.id === effect.fromAccountId);
    if (!account || account.version !== effect.accountVersion || account.balanceFen !== effect.balanceBeforeFen) throw new BankingError('PREVIEW_STALE', '账户已变化，请重新预览并确认');
    assertFen(effect.amountFen);
    if (account.availableBalanceFen < effect.amountFen) throw new BankingError('INSUFFICIENT_BALANCE', '可用余额不足');
    const transaction = /** @type {import('./contracts').Transaction} */ ({ id: `txn_${operationId}`, operationId, accountId: account.id, payeeId: effect.payeeId, occurredAt: at, type: 'transfer_out', category: '转账', merchant: effect.payeeName, amountFen: effect.amountFen, currency: 'CNY', status: 'posted', source: 'mock_execution' });
    account.balanceFen -= effect.amountFen;
    account.availableBalanceFen -= effect.amountFen;
    account.version++;
    transactions.push(transaction);
    revision++;
    return structuredClone(transaction);
  }
  return { repository: Object.freeze(repository), commitTransfer, ownerId: raw.user.id };
}

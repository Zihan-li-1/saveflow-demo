import test from 'node:test';
import assert from 'node:assert/strict';
import { createFinancialContext } from '../src/banking-core/repository.mjs';
import {
  analyzeBills,
  listSubscriptions,
  summarizeBills,
} from '../src/skills/bill/bill-skill.ts';

test('bill.analyze computes comparison, categories and evidence from repository transactions', async () => {
  const { repository } = createFinancialContext();
  const result = await analyzeBills(repository, {
    action: 'bill.analyze',
    period: { month: '2026-08', timezone: 'Asia/Shanghai' },
  });
  const augustExpense = repository
    .getTransactions({ month: '2026-08' })
    .filter((transaction) => transaction.type === 'expense')
    .reduce((sum, transaction) => sum + transaction.amountFen, 0);
  const julyExpense = repository
    .getTransactions({ month: '2026-07' })
    .filter((transaction) => transaction.type === 'expense')
    .reduce((sum, transaction) => sum + transaction.amountFen, 0);

  assert.equal(result.action, 'bill.analyze');
  assert.equal(result.current_month_expense_minor, augustExpense);
  assert.equal(result.previous_month_expense_minor, julyExpense);
  assert.equal(result.change_amount_minor, augustExpense - julyExpense);
  assert.equal(result.comparison_period.month, '2026-07');
  assert.ok(result.category_breakdown.length > 0);
  assert.ok(result.top_increased_categories.length > 0);
  assert.ok(result.unusual_transactions.length > 0);
  assert.equal(result.evidence[0].as_of, repository.getContextInfo().asOf);
});

test('bill summaries exclude transfer_out from consumer expense', () => {
  const summary = summarizeBills([
    transaction('expense', 1200, '餐饮', 'txn_expense'),
    transaction('transfer_out', 50_000, '转账', 'txn_transfer'),
    transaction('income', 100_000, '工资', 'txn_income'),
  ]);
  assert.equal(summary.totalExpenseFen, 1200);
  assert.equal(summary.totalIncomeFen, 100_000);
  assert.deepEqual(summary.categoryTotals, { 餐饮: 1200 });
});

test('bill.analyze validates period and account scope', async () => {
  const { repository } = createFinancialContext();
  await assert.rejects(
    analyzeBills(repository, { action: 'bill.analyze', period: { month: '2026-13', timezone: 'Asia/Shanghai' } }),
    /YYYY-MM/
  );
  await assert.rejects(
    analyzeBills(repository, { action: 'bill.analyze', period: { month: '2026-08', timezone: 'Asia/Shanghai' }, account_ref: 'missing' }),
    /account_ref/
  );
  await assert.rejects(
    analyzeBills(repository, { action: 'bill.analyze', period: { start_date: '2026-08-20', end_date: '2026-08-10', timezone: 'Asia/Shanghai' } }),
    /不能晚于/
  );
  await assert.rejects(
    analyzeBills(repository, { action: 'bill.analyze', period: { start_date: '2026-02-30', end_date: '2026-03-01', timezone: 'Asia/Shanghai' } }),
    /YYYY-MM-DD/
  );
});

test('bill.analyze supports an inclusive custom date range and equal-length comparison range', async () => {
  const { repository } = createFinancialContext();
  const period = { start_date: '2026-08-05', end_date: '2026-08-20', timezone: 'Asia/Shanghai' };
  const result = await analyzeBills(repository, { action: 'bill.analyze', period });
  const expected = repository.getTransactions()
    .filter((transaction) => transaction.type === 'expense' && transaction.occurredAt.slice(0, 10) >= period.start_date && transaction.occurredAt.slice(0, 10) <= period.end_date)
    .reduce((sum, transaction) => sum + transaction.amountFen, 0);
  const comparison = { start_date: '2026-07-20', end_date: '2026-08-04', timezone: 'Asia/Shanghai' };
  const expectedComparison = repository.getTransactions()
    .filter((transaction) => transaction.type === 'expense' && transaction.occurredAt.slice(0, 10) >= comparison.start_date && transaction.occurredAt.slice(0, 10) <= comparison.end_date)
    .reduce((sum, transaction) => sum + transaction.amountFen, 0);

  assert.deepEqual(result.period, period);
  assert.deepEqual(result.comparison_period, comparison);
  assert.equal(result.period_expense_minor, expected);
  assert.equal(result.comparison_period_expense_minor, expectedComparison);
  assert.equal(result.current_month_expense_minor, expected);
  assert.equal(result.previous_month_expense_minor, expectedComparison);
  assert.ok(result.evidence[0].entity_ids.every((id) => typeof id === 'string'));
});

test('bill.analyze assigns midnight-boundary transactions using the requested timezone', async () => {
  const boundary = transaction('expense', 8800, '餐饮', 'txn_boundary');
  boundary.occurredAt = '2026-08-31T16:30:00Z'; // 2026-09-01 in Asia/Shanghai
  const repository = {
    getContextInfo: () => ({ asOf: '2026-09-02T00:00:00+08:00', dataSource: 'synthetic_demo_only' }),
    getAccount: () => undefined,
    getTransactions: () => [boundary],
  };
  const shanghai = await analyzeBills(repository, { action: 'bill.analyze', period: { month: '2026-09', timezone: 'Asia/Shanghai' } });
  const utc = await analyzeBills(repository, { action: 'bill.analyze', period: { month: '2026-09', timezone: 'UTC' } });
  assert.equal(shanghai.period_expense_minor, 8800);
  assert.equal(utc.period_expense_minor, 0);
});

test('subscription.list returns current snapshot without claiming cancellation capability', async () => {
  const { repository } = createFinancialContext();
  const result = await listSubscriptions(repository);
  const active = repository.getSubscriptions().filter((subscription) => subscription.status === 'active');
  assert.equal(result.action, 'subscription.list');
  assert.equal(result.active_count, active.length);
  assert.equal(
    result.active_monthly_total_minor,
    active.reduce((sum, subscription) => sum + subscription.monthlyFeeFen, 0)
  );
  assert.deepEqual(result.capabilities, {
    historical_subscription_state: false,
    cancel_merchant_membership: false,
    cancel_bank_debit: false,
  });
  assert.deepEqual(
    result.potentially_unused.map((subscription) => subscription.subscription_id),
    active.filter((subscription) => subscription.isPotentiallyUnused).map((subscription) => subscription.id)
  );
});

function transaction(type, amountFen, category, id) {
  return {
    id,
    accountId: 'account_001',
    occurredAt: '2026-08-01T00:00:00+08:00',
    type,
    category,
    merchant: category,
    amountFen,
    currency: 'CNY',
    status: 'posted',
    source: 'synthetic_seed',
  };
}

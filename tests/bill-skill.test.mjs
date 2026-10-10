import test from 'node:test';
import assert from 'node:assert/strict';
import { createFinancialContext } from '../src/banking-core/repository.mjs';
import {
  analyzeBills,
  listSubscriptions,
  summarizeBills,
} from '../src/skills/bill/bill-skill.ts';

test('bill.analyze computes comparison, categories and evidence from repository transactions', () => {
  const { repository } = createFinancialContext();
  const result = analyzeBills(repository, {
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

test('bill.analyze validates period and account scope', () => {
  const { repository } = createFinancialContext();
  assert.throws(
    () => analyzeBills(repository, { action: 'bill.analyze', period: { month: '2026-13', timezone: 'Asia/Shanghai' } }),
    /YYYY-MM/
  );
  assert.throws(
    () => analyzeBills(repository, { action: 'bill.analyze', period: { month: '2026-08', timezone: 'Asia/Shanghai' }, account_ref: 'missing' }),
    /account_ref/
  );
});

test('subscription.list returns current snapshot without claiming cancellation capability', () => {
  const { repository } = createFinancialContext();
  const result = listSubscriptions(repository);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFinancialContext } from '../src/banking-core/repository.mjs';
import { transactionMatchesPeriod } from '../src/lib/calendar.mjs';
import { summarizeBills } from '../src/skills/bill/bill-summary.mjs';
import { summarizeBills as skillSummary } from '../src/skills/bill/bill-skill.ts';
import { handleBillSummary } from '../src/agent/runtime.mjs';
import { buildFinancialAnalysisContext } from '../server/financial-analysis-context.mjs';
import { understandingContext } from '../server/understanding-context.mjs';

const now = () => Date.parse('2026-10-26T04:00:00Z');
const transaction = (month, type = 'expense', amountFen = 100, category = '餐饮') => ({
  id: `${month}-${type}`, accountId: 'account-private', occurredAt: `${month}-15T12:00:00+08:00`,
  merchant: 'merchant-private', type, category, amountFen, currency: 'CNY', status: 'posted', source: 'synthetic_seed',
});
function fixture(rows, { availableMonths = [...new Set(rows.map(row => row.occurredAt.slice(0, 7)))], asOf = '2026-10-01T00:00:00+08:00' } = {}) {
  const calls = [];
  const repository = {
    async getContextInfo() { return { datasetId: 'fixture', snapshotId: 'fixture:1', dataSource: 'synthetic_demo_only', currency: 'CNY', asOf, availableMonths }; },
    async getTransactions(filter = {}) { calls.push(filter); return structuredClone(rows.filter(row => transactionMatchesPeriod(row.occurredAt, filter))); },
  };
  return { repository, calls };
}

test('real demo repository: latest three available calendar months, exact integer facts and observed coverage', async () => {
  const { repository } = createFinancialContext();
  const result = await buildFinancialAnalysisContext(repository, { now });
  assert.deepEqual(result.range.months, ['2026-07', '2026-08', '2026-09']);
  assert.equal(result.status, 'available');
  assert.deepEqual([result.summary.totalIncomeFen, result.summary.totalExpenseFen, result.summary.netCashFlowFen, result.summary.transactionCount], [3600000, 2304000, 1296000, 34]);
  assert.equal(Object.values(result.summary.categoryTotals).reduce((a, b) => a + b, 0), 2304000);
  assert.equal(result.coverage.observedStartDate, '2026-07-05');
  assert.equal(result.coverage.observedEndDate, '2026-09-26');
  assert.equal(result.coverage.completeness, 'unverified');
  assert.equal(result.source.snapshotId, repository.getContextInfo().snapshotId);
});

test('one aggregation implementation is shared by Skill, runtime bill handler and financial context', async () => {
  assert.equal(skillSummary, summarizeBills);
  const { repository } = createFinancialContext();
  const bill = await handleBillSummary({ slots: { month: '2026-08' } }, repository);
  const context = await buildFinancialAnalysisContext(repository, { month: '2026-08', now });
  const { netCashFlowFen, ...summary } = context.summary;
  assert.deepEqual(summary, { totalIncomeFen: bill.data.totalIncomeFen, totalExpenseFen: bill.data.totalExpenseFen,
    transactionCount: bill.data.transactionCount, categoryTotals: bill.data.categoryTotals });
  assert.equal(netCashFlowFen, summary.totalIncomeFen - summary.totalExpenseFen);
});

test('default chooses newest three available months, excluding current and future periods', async () => {
  const { repository } = fixture(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'].map(m => transaction(m)), { asOf: '2026-11-01T00:00:00+08:00' });
  const result = await buildFinancialAnalysisContext(repository, { now });
  assert.deepEqual(result.range.months, ['2026-07', '2026-08', '2026-09']);
  assert.equal(result.summary.totalExpenseFen, 300);
});

test('fewer than three months does not manufacture missing month totals or averages', async () => {
  const { repository } = fixture([transaction('2026-06'), transaction('2026-08')], { availableMonths: ['2026-06', '2026-07', '2026-08'] });
  const result = await buildFinancialAnalysisContext(repository, { now });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.range.months, ['2026-06', '2026-08']);
  assert.deepEqual(result.coverage.missingMonths, ['2026-07']);
  assert.equal(result.coverage.insufficientMonths, true);
  assert.equal(result.summary.totalExpenseFen, 200);
});

test('explicit range preserves missing months as null, with inclusive local boundaries and partial selections', async () => {
  const f = fixture([transaction('2026-06'), transaction('2026-08')]);
  const period = { start_date: '2026-06-15', end_date: '2026-08-15', timezone: 'Asia/Shanghai' };
  const result = await buildFinancialAnalysisContext(f.repository, { period, now });
  assert.deepEqual(f.calls, [{ startDate: period.start_date, endDate: period.end_date, timezone: period.timezone }]);
  assert.deepEqual(result.monthly.map(row => row.status), ['partial', 'unavailable', 'partial']);
  assert.equal(result.monthly[1].summary, null);
  assert.equal(result.summary.totalExpenseFen, 200);
});

test('only partial month data is returned as partial, not fabricated complete history', async () => {
  const { repository } = fixture([transaction('2026-08')], { asOf: '2026-08-20T00:00:00+08:00' });
  const result = await buildFinancialAnalysisContext(repository, { now });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.coverage.completeMonths, []);
  assert.equal(result.monthly[0].status, 'partial');
  assert.equal(result.summary.totalExpenseFen, 100);
});

test('empty repository and empty explicit month return unavailable with null metrics', async () => {
  for (const options of [{}, { month: '2026-09' }]) {
    const { repository } = fixture([], { availableMonths: ['2026-07', '2026-08', '2026-09'] });
    const result = await buildFinancialAnalysisContext(repository, { ...options, now });
    assert.equal(result.status, 'unavailable'); assert.equal(result.summary, null);
    assert.equal(result.coverage.observedStartDate, null);
    assert.ok(result.monthly.every(row => row.summary === null));
  }
});

test('zero expense with observed income differs from unavailable; transfers follow the existing bill exclusions', async () => {
  const { repository } = fixture([transaction('2026-08', 'income', 1000), transaction('2026-08', 'expense', 150), transaction('2026-08', 'transfer_out', 50000)]);
  const result = await buildFinancialAnalysisContext(repository, { month: '2026-08', now });
  assert.equal(result.summary.totalIncomeFen, 1000); assert.equal(result.summary.totalExpenseFen, 150);
  assert.equal(result.summary.netCashFlowFen, 850);
  assert.deepEqual(result.summary.categoryTotals, { 餐饮: 150 });
  const incomeOnly = await buildFinancialAnalysisContext(fixture([transaction('2026-08', 'income', 1000)]).repository, { month: '2026-08', now });
  assert.equal(incomeOnly.summary.totalExpenseFen, 0); assert.equal(incomeOnly.status, 'available');
});

test('timezone date boundaries use the Repository calendar helpers, not timestamp string prefixes', async () => {
  const row = { ...transaction('2026-08'), occurredAt: '2026-08-31T16:00:00Z' };
  const { repository } = fixture([row], { availableMonths: ['2026-09'] });
  const result = await buildFinancialAnalysisContext(repository, { month: '2026-09', timezone: 'Asia/Shanghai', now });
  assert.equal(result.summary.transactionCount, 1);
  assert.equal(result.coverage.observedStartDate, '2026-09-01');
  const august = await buildFinancialAnalysisContext(repository, { month: '2026-08', now });
  assert.equal(august.summary, null);
});

test('read-only aggregates contain no raw transactions, account IDs or merchants and have no shared mutable cache', async () => {
  const rows = [transaction('2026-08')];
  const f = fixture(rows);
  const original = structuredClone(rows);
  const first = await buildFinancialAnalysisContext(f.repository, { now });
  const modelContext = understandingContext({ now, financialContext: first });
  const wire = JSON.stringify(modelContext);
  assert.ok(!wire.includes('account-private') && !wire.includes('merchant-private') && !wire.includes(rows[0].id));
  first.summary.categoryTotals.餐饮 = 999;
  rows.push(transaction('2026-08', 'income', 200));
  const next = await buildFinancialAnalysisContext(f.repository, { now });
  assert.equal(next.summary.categoryTotals.餐饮, 100);
  assert.equal(next.summary.totalIncomeFen, 200);
  assert.deepEqual(rows[0], original[0]);
});

test('invalid ranges and malformed or unsafe transaction amounts fail closed', async () => {
  const { repository } = fixture([transaction('2026-08')]);
  for (const options of [{ month: '2026-13' }, { timezone: 'Invalid/Timezone' }, { month: '2026-08', period: {} },
    { period: { start_date: '2026-02-30', end_date: '2026-03-01' } },
    { period: { start_date: '2026-08-02', end_date: '2026-08-01' } },
    { period: { start_date: '2025-01-01', end_date: '2026-01-02' } }]) {
    await assert.rejects(buildFinancialAnalysisContext(repository, { ...options, now }), TypeError);
  }
  for (const amountFen of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(buildFinancialAnalysisContext(fixture([transaction('2026-08', 'expense', amountFen)]).repository, { now }), TypeError);
  }
  assert.throws(() => summarizeBills([transaction('2026-08', 'income', Number.MAX_SAFE_INTEGER), transaction('2026-08', 'income', 1)]), TypeError);
});

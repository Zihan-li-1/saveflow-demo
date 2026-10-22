import test from 'node:test';
import assert from 'node:assert/strict';
import { isExtendedBillPeriodQuery, resolveBillPeriod } from '../src/lib/bill-period.mjs';

const now = Date.parse('2026-10-22T04:00:00Z');

test('resolves Chinese seasons and half years into exact Shanghai calendar ranges', () => {
  assert.deepEqual(resolveBillPeriod('查2026年春季账单', now), {
    period: { start_date: '2026-03-01', end_date: '2026-05-31', timezone: 'Asia/Shanghai', label: '2026年春季' },
  });
  assert.deepEqual(resolveBillPeriod('查下半年账单', now), {
    period: { start_date: '2026-07-01', end_date: '2026-12-31', timezone: 'Asia/Shanghai', label: '2026年下半年' },
  });
  assert.deepEqual(resolveBillPeriod('看看2026年冬天的账单', now), {
    period: { start_date: '2026-12-01', end_date: '2027-02-28', timezone: 'Asia/Shanghai', label: '2026年冬季' },
  });
  assert.deepEqual(resolveBillPeriod('看看去年下半年的账单', now)?.period, {
    start_date: '2025-07-01', end_date: '2025-12-31', timezone: 'Asia/Shanghai', label: '2025年下半年',
  });
  assert.deepEqual(resolveBillPeriod('明年春季账单', now)?.period, {
    start_date: '2027-03-01', end_date: '2027-05-31', timezone: 'Asia/Shanghai', label: '2027年春季',
  });
});

test('resolves quarters, recent months and explicit date ranges without model guessing', () => {
  assert.deepEqual(resolveBillPeriod('2026年第三季度账单', now)?.period, {
    start_date: '2026-07-01', end_date: '2026-09-30', timezone: 'Asia/Shanghai', label: '2026年第3季度',
  });
  assert.deepEqual(resolveBillPeriod('最近3个月账单', now)?.period, {
    start_date: '2026-08-01', end_date: '2026-10-22', timezone: 'Asia/Shanghai', label: '最近3个月',
  });
  assert.deepEqual(resolveBillPeriod('2026年3月15日至2026年6月2日账单', now)?.period, {
    start_date: '2026-03-15', end_date: '2026-06-02', timezone: 'Asia/Shanghai', label: '2026年3月15日至2026年6月2日',
  });
});

test('keeps a month without a year ambiguous while accepting an explicit year and month', () => {
  assert.equal(resolveBillPeriod('查8月账单', now), null);
  assert.deepEqual(resolveBillPeriod('查2026年8月账单', now), { month: '2026-08' });
  assert.equal(isExtendedBillPeriodQuery('查2026年春季账单'), true);
  assert.equal(isExtendedBillPeriodQuery('查2026年8月账单'), false);
});

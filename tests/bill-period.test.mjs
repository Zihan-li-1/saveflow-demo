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
  assert.deepEqual(resolveBillPeriod('2026年3月15日至6月2日账单', now)?.period, {
    start_date: '2026-03-15', end_date: '2026-06-02', timezone: 'Asia/Shanghai', label: '2026年3月15日至6月2日',
  });
  assert.deepEqual(resolveBillPeriod('2026年3月至5月账单', now)?.period, {
    start_date: '2026-03-01', end_date: '2026-05-31', timezone: 'Asia/Shanghai', label: '2026年3月至5月',
  });
  assert.deepEqual(resolveBillPeriod('2026年3月至2026年5月账单', now)?.period, {
    start_date: '2026-03-01', end_date: '2026-05-31', timezone: 'Asia/Shanghai', label: '2026年3月至2026年5月',
  });
  assert.deepEqual(resolveBillPeriod('2026年12月至2027年2月账单', now)?.period, {
    start_date: '2026-12-01', end_date: '2027-02-28', timezone: 'Asia/Shanghai', label: '2026年12月至2027年2月',
  });
  assert.deepEqual(resolveBillPeriod('上季度账单', now)?.period, {
    start_date: '2026-07-01', end_date: '2026-09-30', timezone: 'Asia/Shanghai', label: '2026年第3季度',
  });
  assert.deepEqual(resolveBillPeriod('过去半年账单', now)?.period, {
    start_date: '2026-05-01', end_date: '2026-10-22', timezone: 'Asia/Shanghai', label: '最近半年',
  });
  assert.deepEqual(resolveBillPeriod('近一年账单', now)?.period, {
    start_date: '2025-11-01', end_date: '2026-10-22', timezone: 'Asia/Shanghai', label: '最近一年',
  });
});

test('resolves compact season wording and keeps genuinely ambiguous periods unresolved', () => {
  assert.deepEqual(resolveBillPeriod('今春账单', now)?.period, {
    start_date: '2026-03-01', end_date: '2026-05-31', timezone: 'Asia/Shanghai', label: '2026年春季',
  });
  assert.deepEqual(resolveBillPeriod('去年冬的花销', now)?.period, {
    start_date: '2025-12-01', end_date: '2026-02-28', timezone: 'Asia/Shanghai', label: '2025年冬季',
  });
  for (const phrase of ['查年初账单', '查看年中账单', '年底花销', '2026年5月至2026年3月账单', '2026年2月30日至3月2日账单']) assert.equal(resolveBillPeriod(phrase, now), null, phrase);
});

test('keeps a month without a year ambiguous while accepting an explicit year and month', () => {
  assert.equal(resolveBillPeriod('查8月账单', now), null);
  assert.deepEqual(resolveBillPeriod('查2026年8月账单', now), { month: '2026-08' });
  assert.equal(isExtendedBillPeriodQuery('查2026年春季账单'), true);
  assert.equal(isExtendedBillPeriodQuery('查2026年8月账单'), false);
});

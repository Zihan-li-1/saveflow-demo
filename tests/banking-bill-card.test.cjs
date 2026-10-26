/* eslint-disable @typescript-eslint/no-require-imports -- Render the actual TSX presentation without a build. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  const source = readFileSync(filename, 'utf8').replace(/from "@\/lib\//g, 'from "../lib/');
  module._compile(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, filename);
};
require.extensions['.css'] = () => {};
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { BankingBillCard } = require('../src/app/BankingBillCard.tsx');
const { BankingReadCard } = require('../src/app/BankingReadCards.tsx');
const { BankingWealthResult } = require('../src/app/BankingWealthCards.tsx');
const { formatBillMoney, formatBillAsOf, billCategories } = require('../src/lib/bill-display.ts');
const fixture = JSON.parse(readFileSync(require.resolve('./fixtures/banking-agent/bill-result.json'), 'utf8')).data;
const render = data => renderToStaticMarkup(React.createElement(BankingBillCard, { data }));
const text = html => html.replace(/<[^>]*>/g, '');

test('理财产品卡片用通俗语言解释风险、取用时间和月度期限', () => {
  const html = renderToStaticMarkup(React.createElement(BankingReadCard, { data: {
    status: 'wealth_recommendation',
    data: { products: [{ product_ref: 'p1', name: '模拟稳健产品', risk_level: 'R2', expected_yield_bps: 210, minimum_amount_minor: 10000, liquidity: 'T+1', duration_days: 180 }] },
    evidence: [{ source: 'synthetic_demo_only', as_of: '2026-09-01T00:00:00+08:00' }],
  } }));
  const value = text(html);
  for (const expected of ['中等风险（示例：阶段亏损可能约 2%–10%）', '通常下一个工作日可取', '约 6 个月', '风险等级 点此了解', '流动性 点此了解', '百分比只是帮助理解差异的演示尺度']) assert.ok(value.includes(expected), expected);
  assert.match(html, /<details><summary>风险等级 <span>点此了解<\/span><\/summary>/);
  assert.equal(html.includes('<details open=""'), false);
  assert.equal(value.includes('R2'), false);
  assert.equal(value.includes('T+1'), false);
  assert.equal(value.includes('180 天'), false);
});

test('理财推荐中已选和未选产品合计最多展示五个', () => {
  const product = index => ({ product_id: `selected-${index}`, name: `已选产品${index}`, risk_level: 'R2', liquidity: 'T+1', expected_yield_bps: 200, minimum_amount: { amount_minor: 10000 }, duration_days: 90 });
  const excluded = index => ({ product_id: `excluded-${index}`, product_name: `未选产品${index}`, reason_codes: ['RISK_TOO_HIGH'] });
  const html = renderToStaticMarkup(React.createElement(BankingWealthResult, { data: { data: {
    kind: 'recommendation',
    matches: [1, 2, 3].map(product),
    excluded: [1, 2, 3, 4].map(excluded),
    as_of: '2026-10-26T00:00:00+08:00',
  } } }));
  const value = text(html);
  for (const expected of ['已选产品1', '已选产品2', '已选产品3', '未选产品1', '未选产品2']) assert.ok(value.includes(expected), expected);
  for (const hidden of ['未选产品3', '未选产品4']) assert.equal(value.includes(hidden), false, hidden);
  assert.ok(value.includes('本次最多展示 5 个产品，另有 2 个未展示'));
  assert.equal((html.match(/<article/g) || []).length + (html.match(/<p><strong>未选产品/g) || []).length, 5);
});

test('理财产品对比同样最多展示五个', () => {
  const products = Array.from({ length: 7 }, (_, index) => ({ product_id: `p-${index + 1}`, name: `对比产品${index + 1}`, risk_level: 'R2', liquidity: 'T+1', expected_yield_bps: 200, minimum_amount: { amount_minor: 10000 }, duration_days: 90 }));
  const html = renderToStaticMarkup(React.createElement(BankingWealthResult, { data: { data: { kind: 'comparison', products, as_of: '2026-10-26T00:00:00+08:00' } } }));
  assert.equal((html.match(/<article/g) || []).length, 5);
  assert.equal(text(html).includes('对比产品6'), false);
  assert.ok(text(html).includes('另有 2 个未展示'));
});

test('August card uses structured amounts, exact signed balance, all transaction count and Chinese provenance', () => {
  const value = text(render(fixture));
  for (const expected of ['2026 年 8 月', '月度收支概览', '本月总支出¥8,460.00', '本月收入¥12,000.00', '+¥3,540.00', '不是账户可用余额', '总交易笔数12 笔', '模拟演示数据', '2026年9月1日 00:00（北京时间）', '房租', '35.5%', '¥3,000.00']) assert.ok(value.includes(expected), expected);
  assert.ok(!value.includes('支出笔数'));
  assert.ok(!value.includes('synthetic_demo_only'));
});

test('zero month has honest zeros and no category section; missing/invalid categories are hidden', () => {
  const zero = { ...fixture, data: { month: '2026-01', totalIncomeFen: 0, totalExpenseFen: 0, transactionCount: 0, categoryTotals: {} } };
  const html = render(zero);
  assert.ok(text(html).includes('总交易笔数0 笔'));
  assert.ok(text(html).includes('本月暂无交易记录'));
  assert.equal((text(html).match(/¥0\.00/g) || []).length, 4);
  assert.ok(!/NaN|Infinity|bill-report-categories/.test(html));
  for (const categoryTotals of [undefined, null, {}, { invalid: NaN }, { partial: 100 }, { negative: -846000 }]) {
    assert.ok(!render({ ...fixture, data: { ...fixture.data, categoryTotals } }).includes('bill-report-categories'));
  }
});

test('integer-fen formatting preserves maximum safe-integer cents, negative balance and unknown values', () => {
  assert.equal(formatBillMoney(Number.MAX_SAFE_INTEGER), '¥90,071,992,547,409.91');
  assert.equal(formatBillMoney(-12345, true), '−¥123.45');
  assert.equal(formatBillMoney(0, true), '¥0.00');
  for (const invalid of [undefined, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(formatBillMoney(invalid), '—');
  const html = render({ ...fixture, data: { ...fixture.data, totalIncomeFen: 0 } });
  assert.ok(html.includes('class="negative"'));
  assert.ok(text(html).includes('−¥8,460.00'));
  assert.ok(!/NaN|Infinity/.test(render(undefined)));
});

test('dates use Shanghai time consistently and reject missing or ambiguous dates', () => {
  assert.equal(formatBillAsOf('2026-08-31T16:00:00Z'), '2026年9月1日 00:00（北京时间）');
  for (const value of [undefined, '', 'bad', '2026-09-01', '2026-09-01T00:00:00']) assert.equal(formatBillAsOf(value), '日期未知');
});

test('categories preserve backend amounts in descending order and derive ratios from the total', () => {
  assert.deepEqual(billCategories({ food: 300, rent: 700 }, 1000), [{ name: 'rent', amountFen: 700 }, { name: 'food', amountFen: 300 }]);
  assert.deepEqual(billCategories({ food: 300 }, 1000), []);
  const input = structuredClone(fixture);
  input.message = '收入 ¥99999999；支出 ¥88888888';
  assert.equal(render(input), render(fixture));
  assert.deepEqual(input.data, fixture.data);
});

test('range longer than two months renders a monthly expense bar chart', () => {
  const range = {
    ...fixture,
    data: {
      ...fixture.data,
      month: undefined,
      period: { startDate: '2026-07-01', endDate: '2026-12-31', timezone: 'Asia/Shanghai', label: '2026年下半年' },
      monthlyBreakdown: [
        { month: '2026-07', status: 'complete', totalExpenseFen: 320000, totalIncomeFen: 0, transactionCount: 2, categoryTotals: { '房租': 300000, '餐饮': 20000 } },
        { month: '2026-08', status: 'complete', totalExpenseFen: 846000, totalIncomeFen: 1200000, transactionCount: 12, categoryTotals: fixture.data.categoryTotals },
        { month: '2026-09', status: 'partial', totalExpenseFen: 0, totalIncomeFen: 0, transactionCount: 0 },
        { month: '2026-10', status: 'future', totalExpenseFen: 0, totalIncomeFen: 0, transactionCount: 0 },
        { month: '2026-11', status: 'future', totalExpenseFen: 0, totalIncomeFen: 0, transactionCount: 0 },
        { month: '2026-12', status: 'future', totalExpenseFen: 0, totalIncomeFen: 0, transactionCount: 0 },
      ],
    },
  };
  const html = render(range);
  const value = text(html);
  for (const expected of ['2026年下半年', '2026年7月1日—2026年12月31日', '期间收支概览', '期间总支出', '每月支出对比', '最高：8月', '月均', '主要变化', '8月较7月', '餐饮', '增加', '仅比较最近两个完整月份', '截至目前', '未到', '房租', '35.5%']) assert.ok(value.includes(expected), expected);
  assert.equal((html.match(/bill-report-bar-track/g) || []).length, 6);
});

test('one or two months do not render the comparison chart', () => {
  const html = render({ ...fixture, data: { ...fixture.data, monthlyBreakdown: [
    { month: '2026-07', status: 'complete', totalExpenseFen: 320000, totalIncomeFen: 0, transactionCount: 2 },
    { month: '2026-08', status: 'complete', totalExpenseFen: 846000, totalIncomeFen: 1200000, transactionCount: 12 },
  ] } });
  assert.equal(html.includes('bill-report-chart'), false);
});

test('a short range touching three calendar months does not count as longer than two months', () => {
  const html = render({ ...fixture, data: {
    ...fixture.data,
    month: undefined,
    period: { startDate: '2026-06-30', endDate: '2026-08-01', timezone: 'Asia/Shanghai', label: '自定义时间段' },
    monthlyBreakdown: [
      { month: '2026-06', status: 'complete', totalExpenseFen: 100, totalIncomeFen: 0, transactionCount: 1 },
      { month: '2026-07', status: 'complete', totalExpenseFen: 200, totalIncomeFen: 0, transactionCount: 1 },
      { month: '2026-08', status: 'complete', totalExpenseFen: 300, totalIncomeFen: 0, transactionCount: 1 },
    ],
  } });
  assert.equal(html.includes('bill-report-chart'), false);
});

test('cross-year ranges show years and do not summarize partial or future months', () => {
  const html = render({ ...fixture, data: {
    ...fixture.data,
    totalIncomeFen: 0,
    totalExpenseFen: 10000,
    transactionCount: 1,
    categoryTotals: { '餐饮': 10000 },
    month: undefined,
    period: { startDate: '2026-12-15', endDate: '2027-03-31', timezone: 'Asia/Shanghai', label: '跨年账单' },
    monthlyBreakdown: [
      { month: '2026-12', status: 'partial', totalExpenseFen: 10000, totalIncomeFen: 0, transactionCount: 1 },
      { month: '2027-01', status: 'future', totalExpenseFen: 0, totalIncomeFen: 0, transactionCount: 0 },
      { month: '2027-02', status: 'future', totalExpenseFen: 0, totalIncomeFen: 0, transactionCount: 0 },
      { month: '2027-03', status: 'future', totalExpenseFen: 0, totalIncomeFen: 0, transactionCount: 0 },
    ],
  } });
  const value = text(html);
  assert.ok(value.includes('2026/12'));
  assert.ok(value.includes('2027/01'));
  assert.ok(value.includes('截至目前'));
  assert.equal(value.includes('最高：'), false);
  assert.equal(value.includes('月均：'), false);
});

test('an entirely future range is labelled honestly instead of showing zero spending', () => {
  const html = render({ ...fixture, data: {
    ...fixture.data,
    totalIncomeFen: 0,
    totalExpenseFen: 0,
    transactionCount: 0,
    categoryTotals: {},
    month: undefined,
    period: { startDate: '2027-01-01', endDate: '2027-03-31', timezone: 'Asia/Shanghai', label: '未来账单' },
    monthlyBreakdown: [
      { month: '2027-01', status: 'future', totalExpenseFen: 0, totalIncomeFen: 0, transactionCount: 0 },
      { month: '2027-02', status: 'future', totalExpenseFen: 0, totalIncomeFen: 0, transactionCount: 0 },
      { month: '2027-03', status: 'future', totalExpenseFen: 0, totalIncomeFen: 0, transactionCount: 0 },
    ],
  } });
  assert.ok(text(html).includes('所选时间尚未到来'));
});

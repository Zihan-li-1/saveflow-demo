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
const { formatBillMoney, formatBillAsOf, billCategories } = require('../src/lib/bill-display.ts');
const fixture = JSON.parse(readFileSync(require.resolve('./fixtures/banking-agent/bill-result.json'), 'utf8')).data;
const render = data => renderToStaticMarkup(React.createElement(BankingBillCard, { data }));
const text = html => html.replace(/<[^>]*>/g, '');

test('August card uses structured amounts, exact signed balance, all transaction count and Chinese provenance', () => {
  const value = text(render(fixture));
  for (const expected of ['2026 年 8 月', '月度收支概览', '本月总支出¥8,460.00', '本月收入¥12,000.00', '+¥3,540.00', '不是账户可用余额', '总交易笔数12 笔', '模拟演示数据', '2026年9月1日 00:00（北京时间）', '房租¥3,000.00']) assert.ok(value.includes(expected), expected);
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

test('categories preserve backend amounts in descending order without invented ratios', () => {
  assert.deepEqual(billCategories({ food: 300, rent: 700 }, 1000), [{ name: 'rent', amountFen: 700 }, { name: 'food', amountFen: 300 }]);
  assert.deepEqual(billCategories({ food: 300 }, 1000), []);
  const input = structuredClone(fixture);
  input.message = '收入 ¥99999999；支出 ¥88888888';
  assert.equal(render(input), render(fixture));
  assert.deepEqual(input.data, fixture.data);
});

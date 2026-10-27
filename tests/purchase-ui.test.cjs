/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (module, filename) => module._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText, filename);
require.extensions['.css'] = module => { module.exports = {}; };
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { PurchaseFlow } = require('../src/components/PurchaseFlow.tsx');

test('purchase form explains logical budget, reminder, and user-created orders', () => {
  const html = renderToStaticMarkup(React.createElement(PurchaseFlow, { accessCode: '', consent: false }));
  for (const copy of ['银行余额不变', '提醒我下单的日期', '希望送达的日期', '预览预留金额与提醒时间', '你填写的可用余额', '自行核对商品']) {
    assert.ok(html.includes(copy), copy);
  }
  assert.doesNotMatch(html, /commerce\.order\.execute|配送地址|查询订单/);
});

test('active flow gives preference-based links and leaves checkout to user', () => {
  const html = renderToStaticMarkup(React.createElement(PurchaseFlow, { accessCode: 'code', consent: true, initialData: {
    workflow_ref: 'flow', version: 3, status: 'active', slots: {
      selection_mode: 'browse', budget: { amount_minor: 100000, currency: 'CNY' },
      items: [{ category: 'flowers', quantity: 1 }, { category: 'cake', quantity: 1 }],
      preferences: { flower_colors: ['pink'], cake_flavors: ['fruit'], ingredient_exclusions: ['nuts'] },
    }, orders: [], reservation: { total_minor: 100000, unallocated_minor: 100000, occupied_minor: 0, consumed_minor: 0, released_minor: 0 },
  } }));
  for (const copy of ['本月预留', '银行', '问答搭配', '商品自选', 'search.jd.com', '自行选择并下单', '坚果', '过敏原', '只有一条搜索入口', '没有按价格分档推荐', '重新核对实际可用金额', '按最新自填余额复核预留', '未经银行验证']) assert.ok(html.includes(copy), copy);
  assert.doesNotMatch(html, /查询订单|确认购买|填写配送地址/);
});

test('old mock order is shown as read-only historical state', () => {
  const html = renderToStaticMarkup(React.createElement(PurchaseFlow, { accessCode: 'code', consent: true, initialData: {
    workflow_ref: 'flow', version: 3, status: 'active', slots: { selection_mode: 'browse', budget: { amount_minor: 100000, currency: 'CNY' }, items: [] },
    orders: [{ operation_ref: 'op', status: 'unknown', amount_minor: 31500 }],
    reservation: { total_minor: 100000, unallocated_minor: 68500, occupied_minor: 31500, consumed_minor: 0, released_minor: 0 },
  } }));
  assert.match(html, /旧版模拟订单记录（只读/);
  assert.match(html, /结果待核实/);
  assert.doesNotMatch(html, /查询订单|已付款成功/);
});

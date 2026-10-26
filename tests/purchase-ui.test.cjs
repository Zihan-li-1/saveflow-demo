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
const { PurchaseFlow, PurchaseOrderDetails } = require('../src/components/PurchaseFlow.tsx');
test('purchase form explains logical budget, date meaning, manual data and two selection paths', () => {
  const html = renderToStaticMarkup(React.createElement(PurchaseFlow, { accessCode: '', consent: false }));
  for (const copy of ['银行余额不变', '送达日', '下单日', '问答搭配', '商品自选', '模拟购物', '你填写的可用余额']) assert.ok(html.includes(copy), copy);
  assert.doesNotMatch(html, /commerce\.order\.execute|scenario\.plan_purchase/);
});
test('exact order confirmation includes merchant, payment capability and bound delivery snapshot', () => {
  const html = renderToStaticMarkup(React.createElement(PurchaseOrderDetails, { preview: {
    merchant_name: '演示鲜花店', product_name: '粉色玫瑰', sku_ref: '标准花束', quantity: 1, total: { amount_minor: 31500, currency: 'CNY' },
    delivery: { recipient: '测试收件人', phone: '13800000000', address: '绑定地址1号' }, delivery_window: { starts_at: '2026-11-01 09:00', ends_at: '2026-11-01 12:00' },
    cancellation_terms: '模拟取消条款', payment_mode: 'mock_no_payment',
  } }));
  for (const copy of ['演示鲜花店', '¥315.00', '绑定地址1号', '模拟环境不支持真实付款', '模拟取消条款']) assert.ok(html.includes(copy), copy);
});
test('active flow renders truthful per-order statuses and retained choices', () => {
  const html = renderToStaticMarkup(React.createElement(PurchaseFlow, { accessCode: 'code', consent: true, initialData: {
    workflow_ref: 'flow', version: 3, status: 'active', slots: { selection_mode: 'browse', budget: { amount_minor: 100000, currency: 'CNY' }, items: [{ category: 'flowers', quantity: 1 }] },
    orders: [{ operation_ref: 'op', status: 'unknown', amount_minor: 31500 }], selected_candidate_refs: ['candidate_1'],
    reservation: { total_minor: 100000, unallocated_minor: 68500, occupied_minor: 31500, consumed_minor: 0, released_minor: 0 },
  } }));
  for (const copy of ['结果待核实', '¥315.00', '查询订单', '预算占用', '问答搭配', '商品自选']) assert.ok(html.includes(copy), copy);
  assert.doesNotMatch(html, /已全部购买|已付款成功/);
});

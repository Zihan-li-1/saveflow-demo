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
const { PurchaseRequestCard } = require('../src/components/PurchaseRequestCard.tsx');

test('local Next purchase route reaches the shared JSON API', async () => {
  const { POST } = require('../src/app/api/purchase/route.ts');
  const response = await POST(new Request('http://localhost:3000/api/purchase', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }));
  const body = await response.json();
  assert.notEqual(response.status, 404);
  assert.equal(typeof body.code, 'string');
});

test('purchase request pre-fills the known day and only asks for missing information', () => {
  const html = renderToStaticMarkup(React.createElement(PurchaseRequestCard, { slots: {
    date_expression: '2027-09-01', date_meaning: 'order_on', items: [{ category: 'flowers', quantity: 1 }],
  } }));
  assert.match(html, /value="2027-09-01"/);
  assert.match(html, /日期已填入，请补充时间段/);
  assert.match(html, /预览提醒设置/);
  assert.doesNotMatch(html, />补充<|手动填写完整表单|届时怎么处理|value="09:00"|预提醒已设置成功/);
  const past = renderToStaticMarkup(React.createElement(PurchaseRequestCard, { slots: {
    date_expression: '2020-01-01', date_meaning: 'order_on', items: [{ category: 'flowers', quantity: 1 }],
  } }));
  assert.match(past, /所选日期已过去/);
  assert.doesNotMatch(past, /预览提醒设置|已识别：|type="date"|search.jd.com/);
  const immediate = renderToStaticMarkup(React.createElement(PurchaseRequestCard, { slots: { items: [{ category: 'flowers', quantity: 1 }] } }));
  assert.match(immediate, /search.jd.com/);
  assert.doesNotMatch(immediate, /预览提醒设置|type="date"|现在就买/);
});

test('supplement → preview → confirm calls the real purchase API and only receipts a persisted reminder', async t => {
  const { create, act } = require('react-test-renderer');
  const { handlePurchaseRequest } = await import('../server/purchase-api.mjs');
  const { createPurchaseSkill } = await import('../src/skills/scenario/purchase-skill.mjs');
  const { createPurchaseTestStore } = await import('./fixtures/purchase-memory-store.mjs');
  const previousActEnvironment = global.IS_REACT_ACT_ENVIRONMENT;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  t.after(() => { global.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment; });
  const now = () => Date.parse('2026-10-29T00:00:00Z');
  const env = { SAVEFLOW_ACCESS_CODE: 'purchase-ui-test-access', CONTINUATION_TOKEN_SECRET: 'purchase-test-secret-longer-than-32-characters' };
  const store = createPurchaseTestStore();
  let cookie = '', schedulerEnabled = true, loseSaveResponse = false;
  const actions = [];
  t.mock.method(global, 'fetch', async (_url, init) => {
    const { action } = JSON.parse(init.body); actions.push(action);
    const request = new Request('https://saveflow.test/api/purchase', { ...init, headers: {
      ...init.headers, origin: 'https://saveflow.test', ...(cookie ? { cookie } : {}),
    } });
    const response = await handlePurchaseRequest(request, { env, now,
      getSkill: async () => createPurchaseSkill({ store, now, schedulerEnabled }) });
    cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
    if (action === 'scenario.purchase.save' && response.ok && loseSaveResponse) { loseSaveResponse = false; throw new Error('response lost'); }
    return response;
  });
  let root;
  const click = text => act(async () => { await root.root.findAllByType('button').find(button => button.children.join('') === text).props.onClick(); });
  const field = (label, value) => act(() => root.root.findByProps({ 'aria-label': label }).props.onChange({ target: { value } }));
  const receiptCount = () => root.root.findAllByProps({ 'aria-label': '提醒设置回执' }).length;
  const state = () => store.transaction(cookie.split('=')[1].split('.')[0], value => value);
  try {
    await act(async () => { root = create(React.createElement(PurchaseRequestCard, { consent: true, accessCode: env.SAVEFLOW_ACCESS_CODE,
      slots: { date_expression: '2027-09-01', date_meaning: 'order_on', items: [{ category: 'flowers', quantity: 1 }] }, cards: ['日常虚拟卡'] })); });
    assert.equal(root.root.findByProps({ 'aria-label': '购买日期' }).props.value, '2027-09-01');
    await field('开始时间', '09:00'); await field('结束时间', '12:00'); await field('预留预算', '500'); await click('日常虚拟卡');
    await click('预览提醒设置'); // Missing repository finance asks for data, not fake success.
    assert.equal(receiptCount(), 0);
    assert.equal(Object.keys((await state()).jobs).length, 0);
    await field('可用余额', '1000'); await field('近期待付金额', '100');
    await click('预览提醒设置');
    assert.equal(actions.includes('scenario.purchase.save'), false);
    assert.equal(Object.keys((await state()).jobs).length, 0);
    schedulerEnabled = false; await click('确认设置提醒');
    assert.equal(receiptCount(), 0);
    assert.match(JSON.stringify(root.toJSON()), /后台预约服务未运行/);
    schedulerEnabled = true; loseSaveResponse = true; await click('确认设置提醒');
    assert.equal(receiptCount(), 0); // Lost response is not a success receipt.
    await click('确认设置提醒'); // Exact retry recovers the same persisted reminder.
    assert.equal(receiptCount(), 1);
    const saved = await state();
    assert.equal(Object.keys(saved.workflows).length, 1);
    assert.equal(Object.keys(saved.jobs).length, 1);
    assert.equal(Object.values(saved.jobs)[0].due_at, '2027-09-01T09:00:00+08:00');
    assert.equal(Object.values(saved.reservations)[0].total_minor, 50000);
    assert.equal(Object.keys(saved.operations).length, 0);
    assert.match(JSON.stringify(root.toJSON()), /预提醒已设置成功/);
    await click('获取恢复码');
    assert.ok(root.root.findByProps({ 'aria-label': '提醒恢复码' }).props.value.length >= 40);
  } finally { if (root) await act(async () => root.unmount()); }
});

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

/* eslint-disable @typescript-eslint/no-require-imports -- Exercise the real TS client and TSX card in Node. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  module._compile(ts.transpileModule(readFileSync(filename, 'utf8').replace(/from "@\/lib\//g, 'from "../lib/'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, filename);
};
require.extensions['.css'] = () => {};
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { askBankingAgent } = require('../src/lib/banking-agent-client.ts');
const { BankingBillCard } = require('../src/app/BankingBillCard.tsx');
const env = { SAVEFLOW_ACCESS_CODE: 'synthetic-bill-test-access', CONTINUATION_TOKEN_SECRET: 'synthetic-bill-test-secret' };
const now = () => Date.parse('2026-10-22T04:00:00Z');
const period = (start_date = '2026-06-01', end_date = '2026-09-30', timezone = 'Asia/Shanghai') => ({ start_date, end_date, timezone, label: `${start_date}至${end_date}` });
const intent = slots => ({ schemaVersion: '1.0.0', action: 'bill.summary', slots, missingSlots: [], status: 'ready_for_resolution' });
let sequence = 0;
async function backend(slots = { period: period() }, message = '查看今年六到九月的账单', timezone = 'Asia/Shanghai', { live = false } = {}) {
  const { handleBankingAgent } = await import('../server/banking-agent.mjs');
  const { createBankingCore } = await import('../src/banking-core/core.mjs');
  const core = createBankingCore({ now });
  const queries = [], turns = [];
  const repository = { ...core.repository, getTransactions: filter => { queries.push(filter); return core.repository.getTransactions(filter); } };
  const real = live ? (await import('../server/trueforge-banking-runtime.mjs')).createBankingRuntimeClient({ env: process.env }) : undefined;
  const response = await handleBankingAgent(new Request('http://localhost/api/banking-agent', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'x-forwarded-for': `bill-contract-${++sequence}` },
    body: JSON.stringify({ message, history: [], consent: true }),
  }), { env, core, repository, now, timezone, trueforgeRuntimeClient: {
    createSession: signal => live ? real.createSession(signal) : Promise.resolve('fixture-session'),
    cancel: id => live ? real.cancel(id) : Promise.resolve(),
    runTurn: async (id, wire, signal) => { turns.push(JSON.parse(wire)); return live ? real.runTurn(id, wire, signal) : JSON.stringify(intent(slots)); },
  } });
  assert.equal(response.status, 200);
  return { payload: await response.json(), queries, turns };
}
async function client(payload, options) {
  const original = global.fetch;
  try {
    global.fetch = async () => payload instanceof Response ? payload : Response.json(payload);
    return await askBankingAgent({ message: '查看今年六到九月的账单' }, env.SAVEFLOW_ACCESS_CODE, new AbortController().signal, options);
  } finally { global.fetch = original; }
}
const render = data => renderToStaticMarkup(React.createElement(BankingBillCard, { data })).replace(/<[^>]*>/g, '');

test('real HTTP bill with missing September passes real client and renders missing data', async () => {
  const { payload, queries, turns } = await backend();
  assert.deepEqual(queries, [{ startDate: '2026-06-01', endDate: '2026-09-30', timezone: 'Asia/Shanghai' }]);
  assert.equal(turns[0].userMessage, '查看今年六到九月的账单');
  assert.equal(turns[0].calendar.currentDate, '2026-10-22');
  assert.equal(turns[0].calendar.timezone, 'Asia/Shanghai');
  assert.deepEqual(turns[0].calendar.financialData.availableMonths, ['2026-06', '2026-07', '2026-08']);
  assert.equal(payload.data.data.monthlyBreakdown.at(-1).status, 'unavailable');
  const data = await client(payload);
  const text = render(data);
  assert.ok(text.includes('2026年6月1日—2026年9月30日'));
  assert.ok(text.includes('缺数据'));
  assert.ok(text.includes('无记录不代表没有支出'));
});

test('single month, relative month, year to date, last year and cross-year bills survive HTTP/client/card', async () => {
  const cases = [
    ['查看2026年8月账单', { month: '2026-08' }, '2026 年 8 月'],
    ['分析上个月的账单', { month: '2026-09' }, '本月缺数据'],
    ['查看今年以来的消费', { period: period('2026-01-01', '2026-10-22') }, '2026年1月1日—2026年10月22日'],
    ['查去年全年账单', { period: period('2025-01-01', '2025-12-31') }, '不能视为零消费'],
    ['查询2026年6月到9月的账单', { period: period() }, '缺数据'],
    ['查2025年12月至2026年2月的账单', { period: period('2025-12-01', '2026-02-28') }, '2025/12'],
    ['查2026年8月至9月账单', { period: period('2026-08-01', '2026-09-30') }, '缺数据：9月'],
    ['查六月下半月账单', { period: period('2026-06-15', '2026-06-30') }, '2026年6月15日—2026年6月30日'],
  ];
  for (const [message, slots, expected] of cases) {
    const { payload, queries, turns } = await backend(slots, message);
    assert.equal(turns[0].userMessage, message);
    assert.equal(turns[0].context, undefined);
    const expectedFilter = slots.month ? { month: slots.month } : { startDate: slots.period.start_date, endDate: slots.period.end_date, timezone: slots.period.timezone };
    assert.deepEqual(queries[0], expectedFilter);
    if (slots.month) {
      const { previousMonth } = await import('../src/agent/bill-insights.mjs');
      assert.deepEqual(queries, [expectedFilter, { month: previousMonth(slots.month) }]);
    } else assert.deepEqual(queries, [expectedFilter]);
    const text = render(await client(payload));
    assert.ok(text.includes(expected), `${message}: ${expected}`);
    if (message === '查看2026年8月账单') {
      assert.equal(payload.data.data.totalExpenseFen, 846000);
      assert.ok(text.includes('¥8,460.00'));
    }
    if (message === '查去年全年账单' || message === '分析上个月的账单') {
      assert.equal(text.includes('¥0.00'), false);
      assert.equal(text.includes('暂无交易记录'), false);
      assert.equal(text.includes('尚未到来'), false);
      assert.equal(text.includes('最高：'), false);
    }
  }
});

test('IANA timezone uses the same local day boundaries in repository, HTTP and client', async () => {
  const slots = { period: period('2026-08-01', '2026-08-31', 'America/New_York') };
  const { payload, queries, turns } = await backend(slots, '查纽约时区八月账单', 'America/New_York');
  assert.equal(turns[0].calendar.timezone, 'America/New_York');
  assert.equal(queries[0].timezone, 'America/New_York');
  const result = await client(payload);
  assert.equal(result.data.period.timezone, 'America/New_York');
  assert.ok(render(result).includes('2026年8月1日—2026年8月31日'));
  const { transactionMatchesPeriod } = await import('../src/lib/calendar.mjs');
  assert.equal(transactionMatchesPeriod('2026-09-01T03:59:59Z', queries[0]), true);
  assert.equal(transactionMatchesPeriod('2026-09-01T04:00:00Z', queries[0]), false);
});

test('rejects unknown states, money, category mismatches, malformed statistics and untrusted evidence with safe paths', async () => {
  const { payload } = await backend();
  const mutations = [
    ['INVALID_MONTHLY_STATUS', p => { p.data.data.monthlyBreakdown[3].status = 'invented'; }],
    ['INVALID_MONTHLY_STATUS', p => { p.data.data.monthlyBreakdown[3].status = ['complete']; }],
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100', null].map(amount => ['INVALID_BILL_TOTALS', p => { p.data.data.totalExpenseFen = amount; }]),
    ['INVALID_BILL_TOTALS', p => { p.data.data.categoryTotals = { bogus: p.data.data.totalExpenseFen - 1 }; }],
    ['INVALID_BILL_TOTALS', p => { p.data.data.monthlyBreakdown[0].categoryTotals = {}; }],
    ['INVALID_BILL_TOTALS', p => { p.data.data.totalIncomeFen += 100; }],
    ['INVALID_BILL_TOTALS', p => { p.data.data.transactionCount++; }],
    ['INVALID_BILL_TOTALS', p => { p.data.data.insights.changeFen += 1; }],
    ['INVALID_BILL_TOTALS', p => { p.data.data.insights.largestExpenses[0].transactionId = 'untrusted-transaction'; }],
    ['INVALID_BILL_TOTALS', p => { p.data.data.accountId = 'do-not-log-account'; }],
    ['INVALID_BILL_TOTALS', p => { p.data.data.monthlyBreakdown = [null]; }],
    ['INVALID_BILL_PERIOD', p => { p.data.data.monthlyBreakdown.reverse(); }],
    ['INVALID_BILL_PERIOD', p => { p.data.data.monthlyBreakdown[1].month = '2026-06'; }],
    ['INVALID_BILL_PERIOD', p => { p.data.data.monthlyBreakdown.pop(); }],
    ['INVALID_EVIDENCE', p => { p.data.evidence = []; }],
    ['INVALID_EVIDENCE', p => { p.data.evidence = null; }],
    ['INVALID_EVIDENCE', p => { p.data.evidence[0].source = 'untrusted-bank'; }],
    ['INVALID_EVIDENCE', p => { p.data.evidence[0].asOf = '2026-02-30T00:00:00Z'; }],
    ['INVALID_EVIDENCE', p => { p.data.evidence[0].entityIds = [null]; }],
    ['INVALID_EVIDENCE', p => { p.data.data.coverage.availableMonths = ['bad']; }],
  ];
  for (const [reason, mutate] of mutations) {
    const forged = structuredClone(payload); mutate(forged);
    const diagnostics = [];
    await assert.rejects(client(forged, { onDiagnostic: d => diagnostics.push(d) }), { code: 'BANKING_AGENT_RESPONSE_ERROR', requestId: payload.requestId });
    assert.equal(diagnostics[0].reason, reason);
    assert.equal(diagnostics[0].stage, 'bill');
    assert.deepEqual(Object.keys(diagnostics[0]).sort(), ['event', 'path', 'reason', 'requestId', 'stage']);
    assert.match(diagnostics[0].path, /^data\.(?:data|evidence)/);
    assert.equal(JSON.stringify(diagnostics).includes('do-not-log-account'), false);
  }
});

test('strict periods reject impossible dates, unknown fields, excessive ranges and invalid timezones', async () => {
  const { payload } = await backend();
  for (const patch of [
    { startDate: '2026-02-30' }, { endDate: '2026-13-01' }, { startDate: '1800-01-01' },
    { startDate: '2026-10-01' }, { endDate: '2027-06-01' }, { timezone: 'Unknown/Nowhere' },
    { timezone: '+08:00' }, { timezone: ' Asia/Shanghai' }, { label: ' ' }, { unexpected: true },
  ]) {
    const forged = structuredClone(payload); Object.assign(forged.data.data.period, patch);
    const diagnostics = [];
    await assert.rejects(client(forged, { onDiagnostic: d => diagnostics.push(d) }), { code: 'BANKING_AGENT_RESPONSE_ERROR' });
    assert.equal(diagnostics[0].reason, 'INVALID_BILL_PERIOD');
  }
});

test('non-JSON HTTP, malformed reply and valid business errors remain distinguishable', async () => {
  const diagnostics = [];
  const options = { onDiagnostic: d => diagnostics.push(d) };
  await assert.rejects(client(new Response('<html>gateway error</html>', { status: 502, headers: { 'x-request-id': 'gateway-1' } }), options), { code: 'BANKING_AGENT_RESPONSE_ERROR', requestId: 'gateway-1' });
  assert.equal(diagnostics.at(-1).reason, 'INVALID_HTTP_RESPONSE');
  assert.equal(diagnostics.at(-1).stage, 'http');
  for (const malformed of [null, [], {}, { code: 'OK', data: {} }, { code: 'OK', data: {}, requestId: 'r1', reply: { text: 'x' } }]) {
    await assert.rejects(client(malformed, options), { code: 'BANKING_AGENT_RESPONSE_ERROR' });
    assert.equal(diagnostics.at(-1).reason, 'INVALID_REPLY_ENVELOPE');
  }
  await assert.rejects(client(Response.json({ code: 'RATE_LIMIT', message: '稍后重试', requestId: 'r1' }, { status: 429 })), { code: 'RATE_LIMIT', requestId: 'r1' });
  const { payload } = await backend();
  payload.data.data.monthlyBreakdown[3].status = 'forged';
  await assert.rejects(client(payload, { onDiagnostic: () => { throw new Error('logger unavailable'); } }), { code: 'BANKING_AGENT_RESPONSE_ERROR' });
});

test('client sends original text/history without adding a continuation and consumes real handler Response directly', async () => {
  const { handleBankingAgent } = await import('../server/banking-agent.mjs');
  const { createBankingCore } = await import('../src/banking-core/core.mjs');
  const original = global.fetch;
  const message = '查看今年六到九月的账单';
  const history = [{ role: 'assistant', content: '可以查询账单。' }];
  try {
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.message, message);
      assert.deepEqual(body.history, history);
      assert.equal('continuationToken' in body, false);
      const request = new Request(`http://localhost${url}`, init);
      request.headers.set('x-forwarded-for', `direct-contract-${++sequence}`);
      return handleBankingAgent(request, { env, core: createBankingCore({ now }), now, parseIntent: async value => {
        assert.equal(value, message); return intent({ period: period() });
      } });
    };
    const result = await askBankingAgent({ message, history }, env.SAVEFLOW_ACCESS_CODE, new AbortController().signal);
    assert.equal(result.status, 'bill_result');
    assert.ok(render(result).includes('缺数据'));
  } finally { global.fetch = original; }
});

test('LIVE TrueForge -> real HTTP -> real client -> bill card with unmodified seed', { skip: process.env.SAVEFLOW_VERIFY_LIVE_BILL !== 'true' }, async () => {
  const { payload, queries } = await backend(undefined, undefined, undefined, { live: true });
  assert.deepEqual(queries, [{ startDate: '2026-06-01', endDate: '2026-09-30', timezone: 'Asia/Shanghai' }]);
  assert.equal(payload.data.data.monthlyBreakdown.at(-1).status, 'unavailable');
  assert.ok(render(await client(payload)).includes('缺数据'));
});

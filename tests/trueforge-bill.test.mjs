import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createTrueforgeBillAdapter, shouldRouteTrueforgeBill, validateBillToolResult } from '../server/trueforge-bill-adapter.mjs';
import { billAgentSpec, createTrueforgeClient } from '../server/trueforge-client.mjs';
import { handleBankingAgent } from '../server/banking-agent.mjs';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { billClarificationQuestion } from '../src/lib/trueforge-routing.mjs';

// Captured from the real 0.3.1 service on 2026-10-14. Replay tests are NOT E2E tests.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/trueforge-bill-turn.json', import.meta.url)));
const env = { SAVEFLOW_ACCESS_CODE: 'trial-access-code-1234', CONTINUATION_TOKEN_SECRET: 'trial-secret-code-1234',
  SAVEFLOW_TRUEFORGE_BILL_ENABLED: 'true', TRUEFORGE_BASE_URL: 'http://localhost:8790',
  TRUEFORGE_MODEL: 'test/deepseek-v4-1-flash', TRUEFORGE_MCP_SERVER: 'sv-trial' };
const clone = () => structuredClone(fixture);
const resultOf = t => JSON.parse(t.responses[0].content);
const withResult = (r, month = '2026-08') => {
  const t = clone(); t.responses[0].content = JSON.stringify(r);
  t.calls[0].function.arguments = JSON.stringify(month === undefined ? {} : { month }); return t;
};
function missingTurn() {
  const t = withResult({ error: [{ type: 'text', text: JSON.stringify({ ok: false, kind: 'needs_clarification',
    missingSlots: ['month'], error: { code: 'MISSING_MONTH', message: 'need month' } }) }] });
  t.calls[0].function.arguments = '{}'; return t;
}
function fakeClient(turns = [clone()]) {
  const seen = [];
  return { seen, async createSession() { seen.push('create'); return 'private-session-id'; },
    async runTurn(id, message) { seen.push({ id, message }); return turns.shift() ?? clone(); },
    async cancel(id) { seen.push({ cancel: id }); } };
}
const body = message => ({ message, history: [], consent: true });
const scope = 'owner-a';
let ip = 0;
const request = (b, headers = {}) => new Request('http://localhost/api/banking-agent', { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE,
    'x-forwarded-for': `192.0.2.${++ip}`, ...headers }, body: JSON.stringify(b) });

test('captured real bill data maps to the unchanged HTTP envelope and TS browser validator', async () => {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, filename);
  const { askBankingAgent } = require('../src/lib/banking-agent-client.ts');
  const oldFetch = global.fetch;
  try {
    global.fetch = async (_url, init) => handleBankingAgent(request(JSON.parse(init.body)), {
      env, trueforgeRuntimeClient: { createSession: async () => 'runtime', cancel: async () => {}, runTurn: async () => JSON.stringify({ schemaVersion: '1.0.0', action: 'bill.summary', slots: { month: '2026-08' }, missingSlots: [], status: 'ready_for_resolution' }) },
    });
    const data = await askBankingAgent({ message: '查询 2026 年 8 月账单' }, env.SAVEFLOW_ACCESS_CODE, new AbortController().signal);
    assert.equal(data.status, 'bill_result'); assert.equal(data.data.totalIncomeFen, 1200000);
    assert.equal(data.data.totalExpenseFen, 846000); assert.equal(data.data.transactionCount, 12);
    assert.equal(typeof data.requestId, 'string'); assert.equal(data.operationId, undefined);
  } finally { global.fetch = oldFetch; }
});

test('missing month resumes the same private session, with empty choices and one turn for duplicate resumes', async () => {
  const client = fakeClient([missingTurn(), clone()]);
  const adapter = createTrueforgeBillAdapter({ env, client });
  const first = await adapter.handle(body('查账单'), { scope });
  assert.equal(first.code, 'NEEDS_CLARIFICATION'); assert.deepEqual(first.data.choices, []);
  const token = first.data.continuationToken; assert.ok(token.startsWith('tfb1.')); assert.ok(!token.includes('private-session-id'));
  const answer = { ...body('2026 年 8 月'), continuationToken: token };
  const [a, b] = await Promise.all([adapter.handle(answer, { scope }), adapter.handle(answer, { scope })]);
  assert.equal(a.data.status, 'bill_result'); assert.deepEqual(a, b);
  assert.equal(client.seen.filter(x => x === 'create').length, 1);
  assert.equal(client.seen.filter(x => x?.message && JSON.parse(x.message).userMessage === '2026 年 8 月').length, 1);
  assert.equal((await adapter.handle({ ...answer, message: '2026 年 9 月' }, { scope })).code, 'CONTINUATION_CONSUMED');
  const readOnlyClient = fakeClient([clone(), clone()]);
  const independent = createTrueforgeBillAdapter({ env, client: readOnlyClient });
  const repeated = await Promise.all([independent.handle(body('查2026年8月账单'), { scope }), independent.handle(body('查2026年8月账单'), { scope })]);
  assert.ok(repeated.every(r => r.data.status === 'bill_result' && r.data.data.transactionCount === 12 && r.data.operationId === undefined));
  assert.equal(readOnlyClient.seen.filter(x => x === 'create').length, 2);
});

test('month-only bill query starts the bill Skill and asks for a year without guessing or inheriting transfer state', async () => {
  const client = fakeClient([missingTurn(), clone()]);
  const adapter = createTrueforgeBillAdapter({ env, client });
  assert.equal(shouldRouteTrueforgeBill(body('查询8月账单'), env), true);
  const first = await adapter.handle(body('查询8月账单'), { scope });
  assert.equal(first.code, 'NEEDS_CLARIFICATION'); assert.equal(first.data.action, 'bill.summary');
  assert.equal(first.data.question, '你想查询哪一年的 8 月账单？例如 2026 年 8 月。');
  assert.deepEqual(JSON.parse(client.seen[1].message), { userMessage: '查询8月账单', toolArguments: {} });
  const next = await adapter.handle({ ...body('2026年8月'), continuationToken: first.data.continuationToken }, { scope });
  assert.equal(next.data.status, 'bill_result'); assert.equal(next.data.data.month, '2026-08');
  assert.equal(client.seen.filter(v => v === 'create').length, 1);
  const before = client.seen.length;
  assert.equal((await adapter.handle(body('查询13月账单'), { scope })).code, 'INVALID_MONTH');
  assert.equal(client.seen.length, before);
});

test('bill clarification asks only for the missing part of an incomplete period', async () => {
  const noPeriod = createTrueforgeBillAdapter({ env, client: fakeClient([missingTurn()]) });
  assert.equal((await noPeriod.handle(body('查账单'), { scope })).data.question, '请提供明确的账单年月，例如 2026 年 8 月。');

  const yearOnly = createTrueforgeBillAdapter({ env, client: fakeClient([missingTurn(), clone()]) });
  assert.equal(shouldRouteTrueforgeBill(body('查看2026年账单'), env), true);
  const first = await yearOnly.handle(body('查看2026年账单'), { scope });
  assert.equal(first.data.question, '你想查询 2026 年的哪个月账单？例如 2026 年 8 月。');
  const resolved = await yearOnly.handle({ ...body('2026年8月'), continuationToken: first.data.continuationToken }, { scope });
  assert.equal(resolved.data.status, 'bill_result');
  assert.equal(resolved.data.data.month, '2026-08');
});

test('all month-only and vague period bill requests receive a specific follow-up', async () => {
  for (let month = 1; month <= 12; month += 1) {
    assert.equal(
      billClarificationQuestion(`查看${month}月账单`),
      `你想查询哪一年的 ${month} 月账单？例如 2026 年 ${month} 月。`,
    );
  }
  assert.equal(billClarificationQuestion('查看十二月账单'), '你想查询哪一年的 12 月账单？例如 2026 年 12 月。');
  for (const message of ['查看最近的账单', '查询近期账单', '看前段时间账单', '查看今年账单', '查看去年账单', '查看最近3个月账单']) {
    assert.ok(shouldRouteTrueforgeBill(body(message), env), message);
    assert.equal(billClarificationQuestion(message), '请提供明确的账单年月，例如 2026 年 8 月。');
  }
});

test('unlisted fuzzy time wording clarifies instead of falling through or guessing', async () => {
  for (const message of ['查看上个月账单', '看假期期间的账单', '我想看看那段时间的账单', '查询年初账单']) {
    assert.ok(shouldRouteTrueforgeBill(body(message), env), message);
    const adapter = createTrueforgeBillAdapter({ env, client: fakeClient([missingTurn()]) });
    const result = await adapter.handle(body(message), { scope });
    assert.equal(result.code, 'NEEDS_CLARIFICATION');
    assert.equal(result.data.question, '请提供明确的账单年月，例如 2026 年 8 月。');
    assert.equal(result.data.status, 'needs_clarification');
    assert.equal(result.data.data, undefined);
  }
});

test('signed tokens reject tampering, raw session IDs, other scopes, restart, and expiry', async () => {
  let clock = 1000;
  const client = fakeClient([missingTurn()]);
  const adapter = createTrueforgeBillAdapter({ env, client, now: () => clock });
  const first = await adapter.handle(body('查账单'), { scope }); const token = first.data.continuationToken;
  for (const [tok, owner] of [[token.slice(0, -1) + '!', scope], ['private-session-id', scope], [token, 'owner-b']]) {
    assert.equal((await adapter.handle({ ...body('2026 年 8 月'), continuationToken: tok }, { scope: owner })).code, 'CONTINUATION_INVALID');
  }
  const restarted = createTrueforgeBillAdapter({ env, client });
  assert.equal((await restarted.handle({ ...body('2026 年 8 月'), continuationToken: token }, { scope })).code, 'CONTINUATION_INVALID');
  clock += 300000;
  assert.equal((await adapter.handle({ ...body('2026 年 8 月'), continuationToken: token }, { scope })).code, 'CONTINUATION_INVALID');
  assert.equal(client.seen.filter(x => x?.message).length, 1);
});

test('zero transactions retain actual zero values and empty evidence IDs', async () => {
  const r = resultOf(clone()); r.data = { month: '2026-01', totalIncomeFen: 0, totalExpenseFen: 0, transactionCount: 0, categoryTotals: {} }; r.evidence[0].entityIds = [];
  const adapter = createTrueforgeBillAdapter({ env, client: fakeClient([withResult(r, '2026-01')]) });
  const reply = await adapter.handle(body('查2026年1月账单'), { scope });
  assert.equal(reply.code, 'OK'); assert.equal(reply.data.data.transactionCount, 0); assert.deepEqual(reply.data.evidence[0].entityIds, []);
});

test('MCP error wrapper returns a safe explicit error without model text or card data', async () => {
  const failed = withResult({ error: [{ type: 'text', text: JSON.stringify({ ok: false, kind: 'business_error', error: { code: 'BILL_SUMMARY_FAILED', message: 'secret http://internal/' } }) }] });
  const adapter = createTrueforgeBillAdapter({ env, client: fakeClient([failed]) });
  const reply = await adapter.handle(body('查2026年8月账单'), { scope });
  assert.equal(reply.code, 'BILL_SUMMARY_FAILED'); assert.equal(reply.data.status, 'error');
  assert.equal(reply.data.data, undefined); assert.ok(!JSON.stringify(reply).includes('internal'));
});

test('malformed, unlinked, wrong-month, forged-source and duplicate results cannot form business cards', () => {
  const mutations = [t => t.calls[0].toolInfo.name = 'action.execute', t => t.calls[0].toolInfo.serverName = 'other',
    t => t.responses[0].toolCallId = 'other', t => t.responses[0].threadId = 'other',
    t => t.calls[0].function.arguments = '{"month":"2026-09"}', t => t.calls[0].function.arguments = '{"month":"2026-08","userId":"other"}',
    t => t.responses[0].content = '收入 12000 元', t => t.responses.push(t.responses[0]), t => t.calls.push(t.calls[0]),
    t => t.responses = [], t => t.calls = []];
  for (const mutate of mutations) { const t = clone(); mutate(t); assert.throws(() => validateBillToolResult(t, { serverName: 'sv-trial', expectedMonth: '2026-08' }), { code: 'TRUEFORGE_FORMAT_ERROR' }); }
  for (const mutate of [r => r.data.month = '2026-09', r => r.data.totalIncomeFen = 12000.1, r => r.data.totalExpenseFen = -1,
    r => r.data.transactionCount = 11, r => r.evidence[0].source = 'production', r => r.evidence[0].asOf = 'bad-date',
    r => r.evidence[0].entityIds[1] = r.evidence[0].entityIds[0], r => r.data.categoryTotals['房租'] = 0,
    r => r.data.totalIncomeFen = Number.MAX_SAFE_INTEGER + 1]) {
    const r = resultOf(clone()); mutate(r);
    assert.throws(() => validateBillToolResult(withResult(r), { serverName: 'sv-trial', expectedMonth: '2026-08' }), { code: 'TRUEFORGE_FORMAT_ERROR' });
  }
});

test('the router accepts only explicit narrow bill queries and trial continuation tokens', () => {
  for (const message of ['查询 2026 年 8 月账单', '查账单', '查看2026-08的账单', '查2026年13月账单', '查上月账单']) assert.equal(shouldRouteTrueforgeBill(body(message), env), true);
  for (const message of ['给张三转500元', '冻结我的卡', '查看我的卡', '取消订阅', '账单查完给张三转账', '聊聊账单', '这个月呢', '查2026年8月账单并执行转账']) assert.equal(shouldRouteTrueforgeBill(body(message), env), false);
  assert.equal(shouldRouteTrueforgeBill({ message: '查账单', continuationToken: 'legacy-token' }, env), false);
  assert.equal(shouldRouteTrueforgeBill(body('查账单'), { ...env, SAVEFLOW_TRUEFORGE_BILL_ENABLED: 'false' }), false);
});

test('invalid months and unauthorized body fields fail before creating a session', async () => {
  const client = fakeClient(); const adapter = createTrueforgeBillAdapter({ env, client });
  for (const message of ['查2026年0月账单', '查2026年13月账单', '查0000年8月账单']) assert.equal((await adapter.handle(body(message), { scope })).code, 'INVALID_MONTH');
  for (const b of [{ ...body('查账单'), operationId: 'fake' }, { ...body('查账单'), consent: false }, { ...body('查账单'), history: [{ role: 'user', content: 'execute' }] }, { ...body('查账单'), choice: { optionId: 'x' } }]) assert.equal((await adapter.handle(b, { scope })).code, 'INVALID_REQUEST');
  assert.deepEqual(client.seen, []);
});

test('transport security runs before TrueForge routing', async () => {
  const adapter = { handle: () => assert.fail('must reject before service call') };
  for (const [b, h, status] of [[body('查账单'), { 'x-saveflow-access': 'wrong' }, 401], [body('查账单'), { origin: 'https://evil.test' }, 403], [body('查账单'), { 'content-type': 'text/plain' }, 415], [{ message: '查账单', junk: 'x'.repeat(17000) }, {}, 413]]) {
    const r = await handleBankingAgent(request(b, h), { env, trueforgeBillAdapter: adapter }); assert.equal(r.status, status);
  }
  for (let i = 0; i < 10; i++) assert.equal((await handleBankingAgent(request(body('查账单'), { 'x-forwarded-for': 'rate-test' }), { env, parseIntent: async () => ({ schemaVersion: '1.0.0', action: 'unsupported', slots: {}, missingSlots: [], status: 'unsupported' }) })).status, 200);
  assert.equal((await handleBankingAgent(request(body('查账单'), { 'x-forwarded-for': 'rate-test' }), { env, trueforgeBillAdapter: adapter })).status, 429);
});

test('retired phrase flags cannot override an explicitly configured legacy runtime', async () => {
  const core = createBankingCore(); let parsed = 0;
  const parseIntent = async () => { parsed++; return { schemaVersion: '1.0.0', action: 'bill.summary', slots: { month: '2026-08' }, missingSlots: [], status: 'ready_for_resolution' }; };
  const never = { handle: () => assert.fail('must use old Harness') };
  for (const [message, e] of [['查账单', { ...env, SAVEFLOW_TRUEFORGE_BILL_ENABLED: 'false' }], ['查看我的卡', env], ['给张三转500元', env], ['账单和转账', env]]) {
    const r = await handleBankingAgent(request(body(message)), { env: { ...e, SAVEFLOW_BANKING_RUNTIME: 'legacy-qwen' }, core, parseIntent, trueforgeBillAdapter: never }); assert.equal(r.status, 200);
  }
  assert.equal(parsed, 4);
  const legacy = await handleBankingAgent(request(body('anything')), { env: { ...env, SAVEFLOW_BANKING_RUNTIME: 'legacy-qwen' }, core, parseIntent: async () => ({ schemaVersion: '1.0.0', action: 'bill.summary', slots: {}, missingSlots: ['month'], status: 'needs_clarification' }), trueforgeBillAdapter: never });
  const token = (await legacy.json()).data.continuationToken;
  const resumed = await handleBankingAgent(request({ ...body('2026 年 8 月'), continuationToken: token }), { env: { ...env, SAVEFLOW_BANKING_RUNTIME: 'legacy-qwen' }, core, trueforgeBillAdapter: never }); assert.equal(resumed.status, 200);
});

test('retired bill pilot tokens cannot cross the unified Banking boundary', async () => {
  const adapter = createTrueforgeBillAdapter({ env, client: fakeClient([missingTurn()]) });
  const first = await adapter.handle(body('查账单'), { scope });
  const token = first.data.continuationToken;
  for (const message of ['冻结娱乐虚拟卡', '2026年8月']) {
    const response = await handleBankingAgent(request({ ...body(message), continuationToken: token }), {
      env, parseIntent: () => assert.fail('retired token reached parser'), trueforgeBillAdapter: adapter,
    });
    assert.equal(response.status, 400); assert.equal((await response.json()).code, 'CONTINUATION_INVALID');
  }
});

test('service failure, network failure, timeout, and client abort finish without a fallback', async () => {
  for (const failure of ['network', 'timeout', 'abort']) {
    const client = fakeClient();
    client.runTurn = async (_id, _msg, signal) => {
      if (failure === 'network') throw new Error('ECONNREFUSED http://private/?secret=abc');
      return await new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const adapter = createTrueforgeBillAdapter({ env, client, timeoutMs: 30 });
    const controller = new AbortController(); if (failure === 'abort') setTimeout(() => controller.abort(), 5);
    const r = await adapter.handle(body('查2026年8月账单'), { scope, signal: controller.signal });
    assert.equal(r.httpStatus, failure === 'network' ? 502 : 504); assert.ok(!JSON.stringify(r).includes('secret=abc'));
    assert.equal(client.seen.at(-1).cancel, 'private-session-id');
  }
});

function sdkWithEvents(events, mutateSpec = () => {}) {
  const spec = billAgentSpec(env); mutateSpec(spec);
  const session = { id: 's1', shared: false, agent: { spec } };
  let posts = 0;
  return { get posts() { return posts; }, sessions: {
    create: async () => ({ data: structuredClone(session) }), get: async () => ({ data: structuredClone(session) }),
    createTurnStream: async () => { posts++; return { withMetadata: async function* () { for (const data of structuredClone(events)) yield { data }; } }; }, cancel: async () => {},
  } };
}

test('SDK deltas merge into tool calls and only terminal done without required actions succeeds', async () => {
  const call = clone().calls[0];
  const events = [{ type: 'turn.created', id: 'start', turnId: 't1' }, { type: 'model.message', id: 'msg', threadId: 'main', toolCalls: [] },
    { type: 'model.message.delta', id: 'msg', threadId: 'main', toolCalls: [{ index: 0, ...call, function: { name: 'bill_summary', arguments: '{"month":' } }] },
    { type: 'model.message.delta', id: 'msg', threadId: 'main', toolCalls: [{ index: 0, function: { arguments: '"2026-08"}' } }] },
    clone().responses[0], { type: 'turn.done', id: 'done', state: { status: 'done', requiredActions: [] } }];
  const sdk = sdkWithEvents(events); const c = createTrueforgeClient({ env, sdk });
  const t = await c.runTurn(await c.createSession(), 'bill'); assert.equal(validateBillToolResult(t, { serverName: 'sv-trial', expectedMonth: '2026-08' }).data.transactionCount, 12);
  for (const state of [{ status: 'error' }, { status: 'cancelled' }, { status: 'running' }, { status: 'done', requiredActions: [{ type: 'tool.approval_required' }] }]) {
    const copy = structuredClone(events); copy.at(-1).state = state;
    await assert.rejects(createTrueforgeClient({ env, sdk: sdkWithEvents(copy) }).runTurn('s1', 'bill'), { code: 'TRUEFORGE_TURN_FAILED' });
  }
  await assert.rejects(createTrueforgeClient({ env, sdk: sdkWithEvents(events.slice(0, -1)) }).runTurn('s1', 'bill'), { code: 'TRUEFORGE_TURN_FAILED' });
});

test('Agent exposes only bill_summary and refuses broader permissions before posting any turn', async () => {
  const spec = billAgentSpec(env); assert.deepEqual(spec.mcpServers[0].enableTools, ['bill_summary']); assert.deepEqual(spec.skills, []);
  for (const mutate of [s => s.mcpServers[0].enableTools = ['@all'], s => s.config.sandbox.enabled = true, s => s.config.dynamicSubAgents.enabled = true]) {
    const sdk = sdkWithEvents([], mutate); const c = createTrueforgeClient({ env, sdk });
    await assert.rejects(c.createSession(), { code: 'TRUEFORGE_AGENT_POLICY_ERROR' }); assert.equal(sdk.posts, 0);
  }
});

test('real SDK HTTP failures are not retried or leaked, and disabled pilot tokens are rejected', async () => {
  let requests = 0;
  const service = createTrueforgeClient({ env, fetchImpl: async () => { requests++; return Response.json({ error: { message: 'secret' } }, { status: 503 }); } });
  const adapter = createTrueforgeBillAdapter({ env, client: service });
  const r = await adapter.handle(body('查账单'), { scope }); assert.equal(r.code, 'TRUEFORGE_UNAVAILABLE'); assert.equal(requests, 1); assert.ok(!r.message.includes('secret'));
  const response = await handleBankingAgent(request({ ...body('2026 年 8 月'), continuationToken: 'tfb1.forged' }), {
    env: { ...env, SAVEFLOW_TRUEFORGE_BILL_ENABLED: 'false' }, parseIntent: () => assert.fail('reject trial token'),
  }); assert.equal(response.status, 400);
});

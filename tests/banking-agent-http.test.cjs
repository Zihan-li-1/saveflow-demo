/* eslint-disable @typescript-eslint/no-require-imports -- CJS test loads the ESM server module. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBankingCore } = require('../src/banking-core/core.mjs');
const { handleBankingAgent } = require('../server/banking-agent.mjs');

const env = { SAVEFLOW_ACCESS_CODE: 'test-access-code-1234', CONTINUATION_TOKEN_SECRET: 'test-continuation-secret-1234', DASHSCOPE_API_KEY: 'fake-key' };
const request = (body, headers = {}) => new Request('http://localhost/api/banking-agent', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, ...headers },
  body: JSON.stringify(body),
});
const transferIntent = payee => ({
  schemaVersion: '1.0.0', action: 'transfer.create',
  slots: { payee_ref: payee, amount: { amount_minor: 50000, currency: 'CNY' }, source_account_ref: '活期账户' },
  missingSlots: [], status: 'ready_for_resolution',
});
const billIntent = { schemaVersion: '1.0.0', action: 'bill.summary', slots: { month: '2026-08' }, missingSlots: [], status: 'ready_for_resolution' };
const parse = message => message === 'bill' ? billIntent : transferIntent(message === 'ambiguous' ? '王先生' : '张三');
const read = response => response.json();
const fakeQwen = resolve => async (_url, options) => {
  const payload = JSON.parse(options.body);
  const message = payload.messages.at(-1).content;
  const output = resolve(message);
  return Response.json({
    choices: [{ finish_reason: 'stop', message: { content: typeof output === 'string' ? output : JSON.stringify(output) } }],
  });
};

test('banking-agent returns real bill statistics and evidence', async () => {
  const result = await handleBankingAgent(request({ message: 'bill', history: [] }), { env, fetchImpl: fakeQwen(parse), now: () => 1 });
  const body = await read(result);
  assert.equal(result.status, 200);
  assert.equal(body.code, 'OK');
  assert.equal(body.data.status, 'bill_result');
  assert.equal(body.data.data.transactionCount, 12);
  assert.equal(body.data.evidence[0].source, 'synthetic_demo_only');
  assert.equal(body.data.evidence[0].entityIds.length, 12);
});

test('banking-agent returns Core formal preview without decide or execute', async () => {
  const core = createBankingCore();
  let decide = 0; let execute = 0;
  const wrapped = { ...core, prepare: core.prepare.bind(core), decide: () => { decide++; }, execute: () => { execute++; } };
  const before = core.repository.getAccount('ACC-CHECKING').availableBalanceFen;
  const count = core.repository.getTransactions().length;
  const result = await handleBankingAgent(request({ message: 'transfer', history: [] }), { env, core: wrapped, fetchImpl: fakeQwen(parse), now: () => 2 });
  const body = await read(result);
  assert.equal(result.status, 200);
  assert.equal(body.data.status, 'awaiting_confirmation');
  assert.match(body.data.operationId, /^op_/);
  assert.equal(body.data.preview.exactEffects[0].amountFen, 50000);
  assert.equal(body.data.risk.riskLevel, 'L3');
  assert.equal(decide, 0); assert.equal(execute, 0);
  assert.equal(core.repository.getAccount('ACC-CHECKING').availableBalanceFen, before);
  assert.equal(core.repository.getTransactions().length, count);
});

test('banking-agent returns resolver clarification without preparing Core', async () => {
  let prepares = 0;
  const core = createBankingCore();
  const wrapped = { ...core, prepare: async input => { prepares++; return core.prepare(input); } };
  const result = await handleBankingAgent(request({ message: 'ambiguous', history: [] }), { env, core: wrapped, fetchImpl: fakeQwen(parse), now: () => 3 });
  const body = await read(result);
  assert.equal(result.status, 200);
  assert.equal(body.code, 'NEEDS_CLARIFICATION');
  assert.equal(body.data.status, 'needs_clarification');
  assert.equal(body.data.source, 'resolver');
  assert.equal(prepares, 0);
});

test('banking-agent rejects illegal model output and request execution fields', async () => {
  const illegal = { ...transferIntent('张三'), confirmed: true };
  const modelResult = await handleBankingAgent(request({ message: 'illegal', history: [] }), { env, fetchImpl: fakeQwen(() => illegal), now: () => 4 });
  const modelBody = await read(modelResult);
  assert.equal(modelResult.status, 502);
  assert.equal(modelBody.code, 'MODEL_FORMAT_ERROR');
  const requestResult = await handleBankingAgent(request({ message: 'transfer', operationId: 'op_fake', confirmed: true, riskLevel: 'L0' }), { env, parseIntent: async message => parse(message), now: () => 5 });
  assert.equal(requestResult.status, 400);
  assert.equal((await read(requestResult)).code, 'INVALID_REQUEST');
});

test('banking-agent maps model timeout without leaking provider credentials', async () => {
  const result = await handleBankingAgent(request({ message: 'timeout', history: [] }), { env, fetchImpl: async () => { const error = new Error('provider detail'); error.name = 'AbortError'; throw error; }, now: () => 6 });
  const body = await read(result);
  assert.equal(result.status, 504);
  assert.equal(body.code, 'MODEL_TIMEOUT');
  assert.equal(JSON.stringify(body).includes(env.DASHSCOPE_API_KEY), false);
  assert.equal(JSON.stringify(body).includes('provider detail'), false);
});

test('banking-agent maps Skill errors explicitly', async () => {
  const repository = {
    getPayees: () => { throw new Error('resolver unavailable'); },
    getAccounts: () => [],
  };
  const result = await handleBankingAgent(request({ message: 'transfer', history: [] }), { env, repository, fetchImpl: fakeQwen(parse), now: () => 7 });
  const body = await read(result);
  assert.equal(result.status, 502);
  assert.equal(body.code, 'SKILL_ERROR');
  assert.equal(body.data.status, 'error');
});

test('old /api/agent handler remains available', async () => {
  const { handleAgent } = await import('../server/qwen.mjs');
  assert.equal(typeof handleAgent, 'function');
});

test('banking-agent enforces access code, same-origin, body size, and rate limit', async () => {
  const unauthorized = await handleBankingAgent(request({ message: 'bill' }, { 'x-saveflow-access': 'wrong' }), { env, fetchImpl: fakeQwen(parse), now: () => 10 });
  assert.equal(unauthorized.status, 401);
  const crossOrigin = await handleBankingAgent(request({ message: 'bill' }, { origin: 'https://evil.example' }), { env, fetchImpl: fakeQwen(parse), now: () => 11 });
  assert.equal(crossOrigin.status, 403);

  const oversized = new Request('http://localhost/api/banking-agent', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'x-forwarded-for': 'size-test' },
    body: JSON.stringify({ message: 'bill', padding: 'x'.repeat(17000) }),
  });
  const tooLarge = await handleBankingAgent(oversized, { env, fetchImpl: fakeQwen(parse), now: () => 12 });
  assert.equal(tooLarge.status, 413);

  let limited;
  for (let index = 0; index < 11; index++) {
    limited = await handleBankingAgent(request({ message: 'unsupported' }, { 'x-forwarded-for': 'rate-test' }), {
      env, parseIntent: async () => ({ schemaVersion: '1.0.0', action: 'unsupported', slots: {}, missingSlots: [], status: 'unsupported' }), now: () => 20,
    });
  }
  assert.equal(limited.status, 429);
  assert.equal((await read(limited)).code, 'RATE_LIMIT');
});

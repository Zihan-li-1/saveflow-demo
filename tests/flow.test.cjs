/* eslint-disable @typescript-eslint/no-require-imports -- CJS loader compiles the actual TS modules without a new test dependency. */
const { readFileSync } = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  });
  module._compile(outputText, filename);
};
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { transition, canTransition } = require('../src/lib/flow-machine.ts');
const { mockRequest } = require('../src/lib/api/mock.ts');
const { validatePlan } = require('../src/lib/api/contracts.ts');

const plan = { monthlySavingFen: 250000, saveRateBps: 1000, confirmed: true };
test('model answers and clarification permit follow-up but never direct execution', () => {
  for (const event of ['CLARIFY', 'ANSWER']) {
    const stage = transition('analyzing', event);
    assert.equal(canTransition(stage, 'CONFIRM'), false);
    assert.equal(transition(stage, 'START'), 'analyzing');
    assert.equal(transition(stage, 'RESET'), 'welcome');
  }
});
test('confirmation cannot skip analysis or draft review; double submit is blocked', () => {
  let stage = 'welcome';
  assert.equal(transition(stage, 'CONFIRM'), 'welcome');
  for (const event of ['START', 'ANALYZED', 'EDIT', 'SAVE', 'CONFIRM']) stage = transition(stage, event);
  assert.equal(stage, 'executing');
  for (const event of ['CONFIRM', 'START', 'CANCEL', 'RESET']) assert.equal(canTransition(stage, event), false);
  assert.equal(transition(stage, 'SUCCEEDED'), 'success');
});
test('uncertain operation must be queried, never replayed or reset', () => {
  const stage = transition('executing', 'UNCERTAIN');
  for (const event of ['CONFIRM', 'START', 'EDIT', 'RESET', 'CANCEL']) assert.equal(canTransition(stage, event), false);
  assert.equal(transition(transition(stage, 'CHECK'), 'SUCCEEDED'), 'success');
  assert.equal(transition('checking', 'UNCERTAIN'), 'unknown');
});
test('invalid amounts, fractional cents and invalid rates are rejected', () => {
  for (const amount of [0, -1, NaN, Infinity, 0.5, 300001]) assert.ok(validatePlan({ ...plan, monthlySavingFen: amount }));
  for (const rate of [-1, 10001, NaN, 1.5]) assert.ok(validatePlan({ ...plan, saveRateBps: rate }));
  assert.equal(validatePlan({ ...plan, monthlySavingFen: 1, saveRateBps: 0 }), null);
});
test('same operation replays its receipt; modified payload conflicts', () => {
  const first = mockRequest('create-plan', plan, 'plan-1');
  assert.deepEqual(mockRequest('create-plan', { confirmed: true, saveRateBps: 1000, monthlySavingFen: 250000 }, 'plan-1'), first);
  assert.throws(() => mockRequest('create-plan', { ...plan, monthlySavingFen: 200000 }, 'plan-1'), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(mockRequest('operation-status', { operationId: 'plan-1' }, ''), first);
});
test('operation status keeps an unknown operation pending until a backend receipt exists', () => {
  assert.equal(mockRequest('operation-status', { operationId: 'missing' }, '').status, 'pending');
});
test('consent, confirmation, action whitelist and risk rejection are enforced', () => {
  assert.throws(() => mockRequest('analyze', { goal: 'goal', consent: false }, ''), { code: 'VALIDATION_ERROR' });
  assert.throws(() => mockRequest('create-plan', { ...plan, confirmed: false }, 'no-confirm'), { code: 'CONFIRMATION_REQUIRED' });
  assert.throws(() => mockRequest('unknown', {}, 'unknown'), { code: 'UNKNOWN_ACTION' });
  assert.equal(mockRequest('analyze', { goal: 'goal', consent: true }, '').totalExpenseFen > 0, true);
});

process.env.NEXT_PUBLIC_SAVEFLOW_API_MODE = 'http';
process.env.NEXT_PUBLIC_SAVEFLOW_API_BASE_URL = 'https://sandbox.example.com';
process.env.NEXT_PUBLIC_SAVEFLOW_API_TIMEOUT_MS = '500';
const { request } = require('../src/lib/api/client.ts');
test('HTTP: validates response, sends idempotency key, rejects mismatched receipts, never retries writes', async () => {
  const original = global.fetch;
  let count = 0;
  try {
    global.fetch = async (url, init) => {
      count++;
      assert.equal(url, 'https://sandbox.example.com/api/saveflow');
      assert.equal(init.headers['Idempotency-Key'], 'http-1');
      assert.equal(init.credentials, 'include');
      return Response.json({ code: 'OK', requestId: 'r1', data: { operationId: 'other', status: 'succeeded', message: 'ok' } });
    };
    await assert.rejects(request('create-plan', plan, { operationId: 'http-1' }), { code: 'INVALID_RESPONSE', uncertain: true });
    assert.equal(count, 1);
    global.fetch = async () => { throw new Error('network'); };
    await assert.rejects(request('create-plan', plan, { operationId: 'http-2' }), { code: 'NETWORK_ERROR', uncertain: true });
    await assert.rejects(request('analyze', { goal: 'goal', consent: true }), { code: 'NETWORK_ERROR', uncertain: false });
    global.fetch = async () => Response.json({ code: 'UNAUTHORIZED', requestId: 'r2' }, { status: 401 });
    await assert.rejects(request('create-plan', plan), { code: 'UNAUTHORIZED', uncertain: false });
    global.fetch = async () => Response.json({ code: 'OK', requestId: 'r3', data: { totalExpenseFen: -1, subscriptionCount: 3 } });
    await assert.rejects(request('analyze', { goal: 'goal', consent: true }), { code: 'INVALID_RESPONSE' });
    global.fetch = async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    await assert.rejects(request('create-plan', plan), { code: 'TIMEOUT', uncertain: true });
  } finally { global.fetch = original; }
});

/* eslint-disable @typescript-eslint/no-require-imports -- Test actual TS clients without a build-time runtime dependency. */
const { readFileSync } = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename);
};
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBankingClient } = require('../src/lib/api/banking-client.ts');
const env = { SAVEFLOW_ACCESS_CODE: 'banking-test-access-1234' };
const input = { fromAccountId: 'ACC-CHECKING', payeeId: 'payee_001', amountFen: 50000, currency: 'CNY' };
const url = 'https://demo.example/api/banking';
function req(action, input, extra = {}) {
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Saveflow-Access': env.SAVEFLOW_ACCESS_CODE, Origin: 'https://demo.example', ...extra }, body: JSON.stringify({ schema_version: '1.1.0', action, input }) });
}
async function setup() {
  const { handleBanking } = await import('../server/banking.mjs');
  const { createBankingCore } = await import('../src/banking-core/core.mjs');
  const core = createBankingCore();
  const fetchImpl = async (url, init) => handleBanking(new Request(url, init), { core, env });
  const client = createBankingClient({ mode: 'http', baseUrl: 'https://demo.example', accessCode: () => env.SAVEFLOW_ACCESS_CODE, fetchImpl });
  return { handleBanking, core, client, fetchImpl };
}
async function confirmed(client) {
  const p = await client.request('transfer.prepare', input);
  await client.request('action.decide', { operationId: p.operationId, previewHash: p.preview.previewHash, decision: 'confirm', confirmedStepIds: p.preview.stepIds });
  return p;
}

test('B HTTP: real handler and typed client run reads, preview, confirmation, execution and lookup', async () => {
  const { client, core } = await setup();
  for (const action of ['account.list', 'payee.list', 'transaction.list', 'product.list', 'card.list', 'subscription.list']) assert.ok((await client.request(action, {})).length > 0);
  assert.equal((await client.request('context.get', {})).currentMonth, '2026-08');
  const p = await confirmed(client);
  assert.equal(core.repository.getAccount(input.fromAccountId).balanceFen, 500000);
  const executeInput = { operationId: p.operationId, previewHash: p.preview.previewHash };
  const receipt = await client.request('action.execute', executeInput);
  assert.equal(receipt.status, 'succeeded');
  assert.deepEqual(await client.request('action.execute', executeInput), receipt);
  assert.deepEqual((await client.request('action.status', { operationId: p.operationId })).receipt, receipt);
  assert.equal(core.repository.getAccount(input.fromAccountId).balanceFen, 450000);
});

test('B HTTP: lost execute response is uncertain, no retry; original ID lookup recovers single debit', async () => {
  const { client, core, fetchImpl } = await setup(); const p = await confirmed(client);
  let calls = 0;
  const broken = createBankingClient({ mode: 'http', baseUrl: 'https://demo.example', accessCode: () => env.SAVEFLOW_ACCESS_CODE, fetchImpl: async (...args) => { calls++; await fetchImpl(...args); throw new Error('response lost'); } });
  await assert.rejects(broken.request('action.execute', { operationId: p.operationId, previewHash: p.preview.previewHash }), { uncertain: true, code: 'NETWORK_ERROR' });
  assert.equal(calls, 1);
  assert.equal((await client.request('action.status', { operationId: p.operationId })).status, 'succeeded');
  assert.equal(core.repository.getAccount(input.fromAccountId).balanceFen, 450000);
  assert.equal((await client.request('action.status', { operationId: 'missing_key' })).status, 'pending');
});

test('B HTTP: auth, origin, schema, action allowlist and idempotency header enforced', async () => {
  const { handleBanking, core } = await setup(); const options = { env, core };
  assert.equal((await handleBanking(req('account.list', {}, { 'X-Saveflow-Access': 'bad' }), options)).status, 401);
  assert.equal((await handleBanking(req('account.list', {}, { Origin: 'https://evil.example' }), options)).status, 403);
  assert.equal((await handleBanking(req('account.list', {}), { core, env: {} })).status, 503);
  for (const [action, body] of [['unknown', {}], ['account.list', { user_id: 'another_user' }], ['transfer.prepare', { ...input, confirmed: true }], ['transaction.list', { month: '2026-99' }], ['action.execute', { operation_id: 'missing', preview_hash: 'bad' }]]) {
    const response = await handleBanking(req(action, body), options);
    assert.ok(response.status >= 400);
    const payload = await response.json(); assert.equal(payload.schema_version, '1.1.0'); assert.ok(payload.request_id);
  }
  const big = await handleBanking(req('account.list', { text: 'x'.repeat(17000) }), options);
  assert.equal(big.status, 400);
  assert.equal(core.repository.getAccount(input.fromAccountId).balanceFen, 500000);
});

test('B HTTP: payload cannot change approved amount during execution', async () => {
  const { handleBanking, client, core } = await setup(); const p = await confirmed(client);
  const response = await handleBanking(req('action.execute', { operation_id: p.operationId, preview_hash: p.preview.previewHash, amount_minor: 1 }, { 'Idempotency-Key': p.operationId }), { env, core });
  assert.equal(response.status, 400); assert.equal((await response.json()).code, 'VALIDATION_ERROR');
  assert.equal(core.repository.getAccount(input.fromAccountId).balanceFen, 500000);
});

test('B HTTP: client rejects forged receipts, nonterminal success, altered previews and mismatched IDs', async () => {
  const { client, fetchImpl } = await setup(); const p = await confirmed(client);
  for (const mutate of [d => { d.operation_id = 'other'; }, d => { d.effects = []; }, d => { d.status = 'pending'; }]) {
    const fake = createBankingClient({ mode: 'http', baseUrl: 'https://demo.example', accessCode: () => env.SAVEFLOW_ACCESS_CODE, fetchImpl: async (...args) => { const response = await fetchImpl(...args); const body = await response.json(); mutate(body.data); return Response.json(body); } });
    await assert.rejects(fake.request('action.execute', { operationId: p.operationId, previewHash: p.preview.previewHash }), { code: 'INVALID_RESPONSE', uncertain: true });
  }
  const fakePreview = createBankingClient({ mode: 'http', baseUrl: 'https://demo.example', accessCode: () => env.SAVEFLOW_ACCESS_CODE, fetchImpl: async (...args) => { const body = await (await fetchImpl(...args)).json(); body.data.preview.exact_effects[0].payee_id = 'other'; return Response.json(body); } });
  await assert.rejects(fakePreview.request('transfer.prepare', input), { code: 'INVALID_RESPONSE', uncertain: false });
});

test('B HTTP: client timeout does not retry writes; legacy HTTP shares the Core receipt store', async () => {
  let calls = 0;
  const client = createBankingClient({ mode: 'http', baseUrl: 'https://demo.example', timeoutMs: 20, fetchImpl: async (_, init) => { calls++; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('timeout')))); } });
  await assert.rejects(client.request('action.execute', { operationId: 'op_test', previewHash: 'hash' }), { code: 'TIMEOUT', uncertain: true });
  assert.equal(calls, 1);
  const { handleBanking, core } = await setup();
  const response = await handleBanking(new Request('https://demo.example/api/saveflow', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Saveflow-Access': env.SAVEFLOW_ACCESS_CODE, 'Idempotency-Key': 'legacy_http' }, body: JSON.stringify({ action: 'create-plan', confirmed: true, monthlySavingFen: 250000, saveRateBps: 500 }) }), { env, core });
  assert.equal(response.status, 200);
  const payload = await response.json(); assert.equal(payload.data.status, 'succeeded');
  assert.equal(core.getOperation('legacy_http').data.receipt.action, 'legacy.create-plan');
  assert.equal(core.repository.getAccount(input.fromAccountId).balanceFen, 500000);
});

test('B browser Mock client uses the same validated dispatch path', async () => {
  const client = createBankingClient({ mode: 'mock' });
  const p = await confirmed(client);
  const receipt = await client.request('action.execute', { operationId: p.operationId, previewHash: p.preview.previewHash });
  assert.equal(receipt.status, 'succeeded');
});

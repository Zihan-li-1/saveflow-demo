/* eslint-disable @typescript-eslint/no-require-imports -- CJS test calls the server ESM entry. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { createBankingCore } = require('../src/banking-core/core.mjs');
const { handleBankingAgent } = require('../server/banking-agent.mjs');

const env = { SAVEFLOW_ACCESS_CODE: 'integration-access-code-1234', CONTINUATION_TOKEN_SECRET: 'integration-continuation-secret-1234' };
let ip = 0;
const request = body => new Request('http://localhost/api/banking-agent', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'x-forwarded-for': `integration-${++ip}` }, body: JSON.stringify(body),
});
const parse = message => ({
  schemaVersion: '1.0.0', action: 'transfer.create',
  slots: { payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' }, ...(message.includes('账户') ? { source_account_ref: '活期账户' } : {}) },
  missingSlots: message.includes('账户') ? [] : ['source_account_ref'], status: message.includes('账户') ? 'ready_for_resolution' : 'needs_clarification',
});

async function worker(t, adapter) {
  const child = fork(path.join(__dirname, 'fixtures/banking-agent/http-worker.mjs'), adapter === 'netlify' ? ['--netlify'] : [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => child.kill());
  const [{ port, pid }] = await once(child, 'message');
  return { url: `http://127.0.0.1:${port}`, pid };
}

for (const adapter of ['local', 'netlify']) test(`real HTTP / ${adapter}: independent processes continue account, payee, bill and edit flows`, async t => {
  const a = await worker(t, adapter), b = await worker(t, adapter);
  assert.notEqual(a.pid, b.pid);
  const before = await (await fetch(`${b.url}/test-state`)).json();
  const post = async (host, body, headers = {}) => {
    const response = await fetch(`${host.url}/api/banking-agent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'x-forwarded-for': `http-${++ip}`, origin: host.url, ...headers }, body: JSON.stringify(body) });
    const payload = await response.json();
    assert.ok(payload.requestId);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(!JSON.stringify(payload).includes('test-only-provider-secret'));
    t.diagnostic(JSON.stringify({ adapter, pid: host.pid, input: body.message || (body.choice ? 'choice.optionId' : 'invalid'), http: response.status, code: payload.code, status: payload.data?.status, requestId: payload.requestId }));
    return payload;
  };
  const first = await post(a, { message: '给张三转 500 元' });
  assert.equal(first.data.slot, 'source_account_ref');
  assert.ok(first.data.choices.every(c => Object.keys(c).sort().join(',') === 'label,optionId'));
  const preview = await post(b, { continuationToken: first.data.continuationToken, choice: { optionId: first.data.choices[0].optionId } });
  assert.equal(preview.data.preview.exactEffects[0].amountFen, 50000);
  const edited = await post(a, { continuationToken: preview.data.continuationToken, message: '改成 600 元' });
  assert.equal(edited.data.preview.exactEffects[0].amountFen, 60000);
  assert.notEqual(edited.data.operationId, preview.data.operationId);
  const payees = await post(b, { continuationToken: edited.data.continuationToken, message: '改给王先生' });
  assert.equal(payees.data.choices.length, 2);
  assert.notEqual(payees.data.choices[0].label, payees.data.choices[1].label);
  const changed = await post(a, { continuationToken: payees.data.continuationToken, choice: { optionId: payees.data.choices[1].optionId } });
  assert.equal(changed.data.preview.exactEffects[0].payeeId, 'payee_004');
  assert.equal(changed.data.preview.exactEffects[0].amountFen, 60000);
  const replaced = await post(b, { continuationToken: changed.data.continuationToken, message: '收款人改成李四' });
  assert.equal(replaced.data.preview.exactEffects[0].payeeId, 'payee_002');
  assert.equal(replaced.data.preview.exactEffects[0].amountFen, 60000);
  const reselect = await post(a, { continuationToken: replaced.data.continuationToken, message: '改选收款人' });
  assert.equal(reselect.data.slot, 'payee_ref');
  assert.equal(reselect.data.choices.length, 4);
  const ambiguous = await post(a, { message: '从活期账户给王先生转 500 元' });
  const selected = await post(b, { continuationToken: ambiguous.data.continuationToken, choice: { optionId: ambiguous.data.choices[0].optionId } });
  assert.equal(selected.data.preview.exactEffects[0].payeeId, 'payee_003');
  assert.equal((await post(b, { continuationToken: ambiguous.data.continuationToken, choice: { optionId: 'opt_forged' } })).code, 'INVALID_CHOICE');
  assert.equal((await post(b, { continuationToken: ambiguous.data.continuationToken, choice: { optionId: ambiguous.data.choices[0].optionId, entityId: 'payee_001' } })).code, 'INVALID_REQUEST');
  const bill = await post(a, { message: '查账单' });
  const result = await post(b, { continuationToken: bill.data.continuationToken, message: '2026年8月' });
  assert.equal(result.data.data.month, '2026-08');
  assert.equal(result.data.data.transactionCount, 12);
  assert.equal(result.data.evidence[0].source, 'synthetic_demo_only');
  assert.equal((await post(b, { message: '查账单' }, { 'x-saveflow-access': 'wrong' })).code, 'UNAUTHORIZED');
  assert.equal((await post(b, { message: '查账单' }, { origin: 'https://foreign.example' })).code, 'FORBIDDEN');
  assert.equal((await post(b, { operationId: preview.data.operationId, confirmed: true })).code, 'INVALID_REQUEST');
  assert.deepEqual(await (await fetch(`${b.url}/test-state`)).json(), before);
  assert.deepEqual(await (await fetch(`${a.url}/test-state`)).json(), before);
});

test('HTTP integration: account choice crosses two requests and returns Core preview only', async () => {
  const core = createBankingCore();
  let prepareCalls = 0;
  const wrapped = { ...core, prepare: async input => { prepareCalls++; return core.prepare(input); }, decide: () => { throw new Error('not available'); }, execute: () => { throw new Error('not available'); } };
  const beforeBalance = core.repository.getAccount('ACC-CHECKING').availableBalanceFen;
  const beforeTransactions = core.repository.getTransactions().length;
  const first = await (await handleBankingAgent(request({ message: '给张三转500元' }), { env, core: wrapped, parseIntent: parse, now: () => 1000 })).json();
  assert.equal(first.data.kind, 'clarification');
  assert.equal(prepareCalls, 0);
  const second = await (await handleBankingAgent(request({ continuationToken: first.data.continuationToken, choice: { optionId: first.data.choices[0].optionId } }), { env, core: wrapped, parseIntent: parse, now: () => 1000 })).json();
  assert.equal(second.data.status, 'awaiting_confirmation');
  assert.equal(second.data.preview.exactEffects[0].amountFen, 50000);
  assert.equal(prepareCalls, 1);
  assert.equal(core.repository.getAccount('ACC-CHECKING').availableBalanceFen, beforeBalance);
  assert.equal(core.repository.getTransactions().length, beforeTransactions);
  const edited = await (await handleBankingAgent(request({ continuationToken: second.data.continuationToken, message: '改成600元' }), { env, core: wrapped, parseIntent: parse, now: () => 1000 })).json();
  assert.equal(edited.data.status, 'awaiting_confirmation');
  assert.equal(edited.data.preview.exactEffects[0].amountFen, 60000);
  assert.notEqual(edited.data.operationId, second.data.operationId);
  assert.equal(prepareCalls, 2);
  assert.equal(core.repository.getAccount('ACC-CHECKING').availableBalanceFen, beforeBalance);
  assert.equal(core.repository.getTransactions().length, beforeTransactions);
});

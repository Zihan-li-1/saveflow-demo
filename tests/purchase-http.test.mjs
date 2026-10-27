import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePurchaseRequest } from '../server/purchase-api.mjs';
import { createPurchaseSkill } from '../src/skills/scenario/purchase-skill.mjs';
import { createPurchaseTestStore } from './fixtures/purchase-memory-store.mjs';
const env = { SAVEFLOW_ACCESS_CODE: 'purchase-access-code', CONTINUATION_TOKEN_SECRET: 'purchase-session-secret-at-least-32-characters' };
const request = (body, cookie, extra = {}) => new Request('https://saveflow.test/api/purchase', { method: 'POST', headers: {
  origin: 'https://saveflow.test', 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, ...(cookie ? { cookie } : {}), ...extra }, body: JSON.stringify({ consent: true, ...body }) });
test('purchase HTTP requires access, consent, same origin and ignores no body owner fields', async () => {
  for (const [body, headers, status] of [[{}, { 'x-saveflow-access': 'wrong' }, 401], [{ consent: false }, {}, 403], [{}, { origin: 'https://other.test' }, 403], [{ action: 'purchase.read', owner: 'other' }, {}, 400]]) {
    const response = await handlePurchaseRequest(request(body, '', headers), { env }); assert.equal(response.status, status);
  }
});
test('public shopping API never invokes commerce ordering or stores delivery addresses', async () => {
  let called = false;
  for (const action of ['commerce.search', 'commerce.quote', 'commerce.order.prepare', 'commerce.order.execute', 'commerce.order.status', 'purchase.address']) {
    const response = await handlePurchaseRequest(request({ action, input: {} }), { env, getSkill: async () => { called = true; throw new Error('unexpected skill call'); } });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'CAPABILITY_UNAVAILABLE');
  }
  assert.equal(called, false);
});
test('public shopping API rejects legacy candidate and address selection fields', async () => {
  let called = false;
  for (const changes of [{ selected_candidate_refs: ['candidate_1'] }, { address_ref: 'address_1' }]) {
    const response = await handlePurchaseRequest(request({ action: 'scenario.purchase.update', input: {
      workflow_ref: 'flow_1', expected_version: 1, changes,
    } }), { env, getSkill: async () => { called = true; throw new Error('unexpected skill call'); } });
    assert.equal((await response.json()).code, 'VALIDATION_ERROR');
  }
  assert.equal(called, false);
});
test('server-signed persistent demo session isolates workflows and private address never reaches parser', async () => {
  const store = createPurchaseTestStore(), skill = createPurchaseSkill({ store });
  let seen;
  const parseIntent = async (message, options) => { seen = options; return { schemaVersion: '1.0.0', action: 'scenario.plan_purchase', slots: { selection_mode: 'guided' }, missingSlots: [], status: 'ready_for_resolution' }; };
  const opts = { env, getSkill: async () => skill, parseIntent };
  const first = await handlePurchaseRequest(request({ action: 'purchase.understand', input: { message: '送花和蛋糕' } }), opts);
  assert.equal(first.status, 200);
  const cookie = first.headers.get('set-cookie').split(';')[0];
  assert.match(first.headers.get('set-cookie'), /HttpOnly/); assert.match(first.headers.get('set-cookie'), /SameSite=Strict/);
  const body = await first.json(), id = body.data.workflow_ref;
  assert.equal(seen.history.length, 0);
  const read = await handlePurchaseRequest(request({ action: 'purchase.read', input: { workflow_ref: id } }, cookie), opts);
  assert.equal(read.status, 200);
  const stolen = await handlePurchaseRequest(request({ action: 'purchase.read', input: { workflow_ref: id } }), opts);
  assert.equal((await stolen.json()).code, 'WORKFLOW_NOT_FOUND');
  const forged = cookie.slice(0, -3) + 'abc';
  const replay = await handlePurchaseRequest(request({ action: 'purchase.read', input: { workflow_ref: id } }, forged), opts);
  assert.equal((await replay.json()).code, 'SESSION_INVALID');
});
test('unconfigured production persistence fails explicitly without creating a memory store', async () => {
  const response = await handlePurchaseRequest(request({ action: 'scenario.plan_purchase', input: {} }), { env });
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'PERSISTENCE_UNAVAILABLE');
});
test('configured HTTPS public origin works behind an HTTP reverse proxy and cookies remain Secure', async () => {
  const skill = createPurchaseSkill({ store: createPurchaseTestStore() });
  const req = new Request('http://internal:3000/api/purchase', { method: 'POST', headers: { origin: 'https://public.test', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE }, body: JSON.stringify({ action: 'scenario.plan_purchase', input: {}, consent: true }) });
  const response = await handlePurchaseRequest(req, { env: { ...env, SAVEFLOW_PUBLIC_ORIGIN: 'https://public.test' }, getSkill: async () => skill });
  assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /Secure/);
});
test('dormant users recover the same workflow after session expiry without exposing recovery codes to models', async () => {
  let clock = Date.parse('2026-10-26T00:00:00Z');
  const skill = createPurchaseSkill({ store: createPurchaseTestStore() });
  const opts = { env, getSkill: async () => skill, now: () => clock };
  const first = await handlePurchaseRequest(request({ action: 'scenario.plan_purchase', input: {} }), opts);
  const id = (await first.json()).data.workflow_ref, cookie = first.headers.get('set-cookie').split(';')[0];
  const backup = await handlePurchaseRequest(request({ action: 'purchase.session.backup', input: {} }, cookie), opts);
  assert.equal(backup.status, 200); const code = (await backup.json()).data.recovery_code;
  clock += 30 * 86400000;
  const recovered = await handlePurchaseRequest(request({ action: 'purchase.session.recover', input: { recovery_code: code } }, cookie), opts);
  assert.equal(recovered.status, 200);
  const restored = await handlePurchaseRequest(request({ action: 'purchase.read', input: { workflow_ref: id } }, recovered.headers.get('set-cookie').split(';')[0]), opts);
  assert.equal(restored.status, 200);
  const invalid = await handlePurchaseRequest(request({ action: 'purchase.session.recover', input: { recovery_code: code + 'bad' } }), opts);
  assert.equal(invalid.status, 401);
});

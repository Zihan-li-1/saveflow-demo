import test from 'node:test';
import assert from 'node:assert/strict';
import { createPurchaseSkill, runDuePurchases } from '../src/skills/scenario/purchase-skill.mjs';
import { createPurchaseTestStore } from './fixtures/purchase-memory-store.mjs';
import { createCommerceMockServer } from '../server/commerce/mock-service.mjs';
import { createCommerceClient } from '../src/skills/commerce/commerce-client.mjs';

async function setup(t) {
  let clock = Date.parse('2026-10-26T00:00:00Z'); const faults = {}, token = 'purchase-workflow-test-token';
  const server = createCommerceMockServer({ now: () => clock, faults, token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const store = createPurchaseTestStore();
  const bank = { account_ref: 'account_1', available_minor: 200000, obligations_minor: 0, source: 'synthetic_demo_bank', as_of: new Date(clock).toISOString() };
  const skill = createPurchaseSkill({ store, commerce: createCommerceClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token }), financialContext: async () => structuredClone(bank), now: () => clock, schedulerEnabled: true });
  return { skill, store, faults, bank, advance: ms => { clock += ms; }, now: () => clock };
}
const slots = { budget: { amount_minor: 100000, currency: 'CNY' }, budget_month: '2026-10', funding_account_ref: '我的活期',
  date_expression: '2026-11-01 09:00-12:00', date_meaning: 'deliver_on', selection_mode: 'browse', items: [{ category: 'flowers', quantity: 1 }, { category: 'cake', quantity: 1 }] };
async function saved(skill) {
  let wf = await skill.perform('owner', 'scenario.plan_purchase', slots);
  const preview = await skill.previewPlan('owner', wf.workflow_ref, wf.version);
  wf = await skill.perform('owner', 'scenario.purchase.save', { draft_ref: wf.workflow_ref, expected_version: wf.version,
    plan_preview_ref: preview.plan_preview_ref, plan_confirmation_token: preview.plan_confirmation_token });
  return wf;
}
async function prepare(skill, wf, category = 'flowers') {
  const found = await skill.perform('owner', 'commerce.search', { workflow_ref: wf.workflow_ref, category, preferences: {}, delivery_region_ref: 'demo-shanghai', remaining_budget: slots.budget });
  const candidate = found.candidates[0];
  const address = await skill.saveAddress('owner', wf.workflow_ref, wf.version, { recipient: '测试收件人', phone: '13800000000', address: '模拟路1号', region: 'demo-shanghai' });
  wf = address.workflow;
  const quoted = await skill.perform('owner', 'commerce.quote', { workflow_ref: wf.workflow_ref, expected_version: wf.version,
    selections: [{ candidate_ref: candidate.candidate_ref, sku_ref: candidate.sku_ref, quantity: 1 }], address_ref: address.address_ref,
    delivery_window: { starts_at: '2026-11-01T09:00:00+08:00', ends_at: '2026-11-01T12:00:00+08:00', timezone: 'Asia/Shanghai' } });
  return skill.perform('owner', 'commerce.order.prepare', { workflow_ref: wf.workflow_ref, expected_version: wf.version, quote_ref: quoted.quotes[0].quote_ref });
}
test('full HTTP order path requires exact confirmation, preserves bank facts and is idempotent', async t => {
  const { skill, bank } = await setup(t), before = structuredClone(bank);
  const wf = await saved(skill), p = await prepare(skill, wf);
  assert.equal(p.preview.total.amount_minor, 31500);
  assert.equal(p.preview.merchant_name, '演示鲜花店');
  const request = { operation_ref: p.operation_ref, preview_hash: p.preview_hash, confirmation_token: p.confirmation_token };
  await assert.rejects(skill.perform('other', 'commerce.order.execute', request), { code: 'OPERATION_NOT_FOUND' });
  await assert.rejects(skill.perform('owner', 'commerce.order.execute', { ...request, confirmation_token: 'forged' }), { code: 'CONFIRMATION_INVALID' });
  const [a, b] = await Promise.all([skill.perform('owner', 'commerce.order.execute', request), skill.perform('owner', 'commerce.order.execute', request)]);
  const recovered = await skill.perform('owner', 'commerce.order.status', { operation_ref: p.operation_ref });
  assert.equal(recovered.status, 'created_pending_payment');
  assert.ok([a.status, b.status].includes('created_pending_payment'));
  assert.equal((await skill.read('owner', wf.workflow_ref)).reservation.occupied_minor, 31500);
  assert.deepEqual(bank, before);
});
test('changed context or expired previews never execute and unknown response keeps allocation', async t => {
  const { skill, advance, faults } = await setup(t);
  const wf = await saved(skill); const p = await prepare(skill, wf);
  await skill.perform('owner', 'scenario.purchase.update', { workflow_ref: wf.workflow_ref, expected_version: p.workflow_version, changes: { selection_mode: 'guided' } });
  await assert.rejects(skill.perform('owner', 'commerce.order.execute', { operation_ref: p.operation_ref, preview_hash: p.preview_hash, confirmation_token: p.confirmation_token }), { code: 'PREVIEW_STALE' });
  const wf2 = await skill.read('owner', wf.workflow_ref), p2 = await prepare(skill, wf2);
  advance(300001);
  await assert.rejects(skill.perform('owner', 'commerce.order.execute', { operation_ref: p2.operation_ref, preview_hash: p2.preview_hash, confirmation_token: p2.confirmation_token }), { code: 'PREVIEW_EXPIRED' });
  const p3 = await prepare(skill, await skill.read('owner', wf.workflow_ref));
  faults.dropNextOrderResponse = true;
  const unknown = await skill.perform('owner', 'commerce.order.execute', { operation_ref: p3.operation_ref, preview_hash: p3.preview_hash, confirmation_token: p3.confirmation_token });
  assert.equal(unknown.status, 'unknown');
  assert.equal((await skill.read('owner', wf.workflow_ref)).reservation.occupied_minor, 31500);
  assert.equal((await skill.perform('owner', 'commerce.order.status', { operation_ref: p3.operation_ref })).status, 'created_pending_payment');
});
test('worker generates one due confirmation task, never an order; missing scheduler refuses scheduling', async t => {
  const { skill, store, advance, now } = await setup(t);
  const draft = await skill.perform('owner', 'scenario.plan_purchase', { ...slots, date_meaning: 'order_on' });
  const p = await skill.previewPlan('owner', draft.workflow_ref, draft.version);
  await skill.perform('owner', 'scenario.purchase.save', { draft_ref: draft.workflow_ref, expected_version: draft.version, plan_preview_ref: p.plan_preview_ref, plan_confirmation_token: p.plan_confirmation_token });
  advance(7 * 86400000);
  await Promise.all([runDuePurchases({ store, now }), runDuePurchases({ store, now })]);
  const state = await store.transaction('owner', s => s);
  assert.equal(Object.keys(state.events).length, 1); assert.equal(Object.keys(state.operations).length, 0);
  assert.equal(Object.values(state.events)[0].status, 'missed_window');
  const disabled = createPurchaseSkill({ store, schedulerEnabled: false });
  const d = await disabled.perform('owner', 'scenario.plan_purchase', slots);
  await assert.rejects(disabled.previewPlan('owner', d.workflow_ref, d.version), { code: 'SCHEDULER_UNAVAILABLE' });
});
test('new hard preferences reject previously selected incompatible candidates', async t => {
  const { skill } = await setup(t); const wf = await saved(skill);
  const found = await skill.perform('owner', 'commerce.search', { workflow_ref: wf.workflow_ref, category: 'flowers', preferences: {}, delivery_region_ref: 'demo-shanghai', remaining_budget: slots.budget });
  const old = found.candidates[0]; assert.equal(old.material, 'rose');
  const updated = await skill.perform('owner', 'scenario.purchase.update', { workflow_ref: wf.workflow_ref, expected_version: wf.version, changes: { preferences: { flower_exclusions: ['rose'] } } });
  const address = await skill.saveAddress('owner', wf.workflow_ref, updated.version, { recipient: '测试', phone: '13800000000', address: '模拟路', region: 'demo-shanghai' });
  await assert.rejects(skill.perform('owner', 'commerce.quote', { workflow_ref: wf.workflow_ref, expected_version: address.workflow.version,
    selections: [{ candidate_ref: old.candidate_ref, sku_ref: old.sku_ref, quantity: 1 }], address_ref: address.address_ref,
    delivery_window: { starts_at: '2026-11-01T09:00:00+08:00', ends_at: '2026-11-01T12:00:00+08:00', timezone: 'Asia/Shanghai' } }), { code: 'PREFERENCES_CHANGED' });
});
test('partial failure keeps the successful flower order and frees only failed cake allocation', async t => {
  const { skill, faults } = await setup(t); const wf = await saved(skill);
  const a = await prepare(skill, wf);
  await skill.perform('owner', 'commerce.order.execute', { operation_ref: a.operation_ref, preview_hash: a.preview_hash, confirmation_token: a.confirmation_token });
  const b = await prepare(skill, await skill.read('owner', wf.workflow_ref), 'cake'); faults.outOfStock = true;
  const failed = await skill.perform('owner', 'commerce.order.execute', { operation_ref: b.operation_ref, preview_hash: b.preview_hash, confirmation_token: b.confirmation_token });
  assert.equal(failed.status, 'failed');
  const current = await skill.read('owner', wf.workflow_ref);
  assert.equal(current.orders.find(o => o.category === 'flowers').status, 'created_pending_payment');
  assert.equal(current.reservation.occupied_minor, 31500); assert.equal(current.reservation.unallocated_minor, 68500);
  assert.equal(a.preview.delivery.address, '模拟路1号');
});
test('amending an active plan requires a fresh preview and confirmation and preserves existing orders', async t => {
  const { skill } = await setup(t); const wf = await saved(skill), p = await prepare(skill, wf);
  await skill.perform('owner', 'commerce.order.execute', { operation_ref: p.operation_ref, preview_hash: p.preview_hash, confirmation_token: p.confirmation_token });
  const current = await skill.read('owner', wf.workflow_ref);
  const changed = await skill.reviseDraft('owner', wf.workflow_ref, current.version, { ...slots, budget: { amount_minor: 120000, currency: 'CNY' } });
  assert.equal(changed.reservation.total_minor, 100000);
  const plan = await skill.previewPlan('owner', wf.workflow_ref, changed.version);
  const confirmed = await skill.perform('owner', 'scenario.purchase.save', { draft_ref: wf.workflow_ref, expected_version: changed.version, plan_preview_ref: plan.plan_preview_ref, plan_confirmation_token: plan.plan_confirmation_token });
  assert.equal(confirmed.reservation.total_minor, 120000); assert.equal(confirmed.reservation.occupied_minor, 31500); assert.equal(confirmed.orders.length, 1);
});
test('order_on refreshes a separate future delivery quote at the due time', async t => {
  const { skill, advance } = await setup(t);
  const d = await skill.perform('owner', 'scenario.plan_purchase', { ...slots, date_meaning: 'order_on' });
  const p = await skill.previewPlan('owner', d.workflow_ref, d.version);
  const wf = await skill.perform('owner', 'scenario.purchase.save', { draft_ref: d.workflow_ref, expected_version: d.version, plan_preview_ref: p.plan_preview_ref, plan_confirmation_token: p.plan_confirmation_token });
  advance(6 * 86400000 + 3600000); // Nov 1, 09:00 Asia/Shanghai: ordering window starts.
  const found = await skill.perform('owner', 'commerce.search', { workflow_ref: wf.workflow_ref, category: 'flowers', preferences: {}, delivery_region_ref: 'demo-shanghai', remaining_budget: slots.budget });
  const address = await skill.saveAddress('owner', wf.workflow_ref, wf.version, { recipient: '测试', phone: '13800000000', address: '模拟地址', region: 'demo-shanghai' });
  const q = await skill.perform('owner', 'commerce.quote', { workflow_ref: wf.workflow_ref, expected_version: address.workflow.version,
    selections: [{ candidate_ref: found.candidates[0].candidate_ref, sku_ref: found.candidates[0].sku_ref, quantity: 1 }], address_ref: address.address_ref,
    delivery_window: { starts_at: '2026-11-01T14:00:00+08:00', ends_at: '2026-11-01T16:00:00+08:00', timezone: 'Asia/Shanghai' } });
  const o = await skill.perform('owner', 'commerce.order.prepare', { workflow_ref: wf.workflow_ref, expected_version: address.workflow.version, quote_ref: q.quotes[0].quote_ref });
  assert.equal((await skill.perform('owner', 'commerce.order.execute', { operation_ref: o.operation_ref, preview_hash: o.preview_hash, confirmation_token: o.confirmation_token })).status, 'created_pending_payment');
});

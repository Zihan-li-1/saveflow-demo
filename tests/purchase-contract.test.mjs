import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validatePurchaseAction, purchaseActions, purchaseJsonSchema } from '../src/skills/scenario/purchase-contract.mjs';

const valid = {
  'scenario.plan_purchase': { budget: { amount_minor: 100000, currency: 'CNY' }, items: [{ category: 'flowers', quantity: 1 }, { category: 'cake', quantity: 1 }] },
  'scenario.purchase.save': { draft_ref: 'draft_1', expected_version: 1, plan_preview_ref: 'preview_1', plan_confirmation_token: 'token_1' },
  'scenario.purchase.update': { workflow_ref: 'flow_1', expected_version: 1, changes: { selection_mode: 'browse' } },
  'commerce.search': { workflow_ref: 'flow_1', category: 'flowers', preferences: {}, delivery_region_ref: 'region_1', remaining_budget: { amount_minor: 100000, currency: 'CNY' } },
  'commerce.quote': { workflow_ref: 'flow_1', expected_version: 1, selections: [{ candidate_ref: 'candidate_1', sku_ref: 'sku_1', quantity: 1 }], address_ref: 'address_1', delivery_window: { starts_at: '2026-11-01T09:00:00+08:00', ends_at: '2026-11-01T12:00:00+08:00', timezone: 'Asia/Shanghai' } },
  'commerce.order.prepare': { workflow_ref: 'flow_1', expected_version: 1, quote_ref: 'quote_1' },
  'commerce.order.execute': { operation_ref: 'op_1', preview_hash: 'hash_1', confirmation_token: 'token_1' },
  'commerce.order.status': { operation_ref: 'op_1' },
  'scenario.purchase.cancel': { workflow_ref: 'flow_1', expected_version: 1, plan_preview_ref: 'preview_1', plan_confirmation_token: 'token_1' },
};
test('all nine contracts accept valid inputs and return isolated copies', () => {
  assert.equal(purchaseActions.length, 9);
  for (const [action, input] of Object.entries(valid)) {
    const copy = validatePurchaseAction(action, input);
    assert.deepEqual(copy, input); assert.notEqual(copy, input);
    for (const key of ['owner', 'confirmed', 'risk_level', 'tool', 'product_id']) {
      assert.throws(() => validatePurchaseAction(action, { ...input, [key]: 'forged' }), { code: 'VALIDATION_ERROR' });
    }
  }
});
test('model draft allows missing slots but refuses nested fields, floats and duplicate categories', () => {
  assert.deepEqual(validatePurchaseAction('scenario.plan_purchase', {}), {});
  for (const patch of [
    { budget: { amount_minor: 1.5, currency: 'CNY' } },
    { budget: { amount_minor: 0, currency: 'CNY' } },
    { budget: { amount_minor: 100, currency: 'USD' } },
    { budget: { amount_minor: 100, currency: 'CNY', confirmed: true } },
    { preferences: { tool: 'execute' } }, { preferences: { cake_servings: 0 } },
    { items: [{ category: 'flowers', quantity: 1 }, { category: 'flowers', quantity: 2 }] },
    { budget_month: '2026-13' }, { date_meaning: 'auto' },
  ]) assert.throws(() => validatePurchaseAction('scenario.plan_purchase', patch), { code: 'VALIDATION_ERROR' });
});
test('trusted commands require exact refs/version/token and meaningful changes', () => {
  assert.throws(() => validatePurchaseAction('commerce.order.execute', { confirmed: true }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validatePurchaseAction('scenario.purchase.update', { ...valid['scenario.purchase.update'], changes: {} }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validatePurchaseAction('scenario.purchase.update', { ...valid['scenario.purchase.update'], expected_version: 1.5 }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validatePurchaseAction('commerce.order.status', { operation_ref: '../other' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validatePurchaseAction('commerce.execute_anything', {}), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validatePurchaseAction('scenario.plan_purchase', JSON.parse('{"__proto__":{}}')), { code: 'VALIDATION_ERROR' });
});
test('time windows must be valid ordered timestamps; service validates future against trusted clock', () => {
  const input = valid['commerce.quote'];
  for (const window of [
    { ...input.delivery_window, starts_at: '2026-02-30T09:00:00+08:00' },
    { ...input.delivery_window, ends_at: '2026-11-01T08:00:00+08:00' },
  ]) assert.throws(() => validatePurchaseAction('commerce.quote', { ...input, delivery_window: window }), { code: 'VALIDATION_ERROR' });
});
test('published JSON Schema matches runtime contract source', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/purchase-actions.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema, purchaseJsonSchema());
});

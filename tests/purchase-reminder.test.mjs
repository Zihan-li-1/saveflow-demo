import test from 'node:test';
import assert from 'node:assert/strict';
import { createPurchaseSkill, runDuePurchases } from '../src/skills/scenario/purchase-skill.mjs';
import { createPurchaseTestStore } from './fixtures/purchase-memory-store.mjs';

test('desired delivery date creates an early reminder without creating an order', async () => {
  let clock = Date.parse('2026-10-26T00:00:00Z');
  const store = createPurchaseTestStore(), now = () => clock;
  const skill = createPurchaseSkill({ store, now, schedulerEnabled: true, financialContext: async () => ({
    account_ref: 'test-account', available_minor: 200000, obligations_minor: 0,
    source: 'user_provided', as_of: new Date(clock).toISOString(),
  }) });
  const draft = await skill.perform('owner', 'scenario.plan_purchase', {
    budget: { amount_minor: 100000, currency: 'CNY' }, budget_month: '2026-10', funding_account_ref: '我的活期',
    date_expression: '2026-11-01 09:00-12:00', date_meaning: 'deliver_on',
    items: [{ category: 'flowers', quantity: 1 }], selection_mode: 'browse',
  });
  const preview = await skill.previewPlan('owner', draft.workflow_ref, draft.version);
  assert.equal(preview.preview.reminder_due_at, '2026-10-29T01:00:00.000Z');
  await skill.perform('owner', 'scenario.purchase.save', { draft_ref: draft.workflow_ref, expected_version: draft.version,
    plan_preview_ref: preview.plan_preview_ref, plan_confirmation_token: preview.plan_confirmation_token });
  clock = Date.parse('2026-10-29T00:59:00Z');
  assert.equal((await runDuePurchases({ store, now })).events_created, 0);
  clock = Date.parse('2026-10-29T01:00:00Z');
  assert.equal((await runDuePurchases({ store, now })).events_created, 1);
  const state = await store.transaction('owner', value => value);
  assert.equal(Object.values(state.events)[0].status, 'awaiting_user_review');
  assert.equal(Object.keys(state.operations).length, 0);
});

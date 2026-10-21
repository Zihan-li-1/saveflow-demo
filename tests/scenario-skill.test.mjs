import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryScenarioStore, createScenarioSkill } from '../src/skills/scenario/scenario-skill.mjs';

function fixture() {
  let tick = 0;
  const store = createInMemoryScenarioStore([{ id: 'event_001', rule_ref: 'rule_demo', type: 'balance_changed', trusted: true, occurred_at: '2026-09-01T08:00:00+08:00' }, { id: 'event_bad', type: 'user_text', trusted: false, occurred_at: '2026-09-01T08:00:00+08:00' }]);
  const skill = createScenarioSkill({ store, id: () => 'rule_demo', now: () => `2026-09-01T08:00:0${tick++}+08:00` });
  return { store, skill };
}

test('E scenario: create, update and disable a suggest-only rule', async () => {
  const { skill, store } = fixture();
  const request = { action: 'scenario.create_rule', trigger: { type: 'financial_event', value: 'balance_changed' }, conditions: { balance_below_minor: 100000 }, proposed_steps: [{ action: 'bill.analyze', parameters: { period: 'last_30_days' } }, { action: 'wealth.compare', parameters: { product_refs: ['product_001', 'product_002'] } }], authorization_scope: 'suggest_only' };
  const preview = await skill(request);
  assert.equal(preview.ok, true); assert.equal(preview.kind, 'scenario_rule_preview'); assert.equal(await store.getRule('rule_demo'), undefined);
  const created = await skill(request, { confirmed: true });
  assert.equal(created.ok, true); assert.equal(created.data.rule.status, 'active');
  const updateRequest = { action: 'scenario.update_rule', rule_ref: 'rule_demo', changes: { conditions: { balance_below_minor: 200000 } } };
  assert.equal((await skill(updateRequest)).kind, 'scenario_rule_preview');
  const updated = await skill(updateRequest, { confirmed: true });
  assert.equal(updated.data.rule.conditions.balance_below_minor, 200000);
  const disabled = await skill({ action: 'scenario.disable_rule', rule_ref: 'rule_demo' }, { confirmed: true });
  assert.equal(disabled.data.rule.status, 'disabled');
});

test('E scenario: trusted events produce suggestions without inherited confirmation', async () => {
  const { skill } = fixture();
  await skill({ action: 'scenario.create_rule', trigger: { type: 'financial_event', value: 'balance_changed' }, conditions: {}, proposed_steps: [{ action: 'subscription.list', parameters: {} }], authorization_scope: 'suggest_only' }, { confirmed: true });
  const result = await skill({ action: 'scenario.review_event', event_ref: 'event_001' });
  assert.equal(result.ok, true); assert.equal(result.data.inherited_confirmation, false);
  assert.equal(result.data.proposed_steps[0].action, 'subscription.list');
  assert.equal(result.evidence[0].source, 'trusted_event_store');
});

test('E scenario: rejects write steps and untrusted events', async () => {
  const { skill } = fixture();
  const unsafe = await skill({ action: 'scenario.create_rule', trigger: { type: 'manual', value: 'now' }, conditions: {}, proposed_steps: [{ action: 'wealth.subscribe', parameters: {} }], authorization_scope: 'suggest_only' });
  assert.equal(unsafe.ok, false); assert.equal(unsafe.error.code, 'UNSAFE_STEP');
  const event = await skill({ action: 'scenario.review_event', event_ref: 'event_bad' });
  assert.equal(event.ok, false); assert.equal(event.error.code, 'EVENT_NOT_TRUSTED');
});

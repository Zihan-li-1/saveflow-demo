import test from 'node:test';
import assert from 'node:assert/strict';
import { createBankingCore } from '../src/banking-core/core.mjs';

const createInput = {
  trigger: { type: 'financial_event', value: 'balance_changed' },
  conditions: { balance_below_minor: 100000 },
  proposed_steps: [{ action: 'bill.analyze', parameters: { period: 'last_30_days' } }],
  authorization_scope: 'suggest_only',
};

async function confirmAndExecute(core, prepared) {
  const { operationId, preview } = prepared.data;
  const decision = await core.decide(operationId, { previewHash: preview.previewHash, decision: 'confirm', confirmedStepIds: preview.stepIds });
  assert.equal(decision.ok, true);
  return core.execute(operationId, preview.previewHash);
}

test('scenario Core: preview does not write; exact confirmation executes once with a receipt', async () => {
  const core = createBankingCore({ now: () => Date.parse('2026-09-01T00:00:00Z') });
  const prepared = await core.prepare({ action: 'scenario.create_rule', input: createInput });
  assert.equal(prepared.ok, true);
  const effect = prepared.data.preview.exactEffects[0];
  assert.equal(await core.getScenarioRule(effect.ruleId), undefined);

  const executed = await confirmAndExecute(core, prepared);
  assert.equal(executed.ok, true);
  assert.equal(executed.data.status, 'succeeded');
  assert.equal(executed.data.effects[0].after.authorization_scope, 'suggest_only');
  assert.equal((await core.getScenarioRule(effect.ruleId)).version, 1);
  assert.deepEqual(await core.execute(prepared.data.operationId, prepared.data.preview.previewHash), executed);
});

test('scenario Core: a newer preview invalidates the older update and cancellation writes nothing', async () => {
  const core = createBankingCore({ now: () => Date.parse('2026-09-01T00:00:00Z') });
  const created = await core.prepare({ action: 'scenario.create_rule', input: createInput });
  await confirmAndExecute(core, created);
  const ruleId = created.data.preview.exactEffects[0].ruleId;

  const older = await core.prepare({ action: 'scenario.update_rule', input: { ruleRef: ruleId, changes: { conditions: { balance_below_minor: 200000 } } } });
  const newer = await core.prepare({ action: 'scenario.update_rule', input: { ruleRef: ruleId, changes: { conditions: { balance_below_minor: 300000 } } } });
  const stale = await core.decide(older.data.operationId, { previewHash: older.data.preview.previewHash, decision: 'confirm', confirmedStepIds: older.data.preview.stepIds });
  assert.equal(stale.ok, false); assert.equal(stale.error.code, 'PREVIEW_STALE');
  const updated = await confirmAndExecute(core, newer);
  assert.equal(updated.ok, true); assert.equal((await core.getScenarioRule(ruleId)).conditions.balance_below_minor, 300000);

  const disable = await core.prepare({ action: 'scenario.disable_rule', input: { ruleRef: ruleId } });
  const cancelled = await core.decide(disable.data.operationId, { previewHash: disable.data.preview.previewHash, decision: 'reject', confirmedStepIds: [] });
  assert.equal(cancelled.ok, true); assert.equal(cancelled.data.status, 'cancelled');
  assert.equal((await core.getScenarioRule(ruleId)).status, 'active');
});

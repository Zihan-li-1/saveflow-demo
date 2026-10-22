import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBankingCore } from '../src/banking-core/core.mjs';

const value = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
const confirm = (core, prepared) => core.decide(prepared.operationId, { previewHash: prepared.preview.previewHash, decision: 'confirm', confirmedStepIds: prepared.preview.stepIds });
const execute = (core, prepared) => core.execute(prepared.operationId, prepared.preview.previewHash);

test('card Core: preview and UI decision do not mutate; execute changes state once and can be queried', async () => {
  const core = createBankingCore();
  const before = core.repository.getCard('CARD-ENT');
  const prepared = value(await core.prepare({ action: 'card.freeze', input: { cardId: 'CARD-ENT' } }));
  assert.equal(prepared.preview.exactEffects[0].cardVersion, before.version);
  assert.equal(prepared.preview.exactEffects[0].before.status, 'active');
  assert.equal(prepared.preview.exactEffects[0].after.status, 'frozen');
  assert.equal(core.repository.getCard('CARD-ENT').status, 'active');
  assert.equal((await execute(core, prepared)).error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(core.repository.getCard('CARD-ENT').status, 'active');
  value(await confirm(core, prepared));
  assert.equal(core.repository.getCard('CARD-ENT').status, 'active');
  const receipt = value(await execute(core, prepared));
  assert.equal(receipt.status, 'succeeded');
  assert.equal(core.repository.getCard('CARD-ENT').version, before.version + 1);
  assert.equal(core.repository.getCard('CARD-ENT').status, 'frozen');
  assert.deepEqual(value(await execute(core, prepared)), receipt);
  assert.deepEqual(value(await core.getOperation(prepared.operationId)).receipt, receipt);
  const thaw = value(await core.prepare({ action: 'card.unfreeze', input: { cardId: 'CARD-ENT' } }));
  value(await confirm(core, thaw));
  value(await execute(core, thaw));
  assert.equal(core.repository.getCard('CARD-ENT').status, 'active');
  assert.equal(core.repository.getCard('CARD-ENT').version, before.version + 2);
});

test('card Core: monthly budget below spending warns, then changes only after execution', async () => {
  const core = createBankingCore();
  const prepared = value(await core.prepare({ action: 'card.set_budget', input: { cardId: 'CARD-ENT', monthlyBudgetFen: 10000 } }));
  assert.match(prepared.preview.warnings.join(' '), /当前已超预算/);
  assert.equal(core.repository.getCard('CARD-ENT').monthlyBudgetFen, 80000);
  value(await confirm(core, prepared));
  assert.equal(core.repository.getCard('CARD-ENT').monthlyBudgetFen, 80000);
  value(await execute(core, prepared));
  assert.equal(core.repository.getCard('CARD-ENT').monthlyBudgetFen, 10000);
  assert.equal(core.repository.getCard('CARD-ENT').monthlySpentFen, 76000);
  assert.equal((await core.prepare({ action: 'card.set_budget', input: { cardId: 'CARD-ENT', monthlyBudgetFen: 1.5 } })).error.code, 'VALIDATION_ERROR');
});

test('card Core: security controls change only after explicit confirmation and execution', async () => {
  const core = createBankingCore();
  const before = core.repository.getCard('CARD-ENT');
  const prepared = value(await core.prepare({ action: 'card.set_controls', input: { cardId: 'CARD-ENT', onlinePaymentsEnabled: false, blockedCategories: ['游戏', '博彩'], alertThresholdFen: 50000 } }));
  const effect = prepared.preview.exactEffects[0];
  assert.equal(effect.before.onlinePaymentsEnabled, true);
  assert.equal(effect.after.onlinePaymentsEnabled, false);
  assert.deepEqual(effect.after.blockedCategories, ['游戏', '博彩']);
  assert.equal(effect.after.alertThresholdFen, 50000);
  assert.deepEqual({ ...core.repository.getCard('CARD-ENT'), previewGeneration: before.previewGeneration }, before);
  value(await confirm(core, prepared));
  assert.deepEqual({ ...core.repository.getCard('CARD-ENT'), previewGeneration: before.previewGeneration }, before);
  value(await execute(core, prepared));
  const after = core.repository.getCard('CARD-ENT');
  assert.equal(after.onlinePaymentsEnabled, false);
  assert.deepEqual(after.blockedCategories, ['游戏', '博彩']);
  assert.equal(after.alertThresholdFen, 50000);

  const partial = value(await core.prepare({ action: 'card.set_controls', input: { cardId: 'CARD-ENT', onlinePaymentsEnabled: true } }));
  assert.deepEqual(partial.preview.exactEffects[0].after.blockedCategories, ['游戏', '博彩']);
  assert.equal(partial.preview.exactEffects[0].after.alertThresholdFen, 50000);
  value(await confirm(core, partial));
  value(await execute(core, partial));
  const final = core.repository.getCard('CARD-ENT');
  assert.equal(final.onlinePaymentsEnabled, true);
  assert.deepEqual(final.blockedCategories, ['游戏', '博彩']);
  assert.equal(final.alertThresholdFen, 50000);
});

test('card Core: expiry and newer preview invalidate old confirmation server-side', async () => {
  let time = 1000;
  const core = createBankingCore({ now: () => time, policy: { previewTtlMs: 1000 } });
  const first = value(await core.prepare({ action: 'card.freeze', input: { cardId: 'CARD-ENT' } }));
  const newer = value(await core.prepare({ action: 'card.set_budget', input: { cardId: 'CARD-ENT', monthlyBudgetFen: 50000 } }));
  assert.equal((await confirm(core, first)).error.code, 'PREVIEW_STALE');
  assert.equal(core.repository.getCard('CARD-ENT').status, 'active');
  time = 2000;
  assert.equal((await confirm(core, newer)).error.code, 'PREVIEW_EXPIRED');
  assert.equal(core.repository.getCard('CARD-ENT').monthlyBudgetFen, 80000);
});

test('card Core: state change between confirm and execute is rejected', async () => {
  const core = createBankingCore();
  const first = value(await core.prepare({ action: 'card.freeze', input: { cardId: 'CARD-ENT' } }));
  value(await confirm(core, first));
  const newer = value(await core.prepare({ action: 'card.set_budget', input: { cardId: 'CARD-ENT', monthlyBudgetFen: 50000 } }));
  value(await confirm(core, newer));
  value(await execute(core, newer));
  assert.equal((await execute(core, first)).error.code, 'PREVIEW_STALE');
  assert.equal(core.repository.getCard('CARD-ENT').status, 'active');
});

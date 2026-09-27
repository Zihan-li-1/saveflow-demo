import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createFinancialContext } from '../src/banking-core/repository.mjs';
import {
  CARD_ACTIONS,
  resolveCardReference,
  runResolvedCardIntent,
  validateCardIntent,
  validateResolvedCardIntent,
} from '../src/skills/card/card-skill.mjs';

const context = Object.freeze({
  asOf: '2026-09-01T00:00:00+08:00',
  dataSource: 'synthetic_demo_only',
  currency: 'CNY',
});

const seedCards = Object.freeze([
  Object.freeze({ id: 'CARD-MAIN', name: '日常虚拟卡', accountId: 'ACC-CHECKING', status: 'active', monthlyLimitFen: 500000, monthlySpentFen: 0 }),
  Object.freeze({ id: 'CARD-ENT', name: '娱乐虚拟卡', accountId: 'ACC-CHECKING', status: 'active', monthlyLimitFen: 80000, monthlySpentFen: 76000 }),
]);

const repository = (cards = seedCards) => ({
  getCards: () => structuredClone(cards),
  getContextInfo: () => structuredClone(context),
});

const reference = (cardId = 'CARD-ENT', source = 'financial_context') => ({
  slot: 'card_ref', entity_type: 'card', entity_id: cardId, source,
});

const resolved = (action, cardId = 'CARD-ENT', extra = {}) => ({
  intent_id: 'intent_card_001',
  action,
  state: 'ready_for_planning',
  resolved_slots: { card_id: cardId, ...extra },
  references: [reference(cardId)],
  missing_slots: [],
});

test('four registered actions match both machine-readable schemas', () => {
  const raw = JSON.parse(readFileSync(new URL('../schemas/card-actions.schema.json', import.meta.url), 'utf8'));
  const ready = JSON.parse(readFileSync(new URL('../schemas/card-resolved-actions.schema.json', import.meta.url), 'utf8'));
  const actions = schema => schema.oneOf.map(item => schema.$defs[item.$ref.split('/').at(-1)].properties.action.const).sort();
  assert.deepEqual(actions(raw), [...CARD_ACTIONS].sort());
  assert.deepEqual(actions(ready), [...CARD_ACTIONS].sort());
});

test('raw schema blocks padded service IDs and keeps the money object closed', () => {
  const schema = JSON.parse(readFileSync(new URL('../schemas/card-actions.schema.json', import.meta.url), 'utf8'));
  const serviceIdPattern = new RegExp(schema.$defs.cardRef.allOf[1].not.pattern);
  assert.equal(serviceIdPattern.test(' CARD-ENT '), true);
  assert.equal(schema.$defs.amount.additionalProperties, false);
  assert.equal(schema.$defs.amount.properties.amount_minor.type, 'integer');

  assert.doesNotThrow(() => validateCardIntent({
    action: 'card.set_limit',
    slots: { card_ref: '娱乐虚拟卡', limit_type: 'monthly_total', amount: { amount_minor: 0, currency: 'CNY' } },
  }));
  assert.doesNotThrow(() => validateCardIntent({
    action: 'card.set_limit',
    slots: { card_ref: '娱乐虚拟卡', limit_type: 'monthly_total', amount: { amount_minor: 10000000, currency: 'CNY' } },
  }));
  assert.throws(() => validateCardIntent({
    action: 'card.set_limit',
    slots: { card_ref: '娱乐虚拟卡', limit_type: 'monthly_total', amount: { amount_minor: 100000, currency: 'CNY', confirmed: true } },
  }));
});

test('raw action contract rejects legacy intents, IDs and authorization fields', () => {
  assert.deepEqual(validateCardIntent({ action: 'card.get', slots: { card_ref: '娱乐虚拟卡' } }).slots, { card_ref: '娱乐虚拟卡' });
  for (const value of [
    { action: 'create_plan', slots: { card_ref: '娱乐虚拟卡' } },
    { action: 'card.get', slots: { card_ref: 'CARD-ENT' } },
    { action: 'card.get', slots: { card_ref: '娱乐虚拟卡' }, confirmed: true },
    { action: 'card.freeze', slots: { card_ref: '娱乐虚拟卡', risk_level: 'L0' } },
  ]) assert.throws(() => validateCardIntent(value));
});

test('resolved handoff follows shared ResolvedIntent fields and evidence shape', () => {
  const value = resolved('card.get');
  assert.equal(validateResolvedCardIntent(value).intent_id, 'intent_card_001');
  assert.throws(() => validateResolvedCardIntent({ ...value, missing_slots: ['card_id'] }));
  assert.throws(() => validateResolvedCardIntent({ ...value, references: [{ ...reference(), entity_type: 'account' }] }));
  assert.throws(() => validateResolvedCardIntent({ ...value, references: [reference('CARD-MAIN')] }));
  assert.doesNotThrow(() => validateResolvedCardIntent({ ...value, references: [reference('CARD-ENT', 'tool_result')] }));
});

test('reference resolution never guesses unknown or duplicate names', async () => {
  assert.equal((await resolveCardReference(repository(), '娱乐虚拟卡')).cardId, 'CARD-ENT');
  assert.equal((await resolveCardReference(repository(), 'CARD-MAIN')).reason, 'CARD_NOT_FOUND');
  assert.equal((await resolveCardReference(repository(), '不存在的卡')).reason, 'CARD_NOT_FOUND');
  const duplicated = [...seedCards, { ...seedCards[1], id: 'CARD-ENT-2' }];
  const result = await resolveCardReference(repository(duplicated), '娱乐虚拟卡');
  assert.equal(result.reason, 'CARD_AMBIGUOUS');
  assert.deepEqual(result.candidates.map(card => card.id), ['CARD-ENT', 'CARD-ENT-2']);
});

test('supports the FinancialContextRepository MaybePromise contract', async () => {
  const asyncRepository = {
    getCards: async () => structuredClone(seedCards),
    getContextInfo: async () => structuredClone(context),
  };
  assert.equal((await resolveCardReference(asyncRepository, '娱乐虚拟卡')).cardId, 'CARD-ENT');
  const result = await runResolvedCardIntent(asyncRepository, resolved('card.get'));
  assert.equal(result.ok, true);
  assert.equal(result.data.context.dataSource, 'synthetic_demo_only');
});

test('uses the repository card IDs, names and Fen fields without a second Mock shape', async () => {
  const { repository: projectRepository } = createFinancialContext();
  const selected = await resolveCardReference(projectRepository, '娱乐虚拟卡');
  assert.equal(selected.cardId, 'CARD-ENT');
  const result = await runResolvedCardIntent(projectRepository, resolved('card.get'));
  assert.equal(result.ok, true);
  assert.deepEqual(
    {
      id: result.data.card.id,
      name: result.data.card.name,
      accountId: result.data.card.accountId,
      status: result.data.card.status,
      monthlyLimitFen: result.data.card.monthlyLimitFen,
      monthlySpentFen: result.data.card.monthlySpentFen,
    },
    {
      id: 'CARD-ENT',
      name: '娱乐虚拟卡',
      accountId: 'ACC-CHECKING',
      status: 'active',
      monthlyLimitFen: 80000,
      monthlySpentFen: 76000,
    },
  );
});

test('card.get returns defensive project-shaped data without mutation', async () => {
  const repo = repository();
  const result = await runResolvedCardIntent(repo, resolved('card.get'));
  assert.equal(result.ok, true);
  assert.equal(result.data.kind, 'query');
  assert.equal(result.data.card.monthlyLimitFen, 80000);
  result.data.card.monthlyLimitFen = 1;
  assert.equal(repo.getCards()[1].monthlyLimitFen, 80000);
});

test('card.set_limit maps snake_case/minor to camelCase/Fen without conversion', async () => {
  const value = resolved('card.set_limit', 'CARD-ENT', {
    limit_type: 'monthly_total',
    amount: { amount_minor: 100000, currency: 'CNY' },
  });
  const result = await runResolvedCardIntent(repository(), value);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.request, {
    action: 'card.set_limit',
    input: { cardId: 'CARD-ENT', limitType: 'monthly_total', amountFen: 100000, currency: 'CNY' },
  });
  assert.deepEqual(result.data.requirements, { minimumRiskLevel: 'L2', explicitUserConfirmation: true, executionOwner: 'banking_core' });
  const belowSpent = await runResolvedCardIntent(repository(), resolved('card.set_limit', 'CARD-ENT', {
    limit_type: 'monthly_total', amount: { amount_minor: 75999, currency: 'CNY' },
  }));
  assert.equal(belowSpent.error.code, 'LIMIT_EXCEEDED');
});

test('freeze and unfreeze create requests but never mutate repository state', async () => {
  const activeRepo = repository();
  const freeze = await runResolvedCardIntent(activeRepo, resolved('card.freeze'));
  assert.deepEqual(freeze.data.request, { action: 'card.freeze', input: { cardId: 'CARD-ENT' } });
  assert.equal(freeze.data.requirements.minimumRiskLevel, 'L2');
  assert.equal(activeRepo.getCards()[1].status, 'active');

  const frozenCards = seedCards.map(card => card.id === 'CARD-ENT' ? { ...card, status: 'frozen' } : card);
  const unfreeze = await runResolvedCardIntent(repository(frozenCards), resolved('card.unfreeze'));
  assert.deepEqual(unfreeze.data.request, { action: 'card.unfreeze', input: { cardId: 'CARD-ENT' } });
  assert.equal(unfreeze.data.requirements.minimumRiskLevel, 'L3');
  assert.equal((await runResolvedCardIntent(activeRepo, resolved('card.unfreeze'))).error.code, 'INVALID_STATE');
});

test('unknown card and malformed limits fail without effects', async () => {
  assert.equal((await runResolvedCardIntent(repository(), resolved('card.get', 'CARD-NONE'))).error.code, 'CARD_NOT_FOUND');
  for (const amount_minor of [-1, 1.5, 10000001]) {
    const result = await runResolvedCardIntent(repository(), resolved('card.set_limit', 'CARD-ENT', {
      limit_type: 'monthly_total', amount: { amount_minor, currency: 'CNY' },
    }));
    assert.equal(result.error.code, 'VALIDATION_ERROR');
  }
});

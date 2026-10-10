import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createFinancialContext } from '../src/banking-core/repository.mjs';
import {
  WEALTH_ACTIONS,
  runResolvedWealthIntent,
  validateResolvedWealthIntent,
  validateWealthIntent,
} from '../src/skills/wealth/wealth-skill.mjs';

const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const riskAssessments = json('./fixtures/wealth/risk-assessments.json');
const holdings = json('./fixtures/wealth/holdings.json');
const disclosures = json('./fixtures/wealth/product-disclosures.json');
const operationRules = json('./fixtures/wealth/operation-rules.json');

function ports(overrides = {}) {
  return {
    getRiskAssessment: async () => structuredClone(riskAssessments[0]),
    getHoldings: async () => structuredClone(holdings),
    getDisclosure: async productId => structuredClone(disclosures.find(item => item.product_id === productId)),
    getOperationRule: async productId => structuredClone(operationRules[productId]),
    questionnaire: { route: '/wealth/risk-assessment', source: 'trusted_ui' },
    ...overrides,
  };
}

const ref = (slot, entityType, entityId) => ({ slot, entity_type: entityType, entity_id: entityId, source: 'financial_context' });
const resolved = (action, resolvedSlots, references = []) => ({
  intent_id: `intent_${action.replace('.', '_')}`,
  action,
  state: 'ready_for_planning',
  resolved_slots: resolvedSlots,
  references,
  missing_slots: [],
});

test('five actions match both machine-readable schemas', () => {
  const raw = json('../schemas/wealth-actions.schema.json');
  const ready = json('../schemas/wealth-resolved-actions.schema.json');
  const actions = schema => schema.oneOf.map(item => schema.$defs[item.$ref.split('/').at(-1)].properties.action.const).sort();
  assert.deepEqual(actions(raw), [...WEALTH_ACTIONS].sort());
  assert.deepEqual(actions(ready), [...WEALTH_ACTIONS].sort());
});

test('raw contract rejects IDs, unknown fields, model risk and confirmation', () => {
  assert.doesNotThrow(() => validateWealthIntent({ action: 'wealth.recommend', slots: { goal: { kind: 'short_term_purchase', target_date: '2026-09-20' } } }));
  for (const value of [
    { action: 'wealth.compare', slots: { product_refs: ['product_001', '稳健产品'] } },
    { action: 'wealth.subscribe', slots: { product_ref: '稳健产品', amount: { amount_minor: 10000, currency: 'CNY' }, source_account_ref: 'ACC-CHECKING' } },
    { action: 'wealth.assess_risk', slots: { assessment_scope: 'investment', risk_level: 'R3' } },
    { action: 'wealth.redeem', slots: { holding_ref: '我的持仓', quantity_or_amount: { kind: 'amount', amount_minor: 10000, currency: 'CNY' } }, confirmed: true },
  ]) assert.throws(() => validateWealthIntent(value));
});

test('recommendation uses deterministic suitability and explains exclusions', async () => {
  const { repository } = createFinancialContext();
  const intent = resolved('wealth.recommend', {
    goal: { kind: 'short_term_purchase', target_date: '2026-09-20', max_risk_level: 'R2' },
    constraints: { investable_amount: { amount_minor: 200000, currency: 'CNY' }, max_settlement_days: 1 },
  });
  const result = await runResolvedWealthIntent(repository, ports(), intent);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.matches.map(item => item.product_id), ['product_001', 'product_002']);
  assert.deepEqual(result.data.excluded[0], { product_id: 'product_003', reason_codes: ['RISK_TOO_HIGH', 'LIQUIDITY_TOO_SLOW', 'TERM_TOO_LONG'] });
  assert.equal(result.data.synthetic_demo_only, true);
  assert.match(result.data.disclaimer, /not guaranteed/i);
  assert.ok(result.data.evidence.some(item => item.source === 'trusted_ui'));
  assert.ok(result.data.evidence.some(item => item.source === 'product_disclosure'));
});

test('trusted R2 assessment caps a user supplied R3 recommendation goal', async () => {
  const { repository } = createFinancialContext();
  const result = await runResolvedWealthIntent(repository, ports(), resolved('wealth.recommend', {
    goal: { kind: 'steady_growth', max_risk_level: 'R3' },
    constraints: { investable_amount: { amount_minor: 200000, currency: 'CNY' } },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.data.matches.some(item => item.product_id === 'product_003'), false);
  assert.ok(result.data.excluded.find(item => item.product_id === 'product_003').reason_codes.includes('RISK_TOO_HIGH'));
});

test('capital preservation and a target before the snapshot are not presented as investable matches', async () => {
  const { repository } = createFinancialContext();
  const run = goal => runResolvedWealthIntent(repository, ports(), resolved('wealth.recommend', { goal }));
  assert.equal((await run({ kind: 'capital_preservation' })).error.code, 'NO_MATCHING_PRODUCT');
  assert.equal((await run({ kind: 'short_term_purchase', target_date: '2026-08-01' })).error.code, 'VALIDATION_ERROR');
});

test('raw and resolved validators enforce the same money and settlement limits', () => {
  assert.throws(() => validateWealthIntent({ action: 'wealth.subscribe', slots: { product_ref: '现金产品', amount: { amount_minor: 1000000001, currency: 'CNY' }, source_account_ref: '活期账户' } }));
  assert.throws(() => validateWealthIntent({ action: 'wealth.recommend', slots: { goal: { kind: 'steady_growth' }, constraints: { max_settlement_days: 366 } } }));
  assert.throws(() => validateWealthIntent({ action: 'wealth.recommend', slots: { goal: { kind: 'steady_growth', target_date: '2026-02-30' } } }));
});

test('comparison rejects too few, duplicate and unknown products', async () => {
  const { repository } = createFinancialContext();
  const run = productIds => runResolvedWealthIntent(repository, ports(), resolved('wealth.compare', { product_ids: productIds }, productIds.map(id => ref('product_refs', 'investment_product', id))));
  assert.equal((await run(['product_001'])).error.code, 'VALIDATION_ERROR');
  assert.equal((await run(['product_001', 'product_001'])).error.code, 'VALIDATION_ERROR');
  assert.equal((await run(['product_001', 'product_missing'])).error.code, 'PRODUCT_NOT_FOUND');
  const result = await run(['product_001', 'product_002']);
  assert.deepEqual(result.data.products.map(item => item.product_id), ['product_001', 'product_002']);
});

test('missing or expired risk assessment returns only a trusted questionnaire', async () => {
  const { repository } = createFinancialContext();
  const intent = resolved('wealth.assess_risk', { assessment_scope: 'investment' });
  const missing = await runResolvedWealthIntent(repository, ports({ getRiskAssessment: async () => undefined }), intent);
  assert.equal(missing.data.kind, 'questionnaire_required');
  assert.equal(missing.data.questionnaire.source, 'trusted_ui');
  const expired = await runResolvedWealthIntent(repository, ports({ getRiskAssessment: async () => ({ ...riskAssessments[0], expires_at: '2026-08-01T00:00:00+08:00' }) }), intent);
  assert.equal(expired.data.kind, 'questionnaire_required');
  const missingQuestionnaire = await runResolvedWealthIntent(repository, ports({ getRiskAssessment: async () => undefined, questionnaire: undefined }), intent);
  assert.equal(missingQuestionnaire.error.code, 'CAPABILITY_UNAVAILABLE');
  const wrongScope = await runResolvedWealthIntent(repository, ports(), resolved('wealth.assess_risk', { assessment_scope: 'portfolio' }));
  assert.equal(wrongScope.data.kind, 'questionnaire_required');
});

test('subscribe validates minimum, balance, suitability and disclosure before returning L3 request', async () => {
  const { repository } = createFinancialContext();
  const make = (productId, amountMinor = 10000) => resolved('wealth.subscribe', {
    product_id: productId,
    amount: { amount_minor: amountMinor, currency: 'CNY' },
    source_account_id: 'ACC-CHECKING',
  }, [ref('product_ref', 'investment_product', productId), ref('source_account_ref', 'account', 'ACC-CHECKING')]);
  assert.equal((await runResolvedWealthIntent(repository, ports(), make('product_002', 9999))).error.code, 'BELOW_MINIMUM_AMOUNT');
  assert.equal((await runResolvedWealthIntent(repository, ports(), make('product_003', 100000))).error.code, 'SUITABILITY_FAILED');
  assert.equal((await runResolvedWealthIntent(repository, ports(), make('product_002', 600000))).error.code, 'INSUFFICIENT_BALANCE');
  const stale = ports({ getDisclosure: async id => ({ ...disclosures.find(item => item.product_id === id), expires_at: '2026-08-01T00:00:00+08:00' }) });
  assert.equal((await runResolvedWealthIntent(repository, stale, make('product_002'))).error.code, 'DISCLOSURE_EXPIRED');
  const result = await runResolvedWealthIntent(repository, ports(), make('product_002'));
  assert.equal(result.data.kind, 'action_request');
  assert.equal(result.data.requirements.minimumRiskLevel, 'L3');
  assert.deepEqual(result.data.request.input, { productId: 'product_002', amountFen: 10000, currency: 'CNY', sourceAccountId: 'ACC-CHECKING' });
  const frozenRepository = { ...repository, getAccount: async id => ({ ...(await repository.getAccount(id)), status: 'frozen' }) };
  assert.equal((await runResolvedWealthIntent(frozenRepository, ports(), make('product_002'))).error.code, 'ACCOUNT_UNAVAILABLE');
});

test('redeem validates holding amount and lock before returning L3 request', async () => {
  const { repository } = createFinancialContext();
  const make = (holdingId, quantityOrAmount) => resolved('wealth.redeem', { holding_id: holdingId, quantity_or_amount: quantityOrAmount }, [ref('holding_ref', 'investment_holding', holdingId)]);
  assert.equal((await runResolvedWealthIntent(repository, ports(), make('holding_missing', { kind: 'amount', amount_minor: 10000, currency: 'CNY' }))).error.code, 'HOLDING_NOT_FOUND');
  assert.equal((await runResolvedWealthIntent(repository, ports(), make('holding_001', { kind: 'amount', amount_minor: 999999, currency: 'CNY' }))).error.code, 'INSUFFICIENT_HOLDING');
  assert.equal((await runResolvedWealthIntent(repository, ports(), make('holding_003', { kind: 'units', units_milli: 1000 }))).error.code, 'REDEMPTION_RESTRICTED');
  const result = await runResolvedWealthIntent(repository, ports(), make('holding_001', { kind: 'units', units_milli: 1000 }));
  assert.equal(result.data.kind, 'action_request');
  assert.deepEqual(result.data.request.input, { holdingId: 'holding_001', quantityKind: 'units', unitsMilli: 1000 });
});

test('resolved contract enforces reference IDs and blocks injected authorization', () => {
  const value = resolved('wealth.subscribe', { product_id: 'product_002', amount: { amount_minor: 10000, currency: 'CNY' }, source_account_id: 'ACC-CHECKING' }, [ref('product_ref', 'investment_product', 'product_002'), ref('source_account_ref', 'account', 'ACC-CHECKING')]);
  assert.doesNotThrow(() => validateResolvedWealthIntent(value));
  assert.throws(() => validateResolvedWealthIntent({ ...value, confirmed: true }));
  assert.throws(() => validateResolvedWealthIntent({ ...value, references: [ref('product_ref', 'investment_product', 'product_001'), value.references[1]] }));
});

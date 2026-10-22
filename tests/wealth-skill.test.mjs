import test from 'node:test';
import assert from 'node:assert/strict';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { createWealthSkill, validateWealthAction } from '../src/skills/wealth/wealth-skill.mjs';

const run = () => createWealthSkill(createBankingCore().repository);

test('E wealth: recommendation filters risk, horizon, liquidity and amount with evidence', async () => {
  const result = await run()({ action: 'wealth.recommend', goal: '六个月应急金', max_risk_level: 'R2', horizon_days: 180, liquidity_requirement: 'T+1', amount: { amount_minor: 50000, currency: 'CNY' } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.products.map(item => item.product_ref), ['product_001', 'product_002']);
  assert.equal(result.data.methodology.personalized_suitability_completed, false);
  assert.equal(result.evidence[0].source, 'financial_context.investment_products');
});

test('E wealth: compare keeps source order and never guarantees yield', async () => {
  const result = await run()({ action: 'wealth.compare', product_refs: ['product_003', 'product_001'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.products.map(item => item.product_ref), ['product_003', 'product_001']);
  assert.equal(result.data.methodology.expected_yield_is_guaranteed, false);
  assert.match(result.data.disclaimer, /不构成投资建议/);
});

test('E wealth: assessment cannot be answered by model and writes stay unsupported', async () => {
  const skill = run();
  const assessment = await skill({ action: 'wealth.assess_risk', assessment_scope: 'investment_suitability' });
  assert.equal(assessment.data.model_may_answer_for_user, false);
  const subscribe = await skill({ action: 'wealth.subscribe', product_ref: 'product_001', amount: { amount_minor: 10000, currency: 'CNY' }, source_account_ref: '活期账户' });
  assert.equal(subscribe.ok, false); assert.equal(subscribe.kind, 'unsupported');
  assert.match(subscribe.error.message, /申购执行能力/);
});

test('E wealth: strict validation rejects invented fields and short comparisons', () => {
  assert.throws(() => validateWealthAction({ action: 'wealth.compare', product_refs: ['product_001'] }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validateWealthAction({ action: 'wealth.assess_risk', assessment_scope: 'investment_suitability', answers: [] }), { code: 'VALIDATION_ERROR' });
});

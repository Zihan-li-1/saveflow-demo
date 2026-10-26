import test from 'node:test';
import assert from 'node:assert/strict';
import { handleBankingAgent } from '../server/banking-agent.mjs';
import { createInMemoryScenarioStore, createScenarioSkill } from '../src/skills/scenario/scenario-skill.mjs';
import { createBankingCore } from '../src/banking-core/core.mjs';

const env = { SAVEFLOW_ACCESS_CODE: 'e-test-access-code', CONTINUATION_TOKEN_SECRET: 'e-test-continuation-secret', DASHSCOPE_API_KEY: 'unused' };
let requestNumber = 0;
const request = body => new Request('http://localhost/api/banking-agent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'x-forwarded-for': `e-test-${++requestNumber}` }, body: JSON.stringify({ history: [], consent: true, ...body }) });
const intent = (action, slots) => ({ schemaVersion: '1.0.0', action, slots, missingSlots: [], status: 'ready_for_resolution' });
const body = response => response.json();

test('E agent: product names reach wealth.compare through parser, dispatcher and HTTP', async () => {
  const parsed = intent('wealth.compare', { product_refs: ['模拟灵活现金 A', '模拟稳健现金 B'] });
  const response = await handleBankingAgent(request({ message: '比较两个产品' }), { env, parseIntent: async () => parsed, now: () => 1000 });
  const payload = await body(response);
  assert.equal(response.status, 200); assert.equal(payload.data.status, 'wealth_comparison');
  assert.deepEqual(payload.data.data.products.map(product => product.product_ref), ['product_001', 'product_002']);
  assert.equal(payload.data.data.methodology.expected_yield_is_guaranteed, false);
});

test('E agent: orchestrator goal returns read-only multi-step plan', async () => {
  const parsed = intent('orchestrator.goal', { goal_text: '看看这个月财务情况', horizon: '2026-08' });
  const response = await handleBankingAgent(request({ message: '看看财务情况' }), { env, parseIntent: async () => parsed, now: () => 2000 });
  const payload = await body(response);
  assert.equal(payload.data.status, 'goal_plan'); assert.equal(payload.data.data.execution_allowed, false);
  assert.ok(payload.data.data.steps.some(step => step.action === 'bill.analyze'));
  assert.ok(payload.data.data.steps.every(step => step.requires_confirmation === false));
});

test('E agent: scenario change is previewed, cancellation writes nothing, confirmation saves once', async () => {
  const store = createInMemoryScenarioStore();
  const scenarioHandler = createScenarioSkill({ store });
  const core = createBankingCore({ now: () => 4_000 });
  const parsed = intent('scenario.create_rule', { trigger: { type: 'financial_event', value: 'balance_changed' }, conditions: { balance_below_minor: 100000 }, proposed_steps: [{ action: 'bill.analyze', parameters: {} }], authorization_scope: 'suggest_only' });
  let response = await handleBankingAgent(request({ message: '创建规则' }), { env, core, parseIntent: async () => parsed, scenarioHandler, now: () => 3000 });
  let payload = await body(response);
  const cancelledRuleId = payload.data.data.rule.id;
  assert.equal(payload.data.status, 'scenario_rule_preview'); assert.equal(await core.getScenarioRule(cancelledRuleId), undefined);
  const cancelled = await handleBankingAgent(request({ continuationToken: payload.data.continuationToken, message: '取消' }), { env, core, parseIntent: async () => parsed, scenarioHandler, now: () => 3001 });
  assert.equal((await body(cancelled)).data.status, 'cancelled'); assert.equal(await core.getScenarioRule(cancelledRuleId), undefined);
  response = await handleBankingAgent(request({ message: '创建规则' }), { env, core, parseIntent: async () => parsed, scenarioHandler, now: () => 4000 });
  payload = await body(response);
  const ruleId = payload.data.data.rule.id;
  const confirmed = await handleBankingAgent(request({ continuationToken: payload.data.continuationToken, message: '确认保存' }), { env, core, parseIntent: async () => parsed, scenarioHandler, now: () => 4001 });
  const confirmedPayload = await body(confirmed);
  assert.equal(confirmedPayload.code, 'CONFIRMATION_REQUIRED'); assert.equal(await core.getScenarioRule(ruleId), undefined);
  await core.decide(payload.data.operationId, { previewHash: payload.data.preview.previewHash, decision: 'confirm', confirmedStepIds: payload.data.preview.stepIds });
  const receipt = await core.execute(payload.data.operationId, payload.data.preview.previewHash);
  assert.equal(receipt.ok, true); assert.equal((await core.getScenarioRule(ruleId)).status, 'active');
  const replay = await handleBankingAgent(request({ continuationToken: payload.data.continuationToken, message: '确认保存' }), { env, core, parseIntent: async () => parsed, scenarioHandler, now: () => 4002 });
  assert.equal((await body(replay)).code, 'CONFIRMATION_REQUIRED');
});

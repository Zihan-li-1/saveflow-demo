import test from 'node:test';
import assert from 'node:assert/strict';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { createWealthSkill } from '../src/skills/wealth/wealth-skill.mjs';
import { buildFinancialAnalysisContext } from '../server/financial-analysis-context.mjs';
import { handleBankingAgent } from '../server/banking-agent.mjs';

const env = { SAVEFLOW_ACCESS_CODE: 'test-access-code-1234', CONTINUATION_TOKEN_SECRET: 'test-continuation-secret-1234' };
const NOW = () => Date.parse('2026-10-26T04:00:00Z');

test('bill-driven recommend includes explainable bill_basis and never treats cash flow as investable', async () => {
  const core = createBankingCore();
  const financial = await buildFinancialAnalysisContext(core.repository, { now: NOW });
  assert.equal(financial.status, 'available');

  const result = await createWealthSkill(core.repository)(
    { action: 'wealth.recommend', goal: '根据账单流水推荐', max_risk_level: 'R2', horizon_days: 180, liquidity_requirement: 'T+1' },
    { financialContext: financial },
  );
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'wealth_recommendation');
  assert.ok(result.data.bill_basis, 'bill_basis should be present when financial analysis is provided');
  assert.equal(result.data.bill_basis.status, 'available');
  assert.ok(Number.isSafeInteger(result.data.bill_basis.summary.netCashFlowFen));
  assert.equal(result.data.bill_basis.summary.netCashFlowFen, result.data.bill_basis.summary.totalIncomeFen - result.data.bill_basis.summary.totalExpenseFen);
  assert.equal(result.data.bill_basis.coverage.completeness, 'unverified');
  assert.match(result.data.bill_basis.note, /不是可投资金额/);
  assert.equal(result.data.methodology.financial_analysis_used, true);
  assert.equal(result.data.methodology.net_cash_flow_is_investable, false);
  assert.equal(result.data.methodology.risk_level_source, 'user_declared_constraint');
  assert.equal(result.data.methodology.personalized_suitability_completed, false);
});

test('flat recommend without financial context keeps the original contract', async () => {
  const result = await createWealthSkill(createBankingCore().repository)(
    { action: 'wealth.recommend', goal: '六个月应急金', max_risk_level: 'R2', horizon_days: 180, liquidity_requirement: 'T+1', amount: { amount_minor: 50000, currency: 'CNY' } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.bill_basis, undefined);
  assert.deepEqual(result.data.products.map(item => item.product_ref), ['product_001', 'product_002']);
});

test('orchestrator wires bill analysis into wealth.recommend end-to-end without a write', async () => {
  const core = createBankingCore();
  const account = (await core.repository.getAccounts())[0];
  const intent = { schemaVersion: '1.0.0', action: 'wealth.recommend', slots: { goal: '根据账单流水推荐', max_risk_level: 'R2', horizon_days: 180, liquidity_requirement: 'T+1' }, missingSlots: [], status: 'ready_for_resolution' };
  const request = new Request('http://localhost/api/banking-agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'x-forwarded-for': 'bill-recommend-1' },
    body: JSON.stringify({ message: '根据我的账单流水推荐一些理财产品' }),
  });
  const response = await handleBankingAgent(request, { env, core, now: NOW, parseIntent: async () => intent });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.status, 'wealth_recommendation');
  assert.ok(body.data.data.bill_basis, 'orchestrator should thread buildFinancialAnalysisContext into the recommendation');
  assert.equal(body.data.data.bill_basis.status, 'available');
  assert.equal(body.data.data.methodology.financial_analysis_used, true);
  assert.equal(body.data.data.methodology.net_cash_flow_is_investable, false);
  // read-only recommendation: no balance change, no write operation exposed
  assert.equal((await core.repository.getAccount(account.id)).availableBalanceFen, account.availableBalanceFen);
  assert.equal(body.data.operationId, undefined);
});

test('阶段3验收句：真实 TrueForge 运行时把「根据我的账单流水推荐一些理财产品」识别为 wealth.recommend 并追问，而不是 bill.summary 或 TRUEFORGE_FORMAT_ERROR', async () => {
  const core = createBankingCore();
  // 只 mock TrueForge 理解服务的传输层；返回的是提示词要求的「账单驱动推荐 → wealth.recommend，缺风险/期限/流动性 → 逐项追问」。
  const trueforgeRuntimeClient = {
    createSession: async () => 'session-1',
    cancel: async () => {},
    runTurn: async () => JSON.stringify({ schemaVersion: '1.0.0', action: 'wealth.recommend', slots: {}, missingSlots: ['goal', 'max_risk_level', 'horizon_days', 'liquidity_requirement'], status: 'needs_clarification' }),
  };
  const request = new Request('http://localhost/api/banking-agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'x-forwarded-for': 'bill-recommend-clarify' },
    body: JSON.stringify({ message: '根据我的账单流水推荐一些理财产品' }),
  });
  const response = await handleBankingAgent(request, { env, core, now: NOW, trueforgeRuntimeClient });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.code, 'NEEDS_CLARIFICATION');
  assert.equal(body.data.status, 'needs_clarification');
  assert.equal(body.data.action, 'wealth.recommend');
  assert.equal(body.data.slot, 'goal');
  assert.equal(body.data.operationId, undefined);
  assert.ok(!JSON.stringify(body).includes('TRUEFORGE_FORMAT_ERROR'));
});

test('账单数据不可用时如实说明，而不是静默省略', async () => {
  const result = await createWealthSkill(createBankingCore().repository)(
    { action: 'wealth.recommend', goal: '根据账单流水推荐', max_risk_level: 'R2', horizon_days: 180, liquidity_requirement: 'T+1' },
    { financialContext: { status: 'unavailable', range: { months: [] }, summary: null, coverage: { completeness: 'unverified', missingMonths: [] }, source: {} } },
  );
  assert.equal(result.ok, true);
  assert.ok(result.data.bill_basis, 'unavailable 账单数据也必须如实呈现，不能被静默丢弃');
  assert.equal(result.data.bill_basis.status, 'unavailable');
  assert.equal(result.data.bill_basis.summary, undefined);
  assert.match(result.data.bill_basis.note, /没有可用的账单流水/);
  assert.equal(result.data.methodology.financial_analysis_used, false);
  assert.equal(result.data.methodology.net_cash_flow_is_investable, false);
});

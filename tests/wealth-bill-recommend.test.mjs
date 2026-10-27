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

test('阶段3（mock 传输层）：理解服务把「根据我的账单流水推荐一些理财产品」识别为 wealth.recommend 并追问，而不是 bill.summary 或 TRUEFORGE_FORMAT_ERROR', async () => {
  const core = createBankingCore();
  // 只 mock TrueForge 理解服务的传输层（未跑真实模型）；返回的是提示词要求的「账单驱动推荐 → wealth.recommend，缺风险/期限/流动性 → 逐项追问」。
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

test('账单覆盖状态会改变推荐解释与下一步（available vs partial），但产品筛选不变', async () => {
  const skill = createWealthSkill(createBankingCore().repository);
  const input = { action: 'wealth.recommend', goal: '根据账单流水推荐', max_risk_level: 'R2', horizon_days: 180, liquidity_requirement: 'T+1' };
  const availableCtx = { status: 'available', range: { months: ['2026-07', '2026-08', '2026-09'] }, summary: { totalIncomeFen: 1500000, totalExpenseFen: 900000, netCashFlowFen: 600000 }, coverage: { completeness: 'unverified', missingMonths: [], insufficientMonths: false }, source: {} };
  const partialCtx = { status: 'partial', range: { months: ['2026-07', '2026-09'] }, summary: { totalIncomeFen: 1000000, totalExpenseFen: 800000, netCashFlowFen: 200000 }, coverage: { completeness: 'unverified', missingMonths: ['2026-08'], insufficientMonths: true }, source: {} };
  const available = await skill(input, { financialContext: availableCtx });
  const partial = await skill(input, { financialContext: partialCtx });
  // 解释与下一步随可信账单证据发生变化。
  assert.ok(available.ok && partial.ok);
  assert.notEqual(available.data.next_step, partial.data.next_step);
  assert.notEqual(available.data.bill_basis.note, partial.data.bill_basis.note);
  assert.match(available.data.bill_basis.note, /不是可投资金额/);
  assert.match(available.data.bill_basis.note, /净流入为正/);
  assert.match(partial.data.bill_basis.note, /覆盖不完整/);
  assert.match(partial.data.bill_basis.note, /不代表零支出/);
  // 账单数据只改变解释，不改写产品筛选（同一用户声明约束 → 同一候选集合）。
  assert.deepEqual(available.data.products, partial.data.products);
  assert.deepEqual(available.data.constraints, partial.data.constraints);
});

test('账单净现金流不会改写风险等级与投资金额', async () => {
  const skill = createWealthSkill(createBankingCore().repository);
  const richCtx = { status: 'available', range: { months: ['2026-07', '2026-08', '2026-09'] }, summary: { totalIncomeFen: 5000000, totalExpenseFen: 1000000, netCashFlowFen: 4000000 }, coverage: { completeness: 'unverified', missingMonths: [], insufficientMonths: false }, source: {} };
  const result = await skill(
    { action: 'wealth.recommend', goal: '根据账单流水推荐', max_risk_level: 'R1', horizon_days: 365, liquidity_requirement: 'T+1', amount: { amount_minor: 100000, currency: 'CNY' } },
    { financialContext: richCtx },
  );
  assert.equal(result.ok, true);
  // 用户声明的约束原样保留，净现金流没有被注入为投资金额，也没有抬高风险档位。
  assert.equal(result.data.constraints.max_risk_level, 'R1');
  assert.equal(result.data.constraints.amount.amount_minor, 100000);
  assert.equal(result.data.methodology.net_cash_flow_is_investable, false);
  assert.equal(result.data.methodology.risk_level_source, 'user_declared_constraint');
  // 仅 R1 产品入选：净现金流再多也不把风险从 R1 抬到 R2/R3。
  assert.deepEqual(result.data.products.map(p => p.product_ref), ['product_001']);
  assert.ok(result.data.products.every(p => p.risk_level === 'R1'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { handleBankingAgent } from '../server/banking-agent.mjs';
import { createBankingCore } from '../src/banking-core/core.mjs';

const env = { SAVEFLOW_ACCESS_CODE: 'savings-test-access', CONTINUATION_TOKEN_SECRET: 'savings-test-secret-123', DASHSCOPE_API_KEY: 'unused' };
const now = () => Date.parse('2026-10-22T12:00:00+08:00');
const intent = { schemaVersion: '1.0.0', action: 'orchestrator.goal', slots: { goal_text: '年底存够一万元', amount: { amount_minor: 1000000, currency: 'CNY' }, deadline: '2026-12-31' }, missingSlots: [], status: 'ready_for_resolution' };
const expenses = { 房租: 300000, 餐饮: 145000, 交通: 40000, 通信: 10000, 日用品: 50000, 娱乐: 112000, 购物: 128000, 订阅: 9000, 其他: 52000 };
const planInputs = { month: '2026-09', saved_amount_minor: 0, income_minor: 1200000, category_expenses_minor: expenses };
const advice = { observations: [], category_budgets: Object.entries(expenses).map(([category, suggested_minor]) => ({ category, suggested_minor, reason: '按近期支出暂作参考', evidence_refs: [`recent:${category}`] })), caveats: ['收入与支出来自用户填写'], self_review: { passed: true, data_coverage: true, category_evidence: true, fixed_costs: true, budget_totals: true, uncertainty: true, failed_items: [] } };
let serial = 0;
const request = data => new Request('http://localhost/api/banking-agent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'x-forwarded-for': `savings-${++serial}` }, body: JSON.stringify({ history: [], consent: true, ...data }) });
const options = { env, now, parseIntent: async () => intent, savingsAdvisor: async facts => {
  const category = '购物';
  const previous = facts.history.map(month => month.category_expenses_minor[category]).filter(Number.isSafeInteger);
  const average = previous.reduce((sum, value) => sum + value, 0) / previous.length;
  const difference = facts.recent.category_expenses_minor[category] - average;
  const trend = difference > Math.max(1000, average * .1) ? 'up' : difference < -Math.max(1000, average * .1) ? 'down' : 'flat';
  return { ...advice, observations: [{ category, trend, evidence_refs: [`recent:${category}`, `history:${facts.history[0].month}:${category}`], reason: '近期与历史演示数据仅供参考', uncertain: true }] };
} };

test('savings goal asks for recent category data before producing a verified card', async () => {
  const initial = await (await handleBankingAgent(request({ message: '我要年底存够一万' }), options)).json();
  assert.equal(initial.data.status, 'needs_plan_inputs');
  assert.equal(initial.data.requiredMonth, '2026-09');
  assert.equal(initial.data.recentSource, 'user_provided');
  assert.deepEqual(initial.data.goal, { target_amount_minor: 1000000, deadline: '2026-12-31' });
  assert.ok(initial.data.continuationToken);
  const final = await (await handleBankingAgent(request({ continuationToken: initial.data.continuationToken, planInputs }), options)).json();
  assert.equal(final.data.status, 'goal_plan');
  assert.equal(final.data.data.verification_status, 'verified');
  assert.equal(final.data.data.calculation.required_monthly_minor, 500000);
  assert.equal(final.data.data.advice.feasible, false);
  assert.equal(final.data.data.execution_allowed, false);
});

test('plan input token is bound to goal and invalid model advice never yields a card', async () => {
  const initial = await (await handleBankingAgent(request({ message: '我要年底存够一万' }), options)).json();
  const bad = await (await handleBankingAgent(request({ continuationToken: initial.data.continuationToken, planInputs: { ...planInputs, month: '2026-08' } }), options)).json();
  assert.notEqual(bad.data?.status, 'goal_plan');
  const failed = await (await handleBankingAgent(request({ continuationToken: initial.data.continuationToken, planInputs }), { ...options, savingsAdvisor: async () => ({ ...advice, self_review: { ...advice.self_review, passed: false } }) })).json();
  assert.notEqual(failed.data?.status, 'goal_plan');
});

test('a deadline before the next full month is rejected before asking for category data', async () => {
  const tooSoon = { ...intent, slots: { ...intent.slots, deadline: '2026-10-31' } };
  const response = await (await handleBankingAgent(request({ message: '本月底存够一万' }), { ...options, parseIntent: async () => tooSoon })).json();
  assert.equal(response.code, 'DEADLINE_TOO_SOON');
  assert.notEqual(response.data?.status, 'needs_plan_inputs');
});

test('fresh repository figures replace the recent form and user cannot override income or categories', async () => {
  const base = createBankingCore().repository;
  const context = await base.getContextInfo();
  const september = (await base.getTransactions({ month: '2026-08' })).map(item => ({ ...item, id: `${item.id}-september`, occurredAt: item.occurredAt.replace('2026-08', '2026-09') }));
  const repository = { ...base,
    getContextInfo: async () => ({ ...context, asOf: '2026-10-01T00:00:00+08:00', snapshotId: 'fresh-september', availableMonths: [...context.availableMonths, '2026-09'], completeMonths: ['2026-09'] }),
    getTransactions: async filter => filter.month === '2026-09' ? september : base.getTransactions(filter),
  };
  let modelFacts;
  const enhanced = { ...options, repository, savingsAdvisor: async facts => { modelFacts = facts; return options.savingsAdvisor(facts); } };
  const initial = await (await handleBankingAgent(request({ message: '我要年底存够一万' }), enhanced)).json();
  assert.equal(initial.data.recentSource, 'repository');
  assert.equal(initial.data.recent.income_minor, 1200000);
  const override = await (await handleBankingAgent(request({ continuationToken: initial.data.continuationToken, planInputs }), enhanced)).json();
  assert.equal(override.code, 'PLAN_INPUT_INVALID');
  const final = await (await handleBankingAgent(request({ continuationToken: initial.data.continuationToken, planInputs: { saved_amount_minor: 0 } }), enhanced)).json();
  assert.equal(final.data.status, 'goal_plan');
  assert.equal(final.data.data.recent_source, 'repository');
  assert.equal(final.data.data.recent.month, '2026-09');
  assert.ok(modelFacts.history.every(item => item.month < '2026-09'));
  assert.equal(modelFacts.sources.recent, 'repository');
  assert.equal(final.data.evidence.at(-1).source, 'synthetic_demo_only');
});

test('a changed repository snapshot invalidates the signed plan form before analysis', async () => {
  const base = createBankingCore().repository;
  const context = await base.getContextInfo();
  let snapshotId = context.snapshotId;
  const repository = { ...base, getContextInfo: async () => ({ ...context, snapshotId }) };
  const enhanced = { ...options, repository };
  const initial = await (await handleBankingAgent(request({ message: '我要年底存够一万' }), enhanced)).json();
  snapshotId = 'new-snapshot';
  const changed = await (await handleBankingAgent(request({ continuationToken: initial.data.continuationToken, planInputs }), enhanced)).json();
  assert.equal(changed.code, 'SOURCE_CHANGED');
  assert.notEqual(changed.data?.status, 'goal_plan');
});

test('verified savings plan carries its deadline into a separate read-only Wealth screening', async () => {
  const core = createBankingCore({ now });
  const initial = await (await handleBankingAgent(request({ message: '我要年底存够一万' }), { ...options, core })).json();
  const plan = await (await handleBankingAgent(request({ continuationToken: initial.data.continuationToken, planInputs }), { ...options, core })).json();
  assert.equal(plan.data.status, 'goal_plan');
  assert.equal(typeof plan.data.wealthHandoffToken, 'string');
  const wealthInputs = { max_risk_level: 'R2', investable_amount_minor: 100000, liquidity_requirement: 'T+1' };
  const bypass = await (await handleBankingAgent(request({ continuationToken: plan.data.wealthHandoffToken, message: '直接推荐理财产品' }), { ...options, core,
    parseIntent: async () => ({ schemaVersion: '1.0.0', action: 'wealth.recommend', slots: { goal: { kind: 'steady_growth', target_date: '2026-12-31' } }, missingSlots: [], status: 'ready_for_resolution' }) })).json();
  assert.equal(bypass.code, 'WEALTH_INPUT_REQUIRED');
  const invented = await (await handleBankingAgent(request({ continuationToken: plan.data.wealthHandoffToken, wealthInputs: { ...wealthInputs, target_date: '2027-12-31' } }), { ...options, core })).json();
  assert.equal(invented.code, 'WEALTH_INPUT_INVALID');
  const mixed = await (await handleBankingAgent(request({ continuationToken: plan.data.wealthHandoffToken, wealthInputs, message: '立即申购' }), { ...options, core })).json();
  assert.equal(mixed.code, 'INVALID_REQUEST');
  const screening = await (await handleBankingAgent(request({ continuationToken: plan.data.wealthHandoffToken, wealthInputs }), { ...options, core })).json();
  assert.equal(screening.data.status, 'wealth_result');
  assert.equal(screening.data.action, 'wealth.recommend');
  assert.equal(screening.data.data.kind, 'recommendation');
  assert.deepEqual(screening.data.data.screening_context, { target_date: '2026-12-31', investable_amount_minor: 100000, max_risk_level: 'R2', liquidity_requirement: 'T+1', source: 'verified_savings_plan' });
  assert.equal(screening.data.operationId, undefined);
  assert.equal((await core.repository.getAccounts())[0].availableBalanceFen, (await createBankingCore({ now }).repository.getAccounts())[0].availableBalanceFen);

  const replay = await (await handleBankingAgent(request({ continuationToken: plan.data.wealthHandoffToken, wealthInputs }), { ...options, core })).json();
  assert.equal(replay.code, 'CONTINUATION_STALE');
  const unrelated = await (await handleBankingAgent(request({ continuationToken: initial.data.continuationToken, wealthInputs }), { ...options, core })).json();
  assert.notEqual(unrelated.data.status, 'wealth_result');
});

test('a savings plan still works when the host has no Wealth port', async () => {
  const repository = createBankingCore({ now }).repository;
  const core = createBankingCore({ repository, now });
  const initial = await (await handleBankingAgent(request({ message: '我要年底存够一万' }), { ...options, core })).json();
  const plan = await (await handleBankingAgent(request({ continuationToken: initial.data.continuationToken, planInputs }), { ...options, core })).json();
  assert.equal(plan.data.status, 'goal_plan');
  assert.equal(plan.data.wealthHandoffToken, undefined);
});

test('missing trusted risk assessment returns the questionnaire without a product screening context', async () => {
  const seeded = createBankingCore({ now });
  const core = createBankingCore({ now, wealthPorts: { ...seeded.wealthPorts, getRiskAssessment: async () => null } });
  const initial = await (await handleBankingAgent(request({ message: '我要年底存够一万' }), { ...options, core })).json();
  const plan = await (await handleBankingAgent(request({ continuationToken: initial.data.continuationToken, planInputs }), { ...options, core })).json();
  const screening = await (await handleBankingAgent(request({ continuationToken: plan.data.wealthHandoffToken, wealthInputs: { max_risk_level: 'R2', investable_amount_minor: 100000, liquidity_requirement: 'T+1' } }), { ...options, core })).json();
  assert.equal(screening.data.status, 'wealth_result');
  assert.equal(screening.data.data.kind, 'questionnaire_required');
  assert.equal(screening.data.data.screening_context, undefined);
  assert.equal(screening.data.data.questionnaire.source, 'trusted_ui');
});


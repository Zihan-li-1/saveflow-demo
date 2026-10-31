/* eslint-disable @typescript-eslint/no-require-imports -- Render actual TSX components in Node. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  const source = readFileSync(filename, 'utf8').replace(/from "@\/lib\//g, 'from "../lib/');
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, filename);
};
require.extensions['.css'] = () => {};
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { BankingReadCard } = require('../src/app/BankingReadCards.tsx');
const { BankingSavingsInputsCard, BankingSavingsPlanCard } = require('../src/app/BankingSavingsCards.tsx');
const { BankingWealthResult } = require('../src/app/BankingWealthCards.tsx');
const { askBankingAgent } = require('../src/lib/banking-agent-client.ts');
const { saveBankingChat, restoreBankingChat } = require('../src/lib/banking-chat-storage.ts');
const render = (Component, data) => renderToStaticMarkup(React.createElement(Component, { data, onSubmit: () => {} }));

test('generic plan step action IDs become Chinese user-facing titles', () => {
  const html = render(BankingReadCard, { status: 'goal_plan', data: { steps: [{ action: 'bill.analyze', reason: '先核对收支' }, { action: 'wealth.recommend', reason: '仅供筛选' }] }, evidence: [{ source: 'synthetic_demo_only', asOf: '2026-09-01T00:00:00+08:00' }] });
  assert.match(html, /分析收支/);
  assert.match(html, /筛选理财产品/);
  assert.doesNotMatch(html, /bill\.analyze|wealth\.recommend/);
});

test('理财产品对比卡片展示微众银行入口链接', () => {
  const html = render(BankingReadCard, { status: 'wealth_comparison', action: 'wealth.compare', data: { products: [
    { product_ref: 'product_001', name: '模拟灵活现金 A', risk_level: 'R1', expected_yield_bps: 150, minimum_amount_minor: 100, liquidity: 'T+0', duration_days: 0, currency: 'CNY' },
    { product_ref: 'product_002', name: '模拟稳健现金 B', risk_level: 'R2', expected_yield_bps: 320, minimum_amount_minor: 10000, liquidity: 'T+1', duration_days: 180, currency: 'CNY' },
  ] } });
  assert.equal((html.match(/前往微众银行理财界面查看 →/g) || []).length, 2);
  assert.equal((html.match(/https:\/\/personal\.webank\.com\/s\/hj\/focus2\/client\/index\.html\?fid=1912&amp;aid=10482&amp;bg=_ffffff/g) || []).length, 2);
});

test('missing data card requests saved amount, income and every category without showing a plan', () => {
  const html = render(BankingSavingsInputsCard, { status: 'needs_plan_inputs', goal: { target_amount_minor: 1000000, deadline: '2026-12-31' }, recentSource: 'user_provided', requiredMonth: '2026-09', categories: ['房租', '购物'], continuationToken: 'opaque' });
  for (const label of ['2026-09', '本目标已存金额', '月收入', '房租', '购物', '¥10,000.00', '2026-12-31']) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /每月最低需存/);
});

test('repository-backed input card only asks for saved amount and shows the trusted snapshot', () => {
  const html = render(BankingSavingsInputsCard, { status: 'needs_plan_inputs', goal: { target_amount_minor: 1000000, deadline: '2026-12-31' }, recentSource: 'repository', recent: { month: '2026-09', income_minor: 1200000, category_expenses_minor: { 房租: 420000, 购物: 128000 } }, requiredMonth: '2026-09', categories: ['房租', '购物'], continuationToken: 'opaque' });
  for (const label of ['演示账单已覆盖最近完整月', '¥12,000.00', '¥4,200.00', '¥1,280.00', '本目标已存金额']) assert.ok(html.includes(label), label);
  assert.equal((html.match(/<input/g) || []).length, 1);
  assert.doesNotMatch(html, /月收入（元）|按消费类别填写/);
});

test('verified plan card shows target math, category comparison and data provenance', () => {
  const html = render(BankingSavingsPlanCard, { status: 'goal_plan', data: { verification_status: 'verified', recent: { month: '2026-09', category_expenses_minor: { 购物: 128000 } }, calculation: { target_amount_minor: 1000000, saved_amount_minor: 0, remaining_minor: 1000000, deadline: '2026-12-31', required_monthly_minor: 500000, observed_income_minor: 1200000, observed_expense_minor: 846000, observed_surplus_minor: 354000, monthly_gap_minor: 146000, opportunity_dates: ['2026-11-01', '2026-12-01'] }, advice: { feasible: false, proposed_expense_minor: 100000, remaining_gap_minor: 146000, category_budgets: [{ category: '购物', suggested_minor: 100000, reason: '适度降低', evidence_refs: ['recent:购物'] }], observations: [{ category: '购物', trend: 'up', reason: '近期偏高', evidence_refs: ['recent:购物', 'history:2026-08:购物'], uncertain: true }], caveats: [] } }, evidence: [{ source: 'user_provided', asOf: '2026-10-22', entityIds: [] }] });
  for (const label of ['¥10,000.00', '¥5,000.00', '¥1,460.00', '购物', '用户填写', '2026-09', '消费习惯观察', '历史演示数据', '类别依据', '建议能否执行', '分类建议支出合计', '¥1,000.00']) assert.ok(html.includes(label), label);
});

test('verified plan offers separate Wealth inputs without pre-filling goal money as investable cash', () => {
  const data = { status: 'goal_plan', wealthHandoffToken: 'signed-handoff', data: { verification_status: 'verified', recent: { month: '2026-09', category_expenses_minor: {} }, calculation: { target_amount_minor: 1000000, saved_amount_minor: 0, remaining_minor: 1000000, deadline: '2026-12-31', opportunity_dates: ['2026-11-01', '2026-12-01'], required_monthly_minor: 500000, observed_income_minor: 1000000, observed_expense_minor: 0, observed_surplus_minor: 1000000, monthly_gap_minor: 0 }, advice: { feasible: true, proposed_expense_minor: 0, remaining_gap_minor: 0, observations: [], category_budgets: [], caveats: [] } } };
  const html = renderToStaticMarkup(React.createElement(BankingSavingsPlanCard, { data, onWealth: () => {} }));
  for (const label of ['目标日 2026-12-31', '独立可投资金额', '风险上限', '资金取用要求', '只读筛选']) assert.match(html, new RegExp(label));
  assert.match(html, /name="investable_amount"[^>]*value=""/);
});

test('Wealth result tells the user which savings deadline and separate cash amount were screened', () => {
  const html = renderToStaticMarkup(React.createElement(BankingWealthResult, { data: { status: 'wealth_result', data: { kind: 'recommendation', matches: [], as_of: '2026-10-23T00:00:00+08:00', screening_context: { target_date: '2026-12-31', investable_amount_minor: 100000, max_risk_level: 'R2', liquidity_requirement: 'T+1', source: 'verified_savings_plan' } } } }));
  for (const value of ['2026-12-31', '¥1,000.00', 'R2', '下一个工作日']) assert.match(html, new RegExp(value));
});

test('plan form continuation survives a short pause but expires within its bounded window', () => {
  const token = `${'a'.repeat(16)}.${'b'.repeat(22)}.${'c'.repeat(30)}`;
  const messages = [{ id: 1, role: 'agent', kind: 'banking_savings_inputs', text: '请补充', banking: { status: 'needs_plan_inputs', action: 'orchestrator.goal', continuationToken: token } }];
  const raw = saveBankingChat(messages, token, 1000, 2000);
  assert.equal(restoreBankingChat(raw, 600000).continuation, token);
  assert.equal(restoreBankingChat(raw, 1801001).continuation, null);
});

test('browser accepts plan-input request and rejects a forged calculation', async () => {
  const oldFetch = global.fetch;
  const wrap = data => ({ ok: true, status: 200, json: async () => ({ code: data.status === 'needs_plan_inputs' ? 'NEEDS_PLAN_INPUTS' : 'OK', requestId: 'request-1', message: 'plan', reply: { text: 'plan', style: 'concise', safetyNotices: [] }, data }) });
  try {
    global.fetch = async () => wrap({ status: 'needs_plan_inputs', action: 'orchestrator.goal', goal: { target_amount_minor: 1000000, deadline: '2026-12-31' }, recentSource: 'user_provided', requiredMonth: '2026-09', categories: ['房租'], continuationToken: 'opaque-token' });
    assert.equal((await askBankingAgent({ message: '年底存一万' }, 'access', new AbortController().signal)).status, 'needs_plan_inputs');
    global.fetch = async () => wrap({ status: 'goal_plan', action: 'orchestrator.goal', data: { verification_status: 'verified', calculation: { target_amount_minor: 1000000, saved_amount_minor: 0, remaining_minor: 1000000, opportunity_dates: ['2026-11-01', '2026-12-01'], required_monthly_minor: 1, observed_income_minor: 1200000, observed_expense_minor: 846000, observed_surplus_minor: 354000, monthly_gap_minor: 146000 }, advice: { category_budgets: [], proposed_expense_minor: 0, feasible: false, remaining_gap_minor: 1 }, execution_allowed: false }, evidence: [] });
    await assert.rejects(() => askBankingAgent({ message: '年底存一万' }, 'access', new AbortController().signal), { code: 'BANKING_AGENT_RESPONSE_ERROR' });
    global.fetch = async () => wrap({ status: 'goal_plan', action: 'orchestrator.goal', data: { targetAmountFen: 1000000, deadline: '2026-12-31', steps: [], execution_allowed: false }, evidence: [] });
    await assert.rejects(() => askBankingAgent({ message: '年底存一万' }, 'access', new AbortController().signal), { code: 'BANKING_AGENT_RESPONSE_ERROR' });
  } finally { global.fetch = oldFetch; }
});

test('browser rejects forged Wealth screening context', async () => {
  const oldFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: 'OK', requestId: 'request-wealth', message: 'wealth', reply: { text: 'wealth', style: 'concise', safetyNotices: [] }, data: { status: 'wealth_result', action: 'wealth.recommend', data: { kind: 'recommendation', synthetic_demo_only: true, as_of: '2026-10-23T00:00:00+08:00', context_snapshot_id: 'snapshot', evidence: [], matches: [], screening_context: { source: 'verified_savings_plan', target_date: '2026-12-31', investable_amount_minor: 100000, max_risk_level: 'R4', liquidity_requirement: 'T+1' } } } }) });
    await assert.rejects(() => askBankingAgent({ message: '筛选' }, 'access', new AbortController().signal), { code: 'BANKING_AGENT_RESPONSE_ERROR' });
  } finally { global.fetch = oldFetch; }
});

test('browser accepts the trusted questionnaire step when screening cannot proceed', async () => {
  const oldFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: 'OK', requestId: 'request-risk', message: '先测评', reply: { text: '请先测评', style: 'concise', safetyNotices: [] }, data: { status: 'wealth_result', action: 'wealth.recommend', data: { kind: 'questionnaire_required', questionnaire: { source: 'trusted_ui', route: '/wealth/risk-assessment' }, synthetic_demo_only: true, as_of: '2026-10-23T00:00:00+08:00', context_snapshot_id: 'snapshot', evidence: [] } } }) });
    assert.equal((await askBankingAgent({ message: '筛选' }, 'access', new AbortController().signal)).data.kind, 'questionnaire_required');
  } finally { global.fetch = oldFetch; }
});


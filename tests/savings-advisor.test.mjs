import test from 'node:test';
import assert from 'node:assert/strict';
import { requestSavingsAdvice, verifySavingsAdvice } from '../server/savings-advisor.mjs';

const recent = { month: '2026-09', income_minor: 1200000, category_expenses_minor: { 房租: 300000, 餐饮: 145000, 交通: 40000, 通信: 10000, 日用品: 50000, 娱乐: 112000, 购物: 128000, 订阅: 9000, 其他: 52000 } };
const facts = { recent, history: [{ month: '2026-08', category_expenses_minor: { ...recent.category_expenses_minor } }], sources: { recent: 'user_provided', recent_as_of: '2026-10-22', history: 'synthetic_demo_only', history_as_of: '2026-09-01T00:00:00+08:00' }, required_monthly_minor: 500000 };
const budgets = Object.entries(recent.category_expenses_minor).map(([category, suggested_minor]) => ({ category, suggested_minor, reason: '按最近完整月金额暂作参考', evidence_refs: [`recent:${category}`] }));
const advice = { observations: [{ category: '购物', trend: 'flat', evidence_refs: ['recent:购物', 'history:2026-08:购物'], reason: '两个月支出相近', uncertain: true }], category_budgets: budgets, caveats: ['仅按合成历史和用户填写的近期数据推测'], self_review: { passed: true, data_coverage: true, category_evidence: true, fixed_costs: true, budget_totals: true, uncertainty: true, failed_items: [] } };

test('verified advice retains evidence and reports unaffordable budget without calling it feasible', () => {
  const result = verifySavingsAdvice(advice, facts);
  assert.equal(result.proposed_expense_minor, 846000);
  assert.equal(result.feasible, false);
  assert.equal(result.remaining_gap_minor, 146000);
  assert.equal(result.observations[0].category, '购物');
});

test('model self-check, categories, evidence and fixed costs are independently checked', () => {
  assert.throws(() => verifySavingsAdvice({ ...advice, self_review: { ...advice.self_review, passed: false } }, facts), { code: 'ADVICE_REVIEW_FAILED' });
  assert.throws(() => verifySavingsAdvice({ ...advice, category_budgets: [...budgets, { ...budgets[0], category: '虚构' }] }, facts), { code: 'ADVICE_REVIEW_FAILED' });
  assert.throws(() => verifySavingsAdvice({ ...advice, observations: [{ ...advice.observations[0], evidence_refs: ['history:2026-07:购物'] }] }, facts), { code: 'ADVICE_REVIEW_FAILED' });
  assert.throws(() => verifySavingsAdvice({ ...advice, observations: [{ ...advice.observations[0], trend: 'up' }] }, facts), { code: 'ADVICE_REVIEW_FAILED' });
  assert.throws(() => verifySavingsAdvice({ ...advice, observations: [] }, facts), { code: 'ADVICE_REVIEW_FAILED' });
  assert.throws(() => verifySavingsAdvice({ ...advice, category_budgets: budgets.map(item => item.category === '购物' ? { ...item, reason: '下月可节省 ¥9999' } : item) }, facts), { code: 'ADVICE_REVIEW_FAILED' });
  assert.throws(() => verifySavingsAdvice({ ...advice, category_budgets: budgets.map(item => item.category === '房租' ? { ...item, suggested_minor: 100000 } : item) }, facts), { code: 'ADVICE_REVIEW_FAILED' });
});

test('unverified model prose never appears on a verified plan', () => {
  const unsafe = { ...advice,
    observations: [{ ...advice.observations[0], reason: '保证收益并立即申购' }],
    category_budgets: budgets.map(item => item.category === '购物' ? { ...item, reason: '保证收益并立即申购' } : item),
    caveats: ['保证收益并立即申购'] };
  const result = verifySavingsAdvice(unsafe, facts);
  assert.doesNotMatch(JSON.stringify(result), /保证收益|立即申购/);
  assert.match(result.category_budgets.find(item => item.category === '购物').reason, /历史有该类别记录的1个月月均约¥1280.00/);
});

test('Qwen advice call accepts only structured JSON and never sends raw transactions', async () => {
  let request;
  const fetchImpl = async (_url, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(advice) } }] }) }; };
  const result = await requestSavingsAdvice(facts, { env: { DASHSCOPE_API_KEY: 'test-key' }, fetchImpl });
  assert.equal(result.self_review.passed, true);
  assert.equal(request.response_format.type, 'json_object');
  assert.equal(JSON.parse(request.messages[1].content).sources.recent, 'user_provided');
  assert.equal(JSON.stringify(request).includes('card_number'), false);
});


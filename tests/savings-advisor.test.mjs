import test from 'node:test';
import assert from 'node:assert/strict';
import { requestSavingsAdvice, verifySavingsAdvice } from '../server/savings-advisor.mjs';
import { createSavingsAdviceRuntimeClient, savingsAdviceAgentSpec } from '../server/trueforge-savings-runtime.mjs';
import { savingsAdviceFixture, savingsSdkFixture } from './fixtures/savings-runtime.mjs';

const recent = { month: '2026-09', income_minor: 1200000, category_expenses_minor: { 房租: 300000, 餐饮: 145000, 交通: 40000, 通信: 10000, 日用品: 50000, 娱乐: 112000, 购物: 128000, 订阅: 9000, 其他: 52000 } };
const facts = { recent, history: [{ month: '2026-08', category_expenses_minor: { ...recent.category_expenses_minor } }], sources: { recent: 'user_provided', recent_as_of: '2026-10-22', history: 'synthetic_demo_only', history_as_of: '2026-09-01T00:00:00+08:00' }, required_monthly_minor: 500000 };
const budgets = Object.entries(recent.category_expenses_minor).map(([category, suggested_minor]) => ({ category, suggested_minor, reason: '按最近完整月金额暂作参考', evidence_refs: [`recent:${category}`] }));
const advice = savingsAdviceFixture(facts);
const env = { TRUEFORGE_BASE_URL: 'http://localhost:8790', TRUEFORGE_MODEL: 'test/deepseek-v4-1-flash' };

test('verified advice retains evidence and reports unaffordable budget without calling it feasible', () => {
  const result = verifySavingsAdvice(advice, facts);
  assert.equal(result.proposed_expense_minor, 846000);
  assert.equal(result.feasible, false);
  assert.equal(result.remaining_gap_minor, 146000);
  assert.ok(result.observations.some(item => item.category === '购物'));
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
    observations: advice.observations.map(item => ({ ...item, reason: '保证收益并立即申购' })),
    category_budgets: budgets.map(item => item.category === '购物' ? { ...item, reason: '保证收益并立即申购' } : item),
    caveats: ['保证收益并立即申购'] };
  const result = verifySavingsAdvice(unsafe, facts);
  assert.doesNotMatch(JSON.stringify(result), /保证收益|立即申购/);
  assert.match(result.category_budgets.find(item => item.category === '购物').reason, /历史有该类别记录的1个月月均约¥1280.00/);
});

test('DeepSeek advice succeeds without DashScope and sends only projected aggregate fields', async () => {
  const sdk = savingsSdkFixture({ env, output: JSON.stringify(advice) });
  const client = createSavingsAdviceRuntimeClient({ env, sdk });
  const extra = { ...facts, transactions: ['secret'], continuationToken: 'secret',
    recent: { ...facts.recent, card_number: 'secret' }, history: facts.history.map(item => ({ ...item, transactions: ['secret'] })),
    sources: { ...facts.sources, api_key: 'secret' } };
  const result = await requestSavingsAdvice(extra, { env, client });
  assert.equal(result.self_review.passed, true);
  assert.equal(verifySavingsAdvice(result, facts).remaining_gap_minor, 146000);
  assert.deepEqual(JSON.parse(sdk.seen.inputs[0].request.input[0].content), facts);
  assert.doesNotMatch(JSON.stringify(sdk.seen.creates) + JSON.stringify(sdk.seen.inputs), /secret|card_number|transactions|ParsedIntent/);
  assert.equal(sdk.seen.creates[0].agent.spec.model.name, env.TRUEFORGE_MODEL);
  assert.equal(sdk.seen.creates[0].agent.spec.responseFormat.type, 'json_object');
  await requestSavingsAdvice(facts, { env, client });
  assert.notEqual(sdk.seen.inputs[0].id, sdk.seen.inputs[1].id);
});

for (const [name, change] of [
  ['extra top field', a => { a.feasible = true; }],
  ['missing field', a => { delete a.caveats; }],
  ['null', a => { a.self_review = null; }],
  ['wrong array type', a => { a.observations = {}; }],
  ['extra nested field', a => { a.category_budgets[0].execute = true; }],
  ['string failed_items', a => { a.self_review.failed_items = ''; }],
  ['failed self review', a => { a.self_review.passed = false; a.self_review.failed_items = ['证据不足']; }],
  ['failed individual check', a => { a.self_review.fixed_costs = false; }],
  ['missing category', a => { a.category_budgets.pop(); }],
  ['duplicate category', a => { a.category_budgets[1] = a.category_budgets[0]; }],
  ['invented category', a => { a.category_budgets[0].category = '虚构类别'; }],
  ['missing observation', a => { a.observations.pop(); }],
  ['duplicate observation', a => { a.observations[1] = a.observations[0]; }],
  ['unknown month', a => { a.observations[0].evidence_refs[1] = 'history:2026-07:房租'; }],
  ['unrelated category evidence', a => { a.observations[0].evidence_refs[1] = 'history:2026-08:购物'; }],
  ['wrong trend', a => { a.observations[0].trend = 'up'; }],
  ['unrecognized trend', a => { a.observations[0].trend = 'rising'; }],
  ['no recent evidence', a => { a.category_budgets[0].evidence_refs = ['history:2026-08:房租']; }],
  ['rent reduction', a => { a.category_budgets[0].suggested_minor--; }],
  ['communications reduction', a => { a.category_budgets.find(item => item.category === '通信').suggested_minor--; }],
  ['negative money', a => { a.category_budgets[1].suggested_minor = -1; }],
  ['fractional money', a => { a.category_budgets[1].suggested_minor = .5; }],
  ['string money', a => { a.category_budgets[1].suggested_minor = '100'; }],
  ['out of range money', a => { a.category_budgets[1].suggested_minor = 10_000_000_001; }],
  ['unsafe integer', a => { a.category_budgets[1].suggested_minor = Number.MAX_SAFE_INTEGER + 1; }],
  ['reason digits', a => { a.category_budgets[0].reason = '节省１２元'; }],
  ['currency symbol', a => { a.observations[0].reason = '预算增加美元$'; }],
  ['blank reason', a => { a.category_budgets[0].reason = ' '; }],
  ['long caveat', a => { a.caveats = ['长'.repeat(201)]; }],
  ['uncertain false', a => { a.observations[0].uncertain = false; }],
]) test(`independent review rejects ${name}`, () => {
  const candidate = structuredClone(advice); change(candidate);
  assert.throws(() => verifySavingsAdvice(candidate, facts), { code: 'ADVICE_REVIEW_FAILED' });
});

test('empty or disjoint history needs no observations and must not invent any', () => {
  for (const history of [[], [{ month: '2026-08', category_expenses_minor: { 医疗: 10000 } }]]) {
    const input = { ...facts, history };
    const candidate = { ...advice, observations: [] };
    assert.equal(verifySavingsAdvice(candidate, input).remaining_gap_minor, 146000);
    assert.throws(() => verifySavingsAdvice(advice, input), { code: 'ADVICE_REVIEW_FAILED' });
  }
});

test('missing historical categories are unknown and threshold boundaries are strict', () => {
  for (const [baseline, amount, trend] of [[10000, 11000, 'flat'], [10000, 11001, 'up'], [10000, 9000, 'flat'], [10000, 8999, 'down'], [100000, 110000, 'flat'], [100000, 110001, 'up']]) {
    const input = { ...facts, recent: { ...recent, category_expenses_minor: { 购物: amount } },
      history: [{ month: '2026-08', category_expenses_minor: { 购物: baseline } }, { month: '2026-07', category_expenses_minor: {} }] };
    const candidate = savingsAdviceFixture(input); candidate.observations[0].trend = trend;
    assert.equal(verifySavingsAdvice(candidate, input).observations[0].trend, trend);
    candidate.observations[0].evidence_refs[1] = 'history:2026-07:购物';
    assert.throws(() => verifySavingsAdvice(candidate, input), { code: 'ADVICE_REVIEW_FAILED' });
  }
});

for (const output of ['invalid JSON', '```json\n{}\n```', '{}', JSON.stringify({ ...advice, extra: true }), JSON.stringify({ ...advice, self_review: null }), 'x'.repeat(24001)]) {
  test(`runtime rejects malformed/invalid JSON (${output.length} chars) and cancels`, async () => {
    const sdk = savingsSdkFixture({ env, output });
    await assert.rejects(requestSavingsAdvice(facts, { env, client: createSavingsAdviceRuntimeClient({ env, sdk }) }));
    assert.deepEqual(sdk.seen.cancels, ['savings-1']);
  });
}

test('advice policy denies permissions, changed model parameters and old instructions', async () => {
  assert.equal(savingsAdviceAgentSpec(env).model.params.maxTokens, 4096);
  for (const mutateSpec of [s => { s.mcpServers = [{ name: 'banking' }]; }, s => { s.skills = [{ name: 'savings' }]; },
    s => { s.config.webSearch.enabled = true; }, s => { s.config.dynamicSubAgents.enabled = true; },
    s => { s.config.sandbox.fileDownloads = true; }, s => { s.model.name = 'qwen'; }, s => { s.model.params.maxTokens = 999999; },
    s => { s.instructions = 'ParsedIntent'; }, s => { s.messages = [{ content: 'other user' }]; }]) {
    const sdk = savingsSdkFixture({ env, output: JSON.stringify(advice), mutateSpec });
    await assert.rejects(requestSavingsAdvice(facts, { env, client: createSavingsAdviceRuntimeClient({ env, sdk }) }), { code: 'TRUEFORGE_AGENT_POLICY_ERROR' });
    assert.equal(sdk.seen.inputs.length, 0);
  }
  const sdk = savingsSdkFixture({ env, output: JSON.stringify(advice), beforeGet: session => { session.agent.spec.config.sandbox.enabled = true; } });
  await assert.rejects(requestSavingsAdvice(facts, { env, client: createSavingsAdviceRuntimeClient({ env, sdk }) }), { code: 'TRUEFORGE_AGENT_POLICY_ERROR' });
  assert.equal(sdk.seen.inputs.length, 0);
});

test('truncation, refusal, stream tampering and tool events never produce advice', async () => {
  for (const mutateEvents of [events => { events[1].toolCalls = [{ id: 'execute' }]; }, events => { events[1].type = 'tool.call'; },
    events => { events[2].state.output.finishReason = 'length'; }, events => { events[2].state.output.refusal = 'refused'; },
    events => { events[2].state.requiredActions = [{ type: 'tool.approval_required' }]; },
    events => { events[2].state.output.content = '{}'; }, events => { events.pop(); }]) {
    const sdk = savingsSdkFixture({ env, output: JSON.stringify(advice), mutateEvents });
    await assert.rejects(requestSavingsAdvice(facts, { env, client: createSavingsAdviceRuntimeClient({ env, sdk }) }));
    assert.deepEqual(sdk.seen.cancels, ['savings-1']);
  }
});

test('deadline and caller abort cancel the fresh session without Qwen fallback', async () => {
  for (const abort of [false, true]) {
    let cancelled = 0;
    const controller = new AbortController();
    const client = { createSession: async () => 'private', cancel: async () => { cancelled++; },
      runTurn: async (_id, _input, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) };
    const pending = requestSavingsAdvice(facts, { env, client, signal: controller.signal, timeoutMs: 10, fetchImpl: () => assert.fail('no fallback') });
    if (abort) setTimeout(() => controller.abort(), 1);
    await assert.rejects(pending, { code: 'TRUEFORGE_TIMEOUT' });
    assert.equal(cancelled, 1);
  }
});


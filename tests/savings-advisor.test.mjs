import test from 'node:test';
import assert from 'node:assert/strict';
import { requestSavingsAdvice, savingsAdviceAgentSpec, verifySavingsAdvice } from '../server/savings-advisor.mjs';

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

const env = { TRUEFORGE_BASE_URL: 'https://trueforge.invalid', TRUEFORGE_MODEL: 'test/deepseek-configured' };
function sdkFixture({ output = JSON.stringify(advice), finishReason = 'stop', unsafe = false } = {}) {
  let session; const seen = { turns: 0, cancels: 0 };
  const sdk = { sessions: {
    async create(request, options) {
      seen.spec = structuredClone(request.agent.spec); seen.createOptions = options;
      session = { id: 'advice-session', shared: false, agent: { spec: structuredClone(request.agent.spec) } };
      if (unsafe) session.agent.spec.mcpServers.push({ name: 'unexpected-tools' });
      return { data: session };
    },
    async get() { return { data: session }; },
    async cancel() { seen.cancels++; },
    async createTurnStream(_id, request, options) {
      seen.turns++; seen.input = JSON.parse(request.input[0].content); seen.turnOptions = options;
      const message = { type: 'model.message', id: 'advice-output', threadId: 'main', finishReason, content: output };
      const events = [{ type: 'turn.created', id: 'created', turnId: 'advice-turn' }, message,
        { type: 'turn.done', id: 'done', state: { status: 'done', requiredActions: [], output: structuredClone(message) } }];
      return { withMetadata: async function* () { for (const data of events) yield { data }; } };
    },
  } };
  return { sdk, seen };
}

test('TrueForge SDK uses TRUEFORGE_MODEL without a DashScope key and sends only aggregate facts', async () => {
  const { sdk, seen } = sdkFixture();
  const result = await requestSavingsAdvice({ ...facts, transactions: [{ card_number: 'never-send-raw-data' }] }, {
    env, sdk, fetchImpl: () => assert.fail('must not call a legacy HTTP endpoint'),
  });
  assert.deepEqual(result, advice);
  assert.equal(seen.spec.model.name, env.TRUEFORGE_MODEL);
  assert.equal(seen.spec.responseFormat.type, 'json_object');
  assert.deepEqual(seen.spec.mcpServers, []); assert.deepEqual(seen.spec.skills, []);
  assert.equal(seen.spec.config.sandbox.enabled, false);
  assert.deepEqual(seen.input, facts);
  assert.equal(JSON.stringify(seen.input).includes('card_number'), false);
  assert.equal(seen.turns, 1); assert.equal(seen.createOptions.maxRetries, 0); assert.equal(seen.turnOptions.maxRetries, 0);
  assert.equal(verifySavingsAdvice(result, facts).remaining_gap_minor, 146000);
});

test('savings model follows the configured TrueForge model and requires its configuration', async () => {
  assert.equal(savingsAdviceAgentSpec({ TRUEFORGE_MODEL: 'another/deepseek' }).model.name, 'another/deepseek');
  await assert.rejects(requestSavingsAdvice(facts, { env: { DASHSCOPE_API_KEY: 'unused-legacy-key' } }), { code: 'TRUEFORGE_CONFIG_ERROR' });
  await assert.rejects(requestSavingsAdvice(facts, { env: { TRUEFORGE_MODEL: env.TRUEFORGE_MODEL } }), { code: 'TRUEFORGE_CONFIG_ERROR' });
});

test('invalid JSON, non-object and oversized advice are rejected without retries', async () => {
  for (const output of ['{', 'null', '[]', '"plain answer"', 'x'.repeat(16001)]) {
    const { sdk, seen } = sdkFixture({ output });
    await assert.rejects(requestSavingsAdvice(facts, { env, sdk }), { code: 'MODEL_FORMAT_ERROR' });
    assert.equal(seen.turns, 1); assert.equal(seen.cancels, 1);
  }
});

test('SDK policy changes and truncated output cannot reach savings verification', async () => {
  const unsafe = sdkFixture({ unsafe: true });
  await assert.rejects(requestSavingsAdvice(facts, { env, sdk: unsafe.sdk }), { code: 'TRUEFORGE_AGENT_POLICY_ERROR' });
  assert.equal(unsafe.seen.turns, 0);
  const truncated = sdkFixture({ finishReason: 'length' });
  await assert.rejects(requestSavingsAdvice(facts, { env, sdk: truncated.sdk }), { code: 'TRUEFORGE_TURN_FAILED' });
  assert.equal(truncated.seen.cancels, 1);
});

test('provider failure is sanitized and never falls back to a legacy endpoint', async () => {
  let calls = 0;
  const client = { async createSession() { calls++; throw new Error('private-provider-detail'); } };
  await assert.rejects(requestSavingsAdvice(facts, { env, client }), error => {
    assert.equal(error.code, 'TRUEFORGE_UNAVAILABLE'); assert.doesNotMatch(error.message, /private-provider-detail/); return true;
  });
  assert.equal(calls, 1);
});

test('deadline and caller abort cancel the TrueForge session without retrying', async () => {
  for (const abort of [false, true]) {
    const controller = new AbortController(); let turns = 0, cancelled = 0;
    const client = { async createSession() { return 'timeout-session'; }, async cancel() { cancelled++; },
      async runTurn(_id, _message, signal) {
        turns++;
        return new Promise((resolve, reject) => {
          const stopped = () => reject(new Error('aborted'));
          if (signal.aborted) stopped(); else signal.addEventListener('abort', stopped, { once: true });
        });
      } };
    if (abort) controller.abort();
    await assert.rejects(requestSavingsAdvice(facts, { env, client, signal: controller.signal, timeoutMs: 15 }), { code: 'TRUEFORGE_TIMEOUT' });
    assert.equal(turns, 1); assert.equal(cancelled, 1);
  }
});


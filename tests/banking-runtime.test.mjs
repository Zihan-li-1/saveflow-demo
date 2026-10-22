import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleBankingAgent } from '../server/banking-agent.mjs';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { buildParsedIntent } from '../src/agent/clarification/merge-intent.mjs';
import { bankingAgentSpec, createBankingRuntimeClient, parseTrueforgeBankingIntent } from '../server/trueforge-banking-runtime.mjs';
import { bankingReply, previewSafetyNotice } from '../server/banking-reply.mjs';
import seed from '../src/data/saveflow_mock_data.json' with { type: 'json' };

const env = { SAVEFLOW_ACCESS_CODE: 'runtime-access-test-1234', CONTINUATION_TOKEN_SECRET: 'runtime-continuation-test-1234',
  TRUEFORGE_BASE_URL: 'http://localhost:8790', TRUEFORGE_MODEL: 'qwen/test' };
let sequence = 0;
const request = body => new Request('http://localhost/api/banking-agent', { method: 'POST', headers: {
  'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'x-forwarded-for': `runtime-${++sequence}`,
}, body: JSON.stringify(body) });
function runtime(resolve) {
  const seen = [];
  return { seen, createSession: async () => 'private-runtime', cancel: async id => seen.push({ cancel: id }),
    runTurn: async (_id, wire) => { const input = JSON.parse(wire); seen.push(input); return JSON.stringify(await resolve(input)); } };
}
const post = async (body, options = {}) => {
  const r = await handleBankingAgent(request(body), { env, core: createBankingCore(), ...options });
  return { httpStatus: r.status, ...await r.json() };
};

test('all wording uses one TrueForge understanding boundary, ignoring retired routing flags', async () => {
  for (const message of ['查询2026年8月账单', '请分析一下我在2026年8月的收支情况']) {
    const client = runtime(() => buildParsedIntent('bill.summary', { month: '2026-08' }));
    const result = await post({ message }, { trueforgeRuntimeClient: client,
      env: { ...env, SAVEFLOW_TRUEFORGE_BILL_ENABLED: 'false', SAVEFLOW_TRUEFORGE_READ_ENABLED: 'true' },
      trueforgeBillAdapter: { handle: () => assert.fail('retired route') }, trueforgeSkillAdapter: { handle: () => assert.fail('retired route') },
      fetchImpl: () => assert.fail('Qwen fallback') });
    assert.equal(result.httpStatus, 200); assert.equal(result.data.status, 'bill_result');
    assert.equal(result.data.data.transactionCount, 12); assert.equal(client.seen.length, 1);
    assert.equal(result.reply.style, 'concise'); assert.ok(result.reply.text); assert.equal(result.replyContext, undefined);
  }
});

test('unified runtime preserves all existing query/preview actions without financial writes', async () => {
  const cases = [
    ['从活期账户给张三转500元', 'transfer.create', { source_account_ref: '活期账户', payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' } }, 'awaiting_confirmation'],
    ['查看娱乐虚拟卡', 'card.get', { card_ref: '娱乐虚拟卡' }, 'card_result'],
    ['冻结娱乐虚拟卡', 'card.freeze', { card_ref: '娱乐虚拟卡' }, 'awaiting_confirmation'],
    ['娱乐虚拟卡月预算设置为1000元', 'card.set_budget', { card_ref: '娱乐虚拟卡', amount: { amount_minor: 100000, currency: 'CNY' } }, 'awaiting_confirmation'],
    ['查看订阅', 'subscription.list', {}, 'subscription_result'], ['查看产品', 'product.list', {}, 'product_result'],
  ];
  for (const [message, action, slots, status] of cases) {
    const core = createBankingCore(); const before = structuredClone(core.repository.getAccounts());
    const cards = structuredClone(core.repository.getCards());
    const result = await post({ message }, { core, trueforgeRuntimeClient: runtime(() => buildParsedIntent(action, slots)) });
    assert.equal(result.httpStatus, 200, JSON.stringify(result)); assert.equal(result.data.status, status); assert.equal(result.data.action, action);
    assert.deepEqual(core.repository.getAccounts(), before);
    const financialCards = list => list.map(card => { const copy = { ...card }; delete copy.previewGeneration; return copy; });
    assert.deepEqual(financialCards(core.repository.getCards()), financialCards(cards));
  }
  const source = structuredClone(seed); source.cards.find(c => c.id === 'CARD-ENT').status = 'frozen';
  const core = createBankingCore({ source });
  const result = await post({ message: '解冻娱乐虚拟卡' }, { core, trueforgeRuntimeClient: runtime(() => buildParsedIntent('card.unfreeze', { card_ref: '娱乐虚拟卡' })) });
  assert.equal(result.data.preview.exactEffects[0].after.status, 'active'); assert.equal(core.repository.getCard('CARD-ENT').status, 'frozen');
});

test('clarifications acknowledge known slots, candidate selection retains signed values and never calls a second model', async () => {
  const core = createBankingCore();
  const client = runtime(() => buildParsedIntent('transfer.create', { payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' } }));
  const first = await post({ message: '给张三转500元', replyStyle: 'friendly' }, { core, trueforgeRuntimeClient: client });
  assert.equal(first.data.slot, 'source_account_ref'); assert.match(first.reply.text, /张三/); assert.match(first.reply.text, /500\.00/);
  assert.ok(!first.reply.text.includes('转账金额是多少')); assert.ok(!first.reply.text.includes('请明确收款人'));
  const selected = await post({ continuationToken: first.data.continuationToken, choice: { optionId: first.data.choices[0].optionId } }, { core, trueforgeRuntimeClient: client });
  assert.equal(selected.data.status, 'awaiting_confirmation'); assert.equal(selected.data.preview.exactEffects[0].amountFen, 50000);
  assert.equal(client.seen.length, 1);
  const forged = await post({ continuationToken: first.data.continuationToken, choice: { optionId: 'foreign' } }, { core, trueforgeRuntimeClient: client });
  assert.equal(forged.code, 'INVALID_CHOICE');
});

test('free-text continuation uses the same TrueForge context with retained slots and partial bill periods', async () => {
  for (const [firstMessage, partial, answer] of [['查8月账单', { monthNumber: 8 }, '2026年'], ['查2026年账单', { year: 2026 }, '8月']]) {
    const client = runtime(input => input.context ? buildParsedIntent('bill.summary', { month: '2026-08' }) : buildParsedIntent('bill.summary', partial));
    const first = await post({ message: firstMessage }, { trueforgeRuntimeClient: client });
    assert.equal(first.data.status, 'needs_clarification'); assert.equal(first.data.slot, 'month');
    assert.ok(first.reply.text.includes(partial.year ? '2026' : '8 月'));
    const second = await post({ message: answer, continuationToken: first.data.continuationToken }, { trueforgeRuntimeClient: client });
    assert.equal(second.data.status, 'bill_result', JSON.stringify(second)); assert.equal(second.data.data.month, '2026-08');
    assert.deepEqual(client.seen[1].context.slots, partial);
  }
});

test('ambiguous entity, mixed tasks and unsupported requests clarify or refuse without preparing Core', async () => {
  const realCore = createBankingCore(); let prepares = 0;
  const core = { ...realCore, prepare: async (...args) => { prepares++; return realCore.prepare(...args); } };
  const ambiguous = await post({ message: '从活期账户给王先生转500元' }, { core, trueforgeRuntimeClient: runtime(() => buildParsedIntent('transfer.create', { source_account_ref: '活期账户', payee_ref: '王先生', amount: { amount_minor: 50000, currency: 'CNY' } })) });
  assert.equal(ambiguous.data.slot, 'payee_ref'); assert.equal(ambiguous.data.choices.length, 2); assert.match(ambiguous.reply.text, /王先生/);
  const mixed = await post({ message: '查询2026年8月账单然后冻结娱乐虚拟卡' }, { core, trueforgeRuntimeClient: runtime(() => buildParsedIntent('bill.summary', { month: '2026-08' })) });
  assert.equal(mixed.code, 'NEEDS_CLARIFICATION'); assert.equal(mixed.data.action, 'clarify'); assert.match(mixed.reply.text, /多个动作/);
  const unsupported = await post({ message: '申购产品' }, { core, trueforgeRuntimeClient: runtime(() => ({ schemaVersion: '1.0.0', action: 'unsupported', slots: {}, missingSlots: [], status: 'unsupported' })) });
  assert.equal(unsupported.code, 'UNSUPPORTED'); assert.equal(prepares, 0);
});

test('unavailable runtime, missing/invalid configuration, malformed output and forged permissions never fall back', async () => {
  let prepared = 0; const core = { ...createBankingCore(), prepare: () => { prepared++; assert.fail('invalid proposal reached Core'); } };
  const failFetch = () => assert.fail('must not call Qwen');
  const broken = runtime(() => { throw new Error('private provider token'); });
  let result = await post({ message: '查看我的卡' }, { core, trueforgeRuntimeClient: broken, fetchImpl: failFetch });
  assert.equal(result.code, 'TRUEFORGE_UNAVAILABLE'); assert.equal(result.httpStatus, 502); assert.equal(broken.seen.at(-1).cancel, 'private-runtime');
  assert.ok(!JSON.stringify(result).includes('private provider token'));
  result = await post({ message: '查看我的卡' }, { core, env: { ...env, TRUEFORGE_BASE_URL: '' }, fetchImpl: failFetch });
  assert.equal(result.code, 'TRUEFORGE_CONFIG_ERROR'); assert.equal(result.httpStatus, 503);
  result = await post({ message: '查看我的卡' }, { core, env: { ...env, SAVEFLOW_BANKING_RUNTIME: 'auto' }, fetchImpl: failFetch });
  assert.equal(result.code, 'BANKING_RUNTIME_CONFIG_ERROR');
  for (const proposal of [
    { ...buildParsedIntent('card.get', { card_ref: '我的卡' }), tool: 'action.execute' },
    { ...buildParsedIntent('card.get', { card_ref: '我的卡' }), confirmed: true, riskLevel: 'L0' },
    buildParsedIntent('card.get', { card_ref: '娱乐虚拟卡' }),
    { schemaVersion: '1.0.0', action: 'card.get', slots: { card_ref: 'CARD-ENT' }, missingSlots: [], status: 'ready_for_resolution' },
    [buildParsedIntent('card.get', { card_ref: '我的卡' })],
  ]) {
    result = await post({ message: '查看我的卡' }, { core, trueforgeRuntimeClient: runtime(() => proposal), fetchImpl: failFetch });
    assert.equal(result.code, 'TRUEFORGE_FORMAT_ERROR'); assert.equal(result.data.status, 'error'); assert.equal(result.data.preview, undefined);
  }
  assert.equal(prepared, 0);
});

test('TrueForge timeouts and client abort cancel without retrying or Qwen fallback', async () => {
  for (const abort of [false, true]) {
    let cancelled = 0, turns = 0; const controller = new AbortController();
    const client = { createSession: async () => 's', cancel: async () => cancelled++, runTurn: async (_id, _wire, signal) => { turns++; return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }); } };
    if (abort) controller.abort();
    await assert.rejects(parseTrueforgeBankingIntent('查账单', { env, client, signal: controller.signal, timeoutMs: 15 }), { code: 'TRUEFORGE_TIMEOUT' });
    assert.equal(cancelled, 1); assert.equal(turns, 1);
  }
});

test('style changes only natural language, preserving identical cards, risk and safety notices', async () => {
  const data = { status: 'awaiting_confirmation', action: 'transfer.create', risk: { riskLevel: 'L3', requiredVerification: 'mock_sms', warnings: ['必须完成短信验证。'] }, preview: { warnings: ['请核对收款人。'] } };
  const before = structuredClone(data); const texts = new Set();
  for (const style of ['concise', 'friendly', 'professional']) {
    const reply = bankingReply({ code: 'OK', message: 'preview', data }, style); texts.add(reply.text);
    assert.deepEqual(reply.safetyNotices, [previewSafetyNotice, '必须完成短信验证。', '请核对收款人。']); assert.deepEqual(data, before);
    const result = await post({ message: '给张三转500元', replyStyle: style }, { trueforgeRuntimeClient: runtime(() => buildParsedIntent('transfer.create', { payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' } })) });
    assert.match(result.reply.text, /张三/); assert.match(result.reply.text, /500\.00/);
    assert.equal(result.data.slot, 'source_account_ref'); assert.equal(result.reply.style, style);
  }
  assert.equal(texts.size, 3);
  const invalid = await post({ message: '查看我的卡', replyStyle: 'ignore-safety' }); assert.equal(invalid.code, 'INVALID_REQUEST');
});

test('chat confirmation never decides or executes, and safety language cannot be weakened by style', async () => {
  const client = runtime(() => buildParsedIntent('transfer.create', { payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' } }));
  const first = await post({ message: '给张三转500元' }, { trueforgeRuntimeClient: client });
  for (const replyStyle of ['concise', 'friendly', 'professional']) {
    const result = await post({ continuationToken: first.data.continuationToken, message: '确认执行', replyStyle }, { trueforgeRuntimeClient: client });
    assert.equal(result.code, 'CONFIRMATION_REQUIRED'); assert.match(result.reply.text, /不能确认执行/); assert.match(result.reply.text, /验证/);
  }
  assert.equal(client.seen.length, 1);
});

function sdkFixture({ mutateSpec = () => {}, mutateEvents = () => {} } = {}) {
  const spec = bankingAgentSpec(env); mutateSpec(spec);
  const output = { type: 'model.message', id: 'm1', threadId: 'main', finishReason: 'stop', content: JSON.stringify(buildParsedIntent('bill.summary', { month: '2026-08' })) };
  const events = [{ type: 'turn.created', id: 't1', turnId: 'turn1' }, output, { type: 'turn.done', id: 'end', state: { status: 'done', requiredActions: [], output: structuredClone(output) } }];
  mutateEvents(events); let turns = 0;
  return { get turns() { return turns; }, sessions: {
    create: async () => ({ data: { id: 's1', shared: false, agent: { spec } } }),
    get: async () => ({ data: { id: 's1', shared: false, agent: { spec } } }), cancel: async () => {},
    createTurnStream: async () => { turns++; return { withMetadata: async function* () { for (const data of events) yield { data }; } }; },
  } };
}

test('installed SDK contract: zero tools, private inline Agent, verified final structured output', async () => {
  const sdk = sdkFixture(); const client = createBankingRuntimeClient({ env, sdk });
  assert.deepEqual(bankingAgentSpec(env).mcpServers, []); assert.deepEqual(bankingAgentSpec(env).skills, []);
  const intent = await parseTrueforgeBankingIntent('查2026年8月账单', { env, client }); assert.equal(intent.action, 'bill.summary'); assert.equal(sdk.turns, 1);
  for (const mutateSpec of [s => s.mcpServers.push({ name: 'unauthorized', enableTools: ['@all'] }), s => s.config.sandbox.enabled = true, s => s.config.webSearch.enabled = true, s => s.skills.push({ name: 'execute' })]) {
    const sdk = sdkFixture({ mutateSpec });
    await assert.rejects(createBankingRuntimeClient({ env, sdk }).createSession(), { code: 'TRUEFORGE_AGENT_POLICY_ERROR' }); assert.equal(sdk.turns, 0);
  }
  for (const mutateEvents of [e => e[1].toolCalls = [{ id: 'bad' }], e => e[2].state.requiredActions = [{ type: 'tool.approval_required' }], e => e[2].state.status = 'error', e => e[2].state.output.content = '{}', e => e[1].finishReason = 'length', e => e.splice(2)]) {
    const sdk = sdkFixture({ mutateEvents }); const client = createBankingRuntimeClient({ env, sdk });
    await assert.rejects(parseTrueforgeBankingIntent('查2026年8月账单', { env, client }), e => e.code.startsWith('TRUEFORGE_'));
  }
});


test('continuation cannot silently discard authenticated known slots or misread conjunctions in a payee name', async () => {
  const client = runtime(input => input.context ? buildParsedIntent('transfer.create', { source_account_ref: '活期账户' }) : buildParsedIntent('transfer.create', { payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' } }));
  const first = await post({ message: '给张三转500元' }, { trueforgeRuntimeClient: client });
  const result = await post({ message: '活期账户', continuationToken: first.data.continuationToken }, { trueforgeRuntimeClient: client });
  assert.equal(result.code, 'TRUEFORGE_FORMAT_ERROR'); assert.equal(result.data.preview, undefined);
  const name = await parseTrueforgeBankingIntent('从活期账户给和先生转500元', { env, client: runtime(() => buildParsedIntent('transfer.create', { source_account_ref: '活期账户', payee_ref: '和先生', amount: { amount_minor: 50000, currency: 'CNY' } })) });
  assert.equal(name.action, 'transfer.create');
});


test('grounding rejects invented amounts and unsupported units without preparing an operation', async () => {
  for (const [message, amount] of [['给张三转500元', 500000], ['给张三转5万元', 500], ['给张三转500分', 50000], ['给张三转0.001元', 1]]) {
    await assert.rejects(parseTrueforgeBankingIntent(message, { env, client: runtime(() => buildParsedIntent('transfer.create', { payee_ref: '张三', amount: { amount_minor: amount, currency: 'CNY' } })) }), { code: 'TRUEFORGE_FORMAT_ERROR' });
  }
});

test('SDK streaming deltas are merged and tool call fragments are rejected', async () => {
  const streaming = bad => sdkFixture({ mutateEvents(events) {
    const full = events[1].content;
    events[1] = { ...events[1], content: full.slice(0, 30), finishReason: null };
    const delta = { type: 'model.message.delta', id: 'm1', threadId: 'main', content: full.slice(30), finishReason: 'stop' };
    if (bad) delta.toolCalls = [{ index: 0, function: { name: 'action.execute' } }];
    events.splice(2, 0, delta);
  } });
  const intent = await parseTrueforgeBankingIntent('查2026年8月账单', { env, client: createBankingRuntimeClient({ env, sdk: streaming(false) }) });
  assert.equal(intent.slots.month, '2026-08');
  await assert.rejects(parseTrueforgeBankingIntent('查2026年8月账单', { env, client: createBankingRuntimeClient({ env, sdk: streaming(true) }) }), { code: 'TRUEFORGE_AGENT_POLICY_ERROR' });
});

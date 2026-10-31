import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { createInMemoryScenarioStore } from '../src/skills/scenario/scenario-skill.mjs';
import { registerExistingSkills } from '../server/agent-framework/adapters.mjs';
import { AgentOrchestrator } from '../server/agent-framework/orchestrator.mjs';
import { InMemoryAgentRunRepository } from '../server/agent-framework/repository.mjs';
import { AgentStateMachine } from '../server/agent-framework/state-machine.mjs';
import { IntentRouter } from '../server/agent-framework/router.mjs';
import { IntentUnderstanding } from '../server/intent-routing/service.mjs';
import { SemanticModel, semanticAgentSpec } from '../server/intent-routing/runtime.mjs';
import { routingContext } from '../server/intent-routing/context.mjs';
import { routingExamples } from '../server/intent-routing/examples.mjs';
import { SkillDefinition } from '../server/agent-framework/models.mjs';
import { MockSemanticModel, analysis, task, match, extraction, regressionCases } from './fixtures/intent-routing-cases.mjs';
import { parseTrueforgeBankingIntent } from '../server/trueforge-banking-runtime.mjs';
import { routeConversation } from '../server/conversation-route.mjs';
import { handleBankingAgent } from '../server/banking-agent.mjs';

const registry = () => registerExistingSkills(createBankingCore().repository, createInMemoryScenarioStore());
const fixture = stages => { const r = registry(); const model = new MockSemanticModel(stages); return { registry: r, model, service: new IntentUnderstanding({ registry: r, model, now: () => Date.parse('2026-10-31T04:00:00Z') }) }; };
function single(query, skill, capability, args) {
  return { understanding: analysis(query, [task('task_1', query, capability)]), matching: { matches: [match('task_1', skill, capability)], unmatched_tasks: [] }, extraction: { tasks: [extraction('task_1', args, query)] } };
}
const cardinality = { direct: 5, colloquial: 5, indirect: 3, ambiguous: 3, counter: 3 };
for (const name of ['bill', 'card', 'wealth', 'scenario', 'transfer']) test(`${name}: complete capability metadata and 19 reviewed examples`, () => {
  const def = registry().get(name).definition(); assert.equal(SkillDefinition.safeParse(def).success, true);
  assert.ok(def.capabilities.length); assert.ok(def.description.length > 30);
  for (const [kind, count] of Object.entries(cardinality)) assert.equal(routingExamples.filter(item => item.skill === name && item.kind === kind).length, count);
});

for (const item of regressionCases) test(`regression ${item.id}: ${item.query} [model transport Mock]`, async () => {
  const { service, model } = fixture(item.stages); const result = await service.route(item.query);
  assert.equal(result.decision, item.expected, JSON.stringify(result));
  assert.equal(result.selected_skills.includes('transfer'), false);
  assert.ok(result.unsupported_parts.length);
  assert.equal(model.calls[0].stage, 'understanding'); assert.equal(model.calls[1].stage, 'matching');
  assert.equal(Object.hasOwn(model.calls[0].input, 'skill_definitions'), false);
  if (item.id === 'A') assert.equal(model.calls.length, 2);
  if (item.id === 'B') assert.equal(result.execution_plan.steps[0].skill_name, 'card');
});

const variants = [
  ['查询2026-09账单', 'bill', 'monthly_spending_summary', { action: 'bill.summary', month: '2026-09' }],
  ['2026-09钱都花在哪儿了', 'bill', 'monthly_spending_summary', { action: 'bill.summary', month: '2026-09' }],
  ['我想核对2026-09收入支出是否平衡', 'bill', 'monthly_spending_summary', { action: 'bill.summary', month: '2026-09' }],
  ['帮我瞅瞅2026-09花销', 'bill', 'monthly_spending_summary', { action: 'bill.summary', month: '2026-09' }],
  ['娱乐卡还能花多少', 'card', 'card_budget_snapshot', { action: 'card.get', card_ref: '娱乐卡' }],
  ['担心娱乐卡接近预算，想核对一下', 'card', 'card_budget_snapshot', { action: 'card.get', card_ref: '娱乐卡' }],
  ['比较模拟灵活现金基金 A和模拟稳健债券基金 B', 'wealth', 'investment_comparison', { action: 'wealth.compare', product_refs: ['模拟灵活现金基金 A', '模拟稳健债券基金 B'] }],
  ['先帮我看模拟灵活现金基金 A和模拟稳健债券基金 B取钱有啥不同', 'wealth', 'investment_comparison', { action: 'wealth.compare', product_refs: ['模拟灵活现金基金 A', '模拟稳健债券基金 B'] }],
  ['从活期给张三打五百元', 'transfer', 'external_transfer_resolution', { action: 'transfer.create', source_account_ref: '活期', payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' } }],
  ['把五百元从活期账户划给张三', 'transfer', 'external_transfer_resolution', { action: 'transfer.create', source_account_ref: '活期账户', payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' } }],
  ['复核可信事件event_demo', 'scenario', 'trusted_event_review', { action: 'scenario.review_event', event_ref: 'event_demo' }],
];
for (const [query, skill, capability, args] of variants) test(`phrasing contract: ${query} [Mock]`, async () => {
  const { service, model } = fixture(single(query, skill, capability, args)); const result = await service.route(query);
  assert.equal(result.decision, 'MATCHED', JSON.stringify(result)); assert.deepEqual(result.selected_skills, [skill]);
  assert.deepEqual(result.execution_plan.steps[0].arguments, args);
  assert.deepEqual(model.calls.map(item => item.stage), ['understanding', 'matching', 'extraction']);
  assert.ok(model.calls[1].input.skill_definitions[0].input_schema);
  assert.ok(model.calls[2].input.matched_tasks[0].capability_definition.input_schema);
});

for (const count of [1, 2, 3]) test(`${count} Skill goals produce structured ordered plan [Mock]`, async () => {
  const query = '查询2026-09收支，再查看娱乐卡，最后比较模拟灵活现金基金 A和模拟稳健债券基金 B';
  const inputs = [ ['bill', 'monthly_spending_summary', { action: 'bill.summary', month: '2026-09' }], ['card', 'card_budget_snapshot', { action: 'card.get', card_ref: '娱乐卡' }], ['wealth', 'investment_comparison', { action: 'wealth.compare', product_refs: ['模拟灵活现金基金 A', '模拟稳健债券基金 B'] }] ].slice(0, count);
  const stages = { understanding: analysis(query, inputs.map(([, cap], i) => task(`task_${i}`, cap, cap, i ? [`task_${i - 1}`] : []))), matching: { matches: inputs.map(([skill, cap], i) => match(`task_${i}`, skill, cap)), unmatched_tasks: [] }, extraction: { tasks: inputs.map(([, , args], i) => extraction(`task_${i}`, args, query)) } };
  const { service } = fixture(stages); const result = await service.route(query); assert.equal(result.decision, 'MATCHED'); assert.equal(result.execution_plan.steps.length, count);
  if (count > 1) assert.deepEqual(result.execution_plan.steps[1].dependencies, ['task_0']);
});

test('missing required financial parameters is clarification, not unsupported', async () => {
  const { service } = fixture(single('给张三转账', 'transfer', 'external_transfer_resolution', { action: 'transfer.create', payee_ref: '张三' }));
  const result = await service.route('给张三转账'); assert.equal(result.decision, 'CLARIFICATION_REQUIRED'); assert.deepEqual(result.unsupported_parts, []);
  assert.ok(result.missing_fields.some(item => item.field === 'amount')); assert.ok(result.missing_fields.some(item => item.field === 'source_account_ref'));
});

test('ambiguous goal remains clarification before choosing an action', async () => {
  const stages = { understanding: analysis('查看这张卡', [task('t', '希望查看的信息不明确', 'ambiguous_card_query')], [{ task_id: 't', field: 'goal', question: '想查看卡状态、预算还是某月账单？' }]), matching: { matches: [], unmatched_tasks: [{ task_id: 't', capability: 'ambiguous_card_query', reason: '请明确查询内容和卡片', clarification_required: true }] } };
  const result = await fixture(stages).service.route('帮我看看这张卡'); assert.equal(result.decision, 'CLARIFICATION_REQUIRED'); assert.deepEqual(result.execution_plan.steps, []);
});

test('keywords in nonfinancial goal do not force a skill [Mock]', async () => {
  const query = '把小说里转账和账单两个词换个写法';
  const stages = { understanding: analysis(query, [task('t', '改写小说用词', 'creative_text_edit')]), matching: { matches: [], unmatched_tasks: [{ task_id: 't', capability: 'creative_text_edit', reason: '不是已注册的金融业务能力', clarification_required: false }] } };
  const result = await fixture(stages).service.route(query); assert.equal(result.decision, 'UNSUPPORTED'); assert.equal(result.selected_skills.length, 0);
});

test('incomplete partial task keeps both missing fields and unsupported capabilities', async () => {
  const stages = structuredClone(regressionCases[1].stages); stages.extraction.tasks[0].arguments = { action: 'card.get' };
  const result = await fixture(stages).service.route('这张卡消费到80%提醒我');
  assert.equal(result.decision, 'CLARIFICATION_REQUIRED'); assert.ok(result.missing_fields.some(item => item.field === 'card_ref')); assert.equal(result.unsupported_parts.length, 2);
});

test('second turn uses bounded server context and preserves same AgentRun', async () => {
  const r = registry();
  const stages = single('查询收支', 'bill', 'monthly_spending_summary', { action: 'bill.summary' });
  stages.extraction = input => ({ tasks: [input.user_message === '这个月' ? extraction('task_1', { action: 'bill.summary', month: '2026-10' }, '这个月', { month: 'calendar' }) : extraction('task_1', { action: 'bill.summary' }, '查询收支')] });
  const model = new MockSemanticModel(stages); const router = new IntentRouter({ registry: r, model, now: () => Date.parse('2026-10-31T04:00:00Z') });
  const o = new AgentOrchestrator({ registry: r, repository: new InMemoryAgentRunRepository(), router, machine: new AgentStateMachine(() => {}) });
  const first = await o.create('owner', { session_id: 'session', query: '查询收支' }, 'key'); assert.equal(first.state, 'COLLECTING_INPUT');
  const resumed = await o.input('owner', first.run_id, { message: '这个月' }); assert.equal(resumed.run_id, first.run_id); assert.equal(resumed.state, 'SUCCEEDED');
  const call = model.calls.find(item => item.stage === 'understanding' && item.input.user_message === '这个月');
  assert.equal(call.input.conversation_context.active_goal, '查询收支'); assert.ok(call.input.conversation_context.pending_question.includes('task_1.month'));
});

test('context excludes credentials, raw results and unlimited chat history', () => {
  const context = routingContext({ original_query: '查看账单', state: 'COLLECTING_INPUT', request: { arguments: { month: '2026-09' } }, result: { token: 'secret' }, history: Array(100).fill('private'), confirmations: [{ token: 'secret' }] });
  assert.equal(JSON.stringify(context).includes('secret'), false); assert.equal(Object.hasOwn(context, 'history'), false); assert.equal(context.collected_parameters.current.month, '2026-09');
});

test('relative previous month is validated after extraction against provided calendar [Mock]', async () => {
  const stages = single('上个月开销怎样', 'bill', 'monthly_spending_summary', { action: 'bill.summary', month: '2026-09' });
  stages.extraction.tasks[0].evidence[0].source = 'calendar';
  const { service, model } = fixture(stages); const result = await service.route('上个月开销怎样');
  assert.equal(result.decision, 'MATCHED'); assert.equal(model.calls[2].input.calendar.currentDate, '2026-10-31'); assert.equal(result.execution_plan.steps[0].arguments.month, '2026-09');
});

for (const mutation of ['unknown_skill', 'wrong_owner', 'dropped_task', 'cycle', 'unknown_action', 'ungrounded_ref']) test(`reject malformed model output: ${mutation}`, async () => {
  const stages = single('查看娱乐卡', 'card', 'card_budget_snapshot', { action: 'card.get', card_ref: '娱乐卡' });
  if (mutation === 'unknown_skill') stages.matching.matches[0].skill_name = 'imaginary';
  if (mutation === 'wrong_owner') stages.matching.matches[0].skill_name = 'bill';
  if (mutation === 'dropped_task') stages.matching.matches = [];
  if (mutation === 'cycle') stages.understanding.tasks[0].depends_on = ['task_1'];
  if (mutation === 'unknown_action') stages.extraction.tasks[0].arguments.action = 'card.steal';
  if (mutation === 'ungrounded_ref') stages.extraction.tasks[0].arguments.card_ref = '其他人的卡';
  const result = await fixture(stages).service.route('查看娱乐卡'); assert.equal(result.decision, 'CLARIFICATION_REQUIRED');
});

test('partial result never executes available subset without a new explicit scope', async () => {
  const r = registry(); let calls = 0; r.get('card').execute = async () => { calls++; throw new Error('must not execute'); };
  const o = new AgentOrchestrator({ registry: r, repository: new InMemoryAgentRunRepository(), router: new IntentRouter({ registry: r, model: new MockSemanticModel(regressionCases[1].stages) }), machine: new AgentStateMachine(() => {}) });
  const run = await o.create('owner', { session_id: 'session', query: regressionCases[1].query }, 'partial');
  assert.equal(run.state, 'COLLECTING_INPUT'); assert.equal(run.result.routing.decision, 'PARTIALLY_SUPPORTED'); assert.equal(calls, 0);
});

test('development trace logs stage structure but never raw sensitive values', async () => {
  const query = 'API Key test-private-credential 1234567890123456'; const logs = [];
  const stages = single(query, 'card', 'card_budget_snapshot', { action: 'card.get' });
  const service = new IntentUnderstanding({ registry: registry(), model: new MockSemanticModel(stages), traceOptions: { env: { NODE_ENV: 'development', SAVEFLOW_ROUTING_TRACE: 'true' }, sink: event => logs.push(event) } });
  await service.route(query); assert.equal(logs.length, 1); assert.doesNotMatch(JSON.stringify(logs), /test-private-credential|1234567890123456/);
  assert.equal(logs[0].user_query.redacted, true); assert.equal(logs[0].final_route_decision, 'CLARIFICATION_REQUIRED');
});

test('model disabled fails explicitly instead of pretending keyword intelligence', async () => {
  const service = new IntentUnderstanding({ registry: registry(), model: new SemanticModel({ env: {} }) });
  const result = await service.route('2026-09花了多少'); assert.equal(result.decision, 'CLARIFICATION_REQUIRED'); assert.equal(result.reason_code, 'MODEL_NOT_CONFIGURED');
});

test('transport requires JSON object + schema, rejects free text, no tool execution', async () => {
  const spec = semanticAgentSpec({ TRUEFORGE_MODEL: 'test-only', TRUEFORGE_BASE_URL: 'http://localhost' }, 'understanding');
  assert.deepEqual(spec.responseFormat, { type: 'json_object' }); assert.deepEqual(spec.skills, []); assert.deepEqual(spec.mcpServers, []);
  const model = new SemanticModel({ env: { TRUEFORGE_MODEL: 'test-only', TRUEFORGE_BASE_URL: 'http://localhost' }, clientFactory: () => ({ createSession: async () => 'mock', cancel: async () => {}, runTurn: async () => 'call the card skill' }) });
  const result = await new IntentUnderstanding({ registry: registry(), model }).route('查看卡'); assert.equal(result.reason_code, 'INVALID_STRUCTURED_OUTPUT');
});

for (const item of regressionCases) test(`legacy rejected ParsedIntent recovers specific decision for case ${item.id}`, async () => {
  const client = { createSession: async () => 'mock', cancel: async () => {}, runTurn: async () => JSON.stringify({ action: 'scenario.create_rule', unexpected: 'bad output' }) };
  await assert.rejects(parseTrueforgeBankingIntent(item.query, { client, routingRegistry: registry(), semanticModel: new MockSemanticModel(item.stages) }), error => {
    assert.equal(error.code, 'SEMANTIC_ROUTING_REVIEW'); assert.equal(error.routing.decision, item.expected); assert.doesNotMatch(error.userMessage, /请求理解结果未通过服务端校验/); return true;
  });
});

test('legacy outer unsupported passes semantic recovery before rejecting', async () => {
  let observed;
  const client = { createSession: async () => 'mock', cancel: async () => {}, runTurn: async () => JSON.stringify({ schemaVersion: '1.0.0', kind: 'unsupported', text: '暂不支持。' }) };
  const result = await routeConversation(regressionCases[1].query, { client, routingRegistry: registry(), semanticModel: new MockSemanticModel(regressionCases[1].stages), onSemanticRoute: value => { observed = value.result; } });
  assert.equal(result.kind, 'clarify'); assert.equal(observed.decision, 'PARTIALLY_SUPPORTED'); assert.match(result.text, /notification_delivery/);
});

test('no query-keyword routing remains in the unified IntentRouter', async () => {
  const source = await readFile(new URL('../server/agent-framework/router.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.test\(request\.query\)|request\.query\.match|query\.includes/);
});

for (const item of regressionCases) test(`actual banking HTTP handler exposes case ${item.id} decision without Skill execution`, async () => {
  const core = createBankingCore(); let prepared = 0;
  const client = { createSession: async () => 'mock', cancel: async () => {}, runTurn: async () => JSON.stringify({ invalid: 'simulated old schema rejection' }) };
  const env = { SAVEFLOW_ACCESS_CODE: 'test-only-routing-access', CONTINUATION_TOKEN_SECRET: 'test-only-routing-secret', TRUEFORGE_MODEL: 'test-mock' };
  const request = new Request('http://localhost/api/banking-agent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Saveflow-Access': env.SAVEFLOW_ACCESS_CODE, 'X-Forwarded-For': `intent-${item.id}` }, body: JSON.stringify({ message: item.query }) });
  const response = await handleBankingAgent(request, { core: { ...core, prepare: () => { prepared++; throw new Error('must not prepare'); } }, env, trueforgeRuntimeClient: client, semanticModel: new MockSemanticModel(item.stages) });
  const body = await response.json(); assert.equal(response.status, 200); assert.equal(body.data.routing.decision, item.expected, JSON.stringify(body)); assert.equal(prepared, 0);
});

test('unsupported outer route on a continuation defers to signed business context', async () => {
  const client = { createSession: async () => 'mock', cancel: async () => {}, runTurn: async () => JSON.stringify({ schemaVersion: '1.0.0', kind: 'unsupported', text: '无法判断。' }) };
  const model = new MockSemanticModel({});
  const route = await routeConversation('这个月', { client, hasContinuation: true, routingRegistry: registry(), semanticModel: model });
  assert.equal(route.kind, 'business_intent'); assert.equal(route.continuation, 'current'); assert.equal(model.calls.length, 0);
});

test('live semantic accuracy requires explicitly configured model; no fabricated metric', { skip: process.env.RUN_LIVE_INTENT_TESTS !== 'true' }, async () => {
  assert.ok(process.env.TRUEFORGE_MODEL && process.env.TRUEFORGE_BASE_URL, 'live model must be configured explicitly');
  const service = new IntentUnderstanding({ registry: registry() });
  for (const item of regressionCases) { const result = await service.route(item.query); assert.equal(result.decision, item.expected, JSON.stringify(result)); }
});

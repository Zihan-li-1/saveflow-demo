import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { createInMemoryScenarioStore } from '../src/skills/scenario/scenario-skill.mjs';
import { registerExistingSkills } from '../server/agent-framework/adapters.mjs';
import { SkillAdapter } from '../server/agent-framework/adapter.mjs';
import { SkillRegistry } from '../server/agent-framework/registry.mjs';
import { AgentStateMachine } from '../server/agent-framework/state-machine.mjs';
import { InMemoryAgentRunRepository } from '../server/agent-framework/repository.mjs';
import { AgentOrchestrator } from '../server/agent-framework/orchestrator.mjs';
import { createAgentApi } from '../server/agent-framework/api.mjs';
import { AgentRun, AgentResponse } from '../server/agent-framework/models.mjs';
import { redact } from '../server/agent-framework/safety.mjs';

const owner = 'test_owner';
const events = [];
const request = argumentsValue => ({ session_id: 'session_test', query: 'explicit test task', arguments: argumentsValue });
const confirmInput = run => ({ ...run.confirmations.find(item => item.confirmation_status === 'pending'), confirmed: true });
function setup(options = {}) {
  const core = createBankingCore();
  const registry = options.registry ?? registerExistingSkills(core.repository, createInMemoryScenarioStore());
  const repository = new InMemoryAgentRunRepository();
  const orchestrator = new AgentOrchestrator({ registry, repository, machine: new AgentStateMachine(event => events.push(event)), ...options });
  return { core, registry, repository, orchestrator };
}
const create = (o, input, key = randomUUID()) => o.create(owner, input, key);
function mockAdapter({ name = 'mock', operation = 'READ_ONLY', invoke = async value => ({ ok: true, data: { value: value.value } }) } = {}) {
  // Explicit Mock: no financial data or external service is involved.
  return new SkillAdapter({ name, description: 'TEST MOCK ONLY', schema: z.object({ action: z.literal('mock.read'), value: z.string() }).strict(), health: async () => {}, operation: () => operation, invoke });
}
function mockSetup(options = {}) {
  const registry = new SkillRegistry().register(mockAdapter(options));
  return setup({ registry, timeoutMs: 15, ...options });
}
const mockRequest = value => ({ ...request({ action: 'mock.read', value }), skill_name: 'mock' });

test('registers exactly five existing business Skills and publishes schemas', () => {
  const { registry } = setup();
  assert.deepEqual(registry.list().map(item => item.name), ['bill', 'card', 'wealth', 'scenario', 'transfer']);
  for (const def of registry.list()) { assert.ok(def.input_schema); assert.ok(def.output_schema); }
  assert.throws(() => registry.register(registry.get('bill')), { code: 'DUPLICATE_REQUEST' });
  assert.throws(() => registry.get('missing'), { code: 'SKILL_NOT_FOUND' });
});

test('all five real Skills execute through adapters using existing synthetic repository', async () => {
  const { core, registry } = setup(); const repo = core.repository;
  const account = (await repo.getAccounts())[0]; const payee = (await repo.getPayees())[0];
  const cases = [
    ['bill', { action: 'bill.summary', month: (await repo.getContextInfo()).currentMonth }],
    ['card', { action: 'card.get', card_ref: (await repo.getCards())[0].name }],
    ['wealth', { action: 'wealth.compare', product_refs: (await repo.getInvestmentProducts()).slice(0, 2).map(item => item.name) }],
    ['scenario', { action: 'scenario.create_rule', trigger: { type: 'manual', value: 'test' }, conditions: {}, proposed_steps: [{ action: 'card.get', parameters: {} }], authorization_scope: 'suggest_only' }],
    ['transfer', { action: 'transfer.create', source_account_ref: account.name, payee_ref: payee.name, amount: { amount_minor: 1, currency: 'CNY' } }],
  ];
  for (const [name, args] of cases) {
    const result = await registry.get(name).execute({ request_id: 'request_test', run_id: 'run_test', step_id: 'step_test', idempotency_key: 'key_test', arguments: args });
    assert.equal(result.status, 'succeeded', `${name}: ${JSON.stringify(result)}`);
    assert.equal(result.metadata.financial_execution, false);
  }
});

test('orchestrator imports only framework contracts, never business internals', async () => {
  const source = await readFile(new URL('../server/agent-framework/orchestrator.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from\s+['"][^'"]*(?:src\/|adapters\.mjs|runtime\.mjs|skills\/)/);
});

test('missing month collects input and resumes same run; read-only skips confirmation', async () => {
  const { orchestrator, core } = setup();
  let run = await create(orchestrator, request({ action: 'bill.summary' }));
  assert.equal(run.state, 'COLLECTING_INPUT'); assert.deepEqual(run.missing_fields, ['step_1.month']);
  const original = run.run_id;
  run = await orchestrator.input(owner, original, { arguments: { month: (await core.repository.getContextInfo()).currentMonth } });
  assert.equal(run.run_id, original); assert.equal(run.state, 'SUCCEEDED'); assert.deepEqual(run.confirmations, []);
  assert.equal(AgentRun.safeParse(run).success, true);
});

test('unknown language remains collecting; explicit selection resumes', async () => {
  const { orchestrator } = setup();
  let run = await create(orchestrator, request({}));
  assert.equal(run.state, 'COLLECTING_INPUT');
  run = await orchestrator.input(owner, run.run_id, { skill_name: 'bill', arguments: { action: 'subscription.list' } });
  assert.equal(run.state, 'SUCCEEDED');
});

test('rule router extracts only explicit month', async () => {
  const { orchestrator } = setup();
  const run = await create(orchestrator, { session_id: 'session_test', query: '查看2026-09账单' });
  assert.equal(run.state, 'SUCCEEDED'); assert.equal(run.plan.steps[0].arguments.month, '2026-09');
});

test('state machine rejects illegal transitions and every terminal state', () => {
  const machine = new AgentStateMachine(() => {});
  for (const state of ['CREATED', 'SUCCEEDED', 'FAILED', 'CANCELLED']) assert.throws(() => machine.transition({ state, audit: [] }, 'EXECUTING'), { code: 'INVALID_STATE_TRANSITION' });
});

test('terminal run cannot resume, confirm, cancel or execute', async () => {
  const { orchestrator } = mockSetup(); const run = await create(orchestrator, mockRequest('x'));
  for (const method of ['input', 'confirm', 'cancel']) await assert.rejects(orchestrator[method](owner, run.run_id, {}), { code: 'INVALID_STATE_TRANSITION' });
  await assert.rejects(orchestrator.execute(run), { code: 'INVALID_STATE_TRANSITION' });
});

test('timeout fails with SKILL_TIMEOUT and does not retry uncertain execution', async () => {
  let calls = 0; const { orchestrator } = mockSetup({ invoke: async () => { calls++; return new Promise(() => {}); }, maxRetries: 3 });
  const run = await create(orchestrator, mockRequest('x'));
  assert.equal(run.state, 'FAILED'); assert.equal(run.error.code, 'SKILL_TIMEOUT'); assert.equal(calls, 1);
});

test('retryable external failures are bounded by maxRetries', async () => {
  let calls = 0; const { orchestrator } = mockSetup({ maxRetries: 2, invoke: async () => { calls++; throw Object.assign(new Error('private detail'), { code: 'ECONNRESET' }); } });
  const run = await create(orchestrator, mockRequest('x'));
  assert.equal(calls, 3); assert.equal(run.state, 'FAILED'); assert.equal(run.error.code, 'EXTERNAL_SERVICE_ERROR');
});

test('retryable read may succeed on second attempt', async () => {
  let calls = 0; const { orchestrator } = mockSetup({ invoke: async () => { if (++calls === 1) throw Object.assign(new Error('mock reset'), { code: 'ECONNRESET' }); return { ok: true, data: { value: 'verified' } }; } });
  const run = await create(orchestrator, mockRequest('x')); assert.equal(run.state, 'SUCCEEDED'); assert.equal(calls, 2);
});

test('nonretryable internal exception is sanitized and fails once', async () => {
  let calls = 0; const { orchestrator } = mockSetup({ invoke: async () => { calls++; throw new Error('secret-test-token'); } });
  const run = await create(orchestrator, mockRequest('x')); assert.equal(run.state, 'FAILED'); assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(run), /secret-test-token/);
});

test('write waits; mismatched confirmation cannot execute; matching confirmation runs once', async () => {
  let calls = 0; const { orchestrator } = mockSetup({ operation: 'WRITE', invoke: async () => { calls++; return { ok: true, data: { mock: true } }; } });
  let run = await create(orchestrator, mockRequest('x'));
  assert.equal(run.state, 'WAITING_CONFIRMATION'); assert.equal(calls, 0);
  await assert.rejects(orchestrator.confirm(owner, run.run_id, { ...confirmInput(run), arguments_digest: 'mismatch' }), { code: 'CONFIRMATION_MISMATCH' });
  assert.equal(calls, 0);
  run = await orchestrator.confirm(owner, run.run_id, confirmInput(run));
  assert.equal(run.state, 'SUCCEEDED'); assert.equal(calls, 1); assert.equal(run.error, null);
  await assert.rejects(orchestrator.confirm(owner, run.run_id, confirmInput(run)), { code: 'INVALID_STATE_TRANSITION' });
});

test('changing persisted arguments invalidates old confirmation', async () => {
  const { orchestrator, repository } = mockSetup({ operation: 'SENSITIVE_WRITE' });
  const run = await create(orchestrator, mockRequest('x')); const confirmation = confirmInput(run);
  run.plan.steps[0].arguments.value = 'changed'; await repository.save(run, run.version);
  await assert.rejects(orchestrator.confirm(owner, run.run_id, confirmation), { code: 'CONFIRMATION_MISMATCH' });
});

test('duplicate create keys return existing record; mismatched body is rejected', async () => {
  let calls = 0; const { orchestrator } = mockSetup({ invoke: async () => { calls++; return { ok: true, data: {} }; } });
  const input = mockRequest('x'); const first = await create(orchestrator, input, 'duplicate_key'); const second = await create(orchestrator, input, 'duplicate_key');
  assert.equal(first.run_id, second.run_id); assert.equal(calls, 1);
  await assert.rejects(create(orchestrator, mockRequest('different'), 'duplicate_key'), { code: 'DUPLICATE_REQUEST' });
});

test('concurrent create keys execute exactly once', async () => {
  let calls = 0; const { orchestrator } = mockSetup({ invoke: async () => { calls++; return { ok: true, data: {} }; } });
  const runs = await Promise.all(Array.from({ length: 4 }, () => create(orchestrator, mockRequest('x'), 'same_key')));
  assert.equal(new Set(runs.map(run => run.run_id)).size, 1); assert.equal(calls, 1);
});

test('explicit scalar field mapping passes verified data to next skill', async () => {
  const inputs = []; const registry = new SkillRegistry().register(mockAdapter()).register(mockAdapter({ name: 'second', invoke: async args => { inputs.push(args); return { ok: true, data: { value: args.value } }; } }));
  const { orchestrator } = setup({ registry });
  const run = await create(orchestrator, { ...request({}), steps: [
    { step_id: 'first', skill_name: 'mock', arguments: { action: 'mock.read', value: 'verified' } },
    { step_id: 'second', skill_name: 'second', arguments: { action: 'mock.read' }, dependencies: ['first'], mappings: [{ from_step: 'first', from_field: 'value', to_field: 'value' }] },
  ] });
  assert.equal(run.state, 'SUCCEEDED'); assert.deepEqual(inputs, [{ action: 'mock.read', value: 'verified' }]);
});

test('failed first skill never calls downstream skill', async () => {
  let downstream = 0; const registry = new SkillRegistry().register(mockAdapter({ invoke: async () => { throw new Error('mock'); } })).register(mockAdapter({ name: 'second', invoke: async () => { downstream++; return { ok: true, data: {} }; } }));
  const { orchestrator } = setup({ registry });
  const run = await create(orchestrator, { ...request({}), steps: [
    { step_id: 'first', skill_name: 'mock', arguments: { action: 'mock.read', value: 'x' } },
    { step_id: 'second', skill_name: 'second', arguments: { action: 'mock.read', value: 'y' }, dependencies: ['first'] },
  ] });
  assert.equal(run.state, 'FAILED'); assert.equal(downstream, 0); assert.equal(run.plan.steps[1].status, 'pending'); assert.equal(run.result, null);
});

test('two existing read-only Skills execute in declared order', async () => {
  const { orchestrator, core } = setup();
  const run = await create(orchestrator, { ...request({}), steps: [
    { step_id: 'bills', skill_name: 'bill', arguments: { action: 'bill.summary', month: (await core.repository.getContextInfo()).currentMonth } },
    { step_id: 'card', skill_name: 'card', arguments: { action: 'card.get', card_ref: (await core.repository.getCards())[0].name }, dependencies: ['bills'] },
  ] });
  assert.equal(run.state, 'SUCCEEDED'); assert.deepEqual(run.result.steps.map(step => step.skill_name), ['bill', 'card']);
});

test('unregistered skill and forward dependencies fail before execution', async () => {
  const { orchestrator } = setup();
  const unknown = await create(orchestrator, { ...request({ action: 'unknown.get' }), skill_name: 'unknown' }); assert.equal(unknown.error.code, 'SKILL_NOT_FOUND');
  const bad = await create(orchestrator, { ...request({}), steps: [{ step_id: 'a', skill_name: 'bill', arguments: { action: 'subscription.list' }, dependencies: ['later'] }] }); assert.equal(bad.state, 'FAILED');
});

test('CAS rejects concurrent state overwrite and owner mismatch', async () => {
  const { orchestrator, repository } = setup(); const run = await create(orchestrator, request({ action: 'bill.summary' }));
  const a = await repository.get(owner, run.run_id); const b = await repository.get(owner, run.run_id);
  await repository.save(a, a.version); await assert.rejects(repository.save(b, b.version), { code: 'DUPLICATE_REQUEST' });
  await assert.rejects(repository.get('other_user', run.run_id), { code: 'RUN_NOT_FOUND' });
});

test('concurrent confirmations cannot duplicate write invocation', async () => {
  let calls = 0; const { orchestrator } = mockSetup({ operation: 'WRITE', invoke: async () => { calls++; return { ok: true, data: {} }; } });
  const run = await create(orchestrator, mockRequest('x'));
  const results = await Promise.allSettled([orchestrator.confirm(owner, run.run_id, confirmInput(run)), orchestrator.confirm(owner, run.run_id, confirmInput(run))]);
  assert.equal(calls, 1); assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
});

test('cancel prevents later execution', async () => {
  const { orchestrator } = mockSetup({ operation: 'WRITE' }); const run = await create(orchestrator, mockRequest('x'));
  assert.equal((await orchestrator.cancel(owner, run.run_id)).state, 'CANCELLED');
  await assert.rejects(orchestrator.confirm(owner, run.run_id, confirmInput(run)), { code: 'INVALID_STATE_TRANSITION' });
});

test('logs/audit contain no secret arguments or thrown messages', async () => {
  events.length = 0;
  const { orchestrator } = mockSetup({ invoke: async () => { throw new Error('mock-secret-password'); } });
  await create(orchestrator, mockRequest('safe'));
  await assert.rejects(create(orchestrator, { ...mockRequest('safe'), arguments: { action: 'mock.read', value: '1234567890123456' } }), { code: 'INVALID_REQUEST' });
  assert.doesNotMatch(JSON.stringify(events), /mock-secret-password|1234567890123456/);
  assert.equal(redact({ password: 'mock-secret', accountNo: '1234567890123456' }).password, '[REDACTED]');
  assert.ok(events.length > 0);
});

test('API envelopes, authentication, missing params, HTTP failures, schema and probes', async () => {
  const fixture = setup(); const access = 'test-only-access-code';
  const api = createAgentApi({ ...fixture, env: { SAVEFLOW_ACCESS_CODE: access } });
  const call = (path, method = 'GET', body, auth = access) => api(new Request(`http://localhost${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Saveflow-Access': auth, 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  for (const path of ['/health', '/ready', '/api/v1/skills', '/api/v1/skills/bill/schema']) {
    const response = await call(path); assert.equal(response.status, 200); assert.equal(AgentResponse.safeParse(await response.json()).success, true);
  }
  assert.equal((await call('/api/v1/skills', 'GET', undefined, 'wrong')).status, 401);
  assert.equal((await call('/api/v1/skills/missing/schema')).status, 404);
  const response = await call('/api/v1/agent/runs', 'POST', request({ action: 'bill.summary' })); const body = await response.json();
  assert.equal(body.state, 'COLLECTING_INPUT');
  assert.equal((await call(`/api/v1/agent/runs/${body.run_id}`)).status, 200);
  const completed = await call(`/api/v1/agent/runs/${body.run_id}/input`, 'POST', { arguments: { month: (await fixture.core.repository.getContextInfo()).currentMonth } });
  assert.equal((await completed.json()).state, 'SUCCEEDED');
  assert.equal((await call(`/api/v1/agent/runs/${body.run_id}/cancel`, 'POST', {})).status, 409);
  assert.equal((await call('/api/v1/agent/runs', 'POST', { user_id: 'forged' })).status, 422);
});

test('API timeout is HTTP 504 with unified error', async () => {
  const fixture = mockSetup({ invoke: async () => new Promise(() => {}) }); const access = 'test-only-access-code';
  const api = createAgentApi({ ...fixture, env: { SAVEFLOW_ACCESS_CODE: access } });
  const response = await api(new Request('http://localhost/api/v1/agent/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Saveflow-Access': access, 'Idempotency-Key': 'timeout' }, body: JSON.stringify(mockRequest('x')) }));
  assert.equal(response.status, 504); assert.equal((await response.json()).error.code, 'SKILL_TIMEOUT');
});

test('cancellation during execution is durable and prevents the next step', async () => {
  let release; let started;
  const entered = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const { orchestrator } = mockSetup({ timeoutMs: 1000, invoke: async () => { calls++; started(); await blocked; return { ok: true, data: { value: 'verified' } }; } });
  const body = { ...request({}), steps: [
    { step_id: 'first', skill_name: 'mock', arguments: { action: 'mock.read', value: 'x' } },
    { step_id: 'second', skill_name: 'mock', arguments: { action: 'mock.read', value: 'y' }, dependencies: ['first'] },
  ] };
  const pending = create(orchestrator, body, 'cancel_during_execution');
  await entered;
  const snapshot = await create(orchestrator, body, 'cancel_during_execution');
  const cancellation = await orchestrator.cancel(owner, snapshot.run_id);
  assert.equal(cancellation.cancel_requested, true); release();
  const result = await pending; assert.equal(result.state, 'CANCELLED'); assert.equal(calls, 1);
});

test('missing action collects a concrete field and rejects invented defaults', async () => {
  const { orchestrator } = setup();
  const run = await create(orchestrator, { ...request({}), skill_name: 'bill' });
  assert.equal(run.state, 'COLLECTING_INPUT'); assert.deepEqual(run.missing_fields, ['step_1.action']);
});

test('invalid input patch leaves the original collecting task intact', async () => {
  const { orchestrator } = setup(); const run = await create(orchestrator, request({ action: 'bill.summary' }));
  await assert.rejects(orchestrator.input(owner, run.run_id, { arguments: 'bad' }), { code: 'INVALID_REQUEST' });
  assert.deepEqual((await orchestrator.get(owner, run.run_id)).request, run.request);
});

test('untrusted router cannot execute unknown skills or control state', async () => {
  const { orchestrator } = setup({ router: { route: () => ({ intent: 'unsafe', confidence: 1, selected_skills: ['missing'], extracted_arguments: {}, state: 'SUCCEEDED' }) } });
  const run = await create(orchestrator, request({})); assert.equal(run.state, 'FAILED'); assert.equal(run.error.code, 'SKILL_NOT_FOUND');
});

test('write failures are not retried even when adapter reports retryable', async () => {
  let calls = 0; const { orchestrator } = mockSetup({ operation: 'WRITE', maxRetries: 3, invoke: async () => { calls++; throw Object.assign(new Error('mock'), { code: 'ECONNRESET' }); } });
  let run = await create(orchestrator, mockRequest('x')); run = await orchestrator.confirm(owner, run.run_id, confirmInput(run));
  assert.equal(run.state, 'FAILED'); assert.equal(calls, 1);
});

test('scalar mapping rejects missing fields and whole-object transfer', async () => {
  for (const field of ['absent', 'nested']) {
    const registry = new SkillRegistry().register(mockAdapter({ invoke: async () => ({ ok: true, data: { nested: { secret: 'mock' } } }) }));
    const { orchestrator } = setup({ registry });
    const run = await create(orchestrator, { ...request({}), steps: [
      { step_id: 'a', skill_name: 'mock', arguments: { action: 'mock.read', value: 'x' } },
      { step_id: 'b', skill_name: 'mock', arguments: { action: 'mock.read' }, dependencies: ['a'], mappings: [{ from_step: 'a', from_field: field, to_field: 'value' }] },
    ] });
    assert.equal(run.state, 'FAILED'); assert.equal(run.error.code, 'SKILL_VALIDATION_FAILED');
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import seed from '../src/data/saveflow_mock_data.json' with { type: 'json' };
import { createFinancialContext } from '../src/banking-core/repository.mjs';
import { validateAgentProposalV2, AgentProposalV2Error } from '../server/agent-proposal-v2.mjs';
import { createReadOnlyToolGateway } from '../server/read-only-tool-gateway.mjs';
import { runReadOnlyPlanner } from '../server/read-only-planner.mjs';
import { handleBankingAgent } from '../server/banking-agent.mjs';
import { createBankingCore } from '../src/banking-core/core.mjs';

const proposal = plan => ({ schemaVersion: '2.0.0', kind: 'plan_request', goal: '分析固定开支', plan_request: plan });

test('AgentProposalV2 rejects write capabilities, entity IDs and unregistered tools', () => {
  assert.throws(() => validateAgentProposalV2(proposal({ tool: 'transfer.create', arguments: {}, reason: '越权' })), AgentProposalV2Error);
  assert.throws(() => validateAgentProposalV2(proposal({ tool: 'card.get', arguments: { card_ref: 'card_ent' } })), AgentProposalV2Error);
  assert.throws(() => validateAgentProposalV2(proposal({ tool: 'subscription.list', arguments: { operationId: 'op_1' } })), AgentProposalV2Error);
  const valid = validateAgentProposalV2(proposal({ tool: 'subscription.list', arguments: {}, depends_on: ['bill.summary'] }));
  assert.equal(valid.plan_request.tool, 'subscription.list');
  const wealth = validateAgentProposalV2(proposal({ tool: 'wealth.recommend', arguments: { goal: '保留流动性', max_risk_level: 'R1', horizon_days: 30, liquidity_requirement: 'T+0' } }));
  assert.equal(wealth.plan_request.arguments.max_risk_level, 'R1');
});

test('read-only gateway uses formal repository data and emits evidence without model supplied IDs', async () => {
  const { repository } = createFinancialContext(seed);
  const gateway = createReadOnlyToolGateway({ repository });
  const result = await gateway.execute('bill.summary', { month: '2026-08' });
  assert.equal(result.tool, 'bill.summary');
  assert.equal(result.result.ok, true);
  assert.equal(result.result.data.month, '2026-08');
  assert.equal(result.result.data.transactionCount, 12);
  assert.equal(result.result.evidence[0].source, 'synthetic_demo_only');
  assert.equal(result.result.evidence[0].entityIds.length, 12);
  const products = await repository.getInvestmentProducts();
  const comparison = await gateway.execute('wealth.compare', { product_refs: products.slice(0, 2).map(product => product.name) });
  assert.equal(comparison.result.ok, true);
  assert.equal(comparison.result.evidence[0].entityIds.length, 2);
  assert.equal(Object.hasOwn(comparison.result.data.products[0], 'product_ref'), false);
});

test('planner chooses the second tool after observing the first tool result', async () => {
  const { repository } = createFinancialContext(seed);
  const inputs = [];
  const runtimeClient = {
    async createSession() { return 'planning-session'; },
    async cancel() {},
    async runTurn(_session, wire) {
      const input = JSON.parse(wire); inputs.push(input);
      if (input.observations.length === 0) return JSON.stringify(proposal({ tool: 'bill.summary', arguments: { month: '2026-08' }, reason: '先读取目标月份支出' }));
      if (input.observations.length === 1) {
        assert.equal(input.observations[0].tool, 'bill.summary');
        assert.equal(input.observations[0].result.month, '2026-08');
        return JSON.stringify(proposal({ tool: 'subscription.list', arguments: {}, depends_on: ['bill.summary'], reason: '根据账单结果检查订阅' }));
      }
      return JSON.stringify({ schemaVersion: '2.0.0', kind: 'task_control', goal: '分析固定开支', task_control: { command: 'finish', analysis: '已读取账单与订阅，具体金额以工具结果为准。', evidence_tools: ['bill.summary', 'subscription.list'] } });
    },
  };
  const result = await runReadOnlyPlanner({ message: '8月支出增加是不是订阅造成的', repository, runtimeClient, env: {}, now: () => Date.parse('2026-10-22T04:00:00Z') });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.steps.map(step => step.tool), ['bill.summary', 'subscription.list']);
  assert.equal(result.steps[1].depends_on.length, 1);
  assert.equal(inputs.length, 3);
  assert.equal(result.steps.every(step => step.status === 'completed'), true);
  assert.equal(result.audit.some(item => item.tool === 'subscription.list' && item.status === 'accepted'), true);
});

test('planner stops on repeated calls and never executes a write tool', async () => {
  const { repository } = createFinancialContext(seed);
  let calls = 0;
  const runtimeClient = {
    async createSession() { return 'planning-session'; }, async cancel() {},
    async runTurn() { calls++; return JSON.stringify(proposal({ tool: 'product.list', arguments: {} })); },
  };
  const result = await runReadOnlyPlanner({ message: '看看有哪些理财产品', repository, runtimeClient, env: {}, now: Date.now });
  assert.equal(result.status, 'partial');
  assert.equal(result.reason.includes('重复'), true);
  assert.equal(result.steps.length, 1);
  assert.equal(calls, 2);
  assert.throws(() => validateAgentProposalV2(proposal({ tool: 'wealth.subscribe', arguments: { product_ref: '产品A', amount: { amount_minor: 10000, currency: 'CNY' }, source_account_ref: '活期账户' } })), AgentProposalV2Error);
});

test('single bill request stops after one read and keeps verified analysis evidence', async () => {
  const { repository } = createFinancialContext(seed);
  const seen = [];
  const runtimeClient = {
    async createSession() { return 'single-bill'; }, async cancel() {},
    async runTurn(_session, wire) {
      const input = JSON.parse(wire); seen.push(input);
      return JSON.stringify(input.observations.length === 0
        ? proposal({ tool: 'bill.summary', arguments: { month: '2026-08' }, reason: '查询用户指定月份' })
        : { schemaVersion: '2.0.0', kind: 'task_control', task_control: { command: 'finish', analysis: '已查询八月账单。', evidence_tools: ['bill.summary'] } });
    },
  };
  const result = await runReadOnlyPlanner({ message: '查八月账单', repository, runtimeClient });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.steps.map(step => step.tool), ['bill.summary']);
  assert.deepEqual(result.evidenceSteps, [result.steps[0].stepId]);
  assert.equal(seen[1].observations[0].result.month, '2026-08');
});

test('missing bill coverage is observed and cannot be cited as a successful zero-expense finding', async () => {
  const { repository } = createFinancialContext(seed);
  const runtimeClient = {
    async createSession() { return 'missing-data'; }, async cancel() {},
    async runTurn(_session, wire) {
      const input = JSON.parse(wire);
      if (!input.observations.length) return JSON.stringify(proposal({ tool: 'bill.summary', arguments: { month: '2025-12' } }));
      assert.equal(input.observations[0].status, 'completed');
      assert.ok(input.observations[0].result.coverage);
      return JSON.stringify({ schemaVersion: '2.0.0', kind: 'clarify', clarify: { question: '缺少该月流水，无法判断支出，请提供有数据的月份。' } });
    },
  };
  const result = await runReadOnlyPlanner({ message: '分析2025年12月支出', repository, runtimeClient });
  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.steps.length, 1);
});

test('tool failure returns partial without retry or fabricated completion', async () => {
  const { repository } = createFinancialContext(seed);
  const broken = { ...repository, async getContextInfo() { throw new Error('offline'); } };
  let turns = 0;
  const runtimeClient = { async createSession() { return 'failed-tool'; }, async cancel() {}, async runTurn() { turns++; return JSON.stringify(proposal({ tool: 'subscription.list', arguments: {} })); } };
  const result = await runReadOnlyPlanner({ message: '查看订阅', repository: broken, runtimeClient });
  assert.equal(result.status, 'partial');
  assert.equal(result.steps[0].status, 'failed');
  assert.equal(result.audit[0].status, 'tool_failed');
  assert.equal(turns, 1);
});

test('wealth recommendation requires matching user declared constraints', async () => {
  const { repository } = createFinancialContext(seed);
  const args = { goal: '短期保留流动性', max_risk_level: 'R1', horizon_days: 30, liquidity_requirement: 'T+0' };
  await assert.rejects(createReadOnlyToolGateway({ repository }).execute('wealth.recommend', args), /READ_ONLY_USER_CONSTRAINT_REQUIRED/);
  const gateway = createReadOnlyToolGateway({ repository, constraints: { max_risk_level: 'R1', horizon_days: 30, liquidity_requirement: 'T+0' } });
  const result = await gateway.execute('wealth.recommend', args);
  assert.equal(result.result.kind, 'wealth_recommendation');
  assert.equal(result.result.evidence[0].source, 'financial_context.investment_products');
  const runtimeClient = { async createSession() { return 'wealth-clarify'; }, async cancel() {}, async runTurn() { return JSON.stringify(proposal({ tool: 'wealth.recommend', arguments: args })); } };
  const clarification = await runReadOnlyPlanner({ message: '推荐一些理财产品', repository, runtimeClient });
  assert.equal(clarification.status, 'needs_clarification');
  assert.equal(clarification.steps[0].status, 'rejected');
  assert.equal(clarification.audit[0].resultStatus, 'not_executed');
});

test('model write proposal is audited as rejected before any repository call', async () => {
  const { repository } = createFinancialContext(seed);
  let reads = 0;
  const guarded = { ...repository, async getContextInfo() { reads++; return repository.getContextInfo(); } };
  const runtimeClient = { async createSession() { return 'write-attempt'; }, async cancel() {}, async runTurn() { return JSON.stringify(proposal({ tool: 'transfer.create', arguments: { amount: 50000 } })); } };
  const result = await runReadOnlyPlanner({ message: '不要执行任何修改', repository: guarded, runtimeClient });
  assert.equal(result.status, 'partial');
  assert.equal(result.steps.length, 0);
  assert.equal(result.audit[0].status, 'rejected');
  assert.equal(result.audit[0].reason, 'PROPOSAL_TOOL_NOT_ALLOWED');
  assert.equal(reads, 0);
});

test('banking API exposes planning mode without entering the existing write path', async () => {
  const core = createBankingCore({ source: seed });
  const guardedCore = { ...core, prepare() { throw new Error('planning called Core.prepare'); }, decide() { throw new Error('planning called Core.decide'); }, execute() { throw new Error('planning called Core.execute'); } };
  const balanceBefore = core.repository.getAccount('ACC-CHECKING').balanceFen;
  const env = { SAVEFLOW_ACCESS_CODE: 'planning-test-access', CONTINUATION_TOKEN_SECRET: 'planning-test-secret', SAVEFLOW_BANKING_RUNTIME: 'trueforge' };
  const planningRuntimeClient = {
    async createSession() { return 'planning-session'; }, async cancel() {},
    async runTurn(_session, wire) {
      const input = JSON.parse(wire);
      return input.observations.length
        ? JSON.stringify({ schemaVersion: '2.0.0', kind: 'task_control', goal: input.userMessage, task_control: { command: 'finish', analysis: '已取得产品列表。', evidence_tools: ['product.list'] } })
        : JSON.stringify(proposal({ tool: 'product.list', arguments: {} }));
    },
  };
  const request = new Request('http://localhost/api/banking-agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'x-forwarded-for': 'planning-api-test' },
    body: JSON.stringify({ message: '分析可选理财产品', planning: true }),
  });
  const response = await handleBankingAgent(request, { env, core: guardedCore, planningRuntimeClient, now: () => Date.parse('2026-10-22T04:00:00Z') });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.status, 'completed');
  assert.equal(body.data.plan.steps[0].tool, 'product.list');
  assert.equal(body.data.plan.taskId, body.data.conversation.currentTask.taskId);
  assert.equal(body.data.conversation.currentTask.status, 'completed');
  assert.equal(body.data.plan.evidenceSteps[0], body.data.plan.steps[0].stepId);
  assert.equal(core.repository.getAccount('ACC-CHECKING').balanceFen, balanceBefore);
});

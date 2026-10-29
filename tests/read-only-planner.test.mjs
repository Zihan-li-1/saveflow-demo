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
      return JSON.stringify({ schemaVersion: '2.0.0', kind: 'task_control', goal: '分析固定开支', task_control: { command: 'finish' } });
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

test('banking API exposes planning mode without entering the existing write path', async () => {
  const core = createBankingCore({ source: seed });
  const balanceBefore = core.repository.getAccount('ACC-CHECKING').balanceFen;
  const env = { SAVEFLOW_ACCESS_CODE: 'planning-test-access', CONTINUATION_TOKEN_SECRET: 'planning-test-secret', SAVEFLOW_BANKING_RUNTIME: 'trueforge' };
  const planningRuntimeClient = {
    async createSession() { return 'planning-session'; }, async cancel() {},
    async runTurn(_session, wire) {
      const input = JSON.parse(wire);
      return input.observations.length
        ? JSON.stringify({ schemaVersion: '2.0.0', kind: 'task_control', goal: input.userMessage, task_control: { command: 'finish' } })
        : JSON.stringify(proposal({ tool: 'product.list', arguments: {} }));
    },
  };
  const request = new Request('http://localhost/api/banking-agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'x-forwarded-for': 'planning-api-test' },
    body: JSON.stringify({ message: '分析可选理财产品', planning: true }),
  });
  const response = await handleBankingAgent(request, { env, core, planningRuntimeClient, now: () => Date.parse('2026-10-22T04:00:00Z') });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.status, 'completed');
  assert.equal(body.data.plan.steps[0].tool, 'product.list');
  assert.equal(core.repository.getAccount('ACC-CHECKING').balanceFen, balanceBefore);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { handleBankingAgent } from '../server/banking-agent.mjs';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { buildParsedIntent } from '../src/agent/clarification/merge-intent.mjs';

const env = {
  SAVEFLOW_BANKING_RUNTIME: 'legacy-qwen',
  SAVEFLOW_ACCESS_CODE: 'task-cancel-access-1234',
  CONTINUATION_TOKEN_SECRET: 'task-cancel-secret-1234',
};
let serial = 0;
const request = body => new Request('http://localhost/api/banking-agent', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE,
    'x-forwarded-for': `task-cancel-${++serial}`,
  },
  body: JSON.stringify(body),
});
const post = async (core, body, parseIntent) => {
  const response = await handleBankingAgent(request(body), { env, core, parseIntent, now: () => Date.parse('2026-10-27T04:00:00Z') });
  return { httpStatus: response.status, ...await response.json() };
};
const cancelIntent = () => buildParsedIntent('task.cancel', {});
const transferIntent = complete => buildParsedIntent('transfer.create', {
  payee_ref: '张三',
  amount: { amount_minor: 50000, currency: 'CNY' },
  ...(complete ? { source_account_ref: '活期账户' } : {}),
});

test('task.cancel ends a clarification task without dispatching another Skill', async () => {
  const core = createBankingCore();
  let parsed = transferIntent(false);
  const first = await post(core, { message: '给张三转500元' }, async () => parsed);
  assert.equal(first.data.status, 'needs_clarification');
  parsed = cancelIntent();
  const cancelled = await post(core, {
    conversationToken: first.data.conversation.token,
    conversationRevision: first.data.conversation.revision,
    message: '取消转账',
  }, async () => parsed);
  assert.equal(cancelled.code, 'OK');
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal(cancelled.data.action, 'transfer.create');
  assert.equal(cancelled.data.conversation.currentTask.status, 'cancelled');
});

test('task.cancel rejects an awaiting transfer preview and never changes balance or transactions', async () => {
  const core = createBankingCore();
  const beforeBalance = core.repository.getAccount('ACC-CHECKING').availableBalanceFen;
  const beforeTransactions = core.repository.getTransactions().length;
  let parsed = transferIntent(true);
  const preview = await post(core, { message: '从活期账户给张三转500元' }, async () => parsed);
  assert.equal(preview.data.status, 'awaiting_confirmation');
  parsed = cancelIntent();
  const cancelled = await post(core, {
    conversationToken: preview.data.conversation.token,
    conversationRevision: preview.data.conversation.revision,
    message: '取消转账',
  }, async () => parsed);
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal(cancelled.data.operationId, preview.data.operationId);
  assert.equal((await core.getOperation(preview.data.operationId)).data.state, 'cancelled');
  assert.equal(core.repository.getAccount('ACC-CHECKING').availableBalanceFen, beforeBalance);
  assert.equal(core.repository.getTransactions().length, beforeTransactions);
});

test('task.cancel cannot roll back a Core operation that was already confirmed', async () => {
  const core = createBankingCore();
  let parsed = transferIntent(true);
  const preview = await post(core, { message: '从活期账户给张三转500元' }, async () => parsed);
  await core.decide(preview.data.operationId, {
    previewHash: preview.data.preview.previewHash,
    decision: 'confirm',
    confirmedStepIds: preview.data.preview.stepIds,
  });
  parsed = cancelIntent();
  const refused = await post(core, {
    conversationToken: preview.data.conversation.token,
    conversationRevision: preview.data.conversation.revision,
    message: '取消转账',
  }, async () => parsed);
  assert.equal(refused.code, 'CONVERSATION_OPERATION_LOCKED');
  assert.equal(refused.data.operationId, preview.data.operationId);
  assert.equal((await core.getOperation(preview.data.operationId)).data.state, 'confirmed');
});

test('the same task.cancel rejects pending card, wealth and scenario previews', async () => {
  const cases = [
    {
      label: 'card',
      intent: buildParsedIntent('card.freeze', { card_ref: '日常虚拟卡' }),
      message: '冻结日常虚拟卡',
    },
    {
      label: 'wealth',
      intent: buildParsedIntent('wealth.subscribe', {
        product_ref: '模拟灵活现金 A',
        amount: { amount_minor: 10000, currency: 'CNY' },
        source_account_ref: '活期账户',
      }),
      message: '用活期账户申购100元模拟灵活现金A',
    },
    {
      label: 'scenario',
      intent: buildParsedIntent('scenario.create_rule', {
        trigger: { type: 'financial_event', value: 'balance_changed' },
        conditions: { balance_below_minor: 100000 },
        proposed_steps: [{ action: 'bill.analyze', parameters: {} }],
        authorization_scope: 'suggest_only',
      }),
      message: '创建余额变化提醒规则',
    },
  ];
  for (const item of cases) {
    const core = createBankingCore();
    let parsed = item.intent;
    const preview = await post(core, { message: item.message }, async () => parsed);
    assert.ok(['awaiting_confirmation', 'scenario_rule_preview'].includes(preview.data.status), `${item.label}: ${preview.code}`);
    parsed = cancelIntent();
    const cancelled = await post(core, {
      conversationToken: preview.data.conversation.token,
      conversationRevision: preview.data.conversation.revision,
      message: '取消当前操作',
    }, async () => parsed);
    assert.equal(cancelled.data.status, 'cancelled', item.label);
    assert.equal(cancelled.data.operationId, preview.data.operationId, item.label);
    assert.equal((await core.getOperation(preview.data.operationId)).data.state, 'cancelled', item.label);
  }
});

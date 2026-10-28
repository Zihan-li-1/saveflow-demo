import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationStore } from '../server/conversation-state.mjs';
import { handleTaskControl, validateTaskControlProposal, TaskControlError } from '../server/agent-task-control.mjs';
import { openBankingConversation } from '../server/banking-conversation.mjs';
import { buildParsedIntent } from '../src/agent/clarification/merge-intent.mjs';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { runBankingConversation } from '../server/banking-orchestrator.mjs';
import { issueContinuationToken } from '../src/agent/clarification/continuation-token.mjs';

const epoch = Date.parse('2026-10-28T00:00:00Z');
const env = { SAVEFLOW_ACCESS_CODE: 'test-access', CONTINUATION_TOKEN_SECRET: 'a'.repeat(32) };
const transfer = slots => buildParsedIntent('transfer.create', slots);

test('trusted task summary is bounded and never exposes task or operation identifiers', async () => {
  let clock = epoch;
  const store = createConversationStore({ now: () => clock });
  const { conversationToken } = store.create();
  const state = await store.transition(conversationToken, 0, {
    type: 'start_task',
    intent: transfer({ payee_ref: '张三', amount: { amount_minor: 60000, currency: 'CNY' } }),
  });
  const summary = store.taskSummary(conversationToken);
  assert.equal(summary.currentTask.status, 'awaiting_input');
  assert.deepEqual(summary.currentTask.pendingSlots, ['source_account_ref']);
  assert.equal(summary.currentTask.hasOperation, false);
  assert.equal(summary.currentTask.verifiedSlots.payee_ref, '[已核验引用]');
  assert.equal(JSON.stringify(summary).includes(state.currentTask.taskId), false);
  assert.equal(JSON.stringify(summary).includes('operationId'), false);
  clock += 1;
});

test('task_control proposal is strict and delegates only the normalized command', async () => {
  const calls = [];
  const result = await handleTaskControl(
    { kind: 'task_control', control: { command: 'undo', target: 'previous' } },
    { getTaskSummary: () => ({ currentTask: null, previousTasks: [], recentOperations: [] }), controlTask: control => { calls.push(control); return { status: 'cancelled' }; } },
  );
  assert.deepEqual(result, { status: 'cancelled' });
  assert.deepEqual(calls, [{ command: 'undo', target: 'previous' }]);
  for (const forged of [
    { kind: 'task_control', control: { command: 'undo', target: 'current', taskId: 'task_fake' } },
    { kind: 'task_control', control: { command: 'execute', target: 'current' } },
    { kind: 'task_control', control: { command: 'undo', target: 'current' }, operationId: 'op_fake' },
  ]) assert.throws(() => validateTaskControlProposal(forged), error => error instanceof TaskControlError && error.code === 'TASK_CONTROL_INVALID');
});

test('deterministic cancellation accepts the explicit transfer phrase without widening model authority', async () => {
  const core = createBankingCore({ now: () => epoch });
  const continuationToken = issueContinuationToken({
    action: 'transfer.create',
    slots: { payee_ref: '张三', amount: { amount_minor: 60000, currency: 'CNY' } },
    pendingSlot: 'source_account_ref',
  }, env.CONTINUATION_TOKEN_SECRET, epoch);
  const result = await runBankingConversation({ continuationToken, message: '取消转账' }, {
    core, env, now: () => epoch, parseIntent: async () => transfer({}),
  });
  assert.equal(result.data.status, 'cancelled');
});

async function conversationFixture(slots, { readOverride } = {}) {
  const core = createBankingCore({ now: () => epoch });
  const [account] = core.repository.getAccounts();
  const payee = core.repository.getPayees().find(item => item.name === '张三');
  const realReader = id => core.getOperation(id);
  const adapter = {
    prepare: request => core.prepare(request),
    decide: (id, decision) => core.decide(id, decision),
    getOperation: id => readOverride ? readOverride(id, realReader) : realReader(id),
  };
  const host = { now: epoch, busy: new Set(), store: createConversationStore({ now: () => epoch, readCoreOperation: id => adapter.getOperation(id) }) };
  const conversation = openBankingConversation({}, { core: adapter, env, now: () => epoch, parseIntent: async () => transfer(slots), conversationHost: host });
  await conversation.begin();
  await conversation.acceptIntent(transfer(slots), { env });
  return { core, adapter, conversation, account, payee, release: () => conversation.release() };
}

async function attachTransfer(fixture) {
  const prepared = await fixture.conversation.prepare({ action: 'transfer_money', input: {
    fromAccountId: fixture.account.id, payeeId: fixture.payee.id, amountFen: 60000, currency: 'CNY',
  } });
  assert.equal(prepared.ok, true);
  await fixture.conversation.finish({ code: 'OK', data: { status: 'awaiting_confirmation', operationId: prepared.data.operationId } });
  return prepared.data;
}

test('undo cancels an awaiting-input draft and formal preview through Core', async () => {
  const draft = await conversationFixture({ payee_ref: '张三', amount: { amount_minor: 60000, currency: 'CNY' }});
  try {
    const cancelled = await draft.conversation.taskControl({ kind: 'task_control', control: { command: 'undo', target: 'current' } });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(draft.conversation.taskSummary().currentTask.status, 'cancelled');
  } finally { draft.release(); }

  const preview = await conversationFixture({ payee_ref: '张三', source_account_ref: '活期账户', amount: { amount_minor: 60000, currency: 'CNY' }});
  try {
    const prepared = await attachTransfer(preview);
    const cancelled = await preview.conversation.taskControl({ kind: 'task_control', control: { command: 'undo', target: 'current' } });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await preview.core.getOperation(prepared.operationId)).data.state, 'cancelled');
  } finally { preview.release(); }
});

test('successful execution cannot be undone and uncertain Core state stays query-only', async () => {
  const done = await conversationFixture({ payee_ref: '张三', source_account_ref: '活期账户', amount: { amount_minor: 60000, currency: 'CNY' }});
  try {
    const prepared = await attachTransfer(done);
    const decision = await done.core.decide(prepared.operationId, { previewHash: prepared.preview.previewHash, decision: 'confirm', confirmedStepIds: prepared.preview.stepIds });
    assert.equal(decision.ok, true);
    await done.core.execute(prepared.operationId, prepared.preview.previewHash);
    const result = await done.conversation.taskControl({ kind: 'task_control', control: { command: 'undo', target: 'current' } });
    assert.equal(result.status, 'already_succeeded');
  } finally { done.release(); }

  let reads = 0;
  const uncertain = await conversationFixture({ payee_ref: '张三', source_account_ref: '活期账户', amount: { amount_minor: 60000, currency: 'CNY' } }, {
    readOverride: async (id, realReader) => {
      const real = await realReader(id);
      reads++;
      if (reads === 1) return real;
      return { ok: true, data: { ...real.data, state: 'confirmed', status: 'pending', receipt: undefined } };
    },
  });
  try {
    await attachTransfer(uncertain);
    const result = await uncertain.conversation.taskControl({ kind: 'task_control', control: { command: 'undo', target: 'current' } });
    assert.equal(result.status, 'blocked');
    assert.equal(result.nextAction, 'query_status');
  } finally { uncertain.release(); }
});

test('previous target is clarified when more than one resumable task exists, and concurrent revision wins once', async () => {
  const store = createConversationStore({ now: () => epoch });
  const { conversationToken } = store.create();
  const first = await store.transition(conversationToken, 0, { type: 'start_task', intent: buildParsedIntent('bill.summary', {}) });
  const second = await store.transition(conversationToken, first.revision, { type: 'start_task', suspendCurrent: true, intent: buildParsedIntent('bill.summary', { month: '2026-08' }) });
  const summary = store.taskSummary(conversationToken);
  assert.equal(summary.previousTasks.length, 1);
  const results = await Promise.allSettled([
    store.transition(conversationToken, second.revision, { type: 'end_task', taskId: second.currentTask.taskId, outcome: 'cancelled' }),
    store.transition(conversationToken, second.revision, { type: 'end_task', taskId: second.currentTask.taskId, outcome: 'cancelled' }),
  ]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(store.read(conversationToken).currentTask.status, 'cancelled');

  const conversation = await conversationFixture({ payee_ref: '张三', amount: { amount_minor: 60000, currency: 'CNY' } });
  try {
    await conversation.conversation.acceptIntent(buildParsedIntent('bill.summary', { month: '2026-08' }), { env });
    const result = await conversation.conversation.taskControl({ kind: 'task_control', control: { command: 'undo', target: 'previous' } });
    assert.equal(result.status, 'needs_clarification');
  } finally { conversation.release(); }
});

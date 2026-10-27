import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleBankingAgent } from '../server/banking-agent.mjs';
import { createConversationStore } from '../server/conversation-state.mjs';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { buildParsedIntent } from '../src/agent/clarification/merge-intent.mjs';

const env = { SAVEFLOW_ACCESS_CODE: 'task-control-access-1234', CONTINUATION_TOKEN_SECRET: 'task-control-secret-1234' };
let serial = 0;
const intent = amount => buildParsedIntent('transfer.create', {
  payee_ref: '张三', amount: { amount_minor: amount, currency: 'CNY' }, source_account_ref: '活期账户',
});

function fixture({ observedState } = {}) {
  let clock = Date.parse('2026-10-28T04:00:00Z');
  const now = () => clock;
  const core = createBankingCore({ now });
  const readCoreOperation = async operationId => {
    const result = await core.getOperation(operationId);
    return result.ok && observedState ? { ok: true, data: { ...result.data, state: observedState, status: 'pending' } } : result;
  };
  const host = { store: createConversationStore({ now, readCoreOperation }), busy: new Set() };
  const parseIntent = async (message, options) => {
    if (options.context) {
      const slots = structuredClone(options.context.slots);
      if (message === '改成600元') slots.amount = { amount_minor: 60000, currency: 'CNY' };
      return buildParsedIntent(options.context.action, slots);
    }
    return message === '发起待补充转账'
      ? buildParsedIntent('transfer.create', { payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' } })
      : intent(50000);
  };
  const post = async body => {
    const request = new Request('http://localhost/api/banking-agent', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Saveflow-Access': env.SAVEFLOW_ACCESS_CODE, 'X-Forwarded-For': `task-control-${++serial}`,
    }, body: JSON.stringify(body) });
    const response = await handleBankingAgent(request, { env, core: { ...core, getOperation: readCoreOperation }, now, parseIntent, conversationHost: host });
    return { httpStatus: response.status, ...await response.json() };
  };
  return { core, host, post, setTime: value => { clock = value; } };
}
const session = result => ({ conversationToken: result.data.conversation.token, conversationRevision: result.data.conversation.revision });
const continuation = result => ({ ...session(result), taskMode: 'continue', taskId: result.data.conversation.currentTask.taskId,
  continuationToken: result.data.continuationToken });

test('“取消转账” cancels the server draft while waiting for an account', async () => {
  const f = fixture();
  const draft = await f.post({ message: '发起待补充转账' });
  assert.equal(draft.data.status, 'needs_clarification');
  const cancelled = await f.post({ ...continuation(draft), message: '取消转账' });
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal(cancelled.data.action, 'transfer.create');
  assert.equal(cancelled.data.conversation.currentTask.status, 'cancelled');
});

test('“撤回上一步操作” locates one current cancellable task without model-supplied identity', async () => {
  const f = fixture();
  const draft = await f.post({ message: '发起待补充转账' });
  const undone = await f.post({ ...session(draft), message: '撤回上一步操作' });
  assert.equal(undone.data.status, 'cancelled');
  assert.equal(undone.data.command, 'undo');
  assert.equal(undone.data.taskId, undefined);
});

test('“改成600元” keeps the same task, creates a new preview and never executes it', async () => {
  const f = fixture();
  const before = f.core.repository.getAccount('ACC-CHECKING').availableBalanceFen;
  const first = await f.post({ message: '给张三转500元' });
  assert.equal(first.data.status, 'awaiting_confirmation');
  const changed = await f.post({ ...continuation(first), message: '改成600元' });
  assert.equal(changed.data.status, 'awaiting_confirmation');
  assert.equal(changed.data.conversation.currentTask.taskId, first.data.conversation.currentTask.taskId);
  assert.notEqual(changed.data.operationId, first.data.operationId);
  assert.equal(changed.data.preview.exactEffects[0].amountFen, 60000);
  assert.equal(f.core.repository.getAccount('ACC-CHECKING').availableBalanceFen, before);
});

test('cancelling a formal preview rejects it through Core instead of only clearing chat state', async () => {
  const f = fixture();
  const preview = await f.post({ message: '给张三转500元' });
  assert.equal((await f.core.getOperation(preview.data.operationId)).data.state, 'awaiting_confirmation');
  const cancelled = await f.post({ ...continuation(preview), message: '取消转账' });
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal(cancelled.data.previewRejected, true);
  assert.equal((await f.core.getOperation(preview.data.operationId)).data.state, 'cancelled');
  assert.equal(cancelled.data.conversation.currentTask.status, 'cancelled');
});

test('a succeeded transfer cannot be undone through chat', async () => {
  const f = fixture();
  const preview = await f.post({ message: '给张三转500元' });
  assert.equal(preview.data.status, 'awaiting_confirmation');
  assert.equal((await f.core.decide(preview.data.operationId, { previewHash: preview.data.preview.previewHash,
    decision: 'confirm', confirmedStepIds: preview.data.preview.stepIds })).ok, true);
  assert.equal((await f.core.execute(preview.data.operationId, preview.data.preview.previewHash)).ok, true);
  const result = await f.post({ ...session(preview), message: '撤回上一步操作' });
  assert.equal(result.code, 'CONVERSATION_TASK_FINISHED');
  assert.equal(result.data.status, 'cannot_undo_completed');
  assert.equal((await f.core.getOperation(preview.data.operationId)).data.state, 'succeeded');
});

test('forged continuation cannot cancel a task and repeated or concurrent cancellation cannot create an illegal transition', async () => {
  const f = fixture();
  const draft = await f.post({ message: '发起待补充转账' });
  const forged = await f.post({ ...continuation(draft), continuationToken: `${draft.data.continuationToken}x`, message: '取消转账' });
  assert.equal(forged.code, 'CONTINUATION_INVALID');
  assert.equal(f.host.store.read(draft.data.conversation.token).currentTask.status, 'awaiting_input');
  const request = { ...continuation(draft), message: '取消转账' };
  const results = await Promise.all([f.post(request), f.post(request)]);
  assert.ok(results.some(result => result.data.status === 'cancelled'));
  assert.ok(results.every(result => result.data.status === 'cancelled' || result.code === 'CONVERSATION_BUSY' || result.code === 'CONVERSATION_REVISION_CONFLICT'));
  const repeated = await f.post({ conversationToken: draft.data.conversation.token,
    conversationRevision: f.host.store.read(draft.data.conversation.token).revision, message: '取消转账' });
  assert.equal(repeated.data.status, 'no_task');
  assert.equal(f.host.store.read(draft.data.conversation.token).currentTask.status, 'cancelled');
});

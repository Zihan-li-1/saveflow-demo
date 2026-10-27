import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrustedTaskContext, handleAgentTaskControl, validateTaskControlProposal } from '../server/agent-task-control.mjs';

const task = (overrides = {}) => ({
  taskId: 'task_00000000-0000-4000-8000-000000000001', action: 'transfer.create', status: 'awaiting_input', resumeStatus: null,
  verifiedSlots: { payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' }, account_id: 'ACC-PRIVATE' },
  pendingSlots: ['source_account_ref'], continuationExpiresAt: 999999, latestContinuationId: 'ct_1', previewOperationId: null,
  operationReferences: [], revision: 1, createdAt: 1, updatedAt: 1, ...overrides,
});
const state = (currentTask = task(), overrides = {}) => ({
  conversationId: 'conv_private', currentTask, suspendedTasks: [], verifiedSlots: {}, pendingPreview: null,
  operationReferences: [], revision: 1, createdAt: 1, updatedAt: 1, expiresAt: 999999, ...overrides,
});
const proposal = (command, target = 'current') => ({ kind: 'task_control', control: { command, target } });

function adapter(initial, { validContinuation = true } = {}) {
  let value = structuredClone(initial);
  const rejected = [];
  return {
    readState: () => value,
    hasValidContinuation: () => validContinuation,
    rejected,
    rejectPreview: async reference => { rejected.push(reference.operationId); value.operationReferences.find(ref => ref.operationId === reference.operationId).coreState = 'cancelled'; },
    transition: async command => {
      if (command.type === 'observe_operation') return value;
      if (command.type === 'resume_task') {
        const index = value.suspendedTasks.findIndex(item => item.taskId === command.taskId);
        const resumed = value.suspendedTasks.splice(index, 1)[0];
        if (value.currentTask && ['ready', 'awaiting_input', 'awaiting_confirmation'].includes(value.currentTask.status)) {
          value.currentTask.status = 'suspended'; value.suspendedTasks.push(value.currentTask);
        }
        resumed.status = resumed.resumeStatus ?? 'ready'; resumed.resumeStatus = null; value.currentTask = resumed;
      }
      if (command.type === 'end_task') {
        if (value.currentTask?.taskId === command.taskId) value.currentTask.status = 'cancelled';
        else value.suspendedTasks = value.suspendedTasks.filter(item => item.taskId !== command.taskId);
      }
      value.revision++;
      return value;
    },
  };
}

test('trusted summary is bounded and never exposes internal task, operation or entity IDs', () => {
  const current = task({ verifiedSlots: { payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' }, entityId: 'payee_001' } });
  const input = state(current, { operationReferences: [
    { operationId: 'op_private', taskId: current.taskId, action: current.action, coreState: 'succeeded' },
  ] });
  const summary = buildTrustedTaskContext(input);
  assert.equal(summary.currentTask.action, 'transfer.create');
  assert.deepEqual(summary.currentTask.pendingSlots, ['source_account_ref']);
  assert.equal(summary.currentTask.verifiedContext.entityId, undefined);
  assert.deepEqual(summary.recentResults, [{ action: 'transfer.create', status: 'succeeded' }]);
  assert.doesNotMatch(JSON.stringify(summary), /task_|op_private|payee_001|ACC-PRIVATE/);
});

test('proposal validation rejects model-supplied IDs and unsupported control fields', () => {
  assert.deepEqual(validateTaskControlProposal(proposal('undo', 'previous')), proposal('undo', 'previous'));
  for (const value of [
    { ...proposal('cancel'), taskId: 'task_fake' },
    { kind: 'task_control', control: { command: 'cancel', target: 'current', operationId: 'op_fake' } },
    { kind: 'task_control', control: { command: 'execute', target: 'current' } },
  ]) assert.throws(() => validateTaskControlProposal(value), /TASK_CONTROL_INVALID/);
});

test('cancel ends an awaiting-input draft and repeated cancel is idempotent no-task', async () => {
  const a = adapter(state());
  assert.deepEqual(await handleAgentTaskControl(proposal('cancel'), a), {
    status: 'cancelled', command: 'cancel', action: 'transfer.create', previewRejected: false,
  });
  assert.equal(a.readState().currentTask.status, 'cancelled');
  assert.deepEqual(await handleAgentTaskControl(proposal('cancel'), a), { status: 'no_task', command: 'cancel' });
});

test('undo previous selects one live task but asks when current and suspended tasks are both viable', async () => {
  const one = adapter(state());
  assert.equal((await handleAgentTaskControl(proposal('undo', 'previous'), one)).status, 'cancelled');
  const suspended = task({ taskId: 'task_00000000-0000-4000-8000-000000000002', status: 'suspended', resumeStatus: 'awaiting_input' });
  const many = adapter(state(task(), { suspendedTasks: [suspended] }));
  const result = await handleAgentTaskControl(proposal('undo', 'previous'), many);
  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.choices.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /task_/);
});

test('awaiting-confirmation preview is legally rejected before its task is cancelled', async () => {
  const current = task({ status: 'awaiting_confirmation', pendingSlots: [], previewOperationId: 'op_1', operationReferences: ['op_1'] });
  const a = adapter(state(current, { operationReferences: [{ operationId: 'op_1', taskId: current.taskId, action: current.action,
    previewHash: 'a'.repeat(64), stepIds: ['step_1'], expiresAt: 999999, coreState: 'awaiting_confirmation', observedAt: 1 }] }));
  const result = await handleAgentTaskControl(proposal('cancel'), a);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.previewRejected, true);
  assert.deepEqual(a.rejected, ['op_1']);
  assert.equal(a.readState().operationReferences[0].coreState, 'cancelled');
});

test('confirmed, executing and unknown operations require status query; succeeded effects cannot be undone', async () => {
  for (const coreState of ['confirmed', 'executing', 'unknown']) {
    const current = task({ status: 'awaiting_confirmation', pendingSlots: [] });
    const a = adapter(state(current, { operationReferences: [{ operationId: 'op_1', taskId: current.taskId, action: current.action, coreState }] }));
    const result = await handleAgentTaskControl(proposal('undo'), a);
    assert.equal(result.status, 'query_required'); assert.equal(result.operationStatus, coreState);
    assert.equal(a.readState().currentTask.status, 'awaiting_confirmation');
  }
  const completed = task({ status: 'awaiting_confirmation', pendingSlots: [] });
  const a = adapter(state(completed, { operationReferences: [{ operationId: 'op_2', taskId: completed.taskId, action: completed.action, coreState: 'succeeded' }] }));
  assert.equal((await handleAgentTaskControl(proposal('undo'), a)).status, 'cannot_undo_completed');
});

test('modify and resume require a still-valid continuation relationship', async () => {
  const current = task();
  assert.equal((await handleAgentTaskControl(proposal('modify'), adapter(state(current)))).status, 'ready_for_modification');
  assert.equal((await handleAgentTaskControl(proposal('modify'), adapter(state(current), { validContinuation: false }))).status, 'needs_continuation');
  const suspended = task({ status: 'suspended', resumeStatus: 'awaiting_input' });
  const resumed = await handleAgentTaskControl(proposal('resume', 'previous'), adapter(state(null, { suspendedTasks: [suspended] })));
  assert.equal(resumed.status, 'resumed');
  assert.equal((await handleAgentTaskControl(proposal('resume', 'current'), adapter(state(null, { suspendedTasks: [suspended] })))).status, 'no_task');
});

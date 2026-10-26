import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationStore, ConversationStateError } from '../server/conversation-state.mjs';
import { createBankingCore } from '../src/banking-core/core.mjs';

const epoch = Date.parse('2026-10-22T04:00:00Z');
const bill = (month = '2026-08') => ({ schemaVersion: '1.0.0', action: 'bill.summary', slots: month ? { month } : {},
  missingSlots: month ? [] : ['month'], status: month ? 'ready_for_resolution' : 'needs_clarification' });
const transfer = () => ({ schemaVersion: '1.0.0', action: 'transfer.create',
  slots: { source_account_ref: '模拟活期账户', payee_ref: '张三', amount: { amount_minor: 100, currency: 'CNY' } },
  missingSlots: [], status: 'ready_for_resolution' });
const code = expected => error => error instanceof ConversationStateError && error.code === expected && error.message === expected;
function fixture(options = {}) {
  let clock = epoch;
  const store = createConversationStore({ now: () => clock, ...options });
  const { conversationToken: token, state } = store.create();
  const send = command => store.transition(token, store.read(token).revision, command);
  return { store, token, state, send, advance: ms => { clock += ms; } };
}
async function coreFixture(options = {}) {
  const core = createBankingCore({ now: () => epoch });
  const [account] = core.repository.getAccounts();
  const payee = core.repository.getPayees().find(payee => payee.name === '张三');
  const prepared = await core.prepare({ action: 'transfer_money', input: { fromAccountId: account.id, payeeId: payee.id, amountFen: 100, currency: 'CNY' } });
  assert.equal(prepared.ok, true);
  const f = fixture({ readCoreOperation: id => core.getOperation(id), ...options });
  await f.send({ type: 'start_task', intent: transfer() });
  const attach = () => f.send({ type: 'attach_preview', taskId: f.store.read(f.token).currentTask.taskId, operationId: prepared.data.operationId });
  return { ...f, core, prepared: prepared.data, attach };
}

test('server generates distinct opaque 256-bit tokens and internal IDs; IDs and invented tokens cannot select a conversation', () => {
  const { store, token, state } = fixture();
  const other = store.create();
  assert.match(token, /^cs1\.[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, other.conversationToken);
  assert.notEqual(state.conversationId, other.state.conversationId);
  assert.ok(!JSON.stringify(state).includes(token));
  for (const bad of [state.conversationId, `cs1.${'A'.repeat(43)}`, null, '']) {
    assert.throws(() => store.read(bad), code('CONVERSATION_NOT_FOUND'));
  }
  assert.throws(() => store.create({ conversationId: 'mine' }), code('CONVERSATION_INVALID_INPUT'));
  assert.equal(state.revision, 0);
  assert.deepEqual([state.createdAt, state.updatedAt, state.expiresAt], [epoch, epoch, epoch + 1800000]);
});

test('start/update derive pending parameters, validate the existing intent contract, and isolate snapshots', async () => {
  const f = fixture();
  const intent = bill(null);
  const started = await f.send({ type: 'start_task', intent });
  assert.equal(started.currentTask.status, 'awaiting_input');
  assert.deepEqual(started.currentTask.pendingSlots, ['month']);
  const id = started.currentTask.taskId;
  intent.slots.month = '2020-01'; started.currentTask.verifiedSlots.month = '2020-02';
  assert.deepEqual(f.store.read(f.token).verifiedSlots, {});
  f.advance(10);
  const updated = await f.send({ type: 'update_task', taskId: id, intent: bill() });
  assert.equal(updated.currentTask.status, 'ready');
  assert.deepEqual(updated.verifiedSlots, { month: '2026-08' });
  assert.equal(updated.updatedAt, epoch + 10);
  assert.equal(updated.revision, 2);
  assert.equal(updated.currentTask.revision, 2);
  updated.verifiedSlots.month = '2000-01';
  assert.equal(f.store.read(f.token).currentTask.verifiedSlots.month, '2026-08');
  await assert.rejects(f.send({ type: 'update_task', taskId: id, intent: transfer() }), code('CONVERSATION_ACTION_MISMATCH'));
});

test('no arbitrary state overwrite, forged permission fields, illegal status, invalid amounts or model choices', async () => {
  const f = fixture();
  const invalid = [
    { type: 'replace', currentTask: {} },
    { type: 'start_task', intent: bill(), conversationId: 'mine' },
    { type: 'start_task', intent: { ...bill(), slots: { month: '2026-13' } } },
    { type: 'start_task', intent: { ...bill(), confirmed: true } },
    { type: 'start_task', intent: { ...bill(), status: 'executing' } },
    { type: 'start_task', intent: { ...bill(), choice: { optionId: 'opt_fake' } } },
    { type: 'start_task', intent: { ...transfer(), slots: { ...transfer().slots, amount: { amount_minor: -1, currency: 'CNY' } } } },
    { type: 'start_task', intent: bill(), suspendCurrent: 'yes' },
    { type: 'start_task', intent: { ...bill(), slots: { month: 'x'.repeat(17000) } } },
    { type: 'start_task', intent: { ...bill(), slots: { month: NaN } } },
  ];
  for (const command of invalid) {
    await assert.rejects(f.send(command), code('CONVERSATION_INVALID_INPUT'));
    assert.deepEqual(f.store.read(f.token), f.state);
  }
});

test('explicit suspension and resumption preserve separate same-action drafts without extending their deadlines', async () => {
  const f = fixture();
  const a = await f.send({ type: 'start_task', intent: bill('2026-06') });
  await assert.rejects(f.send({ type: 'start_task', intent: bill('2026-07') }), code('CONVERSATION_INVALID_TRANSITION'));
  f.advance(10);
  const b = await f.send({ type: 'start_task', intent: bill('2026-07'), suspendCurrent: true });
  assert.notEqual(a.currentTask.taskId, b.currentTask.taskId);
  assert.equal(b.suspendedTasks[0].status, 'suspended');
  assert.deepEqual(b.verifiedSlots, { month: '2026-07' });
  await assert.rejects(f.send({ type: 'resume_task', taskId: a.currentTask.taskId }), code('CONVERSATION_INVALID_TRANSITION'));
  const resumed = await f.send({ type: 'resume_task', taskId: a.currentTask.taskId, suspendCurrent: true });
  assert.deepEqual(resumed.verifiedSlots, { month: '2026-06' });
  assert.equal(resumed.currentTask.continuationExpiresAt, a.currentTask.continuationExpiresAt);
  assert.equal(resumed.suspendedTasks[0].taskId, b.currentTask.taskId);
  const suspended = await f.send({ type: 'suspend_task', taskId: resumed.currentTask.taskId });
  assert.equal(suspended.currentTask, null);
  assert.deepEqual(suspended.verifiedSlots, {});
});

test('task IDs from other conversations and ended tasks cannot be resumed or updated', async () => {
  const f = fixture();
  const a = await f.send({ type: 'start_task', intent: bill() });
  const other = f.store.create();
  await assert.rejects(f.store.transition(other.conversationToken, 0, { type: 'resume_task', taskId: a.currentTask.taskId }), code('CONVERSATION_TASK_NOT_FOUND'));
  const ended = await f.send({ type: 'end_task', taskId: a.currentTask.taskId, outcome: 'completed' });
  assert.equal(ended.currentTask.status, 'completed');
  assert.deepEqual(ended.verifiedSlots, {});
  await assert.rejects(f.send({ type: 'update_task', taskId: a.currentTask.taskId, intent: bill() }), code('CONVERSATION_INVALID_TRANSITION'));
  const b = await f.send({ type: 'start_task', intent: bill(null) });
  await assert.rejects(f.send({ type: 'end_task', taskId: b.currentTask.taskId, outcome: 'completed' }), code('CONVERSATION_INVALID_TRANSITION'));
  const cancelled = await f.send({ type: 'end_task', taskId: b.currentTask.taskId, outcome: 'cancelled' });
  assert.equal(cancelled.currentTask.status, 'cancelled');
});

test('ending a suspended task removes its resumable entry and never overwrites the current draft', async () => {
  const f = fixture();
  const a = await f.send({ type: 'start_task', intent: bill() });
  const b = await f.send({ type: 'start_task', intent: bill('2026-07'), suspendCurrent: true });
  const ended = await f.send({ type: 'end_task', taskId: a.currentTask.taskId, outcome: 'cancelled' });
  assert.equal(ended.suspendedTasks.length, 0);
  assert.equal(ended.currentTask.taskId, b.currentTask.taskId);
});

test('revision comparison prevents stale and concurrent transitions without partial updates', async () => {
  const f = fixture();
  const results = await Promise.allSettled([1, 2].map(() => f.store.transition(f.token, 0, { type: 'start_task', intent: bill() })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(code('CONVERSATION_REVISION_CONFLICT')(results.find(r => r.status === 'rejected').reason));
  const state = f.store.read(f.token);
  for (const revision of [-1, 0.5, NaN, '1']) await assert.rejects(f.store.transition(f.token, revision, { type: 'start_task', intent: bill() }), code('CONVERSATION_INVALID_INPUT'));
  assert.deepEqual(f.store.read(f.token), state);
});

test('task expiry invalidates drafts and revisions; cleanup removes suspended expirations', async () => {
  const f = fixture({ taskTtlMs: 100 });
  const a = await f.send({ type: 'start_task', intent: bill() });
  await f.send({ type: 'start_task', intent: bill(), suspendCurrent: true });
  const revision = f.store.read(f.token).revision;
  f.advance(100);
  assert.deepEqual(f.store.cleanup(), { conversationsRemoved: 0, tasksExpired: 2 });
  const expired = f.store.read(f.token);
  assert.equal(expired.currentTask.status, 'expired');
  assert.equal(expired.suspendedTasks.length, 0);
  assert.equal(expired.revision, revision + 1);
  await assert.rejects(f.store.transition(f.token, revision, { type: 'start_task', intent: bill() }), code('CONVERSATION_REVISION_CONFLICT'));
  await assert.rejects(f.send({ type: 'resume_task', taskId: a.currentTask.taskId }), code('CONVERSATION_TASK_NOT_FOUND'));
  await assert.rejects(f.send({ type: 'update_task', taskId: expired.currentTask.taskId, intent: bill() }), code('CONVERSATION_TASK_EXPIRED'));
  assert.equal(f.store.cleanup().tasksExpired, 0);
  assert.equal((await f.send({ type: 'start_task', intent: bill() })).currentTask.status, 'ready');
});

test('session expiry is absolute, frees capacity, and a new process cannot recover old bearer tokens', async () => {
  const f = fixture({ ttlMs: 100, maxConversations: 1 });
  assert.throws(() => f.store.create(), code('CONVERSATION_CAPACITY'));
  f.advance(50); await f.send({ type: 'start_task', intent: bill() });
  assert.equal(f.store.read(f.token).expiresAt, epoch + 100);
  f.advance(50);
  assert.throws(() => f.store.read(f.token), code('CONVERSATION_EXPIRED'));
  assert.ok(f.store.create().conversationToken);
  assert.throws(() => createConversationStore().read(f.token), code('CONVERSATION_NOT_FOUND'));
  const second = fixture({ ttlMs: 100 }); second.advance(100);
  assert.equal(second.store.cleanup().conversationsRemoved, 1);
});

test('bounded task count and server-controlled continuation lifetime, including a 30 minute form', async () => {
  const f = fixture({ maxTasks: 1 });
  const a = await f.send({ type: 'start_task', intent: bill(), continuationExpiresAt: epoch + 1800000 });
  assert.equal(a.currentTask.continuationExpiresAt, epoch + 1800000);
  await assert.rejects(f.send({ type: 'start_task', intent: bill(), suspendCurrent: true }), code('CONVERSATION_TASK_CAPACITY'));
  assert.deepEqual(f.store.read(f.token), a);
  for (const expires of [epoch, epoch - 1, epoch + 1800001, Infinity]) {
    await assert.rejects(f.send({ type: 'update_task', taskId: a.currentTask.taskId, intent: bill(), continuationExpiresAt: expires }), code('CONVERSATION_INVALID_INPUT'));
  }
  for (const options of [{ maxTasks: 0 }, { ttlMs: -1 }, { taskTtlMs: 1800001 }, { now: null }, { conversationId: 'fake' }]) {
    assert.throws(() => createConversationStore(options), code('CONVERSATION_INVALID_INPUT'));
  }
});

test('only an actual Core-read preview is attached; projection contains references, no effects or authority', async () => {
  const f = await coreFixture();
  const audit = f.core.getAuditEvents();
  const attached = await f.attach();
  assert.equal(attached.currentTask.status, 'awaiting_confirmation');
  assert.equal(attached.pendingPreview.operationId, f.prepared.operationId);
  assert.equal(attached.pendingPreview.previewHash, f.prepared.preview.previewHash);
  assert.deepEqual(attached.pendingPreview.stepIds, f.prepared.preview.stepIds);
  assert.equal(attached.pendingPreview.exactEffects, undefined);
  assert.equal(attached.pendingPreview.confirmed, undefined);
  assert.equal(attached.operationReferences[0].coreState, 'awaiting_confirmation');
  attached.operationReferences[0].stepIds.push('forged');
  assert.equal(f.store.read(f.token).operationReferences[0].stepIds.length, 1);
  assert.deepEqual(f.core.getAuditEvents(), audit);
  const id = attached.currentTask.taskId;
  await assert.rejects(f.send({ type: 'end_task', taskId: id, outcome: 'completed' }), code('CONVERSATION_INVALID_TRANSITION'));
  await assert.rejects(f.send({ type: 'attach_preview', taskId: id, operationId: f.prepared.operationId, previewHash: 'a'.repeat(64) }), code('CONVERSATION_INVALID_INPUT'));
  await assert.rejects(f.attach(), code('CONVERSATION_OPERATION_ALREADY_BOUND'));
});

test('suspend/resume preserve preview ownership; editing clears pending preview but retains original operation queries', async () => {
  const f = await coreFixture();
  const attached = await f.attach(); const id = attached.currentTask.taskId;
  const next = await f.send({ type: 'start_task', intent: bill(), suspendCurrent: true });
  assert.equal(next.pendingPreview, null);
  assert.equal(next.operationReferences.length, 1);
  const resumed = await f.send({ type: 'resume_task', taskId: id, suspendCurrent: true });
  assert.equal(resumed.pendingPreview.operationId, f.prepared.operationId);
  const intent = transfer(); intent.slots.amount.amount_minor = 200;
  const edited = await f.send({ type: 'update_task', taskId: id, intent });
  assert.equal(edited.pendingPreview, null);
  assert.equal(edited.operationReferences[0].coreState, 'awaiting_confirmation');
  const observed = await f.send({ type: 'observe_operation', operationId: f.prepared.operationId });
  assert.equal(observed.pendingPreview, null);
  assert.equal(observed.currentTask.status, 'ready');
});

test('cancelling or expiring a conversation task does not cancel or execute the Core operation', async () => {
  for (const mode of ['cancel', 'expire']) {
    const f = await coreFixture({ taskTtlMs: 100 }); await f.attach();
    if (mode === 'cancel') await f.send({ type: 'end_task', taskId: f.store.read(f.token).currentTask.taskId, outcome: 'cancelled' });
    else f.advance(100);
    const state = f.store.read(f.token);
    assert.equal(state.pendingPreview, null);
    assert.equal(state.operationReferences[0].coreState, 'awaiting_confirmation');
    assert.equal((await f.core.getOperation(f.prepared.operationId)).data.state, 'awaiting_confirmation');
    assert.equal((await f.send({ type: 'observe_operation', operationId: f.prepared.operationId })).currentTask.status, mode === 'cancel' ? 'cancelled' : 'expired');
  }
});

test('operation reference cannot move to another task or conversation, including after a draft edit', async () => {
  const f = await coreFixture(); await f.attach();
  const b = await f.send({ type: 'start_task', intent: transfer(), suspendCurrent: true });
  await assert.rejects(f.send({ type: 'attach_preview', taskId: b.currentTask.taskId, operationId: f.prepared.operationId }), code('CONVERSATION_OPERATION_ALREADY_BOUND'));
  const other = f.store.create();
  const s = await f.store.transition(other.conversationToken, 0, { type: 'start_task', intent: transfer() });
  await assert.rejects(f.store.transition(other.conversationToken, s.revision, { type: 'attach_preview', taskId: s.currentTask.taskId, operationId: f.prepared.operationId }), code('CONVERSATION_OPERATION_ALREADY_BOUND'));
  await assert.rejects(f.store.transition(other.conversationToken, s.revision, { type: 'observe_operation', operationId: f.prepared.operationId }), code('CONVERSATION_OPERATION_NOT_FOUND'));
});

test('missing Core reader/operation, wrong action and malformed Core results fail closed', async () => {
  const bare = fixture(); const started = await bare.send({ type: 'start_task', intent: transfer() });
  await assert.rejects(bare.send({ type: 'attach_preview', taskId: started.currentTask.taskId, operationId: 'op_missing' }), code('CONVERSATION_CORE_UNAVAILABLE'));
  const f = await coreFixture();
  await assert.rejects(f.send({ type: 'attach_preview', taskId: f.store.read(f.token).currentTask.taskId, operationId: 'op_missing' }), code('CONVERSATION_INVALID_CORE_REFERENCE'));
  const status = (await f.core.getOperation(f.prepared.operationId)).data;
  const badResults = [
    { ...status, operationId: 'op_other' }, { ...status, state: 'made_up' }, { ...status, status: 'succeeded' },
    { ...status, preview: { ...status.preview, exactEffects: [] } },
    { ...status, preview: { ...status.preview, previewHash: 'fake' } },
    { ...status, preview: { ...status.preview, stepIds: [] } },
    { ...status, preview: { ...status.preview, expiresAt: new Date(epoch).toISOString() } },
  ];
  for (const bad of badResults) {
    const b = fixture({ readCoreOperation: async () => ({ ok: true, data: bad }) });
    const start = await b.send({ type: 'start_task', intent: transfer() });
    await assert.rejects(b.send({ type: 'attach_preview', taskId: start.currentTask.taskId, operationId: status.operationId }), code('CONVERSATION_INVALID_CORE_REFERENCE'));
    assert.deepEqual(b.store.read(b.token), start);
  }
  const wrong = fixture({ readCoreOperation: id => f.core.getOperation(id) });
  const start = await wrong.send({ type: 'start_task', intent: bill() });
  await assert.rejects(wrong.send({ type: 'attach_preview', taskId: start.currentTask.taskId, operationId: status.operationId }), code('CONVERSATION_INVALID_CORE_REFERENCE'));
});

test('Core await has atomic revision and ownership checks; mutating a submitted command cannot change its target', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await coreFixture({ readCoreOperation: async id => { await gate; return f.core.getOperation(id); } });
  const audit = f.core.getAuditEvents();
  const state = f.store.read(f.token);
  const command = { type: 'attach_preview', taskId: state.currentTask.taskId, operationId: f.prepared.operationId };
  const pending = f.store.transition(f.token, state.revision, command);
  command.operationId = 'op_forged';
  await f.send({ type: 'suspend_task', taskId: state.currentTask.taskId });
  release();
  await assert.rejects(pending, code('CONVERSATION_REVISION_CONFLICT'));
  assert.equal(f.store.read(f.token).operationReferences.length, 0);
  assert.deepEqual(f.core.getAuditEvents(), audit);
  const resumed = await f.send({ type: 'resume_task', taskId: state.currentTask.taskId });
  const results = await Promise.allSettled([1, 2].map(() => f.store.transition(f.token, resumed.revision, { ...command, operationId: f.prepared.operationId })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.store.read(f.token).operationReferences.length, 1);
});

test('expiration while Core read is pending never publishes a preview', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await coreFixture({ taskTtlMs: 100, readCoreOperation: async id => { await gate; return f.core.getOperation(id); } });
  const pending = f.attach(); f.advance(100); release();
  await assert.rejects(pending, code('CONVERSATION_REVISION_CONFLICT'));
  assert.equal(f.store.read(f.token).pendingPreview, null);
  assert.equal(f.store.read(f.token).operationReferences.length, 0);
});

test('Core observation records actual execution without exposing a write capability or reviving an ended task', async () => {
  const f = await coreFixture(); await f.attach();
  await f.core.decide(f.prepared.operationId, { decision: 'confirm', previewHash: f.prepared.preview.previewHash, confirmedStepIds: f.prepared.preview.stepIds });
  const confirmed = await f.send({ type: 'observe_operation', operationId: f.prepared.operationId });
  assert.equal(confirmed.pendingPreview.coreState, 'confirmed');
  await f.core.execute(f.prepared.operationId, f.prepared.preview.previewHash);
  const completed = await f.send({ type: 'observe_operation', operationId: f.prepared.operationId });
  assert.equal(completed.currentTask.status, 'completed');
  assert.equal(completed.operationReferences[0].coreState, 'succeeded');
  assert.equal(completed.pendingPreview, null);
  assert.deepEqual(completed.verifiedSlots, {});
  assert.deepEqual(Object.keys(f.store).sort(), ['cleanup', 'create', 'read', 'transition']);
});

test('preview expiry clears only the projection and is counted once; operation capacity preserves query references', async () => {
  const f = await coreFixture({ maxOperations: 1 });
  const attached = await f.attach();
  f.advance(attached.pendingPreview.expiresAt - epoch);
  const expired = f.store.read(f.token);
  assert.equal(expired.pendingPreview, null);
  assert.equal(expired.operationReferences.length, 1);
  assert.equal(expired.operationReferences[0].coreState, 'awaiting_confirmation');
  assert.equal(f.store.read(f.token).revision, expired.revision);
  const next = await f.send({ type: 'start_task', intent: transfer() });
  await assert.rejects(f.send({ type: 'attach_preview', taskId: next.currentTask.taskId, operationId: 'op_other' }), code('CONVERSATION_OPERATION_CAPACITY'));
});

test('caller mutation during Core await cannot replace the operation or task in a successful commit', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await coreFixture({ readCoreOperation: async id => { await gate; return f.core.getOperation(id); } });
  const state = f.store.read(f.token);
  const command = { type: 'attach_preview', taskId: state.currentTask.taskId, operationId: f.prepared.operationId };
  const pending = f.store.transition(f.token, state.revision, command);
  command.taskId = 'task_forged'; command.operationId = 'op_forged'; release();
  const attached = await pending;
  assert.equal(attached.pendingPreview.operationId, f.prepared.operationId);
  assert.equal(attached.pendingPreview.taskId, state.currentTask.taskId);
});

test('conversation expiration during Core await and Core reader failure leave no published reference', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await coreFixture({ ttlMs: 100, readCoreOperation: async id => { await gate; return f.core.getOperation(id); } });
  const pending = f.attach(); f.advance(100); release();
  await assert.rejects(pending, code('CONVERSATION_EXPIRED'));
  assert.throws(() => f.store.read(f.token), code('CONVERSATION_NOT_FOUND'));
  const failed = await coreFixture({ readCoreOperation: async () => { throw new Error('private upstream content'); } });
  const before = failed.store.read(failed.token);
  await assert.rejects(failed.attach(), code('CONVERSATION_CORE_UNAVAILABLE'));
  assert.deepEqual(failed.store.read(failed.token), before);
});

test('observing an operation completed while suspended ends only its owning task', async () => {
  const f = await coreFixture(); const original = await f.attach();
  const current = await f.send({ type: 'start_task', intent: bill(), suspendCurrent: true });
  await f.core.decide(f.prepared.operationId, { decision: 'reject', previewHash: f.prepared.preview.previewHash, confirmedStepIds: [] });
  const observed = await f.send({ type: 'observe_operation', operationId: f.prepared.operationId });
  assert.equal(observed.currentTask.taskId, current.currentTask.taskId);
  assert.equal(observed.suspendedTasks.length, 0);
  assert.equal(observed.operationReferences[0].coreState, 'cancelled');
  await assert.rejects(f.send({ type: 'resume_task', taskId: original.currentTask.taskId }), code('CONVERSATION_TASK_NOT_FOUND'));
});

test('session cleanup releases operation bindings as well as conversation capacity', async () => {
  const f = await coreFixture({ ttlMs: 100, maxConversations: 1 }); await f.attach();
  f.advance(100);
  assert.equal(f.store.cleanup().conversationsRemoved, 1);
  const next = f.store.create();
  const started = await f.store.transition(next.conversationToken, 0, { type: 'start_task', intent: transfer() });
  const attached = await f.store.transition(next.conversationToken, started.revision, {
    type: 'attach_preview', taskId: started.currentTask.taskId, operationId: f.prepared.operationId,
  });
  assert.equal(attached.operationReferences.length, 1);
});

test('continuation bookkeeping belongs to one active task and is invalidated by a parameter update', async () => {
  const f = fixture();
  const started = await f.send({ type: 'start_task', intent: bill(null) });
  const taskId = started.currentTask.taskId;
  const tokenId = 'ct_00000000-0000-4000-8000-000000000001';
  const bound = await f.send({ type: 'set_continuation', taskId, tokenId, expiresAt: epoch + 300000, pendingSlot: 'month', awaitingInput: true });
  assert.equal(bound.currentTask.latestContinuationId, tokenId);
  assert.deepEqual(bound.currentTask.pendingSlots, ['month']);
  await assert.rejects(f.send({ type: 'set_continuation', taskId, tokenId: 'forged', expiresAt: epoch + 300000, awaitingInput: true }), code('CONVERSATION_INVALID_INPUT'));
  const updated = await f.send({ type: 'update_task', taskId, intent: bill() });
  assert.equal(updated.currentTask.latestContinuationId, null);
  const other = await f.send({ type: 'start_task', intent: bill(), suspendCurrent: true });
  await assert.rejects(f.send({ type: 'set_continuation', taskId, tokenId, expiresAt: epoch + 300000, awaitingInput: true }), code('CONVERSATION_TASK_NOT_FOUND'));
  assert.deepEqual(f.store.read(f.token), other);
});

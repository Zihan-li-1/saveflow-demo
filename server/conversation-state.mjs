// @ts-check
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { validateParsedIntent } from '../src/agent/validate-parsed-intent.mjs';

/** @typedef {import('./conversation-state-types').ConversationState} State */
/** @typedef {import('./conversation-state-types').ConversationTask} Task */
/** @typedef {import('./conversation-state-types').ConversationCommand} Command */
/** @typedef {import('./conversation-state-types').OperationReference} OperationReference */

export class ConversationStateError extends Error {
  /** @param {string} code */
  constructor(code) {
    // Never put tokens, slot values or financial details in errors.
    super(code);
    this.name = 'ConversationStateError';
    this.code = code;
  }
}
/** @param {string} code @returns {never} */
function fail(code) { throw new ConversationStateError(code); }
/** @param {unknown} value @param {string[]} allowed */
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some(key => !allowed.includes(key))) fail('CONVERSATION_INVALID_INPUT');
}
/** @param {unknown} n @returns {asserts n is number} */
function positive(n) { if (!Number.isSafeInteger(n) || Number(n) <= 0) fail('CONVERSATION_INVALID_INPUT'); }
/** @param {unknown} value @param {number} [depth] */
function jsonData(value, depth = 0) {
  if (depth > 16) fail('CONVERSATION_INVALID_INPUT');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object') fail('CONVERSATION_INVALID_INPUT');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('CONVERSATION_INVALID_INPUT');
  for (const key of Object.keys(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('CONVERSATION_INVALID_INPUT');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) fail('CONVERSATION_INVALID_INPUT');
    jsonData(descriptor.value, depth + 1);
  }
}
/** @param {Task | null} task */
function live(task) { return !!task && ['ready', 'awaiting_input', 'awaiting_confirmation'].includes(task.status); }
/** @param {State} state @param {number} at */
function project(state, at) {
  const task = state.currentTask;
  state.verifiedSlots = live(task) ? structuredClone(task?.verifiedSlots ?? {}) : {};
  const ref = task && live(task) && state.operationReferences.find(ref => ref.operationId === task.previewOperationId);
  state.pendingPreview = ref && ref.expiresAt > at && !['succeeded', 'failed', 'cancelled'].includes(ref.coreState)
    ? { operationId: ref.operationId, taskId: ref.taskId, previewHash: ref.previewHash,
      stepIds: [...ref.stepIds], expiresAt: ref.expiresAt, coreState: ref.coreState } : null;
}
const summaryKeyLimit = 32;
const summaryValueLimit = 512;
const internalReferenceKey = /(?:^|_)(?:id|taskid|operationid|entityid|optionid|token|secret)$/i;
/** @param {unknown} value @param {number} [depth] @returns {unknown} */
function summaryValue(value, depth = 0) {
  if (depth > 4) return '[å·²çœç•¥]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > summaryValueLimit ? `${value.slice(0, summaryValueLimit)}â€¦` : value;
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return '[å·²çœç•¥]';
  if (Array.isArray(value)) return value.slice(0, summaryKeyLimit).map(item => summaryValue(item, depth + 1));
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const [key, child] of Object.entries(value).slice(0, summaryKeyLimit)) {
    if (internalReferenceKey.test(key) || /id$/i.test(key) || key.endsWith('_ref')) result[key] = '[å·²æ ¸éªŒå¼•ç”¨]';
    else result[key] = summaryValue(child, depth + 1);
  }
  return result;
}
/** @param {Task} task @param {State} state */
function summaryTask(task, state) {
  const refs = state.operationReferences.filter(ref => ref.taskId === task.taskId);
  const latest = refs.at(-1);
  return {
    action: task.action,
    status: task.status,
    pendingSlots: task.pendingSlots.slice(0, summaryKeyLimit),
    verifiedSlots: /** @type {Record<string, unknown>} */ (summaryValue(task.verifiedSlots) ?? {}),
    operationState: latest?.coreState ?? null,
    hasOperation: refs.length > 0,
  };
}
/** @param {State} state */
function summarize(state) {
  const tasks = [...(state.suspendedTasks ?? [])];
  const currentTask = state.currentTask ? summaryTask(state.currentTask, state) : null;
  const previousTasks = tasks.slice(-5).reverse().map(task => summaryTask(task, state));
  const recentOperations = state.operationReferences.slice(-10).reverse().map(ref => ({
    action: ref.action,
    state: ref.coreState,
    outcome: /** @type {'pending' | 'succeeded' | 'failed' | 'cancelled'} */ (
      ref.coreState === 'succeeded' || ref.coreState === 'failed' || ref.coreState === 'cancelled' ? ref.coreState : 'pending'),
    hasReceipt: ['succeeded', 'failed', 'cancelled'].includes(ref.coreState),
  }));
  return { currentTask, previousTasks, recentOperations };
}
/** @param {State} state @param {number} at */
function expireTasks(state, at) {
  let expired = 0;
  if (live(state.currentTask) && state.currentTask && state.currentTask.continuationExpiresAt <= at) {
    state.currentTask.status = 'expired';
    state.currentTask.resumeStatus = null;
    state.currentTask.revision++;
    state.currentTask.updatedAt = at;
    expired++;
  }
  state.suspendedTasks = state.suspendedTasks.filter(task => {
    if (task.continuationExpiresAt > at) return true;
    expired++;
    return false;
  });
  // Preview expiry changes the projection but never changes observed Core state.
  const previewExpired = !!state.pendingPreview && state.pendingPreview.expiresAt <= at;
  project(state, at);
  if (expired || previewExpired) { state.revision++; state.updatedAt = at; }
  return expired;
}

/**
 * Local, server-only store. Token possession selects a conversation, not a bank identity
 * or permission to execute. HTTP adapters must still authenticate requests.
 * Slots must come from the server's existing validation/resolution boundary; schema
 * checks here do not replace entity resolution or Core validation.
 *
 * @param {import('./conversation-state-types').ConversationStoreOptions} [options]
 * @returns {import('./conversation-state-types').ConversationStore}
 */
export function createConversationStore(options = {}) {
  fields(options, ['now', 'ttlMs', 'taskTtlMs', 'maxTaskTtlMs', 'maxConversations', 'maxTasks', 'maxOperations', 'readCoreOperation']);
  const { now = Date.now, ttlMs = 30 * 60_000, taskTtlMs = 5 * 60_000, maxTaskTtlMs = 30 * 60_000,
    maxConversations = 500, maxTasks = 25, maxOperations = 100, readCoreOperation } = options;
  for (const n of [ttlMs, taskTtlMs, maxTaskTtlMs, maxConversations, maxTasks, maxOperations]) positive(n);
  if (taskTtlMs > maxTaskTtlMs || typeof now !== 'function' ||
      (readCoreOperation !== undefined && typeof readCoreOperation !== 'function')) fail('CONVERSATION_INVALID_INPUT');
  /** Only token digests are retained. No lookup or write API accepts internal IDs. @type {Map<string, State>} */
  const records = new Map();
  /** Prevent the same Core operation being assigned to another task/conversation. @type {Map<string, string>} */
  const bindings = new Map();
  const time = () => { const at = now(); if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(at + ttlMs)) fail('CONVERSATION_INVALID_CLOCK'); return at; };
  /** @param {string} token */
  const keyFor = token => {
    if (typeof token !== 'string' || !/^cs1\.[A-Za-z0-9_-]{43}$/.test(token)) fail('CONVERSATION_NOT_FOUND');
    return createHash('sha256').update(token).digest('hex');
  };
  /** @param {string} key */
  const remove = key => {
    for (const ref of records.get(key)?.operationReferences ?? []) bindings.delete(ref.operationId);
    records.delete(key);
  };
  /** @param {string} token */
  const lookup = token => {
    const key = keyFor(token);
    const state = records.get(key);
    const at = time();
    if (!state) fail('CONVERSATION_NOT_FOUND');
    if (state.expiresAt <= at) { remove(key); fail('CONVERSATION_EXPIRED'); }
    expireTasks(state, at);
    return { key, state, at };
  };
  /** @param {unknown} intent */
  const draft = intent => {
    let copy;
    try {
      // Bounded JSON data only; no functions, exotic objects or permission fields.
      jsonData(intent);
      const json = JSON.stringify(intent);
      if (!json || json.length > 16384) fail('CONVERSATION_INVALID_INPUT');
      copy = structuredClone(intent);
      if (JSON.stringify(copy) !== json) fail('CONVERSATION_INVALID_INPUT');
      copy = validateParsedIntent(copy);
      if (copy.choice || copy.action === 'unsupported') fail('CONVERSATION_INVALID_INPUT');
    } catch { fail('CONVERSATION_INVALID_INPUT'); }
    return { action: /** @type {string} */ (copy.action), slots: /** @type {Record<string, unknown>} */ (copy.slots),
      pending: /** @type {string[]} */ (copy.missingSlots) };
  };
  /** @param {State} state @param {number | undefined} requested @param {number} at */
  const deadline = (state, requested, at) => {
    const expires = requested ?? Math.min(at + taskTtlMs, state.expiresAt);
    if (!Number.isSafeInteger(expires) || expires <= at || expires > state.expiresAt || expires > at + maxTaskTtlMs) fail('CONVERSATION_INVALID_INPUT');
    return expires;
  };
  /** @param {State} state @param {string} id */
  const current = (state, id) => {
    const task = state.currentTask;
    if (!task || task.taskId !== id) fail('CONVERSATION_TASK_NOT_FOUND');
    if (task.status === 'expired') fail('CONVERSATION_TASK_EXPIRED');
    if (!live(task)) fail('CONVERSATION_INVALID_TRANSITION');
    return task;
  };
  /** @param {Task} task @param {number} at */
  const touch = (task, at) => { task.revision++; task.updatedAt = at; };
  /** @param {State} state @param {boolean | undefined} allowed @param {number} at */
  const suspendCurrent = (state, allowed, at) => {
    if (!live(state.currentTask)) return;
    if (allowed !== true || !state.currentTask) fail('CONVERSATION_INVALID_TRANSITION');
    const task = state.currentTask;
    task.resumeStatus = /** @type {'ready' | 'awaiting_input' | 'awaiting_confirmation'} */ (task.status);
    task.status = 'suspended'; touch(task, at);
    state.suspendedTasks.push(task); state.currentTask = null;
  };
  /** @param {string} id */
  const coreSnapshot = async id => {
    if (typeof id !== 'string' || !/^op_[A-Za-z0-9-]{1,128}$/.test(id)) fail('CONVERSATION_INVALID_INPUT');
    if (!readCoreOperation) fail('CONVERSATION_CORE_UNAVAILABLE');
    let result;
    try { result = await readCoreOperation(id); }
    catch { fail('CONVERSATION_CORE_UNAVAILABLE'); }
    if (!result?.ok || result.data?.operationId !== id ||
        !['preparing', 'risk_check', 'awaiting_confirmation', 'confirmed', 'executing', 'succeeded', 'failed', 'cancelled', 'unknown', 'checking'].includes(result.data.state)) fail('CONVERSATION_INVALID_CORE_REFERENCE');
    const data = result.data;
    const terminal = ['succeeded', 'failed', 'cancelled'].includes(data.state);
    if (data.status !== (terminal ? data.state : 'pending') ||
        (data.receipt && (data.receipt.operationId !== id || data.receipt.status !== data.state))) fail('CONVERSATION_INVALID_CORE_REFERENCE');
    return structuredClone(data);
  };
  /** @param {import('../src/banking-core/contracts').OperationStatus} status @param {Task} task @param {number} at @returns {OperationReference} */
  const previewReference = (status, task, at) => {
    const preview = status.preview;
    const effect = preview?.exactEffects?.[0];
    const action = effect && ['transfer_out', 'transfer_internal'].includes(effect.kind) ? 'transfer.create' :
      effect && ['card_change', 'wealth_change', 'scenario_rule_change'].includes(effect.kind) && 'action' in effect ? effect.action : null;
    const expires = Date.parse(preview?.expiresAt ?? '');
    if (status.state !== 'awaiting_confirmation' || !preview || !Array.isArray(preview.exactEffects) || preview.exactEffects.length !== 1 || action !== task.action ||
        !/^[a-f0-9]{64}$/.test(preview.previewHash) || !Array.isArray(preview.stepIds) || preview.stepIds.length !== 1 ||
        preview.stepIds.some(id => typeof id !== 'string' || !id || id.length > 200) || !Number.isSafeInteger(expires) || expires <= at) fail('CONVERSATION_INVALID_CORE_REFERENCE');
    return { operationId: status.operationId, taskId: task.taskId, action: task.action, previewHash: preview.previewHash,
      stepIds: [...preview.stepIds], expiresAt: expires, coreState: status.state, observedAt: at };
  };

  const store = {
    create() {
      if (arguments.length) fail('CONVERSATION_INVALID_INPUT');
      store.cleanup();
      if (records.size >= maxConversations) fail('CONVERSATION_CAPACITY');
      const at = time();
      const conversationToken = `cs1.${randomBytes(32).toString('base64url')}`;
      /** @type {State} */
      const state = { conversationId: `conv_${randomUUID()}`, currentTask: null, suspendedTasks: [], verifiedSlots: {}, pendingPreview: null,
        operationReferences: [], revision: 0, createdAt: at, updatedAt: at, expiresAt: at + ttlMs };
      records.set(keyFor(conversationToken), state);
      return { conversationToken, state: structuredClone(state) };
    },
    /** @param {string} token */
    read(token) { return structuredClone(lookup(token).state); },
    /** @param {string} token */
    taskSummary(token) { return structuredClone(summarize(lookup(token).state)); },
    /** @param {string} token @param {number} expectedRevision @param {Command} command */
    async transition(token, expectedRevision, command) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('CONVERSATION_INVALID_INPUT');
      const { key, state: original, at } = lookup(token);
      if (original.revision !== expectedRevision) fail('CONVERSATION_REVISION_CONFLICT');
      const state = structuredClone(original);
      fields(command, ['type', 'taskId', 'intent', 'continuationExpiresAt', 'suspendCurrent', 'outcome', 'operationId', 'tokenId', 'expiresAt', 'pendingSlot', 'awaitingInput']);
      const allowed = {
        start_task: ['type', 'intent', 'continuationExpiresAt', 'suspendCurrent'], update_task: ['type', 'taskId', 'intent', 'continuationExpiresAt'],
        suspend_task: ['type', 'taskId'], resume_task: ['type', 'taskId', 'suspendCurrent'], end_task: ['type', 'taskId', 'outcome'],
        attach_preview: ['type', 'taskId', 'operationId'], observe_operation: ['type', 'operationId'],
        set_continuation: ['type', 'taskId', 'tokenId', 'expiresAt', 'pendingSlot', 'awaitingInput'],
      };
      if (!Object.hasOwn(allowed, command.type)) fail('CONVERSATION_INVALID_INPUT');
      fields(command, allowed[command.type]);
      // Caller-owned objects must not change task/operation identity across a Core await.
      try { command = structuredClone(command); } catch { fail('CONVERSATION_INVALID_INPUT'); }
      if ('suspendCurrent' in command && typeof command.suspendCurrent !== 'boolean') fail('CONVERSATION_INVALID_INPUT');
      switch (command.type) {
        case 'start_task': {
          const value = draft(command.intent);
          suspendCurrent(state, command.suspendCurrent, at);
          if (state.suspendedTasks.length + 1 > maxTasks) fail('CONVERSATION_TASK_CAPACITY');
          state.currentTask = { taskId: `task_${randomUUID()}`, action: value.action, status: value.pending.length ? 'awaiting_input' : 'ready',
            resumeStatus: null, verifiedSlots: value.slots, pendingSlots: value.pending, continuationExpiresAt: deadline(state, command.continuationExpiresAt, at), latestContinuationId: null,
            previewOperationId: null, operationReferences: [], revision: 1, createdAt: at, updatedAt: at };
          break;
        }
        case 'update_task': {
          const task = current(state, command.taskId);
          const value = draft(command.intent);
          if (value.action !== task.action) fail('CONVERSATION_ACTION_MISMATCH');
          task.verifiedSlots = value.slots; task.pendingSlots = value.pending;
          task.status = value.pending.length ? 'awaiting_input' : 'ready'; task.previewOperationId = null;
          task.latestContinuationId = null;
          if (command.continuationExpiresAt !== undefined) task.continuationExpiresAt = deadline(state, command.continuationExpiresAt, at);
          touch(task, at); break;
        }
        case 'suspend_task':
          current(state, command.taskId); suspendCurrent(state, true, at); break;
        case 'set_continuation': {
          const task = current(state, command.taskId);
          if (typeof command.tokenId !== 'string' || !/^ct_[a-f0-9-]{36}$/.test(command.tokenId) || typeof command.awaitingInput !== 'boolean' ||
              (command.pendingSlot !== undefined && (typeof command.pendingSlot !== 'string' || !/^[a-z_]{1,64}$/.test(command.pendingSlot)))) fail('CONVERSATION_INVALID_INPUT');
          task.continuationExpiresAt = deadline(state, command.expiresAt, at);
          task.latestContinuationId = command.tokenId;
          if (command.awaitingInput) {
            task.status = 'awaiting_input'; task.previewOperationId = null;
            if (command.pendingSlot && !task.pendingSlots.includes(command.pendingSlot)) task.pendingSlots.push(command.pendingSlot);
          }
          touch(task, at); break;
        }
        case 'resume_task': {
          const index = state.suspendedTasks.findIndex(task => task.taskId === command.taskId);
          if (index < 0) fail('CONVERSATION_TASK_NOT_FOUND');
          const task = state.suspendedTasks.splice(index, 1)[0];
          suspendCurrent(state, command.suspendCurrent, at);
          task.status = task.resumeStatus ?? 'ready'; task.resumeStatus = null; touch(task, at);
          state.currentTask = task; break;
        }
        case 'end_task': {
          if (!['completed', 'cancelled'].includes(command.outcome)) fail('CONVERSATION_INVALID_INPUT');
          if (command.outcome === 'completed' && state.operationReferences.some(ref => ref.taskId === command.taskId &&
              !['succeeded', 'failed', 'cancelled'].includes(ref.coreState))) fail('CONVERSATION_INVALID_TRANSITION');
          if (state.currentTask?.taskId === command.taskId) {
            const task = current(state, command.taskId);
            if (command.outcome === 'completed' && task.pendingSlots.length) fail('CONVERSATION_INVALID_TRANSITION');
            task.status = command.outcome; task.previewOperationId = null; task.resumeStatus = null; touch(task, at);
          } else {
            const index = state.suspendedTasks.findIndex(task => task.taskId === command.taskId);
            if (index < 0) fail('CONVERSATION_TASK_NOT_FOUND');
            if (command.outcome === 'completed' && state.suspendedTasks[index].pendingSlots.length) fail('CONVERSATION_INVALID_TRANSITION');
            state.suspendedTasks.splice(index, 1);
          }
          break;
        }
        case 'attach_preview': {
          const task = current(state, command.taskId);
          if (task.pendingSlots.length) fail('CONVERSATION_INVALID_TRANSITION');
          if (state.operationReferences.length >= maxOperations) fail('CONVERSATION_OPERATION_CAPACITY');
          if (bindings.has(command.operationId)) fail('CONVERSATION_OPERATION_ALREADY_BOUND');
          const reference = previewReference(await coreSnapshot(command.operationId), task, time());
          state.operationReferences.push(reference); task.operationReferences.push(reference.operationId);
          task.previewOperationId = reference.operationId; task.status = 'awaiting_confirmation'; touch(task, at); break;
        }
        case 'observe_operation': {
          const reference = state.operationReferences.find(ref => ref.operationId === command.operationId);
          if (!reference) fail('CONVERSATION_OPERATION_NOT_FOUND');
          const status = await coreSnapshot(command.operationId);
          if (status.preview && status.preview.previewHash !== reference.previewHash) fail('CONVERSATION_INVALID_CORE_REFERENCE');
          if (status.receipt && status.receipt.action !== (reference.action === 'transfer.create' ? 'transfer_money' : reference.action)) fail('CONVERSATION_INVALID_CORE_REFERENCE');
          reference.coreState = status.state; reference.observedAt = time();
          // Core observations never reactivate an ended task or an old draft preview.
          const task = state.currentTask?.taskId === reference.taskId ? state.currentTask :
            state.suspendedTasks.find(task => task.taskId === reference.taskId);
          if (task && (live(task) || task.status === 'suspended') && (task.previewOperationId === reference.operationId || status.state === 'succeeded') && ['succeeded', 'failed', 'cancelled'].includes(status.state)) {
            task.status = status.state === 'succeeded' ? 'completed' : /** @type {'failed' | 'cancelled'} */ (status.state);
            task.previewOperationId = null; task.resumeStatus = null; touch(task, at);
            state.suspendedTasks = state.suspendedTasks.filter(item => item.taskId !== task.taskId);
          }
          break;
        }
      }
      // No await between compare and publish. Concurrent Core reads cannot both commit.
      const latest = lookup(token);
      if (latest.state.revision !== expectedRevision) fail('CONVERSATION_REVISION_CONFLICT');
      if (command.type === 'attach_preview') {
        if (bindings.has(command.operationId)) fail('CONVERSATION_OPERATION_ALREADY_BOUND');
        if (state.currentTask && state.currentTask.continuationExpiresAt <= latest.at) fail('CONVERSATION_TASK_EXPIRED');
        const reference = state.operationReferences.at(-1);
        if (!reference || reference.expiresAt <= latest.at) fail('CONVERSATION_INVALID_CORE_REFERENCE');
        bindings.set(command.operationId, key);
      }
      state.revision++;
      state.updatedAt = latest.at;
      if (state.currentTask && state.currentTask.updatedAt === at) state.currentTask.updatedAt = latest.at;
      project(state, latest.at);
      records.set(key, state);
      return structuredClone(state);
    },
    cleanup() {
      const at = time();
      let conversationsRemoved = 0, tasksExpired = 0;
      for (const [key, state] of records) {
        if (state.expiresAt <= at) { remove(key); conversationsRemoved++; }
        else tasksExpired += expireTasks(state, at);
      }
      return { conversationsRemoved, tasksExpired };
    },
  };
  // Keep the read-only diagnostic entry point out of the legacy enumerable
  // store surface used by adapters that feature-detect mutation methods.
  Object.defineProperty(store, 'taskSummary', { value: store.taskSummary, enumerable: false });
  return Object.freeze(store);
}


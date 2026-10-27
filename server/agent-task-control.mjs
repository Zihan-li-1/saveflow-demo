const LIVE = new Set(['ready', 'awaiting_input', 'awaiting_confirmation']);
const LOCKED = new Set(['preparing', 'risk_check', 'confirmed', 'executing', 'unknown', 'checking']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const COMMANDS = new Set(['cancel', 'undo', 'modify', 'resume']);
const TARGETS = new Set(['current', 'previous']);

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function safeValue(value, depth = 0) {
  if (depth > 3) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 160);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.slice(0, 8).map(item => safeValue(item, depth + 1)).filter(item => item !== undefined);
  if (!plain(value)) return undefined;
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 12)) {
    if (/(?:^|_)(?:id|task_id|operation_id|entity_id)$/i.test(key) || /Id$/.test(key)) continue;
    const sanitized = safeValue(item, depth + 1);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function summarizeTask(task, state) {
  if (!task) return null;
  const references = state.operationReferences.filter(ref => ref.taskId === task.taskId).slice(-3);
  const verifiedContext = safeValue(task.verifiedSlots);
  return {
    action: task.action,
    status: task.status,
    pendingSlots: task.pendingSlots.slice(0, 12),
    ...(verifiedContext && Object.keys(verifiedContext).length ? { verifiedContext } : {}),
    ...(references.length ? { operationStates: references.map(ref => ref.coreState) } : {}),
  };
}

/** A bounded, read-only projection for language understanding. It contains no internal identifiers or authority. */
export function buildTrustedTaskContext(state, { maxPreviousTasks = 3, maxRecentResults = 3 } = {}) {
  if (!plain(state) || !Number.isInteger(maxPreviousTasks) || maxPreviousTasks < 0 || maxPreviousTasks > 5 ||
      !Number.isInteger(maxRecentResults) || maxRecentResults < 0 || maxRecentResults > 5) throw new Error('TASK_CONTEXT_INVALID');
  const previousTasks = state.suspendedTasks.slice(-maxPreviousTasks).reverse().map(task => summarizeTask(task, state));
  const recentResults = state.operationReferences.filter(ref => TERMINAL.has(ref.coreState)).slice(-maxRecentResults).reverse()
    .map(ref => ({ action: ref.action, status: ref.coreState }));
  return Object.freeze({
    currentTask: summarizeTask(state.currentTask, state),
    previousTasks,
    recentResults,
  });
}

export function validateTaskControlProposal(value) {
  if (!plain(value) || Object.keys(value).some(key => !['kind', 'control'].includes(key)) || value.kind !== 'task_control' || !plain(value.control) ||
      Object.keys(value.control).some(key => !['command', 'target'].includes(key)) || !COMMANDS.has(value.control.command) || !TARGETS.has(value.control.target)) {
    throw new Error('TASK_CONTROL_INVALID');
  }
  return { kind: 'task_control', control: { command: value.control.command, target: value.control.target } };
}

function candidates(state, command, target) {
  if (command === 'resume') return target === 'previous' ? state.suspendedTasks.filter(task => task.status === 'suspended') : [];
  if (target === 'current') return state.currentTask && LIVE.has(state.currentTask.status) ? [state.currentTask] : [];
  return [state.currentTask, ...state.suspendedTasks]
    .filter(task => task && (LIVE.has(task.status) || task.status === 'suspended'));
}

/**
 * Consume a V2-shaped task-control proposal using only server-owned state.
 * The adapter owns revision-checked transitions and legal Core preview rejection.
 */
export async function handleAgentTaskControl(value, adapter) {
  const proposal = validateTaskControlProposal(value);
  let state = adapter.readState();
  let choices = candidates(state, proposal.control.command, proposal.control.target);
  if (!choices.length) return { status: 'no_task', command: proposal.control.command };
  if (choices.length !== 1) return { status: 'needs_clarification', command: proposal.control.command,
    choices: choices.slice(0, 3).map(task => ({ action: task.action, status: task.status })) };
  let task = choices[0];

  if (proposal.control.command === 'resume') {
    if (!adapter.hasValidContinuation(task)) return { status: 'needs_continuation', command: 'resume', action: task.action };
    state = await adapter.transition({ type: 'resume_task', taskId: task.taskId, suspendCurrent: true });
    return { status: 'resumed', command: 'resume', action: state.currentTask.action };
  }
  if (proposal.control.command === 'modify') {
    if (!adapter.hasValidContinuation(task)) return { status: 'needs_continuation', command: 'modify', action: task.action };
    return { status: 'ready_for_modification', command: 'modify', action: task.action };
  }

  for (const reference of state.operationReferences.filter(ref => ref.taskId === task.taskId && !TERMINAL.has(ref.coreState))) {
    state = await adapter.transition({ type: 'observe_operation', operationId: reference.operationId });
  }
  task = state.currentTask?.taskId === task.taskId ? state.currentTask : state.suspendedTasks.find(item => item.taskId === task.taskId);
  const references = state.operationReferences.filter(ref => ref.taskId === choices[0].taskId);
  const locked = references.find(ref => LOCKED.has(ref.coreState));
  if (locked) return { status: 'query_required', command: proposal.control.command, action: choices[0].action,
    operationId: locked.operationId, operationStatus: locked.coreState };
  const succeeded = references.find(ref => ref.coreState === 'succeeded');
  if (succeeded) return { status: 'cannot_undo_completed', command: proposal.control.command, action: choices[0].action,
    operationId: succeeded.operationId };
  if (!task || !(LIVE.has(task.status) || task.status === 'suspended')) return { status: 'no_task', command: proposal.control.command };

  const previews = references.filter(ref => ref.coreState === 'awaiting_confirmation');
  for (const preview of previews) {
    await adapter.rejectPreview(preview);
    state = await adapter.transition({ type: 'observe_operation', operationId: preview.operationId });
  }
  const remaining = state.operationReferences.find(ref => ref.taskId === task.taskId && !TERMINAL.has(ref.coreState));
  if (remaining) return { status: 'query_required', command: proposal.control.command, action: task.action,
    operationId: remaining.operationId, operationStatus: remaining.coreState };
  const current = state.currentTask?.taskId === task.taskId ? state.currentTask : state.suspendedTasks.find(item => item.taskId === task.taskId);
  if (current && (LIVE.has(current.status) || current.status === 'suspended')) {
    state = await adapter.transition({ type: 'end_task', taskId: task.taskId, outcome: 'cancelled' });
  }
  return { status: 'cancelled', command: proposal.control.command, action: task.action, previewRejected: previews.length > 0 };
}

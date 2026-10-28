// Server boundary for AgentProposalV2 task_control results.
// This module validates the proposal shape only. Task identity, authorization,
// continuation tokens and financial state remain owned by the conversation host.

const commands = new Set(['undo', 'resume', 'modify']);
const targets = new Set(['current', 'previous']);

export class TaskControlError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'TaskControlError';
    this.code = code;
  }
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** @param {unknown} proposal */
export function validateTaskControlProposal(proposal) {
  if (!plainObject(proposal) || Object.keys(proposal).length !== 2 || proposal.kind !== 'task_control' || !plainObject(proposal.control) ||
      Object.keys(proposal.control).length !== 2 || !commands.has(proposal.control.command) || !targets.has(proposal.control.target)) {
    throw new TaskControlError('TASK_CONTROL_INVALID', '任务控制请求格式无效。');
  }
  return Object.freeze({ kind: 'task_control', control: Object.freeze({
    command: proposal.control.command,
    target: proposal.control.target,
  }) });
}

/**
 * Consume a validated task_control proposal without giving the model access to
 * task IDs or financial capabilities. The host supplies both read-only summary
 * and authenticated state mutation functions.
 *
 * @param {unknown} proposal
 * @param {{ getTaskSummary?: () => unknown, controlTask: (control: {command: string, target: string}, summary?: unknown) => Promise<unknown> | unknown }} handlers
 */
export async function handleTaskControl(proposal, handlers) {
  const normalized = validateTaskControlProposal(proposal);
  if (!handlers || typeof handlers.controlTask !== 'function') throw new TaskControlError('TASK_CONTROL_UNAVAILABLE', '当前无法处理任务控制请求。');
  const summary = typeof handlers.getTaskSummary === 'function' ? await handlers.getTaskSummary() : undefined;
  return handlers.controlTask(normalized.control, summary);
}

export const TASK_CONTROL_COMMANDS = Object.freeze([...commands]);
export const TASK_CONTROL_TARGETS = Object.freeze([...targets]);

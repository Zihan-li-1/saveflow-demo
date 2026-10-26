import { PARSED_INTENT_ACTIONS } from '../agent/parsed-intent';

export type BankingTask = { taskId: string; action: string; status: string; expiresAt: number };
export type BankingConversation = {
  token: string; revision: number; expiresAt: number; currentTask: BankingTask | null; suspendedTasks: BankingTask[];
  operationReferences: Array<{ operationId: string; taskId: string; coreState: string }>;
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const taskId = (value: unknown) => typeof value === 'string' && /^task_[a-f0-9-]{36}$/.test(value);
export function validBankingConversation(value: unknown): value is BankingConversation {
  if (!record(value) || !keys(value, ['token', 'revision', 'expiresAt', 'currentTask', 'suspendedTasks', 'operationReferences']) ||
      typeof value.token !== 'string' || !/^cs1\.[A-Za-z0-9_-]{43}$/.test(value.token) || !integer(value.revision) || !integer(value.expiresAt) || value.expiresAt === 0 ||
      !Array.isArray(value.suspendedTasks) || value.suspendedTasks.length > 25 || !Array.isArray(value.operationReferences) || value.operationReferences.length > 100) return false;
  const task = (v: unknown) => record(v) && keys(v, ['taskId', 'action', 'status', 'expiresAt']) && taskId(v.taskId) &&
    PARSED_INTENT_ACTIONS.includes(v.action as typeof PARSED_INTENT_ACTIONS[number]) && v.action !== 'unsupported' &&
    ['ready', 'awaiting_input', 'awaiting_confirmation', 'suspended', 'completed', 'cancelled', 'failed', 'expired'].includes(String(v.status)) &&
    integer(v.expiresAt) && v.expiresAt <= Number(value.expiresAt);
  if ((value.currentTask !== null && !task(value.currentTask)) || value.suspendedTasks.some(v => !task(v) || v.status !== 'suspended') ||
      (record(value.currentTask) && value.currentTask.status === 'suspended')) return false;
  const tasks = [...(value.currentTask ? [value.currentTask] : []), ...value.suspendedTasks] as BankingTask[];
  return tasks.length <= 25 && new Set(tasks.map(v => v.taskId)).size === tasks.length &&
    new Set(value.operationReferences.map(v => record(v) ? v.operationId : null)).size === value.operationReferences.length &&
    value.operationReferences.every(v => record(v) && keys(v, ['operationId', 'taskId', 'coreState']) && typeof v.operationId === 'string' &&
      /^op_[A-Za-z0-9-]{1,128}$/.test(v.operationId) && taskId(v.taskId) &&
      ['preparing', 'risk_check', 'awaiting_confirmation', 'confirmed', 'executing', 'succeeded', 'failed', 'cancelled', 'unknown', 'checking'].includes(String(v.coreState)));
}

import type { Message } from "./use-saveflow";
import { bankingContinuationToken, type BankingFlows } from "./banking-flow-state";
import { validBankingConversation } from './banking-conversation-contract';
import { PARSED_INTENT_ACTIONS } from '../agent/parsed-intent';

export const bankingChatKey = "saveflow.banking-chat.v1";
const retentionMs = 30 * 60 * 1000;
const continuationMs = 5 * 60 * 1000;
const planContinuationMs = 30 * 60 * 1000;
const kinds = new Set(["conversation", "normal", "error", "banking_clarification", "banking_bill", "banking_preview", "banking_card", "banking_card_preview", "banking_read", "banking_plan", "banking_receipt", "banking_wealth", "banking_wealth_preview", "banking_wealth_inputs", "banking_savings_inputs", "banking_savings_plan", "banking_internal_transfer"]);
export const continuationLifetime = (messages: Message[], token: string | null) => messages.some(message => message.banking?.status === "needs_plan_inputs" && message.banking.continuationToken === token) ? planContinuationMs : continuationMs;
type ChatTurn = { role: 'user' | 'assistant'; content: string };
function boundedChatHistory(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ChatTurn => !!item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string' && !!item.content.trim()).slice(-6).map(({ role, content }) => ({ role, content: content.slice(0, 400) }));
}
type Snapshot = { chatHistory: ChatTurn[]; version: 1 | 2; savedAt: number; messages: Message[]; continuation: string | null; continuationExpiresAt: number; flows: BankingFlows; focusedFlowId: string | null; conversationToken?: string };
const sessionToken = (token: unknown): token is string => typeof token === 'string' && /^cs1\.[A-Za-z0-9_-]{43}$/.test(token);
const displayFields = new Set(['reply', 'kind', 'status', 'action', 'question', 'slot', 'source', 'choices', 'continuationToken', 'goal', 'recentSource',
  'recent', 'requiredMonth', 'categories', 'operationId', 'preview', 'risk', 'receipt', 'data', 'evidence', 'disclosure', 'requestId', 'previewOnly',
  'plan', 'executionAllowed', 'previewCurrent', 'executed', 'outcomePending', 'error', 'coreStage', 'historySnapshot']);
const pendingMessage = (message: Message) => message.banking?.outcomePending === true || ['executing', 'checking', 'unknown'].includes(message.banking?.coreStage ?? '');

// Tab-local history can include user-entered aggregate finances. Never store access codes, consent, raw
// TrueForge session IDs/MCP tokens, or permission to confirm/execute an operation.
export function saveBankingChat(messages: Message[], continuation: string | null, continuationIssuedAt: number, now = Date.now(), state: { flows: BankingFlows; focusedFlowId: string | null; conversationToken?: string; chatHistory?: ChatTurn[] } = { flows: {}, focusedFlowId: null }): string {
  const pending = new Set(messages.filter(pendingMessage).slice(-25));
  const recent = new Set(messages.filter(m => !pending.has(m)).slice(-(100 - pending.size)));
  const safeMessages = messages.filter(m => pending.has(m) || recent.has(m)).map(message => ({ id: message.id, role: message.role, text: message.text, kind: message.kind,
    receipt: message.receipt, verification: message.verification, errorHint: message.errorHint, banking: message.banking ? {
    ...Object.fromEntries(Object.entries(message.banking).filter(([key]) => displayFields.has(key))),
    status: message.banking.status,
    continuationToken: bankingContinuationToken(message.banking.continuationToken) ? message.banking.continuationToken : undefined,
  } : undefined }));
  const safeFlows = Object.fromEntries(Object.entries(state.flows).slice(-25).filter(([, flow]) => flow && bankingContinuationToken(flow.token))
    .map(([id, flow]) => [id, { id, taskId: flow.taskId, action: flow.action, token: flow.token, expiresAt: flow.expiresAt, previewOperationId: flow.previewOperationId, slot: flow.slot }]));
  return JSON.stringify({ version: 2, chatHistory: boundedChatHistory(state.chatHistory), savedAt: now, messages: safeMessages,
    continuation: bankingContinuationToken(continuation) ? continuation : null,
    continuationExpiresAt: continuationIssuedAt + continuationLifetime(safeMessages, continuation), flows: safeFlows, focusedFlowId: state.focusedFlowId,
    ...(sessionToken(state.conversationToken) ? { conversationToken: state.conversationToken } : {}) } satisfies Snapshot);
}

export function restoreBankingChat(raw: string | null, now = Date.now()): Snapshot | null {
  if (!raw || raw.length > 256000) return null;
  try {
    const value = JSON.parse(raw) as Snapshot;
    if (![1, 2].includes(value.version) || !Number.isFinite(value.savedAt) || value.savedAt > now ||
        !Number.isFinite(value.continuationExpiresAt) || !Array.isArray(value.messages) || !value.messages.length || value.messages.length > 100 ||
        value.messages.some(m => !m || !Number.isSafeInteger(m.id) || !["agent", "user"].includes(m.role) || typeof m.text !== "string" || m.text.length > 4000 ||
          (m.kind !== undefined && !kinds.has(m.kind)) || (m.banking !== undefined && (!m.banking || typeof m.banking.status !== "string" ||
            (m.banking.choices !== undefined && (!Array.isArray(m.banking.choices) || m.banking.choices.some(c => !c || typeof c.optionId !== "string" || typeof c.label !== "string"))))))) return null;
    if (now - value.savedAt >= retentionMs && !value.messages.some(pendingMessage)) return null;
    const oldSession = value.messages.findLast(m => validBankingConversation(m.banking?.conversation))?.banking?.conversation;
    const conversationToken = sessionToken(value.conversationToken) ? value.conversationToken : oldSession?.token;
    const continuation = bankingContinuationToken(value.continuation) &&
      now < value.continuationExpiresAt && value.continuationExpiresAt <= value.savedAt + continuationLifetime(value.messages, value.continuation) ? value.continuation : null;
    const flows: BankingFlows = {};
    if (value.flows && typeof value.flows === "object" && !Array.isArray(value.flows)) {
      for (const [id, flow] of Object.entries(value.flows).slice(-25)) {
        const serverTask = !!flow?.taskId && /^task_[a-f0-9-]{36}$/.test(flow.taskId) && flow.taskId === id;
        if (!flow || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || flow.id !== id || !bankingContinuationToken(flow.token) ||
            !PARSED_INTENT_ACTIONS.includes(flow.action as typeof PARSED_INTENT_ACTIONS[number]) ||
            (flow.taskId !== undefined && !serverTask) || !Number.isSafeInteger(flow.expiresAt) || flow.expiresAt < 0 ||
            (!serverTask && (flow.expiresAt <= now || flow.expiresAt > value.savedAt + continuationMs)) ||
            (flow.previewOperationId !== undefined && (typeof flow.previewOperationId !== "string" ||
              !(serverTask ? /^op_[A-Za-z0-9-]{1,128}$/.test(flow.previewOperationId) : flow.previewOperationId.startsWith("tfpreview:")))) ||
            (flow.slot !== undefined && typeof flow.slot !== "string")) continue;
        flows[id] = { id, ...(serverTask ? { taskId: flow.taskId } : {}), action: flow.action, token: flow.token, expiresAt: flow.expiresAt,
          previewOperationId: flow.previewOperationId, slot: flow.slot };
      }
    }
    // P2-3 histories kept server metadata in each message but not in the root.
    // Recover only opaque navigation references; the Hook must sync before use.
    if (conversationToken) for (const message of value.messages) {
      const data = message.banking;
      if (!data || !validBankingConversation(data.conversation) || data.conversation.token !== conversationToken || !bankingContinuationToken(data.continuationToken)) continue;
      const task = data.conversation.currentTask;
      if (!task || task.action !== data.action || !['ready', 'awaiting_input', 'awaiting_confirmation'].includes(task.status)) continue;
      flows[task.taskId] = { id: task.taskId, taskId: task.taskId, action: task.action, token: data.continuationToken, expiresAt: task.expiresAt,
        previewOperationId: typeof data.operationId === 'string' && /^op_[A-Za-z0-9-]{1,128}$/.test(data.operationId) ? data.operationId : undefined, slot: data.slot };
    }
    // Migrate existing tab history without inventing or altering a token.
    const old = value.messages.findLast(m => m.banking?.continuationToken === continuation)?.banking;
    if (continuation && !Object.keys(flows).length && old?.action) flows.restored = { id: "restored", action: old.action, token: continuation, expiresAt: value.continuationExpiresAt,
      previewOperationId: old.operationId?.startsWith("tfpreview:") ? old.operationId : undefined, slot: old.slot };
    const focusedFlowId = typeof value.focusedFlowId === "string" && flows[value.focusedFlowId]?.token === continuation ? value.focusedFlowId : Object.values(flows).find(flow => flow.token === continuation)?.id || null;
    return { chatHistory: boundedChatHistory(value.chatHistory), version: value.version, savedAt: value.savedAt, continuationExpiresAt: value.continuationExpiresAt, conversationToken,
      continuation, flows, focusedFlowId, messages: value.messages.map(m => ({ id: m.id, role: m.role, text: m.text, kind: m.kind,
        receipt: m.receipt, verification: m.verification, errorHint: m.errorHint, banking: m.banking ? { ...m.banking, conversation: undefined,
      // Original Core card execution is never reactivated from browser storage.
      previewCurrent: false, historySnapshot: true,
      ...(conversationToken ? { choices: [] } : {}),
      ...(!continuation ? { choices: [], continuationToken: undefined } : {}),
    } : undefined })) };
  } catch { return null; }
}


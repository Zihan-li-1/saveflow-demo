import type { Message } from "./use-saveflow";
import { trialContinuation, type BankingFlows } from "./banking-flow-state";

export const bankingChatKey = "saveflow.banking-chat.v1";
const retentionMs = 30 * 60 * 1000;
const continuationMs = 5 * 60 * 1000;
const kinds = new Set(["normal", "error", "banking_clarification", "banking_bill", "banking_preview", "banking_card", "banking_card_preview", "banking_read", "banking_receipt"]);
type Snapshot = { version: 1; savedAt: number; messages: Message[]; continuation: string | null; continuationExpiresAt: number; flows: BankingFlows; focusedFlowId: string | null };

// Tab-local synthetic history only. Never store access codes, consent, raw
// TrueForge session IDs/MCP tokens, or permission to confirm/execute an operation.
export function saveBankingChat(messages: Message[], continuation: string | null, continuationIssuedAt: number, now = Date.now(), state: { flows: BankingFlows; focusedFlowId: string | null } = { flows: {}, focusedFlowId: null }): string {
  const safeMessages = messages.slice(-100).map(message => ({ ...message, banking: message.banking ? {
    ...message.banking,
    continuationToken: trialContinuation(message.banking.continuationToken) ? message.banking.continuationToken : undefined,
  } : undefined }));
  return JSON.stringify({ version: 1, savedAt: now, messages: safeMessages,
    continuation: trialContinuation(continuation) ? continuation : null,
    continuationExpiresAt: continuationIssuedAt + continuationMs, ...state } satisfies Snapshot);
}

export function restoreBankingChat(raw: string | null, now = Date.now()): Snapshot | null {
  if (!raw || raw.length > 256000) return null;
  try {
    const value = JSON.parse(raw) as Snapshot;
    if (value.version !== 1 || !Number.isFinite(value.savedAt) || value.savedAt > now || now - value.savedAt >= retentionMs ||
        !Number.isFinite(value.continuationExpiresAt) || !Array.isArray(value.messages) || !value.messages.length || value.messages.length > 100 ||
        value.messages.some(m => !m || !Number.isSafeInteger(m.id) || !["agent", "user"].includes(m.role) || typeof m.text !== "string" || m.text.length > 4000 ||
          (m.kind !== undefined && !kinds.has(m.kind)) || (m.banking !== undefined && (!m.banking || typeof m.banking.status !== "string" ||
            (m.banking.choices !== undefined && (!Array.isArray(m.banking.choices) || m.banking.choices.some(c => !c || typeof c.optionId !== "string" || typeof c.label !== "string"))))))) return null;
    const continuation = trialContinuation(value.continuation) &&
      now < value.continuationExpiresAt && value.continuationExpiresAt <= value.savedAt + continuationMs ? value.continuation : null;
    const flows: BankingFlows = {};
    if (value.flows && typeof value.flows === "object" && !Array.isArray(value.flows)) {
      for (const [id, flow] of Object.entries(value.flows).slice(-25)) {
        if (!flow || !/^[a-zA-Z0-9-]{1,64}$/.test(id) || flow.id !== id || !trialContinuation(flow.token) ||
            !["transfer.create", "card.get", "card.set_budget", "card.freeze", "card.unfreeze", "bill.summary", "product.list", "subscription.list"].includes(flow.action) ||
            !Number.isFinite(flow.expiresAt) || flow.expiresAt <= now || flow.expiresAt > value.savedAt + continuationMs ||
            (flow.previewOperationId !== undefined && (typeof flow.previewOperationId !== "string" || !flow.previewOperationId.startsWith("tfpreview:"))) ||
            (flow.slot !== undefined && typeof flow.slot !== "string")) continue;
        flows[id] = flow;
      }
    }
    // Migrate existing tab history without inventing or altering a token.
    const old = value.messages.findLast(m => m.banking?.continuationToken === continuation)?.banking;
    if (continuation && !Object.keys(flows).length && old?.action) flows.restored = { id: "restored", action: old.action, token: continuation, expiresAt: value.continuationExpiresAt,
      previewOperationId: old.operationId?.startsWith("tfpreview:") ? old.operationId : undefined, slot: old.slot };
    const focusedFlowId = typeof value.focusedFlowId === "string" && flows[value.focusedFlowId]?.token === continuation ? value.focusedFlowId : Object.values(flows).find(flow => flow.token === continuation)?.id || null;
    return { ...value, continuation, flows, focusedFlowId, messages: value.messages.map(m => ({ ...m, banking: m.banking ? { ...m.banking,
      // Original Core card execution is never reactivated from browser storage.
      ...(m.kind === "banking_card_preview" ? { previewCurrent: false } : {}),
      ...(!continuation ? { choices: [], continuationToken: undefined } : {}),
    } : undefined })) };
  } catch { return null; }
}

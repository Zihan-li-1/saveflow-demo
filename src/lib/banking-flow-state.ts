import type { BankingAgentData } from "./banking-agent-client";

// UI conversation focus is separate from each operation's opaque continuation.
// IDs here are local navigation keys, never Core IDs or server authorization.
export type BankingFlow = { id: string; action: string; token: string; expiresAt: number; previewOperationId?: string; slot?: string };
export type BankingFlows = Record<string, BankingFlow>;
export const trialContinuation = (token: unknown): token is string => typeof token === "string" && /^(?:tfm1|tfb1)\.[\w-]{43}\.[\w-]{43}$/.test(token);

// Shape check only; authenticity and expiry are always verified by the server.
export const bankingContinuationToken = (token: unknown): token is string => typeof token === "string" && token.length <= 10000 &&
  (trialContinuation(token) || /^[\w-]{16}\.[\w-]{22}\.[\w-]+$/.test(token));

export function updateBankingFlows(flows: BankingFlows, id: string, answer: BankingAgentData, now = Date.now()): BankingFlows {
  const next = Object.fromEntries(Object.entries(flows).filter(([, flow]) => flow.expiresAt > now));
  if (bankingContinuationToken(answer.continuationToken) && answer.action &&
      (answer.status === "needs_clarification" || trialContinuation(answer.continuationToken))) {
    next[id] = { id, action: answer.action, token: answer.continuationToken, expiresAt: now + 300000,
      previewOperationId: answer.status === "awaiting_confirmation" ? answer.operationId : next[id]?.previewOperationId,
      slot: answer.slot };
  } else delete next[id];
  return Object.fromEntries(Object.entries(next).slice(-25));
}

export function transferFlow(flows: BankingFlows, data: BankingAgentData, now = Date.now()): BankingFlow | undefined {
  return Object.values(flows).find(flow => flow.action === "transfer.create" && flow.expiresAt > now && !!data.operationId && flow.previewOperationId === data.operationId);
}

import { ApiError } from './api/contracts';

export type BankingChoice = { optionId: string; label: string };
export type BankingAgentData = {
  kind?: 'clarification';
  status: string;
  action?: string;
  question?: string;
  slot?: string;
  source?: string;
  choices?: BankingChoice[];
  continuationToken?: string;
  operationId?: string;
  preview?: Record<string, unknown>;
  risk?: Record<string, unknown>;
  data?: Record<string, unknown>;
  evidence?: Array<Record<string, unknown>>;
  disclosure?: Record<string, unknown>;
  requestId?: string;
  error?: { code?: string; message?: string };
};

export type BankingAgentRequest = {
  message?: string;
  continuationToken?: string;
  choice?: { optionId: string };
};

export async function askBankingAgent(
  body: BankingAgentRequest,
  accessCode: string,
  signal: AbortSignal,
): Promise<BankingAgentData> {
  let response: Response;
  try {
    response = await fetch('/api/banking-agent', {
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      headers: { 'Content-Type': 'application/json', 'X-Saveflow-Access': accessCode },
      body: JSON.stringify({ history: [], consent: true, ...body }),
    });
  } catch {
    throw new ApiError('BANKING_AGENT_NETWORK_ERROR', 'Banking Agent 连接失败，请稍后重试。');
  }
  let payload: { code?: string; message?: string; requestId?: string; data?: BankingAgentData };
  try { payload = await response.json(); } catch { throw new ApiError('BANKING_AGENT_RESPONSE_ERROR', 'Banking Agent 返回格式异常。'); }
  if (!payload || !response.ok || !payload.data || !['OK', 'NEEDS_CLARIFICATION'].includes(payload.code || '')) throw new ApiError(String(payload?.code || 'BANKING_AGENT_ERROR'), payload?.message || 'Banking Agent 请求失败');
  const data = payload.data;
  const card = data.data?.card as Record<string, unknown> | undefined;
  const cardPreview = data.preview as Record<string, unknown> | undefined;
  const cardEffect = Array.isArray(cardPreview?.exactEffects) ? cardPreview.exactEffects[0] as Record<string, unknown> | undefined : undefined;
  const before = cardEffect?.before as Record<string, unknown> | undefined;
  const after = cardEffect?.after as Record<string, unknown> | undefined;
  const evidence = data.evidence?.[0];
  const cardEvidenceValid = typeof evidence?.source === 'string' && typeof evidence?.asOf === 'string' && Array.isArray(evidence?.entityIds);
  const valid = typeof payload.requestId === 'string' && (
    (payload.code === 'NEEDS_CLARIFICATION' && data.status === 'needs_clarification' && typeof data.question === 'string' && typeof data.continuationToken === 'string' && Array.isArray(data.choices) && data.choices.every(choice => typeof choice.optionId === 'string' && typeof choice.label === 'string')) ||
    (payload.code === 'OK' && data.status === 'bill_result' && typeof data.data?.month === 'string' && Number.isSafeInteger(data.data?.totalExpenseFen) && Number.isSafeInteger(data.data?.totalIncomeFen) && Number.isSafeInteger(data.data?.transactionCount) && Array.isArray(data.evidence) && data.evidence.length > 0) ||
    (payload.code === 'OK' && data.status === 'card_result' && data.action === 'card.get' && typeof card?.id === 'string' && typeof card.name === 'string' && ['active', 'frozen'].includes(String(card.status)) && Number.isSafeInteger(card.monthlyBudgetFen) && Number(card.monthlyBudgetFen) >= 0 && Number.isSafeInteger(card.monthlySpentFen) && Number(card.monthlySpentFen) >= 0 && Number.isSafeInteger(card.version) && cardEvidenceValid) ||
    (payload.code === 'OK' && data.status === 'wealth_result' && data.action?.startsWith('wealth.') && typeof data.data?.kind === 'string' && data.data?.synthetic_demo_only === true && typeof data.data?.as_of === 'string' && typeof data.data?.context_snapshot_id === 'string' && Array.isArray(data.data?.evidence)) ||
    (payload.code === 'OK' && data.status === 'awaiting_confirmation' && ['wealth.subscribe', 'wealth.redeem'].includes(data.action || '') && typeof data.operationId === 'string' && typeof cardPreview?.previewHash === 'string' && /^[a-f0-9]{64}$/.test(cardPreview.previewHash) && Array.isArray(cardPreview.stepIds) && cardPreview.stepIds.length === 1 && cardEffect?.kind === 'wealth_change' && cardEffect.action === data.action && Number.isSafeInteger(cardEffect.amountFen) && data.risk?.allowed === true && data.risk?.riskLevel === 'L3' && Array.isArray(data.evidence)) ||
    (payload.code === 'OK' && data.status === 'awaiting_confirmation' && ['card.set_budget', 'card.freeze', 'card.unfreeze'].includes(data.action || '') && typeof data.operationId === 'string' && typeof cardPreview?.previewHash === 'string' && /^[a-f0-9]{64}$/.test(cardPreview.previewHash) && Array.isArray(cardPreview?.stepIds) && cardPreview.stepIds.length === 1 && cardEffect?.kind === 'card_change' && cardEffect.action === data.action && typeof cardEffect.cardId === 'string' && typeof cardEffect.cardName === 'string' && Number.isSafeInteger(cardEffect.cardVersion) && Number.isSafeInteger(cardEffect.previewGeneration) && ['active', 'frozen'].includes(String(before?.status)) && Number.isSafeInteger(before?.monthlyBudgetFen) && Number(before?.monthlyBudgetFen) >= 0 && ['active', 'frozen'].includes(String(after?.status)) && Number.isSafeInteger(after?.monthlyBudgetFen) && Number(after?.monthlyBudgetFen) >= 0 && data.risk?.allowed === true && cardEvidenceValid) ||
    (payload.code === 'OK' && data.status === 'awaiting_confirmation' && data.action === 'transfer.create' && typeof data.operationId === 'string' && typeof data.continuationToken === 'string' && typeof data.preview?.previewHash === 'string' && typeof data.preview?.summary === 'string' && Array.isArray(data.preview?.exactEffects) && data.preview.exactEffects.length > 0 && data.risk?.allowed === true)
  );
  if (!valid) throw new ApiError('BANKING_AGENT_RESPONSE_ERROR', 'Banking Agent 返回格式异常。');
  return { ...data, requestId: payload.requestId };
}

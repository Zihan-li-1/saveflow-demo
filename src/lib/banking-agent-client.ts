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
  const valid = typeof payload.requestId === 'string' && (
    (payload.code === 'NEEDS_CLARIFICATION' && data.status === 'needs_clarification' && typeof data.question === 'string' && typeof data.continuationToken === 'string' && Array.isArray(data.choices) && data.choices.every(choice => typeof choice.optionId === 'string' && typeof choice.label === 'string')) ||
    (payload.code === 'OK' && data.status === 'bill_result' && typeof data.data?.month === 'string' && Number.isSafeInteger(data.data?.totalExpenseFen) && Number.isSafeInteger(data.data?.totalIncomeFen) && Number.isSafeInteger(data.data?.transactionCount) && Array.isArray(data.evidence) && data.evidence.length > 0) ||
    (payload.code === 'OK' && data.status === 'awaiting_confirmation' && typeof data.operationId === 'string' && typeof data.continuationToken === 'string' && typeof data.preview?.previewHash === 'string' && typeof data.preview?.summary === 'string' && Array.isArray(data.preview?.exactEffects) && data.preview.exactEffects.length > 0 && data.risk?.allowed === true)
  );
  if (!valid) throw new ApiError('BANKING_AGENT_RESPONSE_ERROR', 'Banking Agent 返回格式异常。');
  return { ...data, requestId: payload.requestId };
}

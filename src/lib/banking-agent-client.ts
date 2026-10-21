import { ApiError } from './api/contracts';
import { isTrialOperationId } from './trial-preview.mjs';

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
  receipt?: Record<string, unknown>;
  data?: Record<string, unknown>;
  evidence?: Array<Record<string, unknown>>;
  requestId?: string;
  previewOnly?: boolean;
  executionAllowed?: boolean;
  previewCurrent?: boolean;
  error?: { code?: string; message?: string };
  recovery?: BankingAgentData;
};

export class BankingAgentError extends ApiError {
  constructor(code: string, message: string, public recovery: BankingAgentData, requestId: string) {
    super(code, message, false, requestId);
  }
}

export type BankingAgentRequest = {
  message?: string;
  continuationToken?: string;
  choice?: { optionId: string };
};

/** Clarifications without selectable options stay as plain chat prompts. */
export function hasBankingChoices(data?: BankingAgentData): boolean {
  return Array.isArray(data?.choices) && data.choices.length > 0;
}

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
  if (response.status === 401) throw new ApiError('UNAUTHORIZED', '访问验证失败，请检查演示访问码后重试。');
  if (['ACCESS_NOT_CONFIGURED', 'CONTINUATION_CONFIG_ERROR', 'SERVICE_UNAVAILABLE'].includes(payload?.code || '')) throw new ApiError('SERVICE_UNAVAILABLE', '服务暂时不可用，请联系演示维护者。');
  if (response.status === 400 && payload?.code === 'INSUFFICIENT_BALANCE' && payload.data?.recovery !== undefined) {
    const c = payload.data.recovery;
    if (!c || typeof c !== 'object' || typeof payload.requestId !== 'string' || payload.data.status !== 'error' || payload.data.error?.code !== payload.code ||
        c.kind !== 'clarification' || c.status !== 'needs_clarification' || c.action !== 'transfer.create' || c.slot !== 'source_account_ref' || c.source !== 'trueforge-mcp' ||
        typeof c.continuationToken !== 'string' || !/^tfm1\.[\w-]{43}\.[\w-]{43}$/.test(c.continuationToken) || typeof c.question !== 'string' || !c.question || c.question.length > 1000 ||
        !Array.isArray(c.choices) || !c.choices.length || c.choices.some(v => !v || typeof v.optionId !== 'string' || !v.optionId || typeof v.label !== 'string' || !v.label) ||
        new Set(c.choices.map(v => v.optionId)).size !== c.choices.length || Object.keys(c).some(k => !['kind', 'status', 'action', 'slot', 'question', 'source', 'choices', 'continuationToken'].includes(k))) throw new ApiError('BANKING_AGENT_RESPONSE_ERROR', 'Banking Agent 恢复凭据格式异常。');
    throw new BankingAgentError(payload.code, payload.message || '付款账户可用余额不足。', c, payload.requestId);
  }
  if (!payload || !response.ok || !payload.data || !['OK', 'NEEDS_CLARIFICATION'].includes(payload.code || '')) throw new ApiError(String(payload?.code || 'BANKING_AGENT_ERROR'), payload?.message || 'Banking Agent 请求失败');
  const data = payload.data;
  const card = data.data?.card as Record<string, unknown> | undefined;
  const cardPreview = data.preview as Record<string, unknown> | undefined;
  const cardEffect = Array.isArray(cardPreview?.exactEffects) ? cardPreview.exactEffects[0] as Record<string, unknown> | undefined : undefined;
  const before = cardEffect?.before as Record<string, unknown> | undefined;
  const after = cardEffect?.after as Record<string, unknown> | undefined;
  const evidence = data.evidence?.[0];
  const cardEvidenceValid = typeof evidence?.source === 'string' && typeof evidence?.asOf === 'string' && Array.isArray(evidence?.entityIds);
  const subscriptions = data.data?.subscriptions;
  const products = data.data?.products;
  const wealthProducts = data.data?.products as Array<Record<string, unknown>> | undefined;
  const nonnegative = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
  const listEvidence = evidence?.source === 'synthetic_demo_only' && typeof evidence.asOf === 'string' && Array.isArray(evidence.entityIds);
  const trialMetadataValid = !isTrialOperationId(data.operationId) || (data.source === 'trueforge-mcp' && data.previewOnly === true && data.executionAllowed === false);
  const scenarioPreview = data.preview as Record<string, unknown> | undefined;
  const scenarioEffect = Array.isArray(scenarioPreview?.exactEffects) ? scenarioPreview.exactEffects[0] as Record<string, unknown> | undefined : undefined;
  const scenarioAfter = scenarioEffect?.after as Record<string, unknown> | undefined;
  const scenarioRule = data.data?.rule as Record<string, unknown> | undefined;
  const scenarioReceipt = data.receipt as Record<string, unknown> | undefined;
  const scenarioReceiptEffect = Array.isArray(scenarioReceipt?.effects) ? scenarioReceipt.effects[0] as Record<string, unknown> | undefined : undefined;
  const scenarioReceiptAfter = scenarioReceiptEffect?.after as Record<string, unknown> | undefined;
  const scenarioAction = ['scenario.create_rule', 'scenario.update_rule', 'scenario.disable_rule'].includes(data.action || '');
  const valid = typeof payload.requestId === 'string' && trialMetadataValid && (
    (payload.code === 'OK' && data.status === 'cancelled' && data.source === 'trueforge-mcp' && data.previewOnly === true && data.executionAllowed === false) ||
    (payload.code === 'OK' && data.status === 'cancelled' && scenarioAction && typeof data.operationId === 'string') ||
    (payload.code === 'NEEDS_CLARIFICATION' && data.status === 'needs_clarification' && typeof data.question === 'string' && typeof data.continuationToken === 'string' && Array.isArray(data.choices) && data.choices.every(choice => typeof choice.optionId === 'string' && typeof choice.label === 'string')) ||
    (payload.code === 'OK' && data.status === 'bill_result' && typeof data.data?.month === 'string' && Number.isSafeInteger(data.data?.totalExpenseFen) && Number.isSafeInteger(data.data?.totalIncomeFen) && Number.isSafeInteger(data.data?.transactionCount) && Array.isArray(data.evidence) && data.evidence.length > 0) ||
    (payload.code === 'OK' && data.status === 'card_result' && data.action === 'card.get' && typeof card?.id === 'string' && typeof card.name === 'string' && ['active', 'frozen'].includes(String(card.status)) && Number.isSafeInteger(card.monthlyBudgetFen) && Number(card.monthlyBudgetFen) >= 0 && Number.isSafeInteger(card.monthlySpentFen) && Number(card.monthlySpentFen) >= 0 && Number.isSafeInteger(card.version) && cardEvidenceValid) ||
    (payload.code === 'OK' && data.status === 'subscription_result' && data.action === 'subscription.list' && listEvidence && Array.isArray(subscriptions) && subscriptions.every(s => s && typeof s.id === 'string' && typeof s.name === 'string' && nonnegative(s.monthlyFeeFen) && ['active', 'cancelled'].includes(s.status) && typeof s.lastUsedDate === 'string' && typeof s.isPotentiallyUnused === 'boolean')) ||
    (payload.code === 'OK' && data.status === 'product_result' && data.action === 'product.list' && listEvidence && Array.isArray(products) && products.every(p => p && typeof p.id === 'string' && typeof p.name === 'string' && ['R1', 'R2', 'R3'].includes(p.riskLevel) && nonnegative(p.expectedYield) && nonnegative(p.minimumAmountFen) && nonnegative(p.durationDays) && ['T+0', 'T+1', 'AT_MATURITY'].includes(p.liquidity) && p.currency === 'CNY' && p.isSynthetic === true)) ||
    (payload.code === 'OK' && ['wealth_recommendation', 'wealth_comparison'].includes(data.status) && ['wealth.recommend', 'wealth.compare'].includes(data.action || '') && Array.isArray(wealthProducts) && wealthProducts.every(p => typeof p.product_ref === 'string' && typeof p.name === 'string' && ['R1', 'R2', 'R3'].includes(String(p.risk_level)) && nonnegative(p.expected_yield_bps) && nonnegative(p.minimum_amount_minor) && nonnegative(p.duration_days) && ['T+0', 'T+1', 'AT_MATURITY'].includes(String(p.liquidity)) && p.currency === 'CNY') && Array.isArray(data.evidence)) ||
    (payload.code === 'OK' && data.status === 'risk_assessment_required' && data.action === 'wealth.assess_risk' && data.data?.status === 'requires_user_questionnaire' && data.data?.model_may_answer_for_user === false) ||
    (payload.code === 'OK' && data.status === 'goal_plan' && data.action === 'orchestrator.goal' && data.data?.execution_allowed === false && Array.isArray(data.data?.steps) && Array.isArray(data.evidence)) ||
    (payload.code === 'OK' && data.status === 'scenario_rule_preview' && scenarioAction && data.data?.requires_confirmation === true && typeof data.operationId === 'string' && typeof data.continuationToken === 'string' && typeof scenarioPreview?.previewHash === 'string' && /^[a-f0-9]{64}$/.test(scenarioPreview.previewHash) && Array.isArray(scenarioPreview.stepIds) && scenarioPreview.stepIds.length === 1 && scenarioEffect?.kind === 'scenario_rule_change' && scenarioEffect.action === data.action && typeof scenarioEffect.ruleId === 'string' && scenarioAfter?.id === scenarioEffect.ruleId && scenarioRule?.id === scenarioEffect.ruleId && data.risk?.allowed === true) ||
    (payload.code === 'OK' && data.status === 'scenario_rule' && scenarioAction && typeof data.operationId === 'string' && typeof scenarioRule?.id === 'string' && scenarioReceipt?.status === 'succeeded' && scenarioReceipt.action === data.action && scenarioReceiptEffect?.kind === 'scenario_rule_change' && scenarioReceiptEffect.action === data.action && scenarioReceiptAfter?.id === scenarioRule.id) ||
    (payload.code === 'OK' && data.status === 'scenario_event_review' && data.action === 'scenario.review_event' && data.data?.inherited_confirmation === false) ||
    (payload.code === 'OK' && data.status === 'awaiting_confirmation' && ['card.set_budget', 'card.freeze', 'card.unfreeze'].includes(data.action || '') && typeof data.operationId === 'string' && typeof cardPreview?.previewHash === 'string' && /^[a-f0-9]{64}$/.test(cardPreview.previewHash) && Array.isArray(cardPreview?.stepIds) && cardPreview.stepIds.length === 1 && cardEffect?.kind === 'card_change' && cardEffect.action === data.action && typeof cardEffect.cardId === 'string' && typeof cardEffect.cardName === 'string' && Number.isSafeInteger(cardEffect.cardVersion) && Number.isSafeInteger(cardEffect.previewGeneration) && ['active', 'frozen'].includes(String(before?.status)) && Number.isSafeInteger(before?.monthlyBudgetFen) && Number(before?.monthlyBudgetFen) >= 0 && ['active', 'frozen'].includes(String(after?.status)) && Number.isSafeInteger(after?.monthlyBudgetFen) && Number(after?.monthlyBudgetFen) >= 0 && data.risk?.allowed === true && cardEvidenceValid) ||
    (payload.code === 'OK' && data.status === 'awaiting_confirmation' && data.action === 'transfer.create' && typeof data.operationId === 'string' && typeof data.continuationToken === 'string' && typeof data.preview?.previewHash === 'string' && typeof data.preview?.summary === 'string' && Array.isArray(data.preview?.exactEffects) && data.preview.exactEffects.length > 0 && data.risk?.allowed === true)
  );
  if (!valid) throw new ApiError('BANKING_AGENT_RESPONSE_ERROR', 'Banking Agent 返回格式异常。');
  return { ...data, requestId: payload.requestId };
}

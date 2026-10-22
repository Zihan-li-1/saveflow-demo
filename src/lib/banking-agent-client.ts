import { ApiError } from './api/contracts';
import { isTrialOperationId } from './trial-preview.mjs';
import type { ActionReceipt } from '../banking-core/contracts';

export type BankingReply = { text: string; style: 'concise' | 'friendly' | 'professional'; safetyNotices: string[] };
export type BankingChoice = { optionId: string; label: string };
export type BankingAgentData = {
  reply?: BankingReply;
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
  disclosure?: Record<string, unknown>;
  requestId?: string;
  previewOnly?: boolean;
  executionAllowed?: boolean;
  previewCurrent?: boolean;
  /** 预览已执行：界面只读，不再提供确认/取消入口。 */
  executed?: boolean;
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
  replyStyle?: BankingReply['style'];
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
  let payload: { code?: string; message?: string; requestId?: string; reply?: BankingReply; data?: BankingAgentData };
  try { payload = await response.json(); } catch { throw new ApiError('BANKING_AGENT_RESPONSE_ERROR', 'Banking Agent 返回格式异常。'); }
  if (response.status === 401) throw new ApiError('UNAUTHORIZED', '访问验证失败，请检查演示访问码后重试。');
  if (['ACCESS_NOT_CONFIGURED', 'CONTINUATION_CONFIG_ERROR', 'SERVICE_UNAVAILABLE'].includes(payload?.code || '')) throw new ApiError('SERVICE_UNAVAILABLE', '服务暂时不可用，请联系演示维护者。');
  const validReply = (reply: BankingReply | undefined): reply is BankingReply => !!reply && typeof reply.text === 'string' && ['concise', 'friendly', 'professional'].includes(reply.style) && Array.isArray(reply.safetyNotices) && reply.safetyNotices.every(n => typeof n === 'string');
  if (response.status === 400 && payload?.code === 'INSUFFICIENT_BALANCE' && payload.data?.recovery !== undefined) {
    const c = payload.data.recovery;
    if (!validReply(payload.reply) || !c || typeof c !== 'object' || typeof payload.requestId !== 'string' || !['error', 'core_error'].includes(payload.data.status) || payload.data.error?.code !== payload.code ||
        c.kind !== 'clarification' || c.status !== 'needs_clarification' || c.action !== 'transfer.create' || c.slot !== 'source_account_ref' ||
        typeof c.continuationToken !== 'string' || c.continuationToken.length > 10000 || !/^(?:tfm1\.[\w-]{43}\.[\w-]{43}|[\w-]{16}\.[\w-]{22}\.[\w-]+)$/.test(c.continuationToken) || typeof c.question !== 'string' || !c.question || c.question.length > 1000 ||
        !Array.isArray(c.choices) || !c.choices.length || c.choices.some(v => !v || typeof v.optionId !== 'string' || !v.optionId || typeof v.label !== 'string' || !v.label) ||
        new Set(c.choices.map(v => v.optionId)).size !== c.choices.length || Object.keys(c).some(k => !['kind', 'status', 'action', 'slot', 'question', 'source', 'choices', 'continuationToken'].includes(k))) throw new ApiError('BANKING_AGENT_RESPONSE_ERROR', 'Banking Agent 恢复凭据格式异常。');
    throw new BankingAgentError(payload.code, payload.reply?.text || payload.message || '付款账户可用余额不足。', { ...c, reply: payload.reply }, payload.requestId);
  }
  if (!payload || !response.ok || !payload.data || !['OK', 'NEEDS_CLARIFICATION', 'UNSUPPORTED'].includes(payload.code || '')) throw new ApiError(String(payload?.code || 'BANKING_AGENT_ERROR'), payload?.message || 'Banking Agent 请求失败');
  const reply = payload.reply;
  if (!validReply(reply)) throw new ApiError('BANKING_AGENT_RESPONSE_ERROR', 'Banking Agent 回复格式异常。');
  const data = payload.data;
  const card = data.data?.card as Record<string, unknown> | undefined;
  const cardPreview = data.preview as Record<string, unknown> | undefined;
  const cardEffect = Array.isArray(cardPreview?.exactEffects) ? cardPreview.exactEffects[0] as Record<string, unknown> | undefined : undefined;
  const before = cardEffect?.before as Record<string, unknown> | undefined;
  const after = cardEffect?.after as Record<string, unknown> | undefined;
  const evidence = data.evidence?.[0];
  const cardEvidenceValid = typeof evidence?.source === 'string' && typeof evidence?.asOf === 'string' && Array.isArray(evidence?.entityIds);
  const subscriptions = data.data?.subscriptions;
  const subscriptionSummary = data.data?.summary as Record<string, unknown> | undefined;
  const subscriptionMethodology = data.data?.methodology as Record<string, unknown> | undefined;
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
  const bill = data.data;
  const billPeriod = bill?.period as Record<string, unknown> | undefined;
  const monthlyBreakdown = bill?.monthlyBreakdown as Array<Record<string, unknown>> | undefined;
  const validBillMonth = typeof bill?.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(bill.month);
  const validBillPeriod = !!billPeriod && typeof billPeriod.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(billPeriod.startDate) && typeof billPeriod.endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(billPeriod.endDate) && billPeriod.startDate <= billPeriod.endDate && billPeriod.timezone === 'Asia/Shanghai' && typeof billPeriod.label === 'string' && !!billPeriod.label;
  const validCategoryTotals = (value: unknown, total: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([name, amount]) => !!name.trim() && nonnegative(amount)) && Object.values(value).reduce((sum, amount) => sum + Number(amount), 0) === total;
  const enhancedSubscriptionValid = !subscriptionSummary && !subscriptionMethodology || (!!subscriptionSummary && !!subscriptionMethodology && nonnegative(subscriptionSummary.activeCount) && nonnegative(subscriptionSummary.activeMonthlyFeeFen) && nonnegative(subscriptionSummary.potentiallyUnusedCount) && nonnegative(subscriptionSummary.potentiallyUnusedMonthlyFeeFen) && nonnegative(subscriptionSummary.potentialAnnualSavingsFen) && subscriptionSummary.potentialAnnualSavingsFen === Number(subscriptionSummary.potentiallyUnusedMonthlyFeeFen) * 12 && subscriptionMethodology.usesRepositoryFlag === true && subscriptionMethodology.historicalSubscriptionState === false && subscriptionMethodology.savingsEstimateMonths === 12);
  const validMonthlyBreakdown = Array.isArray(monthlyBreakdown) && monthlyBreakdown.length >= 1 && monthlyBreakdown.length <= 13 && monthlyBreakdown.every(item => typeof item.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(item.month) && ['complete', 'partial', 'future'].includes(String(item.status)) && nonnegative(item.totalExpenseFen) && nonnegative(item.totalIncomeFen) && nonnegative(item.transactionCount) && validCategoryTotals(item.categoryTotals, item.totalExpenseFen));
  const valid = typeof payload.requestId === 'string' && trialMetadataValid && (
    (payload.code === 'UNSUPPORTED' && data.status === 'unsupported') ||
    (payload.code === 'OK' && data.status === 'cancelled') ||
    (payload.code === 'NEEDS_CLARIFICATION' && data.status === 'needs_clarification' && typeof data.question === 'string' && typeof data.continuationToken === 'string' && Array.isArray(data.choices) && data.choices.every(choice => typeof choice.optionId === 'string' && typeof choice.label === 'string')) ||
    (payload.code === 'OK' && data.status === 'bill_result' && validBillMonth !== validBillPeriod && nonnegative(bill?.totalExpenseFen) && nonnegative(bill?.totalIncomeFen) && nonnegative(bill?.transactionCount) && (!monthlyBreakdown || validMonthlyBreakdown) && (!validBillPeriod || validMonthlyBreakdown) && Array.isArray(data.evidence) && data.evidence.length > 0) ||
    (payload.code === 'OK' && data.status === 'card_result' && ['card.get', 'card.security_review'].includes(data.action || '') && typeof card?.id === 'string' && typeof card.name === 'string' && ['active', 'frozen'].includes(String(card.status)) && Number.isSafeInteger(card.monthlyBudgetFen) && Number(card.monthlyBudgetFen) >= 0 && Number.isSafeInteger(card.monthlySpentFen) && Number(card.monthlySpentFen) >= 0 && typeof card.onlinePaymentsEnabled === 'boolean' && Array.isArray(card.blockedCategories) && (card.alertThresholdFen === null || nonnegative(card.alertThresholdFen)) && Number.isSafeInteger(card.version) && cardEvidenceValid && (data.action !== 'card.security_review' || (data.data?.execution_allowed === false && data.data?.requires_explicit_user_request_to_freeze === true && Array.isArray(data.data?.guidance)))) ||
    (payload.code === 'OK' && data.status === 'wealth_result' && data.action?.startsWith('wealth.') && typeof data.data?.kind === 'string' && data.data?.synthetic_demo_only === true && typeof data.data?.as_of === 'string' && typeof data.data?.context_snapshot_id === 'string' && Array.isArray(data.data?.evidence)) ||
    (payload.code === 'OK' && data.status === 'awaiting_confirmation' && ['wealth.subscribe', 'wealth.redeem'].includes(data.action || '') && typeof data.operationId === 'string' && typeof cardPreview?.previewHash === 'string' && /^[a-f0-9]{64}$/.test(cardPreview.previewHash) && Array.isArray(cardPreview.stepIds) && cardPreview.stepIds.length === 1 && cardEffect?.kind === 'wealth_change' && cardEffect.action === data.action && Number.isSafeInteger(cardEffect.amountFen) && data.risk?.allowed === true && data.risk?.riskLevel === 'L3' && Array.isArray(data.evidence)) ||
    (payload.code === 'OK' && data.status === 'subscription_result' && data.action === 'subscription.list' && listEvidence && enhancedSubscriptionValid && Array.isArray(subscriptions) && subscriptions.every(s => s && typeof s.id === 'string' && typeof s.name === 'string' && nonnegative(s.monthlyFeeFen) && ['active', 'cancelled'].includes(s.status) && typeof s.lastUsedDate === 'string' && typeof s.isPotentiallyUnused === 'boolean' && (s.unusedReason === undefined || typeof s.unusedReason === 'string') && (s.inactivityDays === undefined || nonnegative(s.inactivityDays)))) ||
    (payload.code === 'OK' && data.status === 'product_result' && data.action === 'product.list' && listEvidence && Array.isArray(products) && products.every(p => p && typeof p.id === 'string' && typeof p.name === 'string' && ['R1', 'R2', 'R3'].includes(p.riskLevel) && nonnegative(p.expectedYield) && nonnegative(p.minimumAmountFen) && nonnegative(p.durationDays) && ['T+0', 'T+1', 'AT_MATURITY'].includes(p.liquidity) && p.currency === 'CNY' && p.isSynthetic === true)) ||
    (payload.code === 'OK' && ['wealth_recommendation', 'wealth_comparison'].includes(data.status) && ['wealth.recommend', 'wealth.compare'].includes(data.action || '') && Array.isArray(wealthProducts) && wealthProducts.every(p => typeof p.product_ref === 'string' && typeof p.name === 'string' && ['R1', 'R2', 'R3'].includes(String(p.risk_level)) && nonnegative(p.expected_yield_bps) && nonnegative(p.minimum_amount_minor) && nonnegative(p.duration_days) && ['T+0', 'T+1', 'AT_MATURITY'].includes(String(p.liquidity)) && p.currency === 'CNY') && Array.isArray(data.evidence)) ||
    (payload.code === 'OK' && data.status === 'risk_assessment_required' && data.action === 'wealth.assess_risk' && data.data?.status === 'requires_user_questionnaire' && data.data?.model_may_answer_for_user === false) ||
    (payload.code === 'OK' && data.status === 'goal_plan' && data.action === 'orchestrator.goal' && data.data?.execution_allowed === false && Array.isArray(data.data?.steps) && Array.isArray(data.evidence)) ||
    (payload.code === 'OK' && data.status === 'scenario_rule_preview' && scenarioAction && data.data?.requires_confirmation === true && typeof data.operationId === 'string' && typeof data.continuationToken === 'string' && typeof scenarioPreview?.previewHash === 'string' && /^[a-f0-9]{64}$/.test(scenarioPreview.previewHash) && Array.isArray(scenarioPreview.stepIds) && scenarioPreview.stepIds.length === 1 && scenarioEffect?.kind === 'scenario_rule_change' && scenarioEffect.action === data.action && typeof scenarioEffect.ruleId === 'string' && scenarioAfter?.id === scenarioEffect.ruleId && scenarioRule?.id === scenarioEffect.ruleId && data.risk?.allowed === true) ||
    (payload.code === 'OK' && data.status === 'scenario_rule' && scenarioAction && typeof data.operationId === 'string' && typeof scenarioRule?.id === 'string' && scenarioReceipt?.status === 'succeeded' && scenarioReceipt.action === data.action && scenarioReceiptEffect?.kind === 'scenario_rule_change' && scenarioReceiptEffect.action === data.action && scenarioReceiptAfter?.id === scenarioRule.id) ||
    (payload.code === 'OK' && data.status === 'scenario_event_review' && data.action === 'scenario.review_event' && data.data?.inherited_confirmation === false) ||
    (payload.code === 'OK' && data.status === 'awaiting_confirmation' && ['card.set_budget', 'card.set_controls', 'card.freeze', 'card.unfreeze'].includes(data.action || '') && typeof data.operationId === 'string' && typeof cardPreview?.previewHash === 'string' && /^[a-f0-9]{64}$/.test(cardPreview.previewHash) && Array.isArray(cardPreview?.stepIds) && cardPreview.stepIds.length === 1 && cardEffect?.kind === 'card_change' && cardEffect.action === data.action && typeof cardEffect.cardId === 'string' && typeof cardEffect.cardName === 'string' && Number.isSafeInteger(cardEffect.cardVersion) && Number.isSafeInteger(cardEffect.previewGeneration) && ['active', 'frozen'].includes(String(before?.status)) && Number.isSafeInteger(before?.monthlyBudgetFen) && Number(before?.monthlyBudgetFen) >= 0 && typeof before?.onlinePaymentsEnabled === 'boolean' && Array.isArray(before?.blockedCategories) && (before?.alertThresholdFen === null || nonnegative(before?.alertThresholdFen)) && ['active', 'frozen'].includes(String(after?.status)) && Number.isSafeInteger(after?.monthlyBudgetFen) && Number(after?.monthlyBudgetFen) >= 0 && typeof after?.onlinePaymentsEnabled === 'boolean' && Array.isArray(after?.blockedCategories) && (after?.alertThresholdFen === null || nonnegative(after?.alertThresholdFen)) && data.risk?.allowed === true && cardEvidenceValid) ||
    (payload.code === 'OK' && data.status === 'awaiting_confirmation' && data.action === 'transfer.create' && typeof data.operationId === 'string' && typeof data.continuationToken === 'string' && typeof data.preview?.previewHash === 'string' && typeof data.preview?.summary === 'string' && Array.isArray(data.preview?.exactEffects) && data.preview.exactEffects.length > 0 && data.risk?.allowed === true)
  );
  if (!valid) throw new ApiError('BANKING_AGENT_RESPONSE_ERROR', 'Banking Agent 返回格式异常。');
  return { ...data, reply, requestId: payload.requestId };
}

/** 经服务端「执行桥」把一座试点转账预览真正执行（扣款）并取回回执。仅接受 tfpreview: 编号 + 预览哈希。 */
export async function executeTrialTransfer(
  trialOperationId: string,
  previewHash: string,
  accessCode: string,
  signal: AbortSignal,
): Promise<ActionReceipt> {
  let response: Response;
  try {
    response = await fetch('/api/execute-trial', {
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      headers: { 'Content-Type': 'application/json', 'X-Saveflow-Access': accessCode },
      body: JSON.stringify({ trialOperationId, previewHash }),
    });
  } catch {
    throw new ApiError('BANKING_AGENT_NETWORK_ERROR', '执行桥连接失败，请稍后重试。');
  }
  let payload: { code?: string; message?: string; requestId?: string; data?: unknown };
  try { payload = await response.json(); } catch { throw new ApiError('BANKING_AGENT_RESPONSE_ERROR', '执行桥返回格式异常。'); }
  if (response.status === 401) throw new ApiError('UNAUTHORIZED', '访问验证失败，请检查演示访问码后重试。');
  if (response.status === 503 && ['ACCESS_NOT_CONFIGURED', 'DATABASE_NOT_CONFIGURED'].includes(payload?.code || '')) throw new ApiError('SERVICE_UNAVAILABLE', '执行服务未配置，请联系演示维护者。');
  if (!payload || !response.ok || payload.code !== 'OK') throw new ApiError(String(payload?.code || 'EXECUTE_TRIAL_ERROR'), payload?.message || '试点转账执行失败');
  const receipt = payload.data;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
    typeof (receipt as ActionReceipt).operationId !== 'string' ||
    !['succeeded', 'failed', 'cancelled'].includes(String((receipt as ActionReceipt).status)) ||
    !Array.isArray((receipt as ActionReceipt).effects)) throw new ApiError('BANKING_AGENT_RESPONSE_ERROR', '执行桥回执格式异常。');
  return receipt as ActionReceipt;
}

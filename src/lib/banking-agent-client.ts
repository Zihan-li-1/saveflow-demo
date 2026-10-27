import { ApiError } from './api/contracts';
import { isTrialOperationId } from './trial-preview.mjs';
import { billResponseFailure, type ResponseFailure } from './bill-response-validation';
import { agentErrorPolicy, validAgentErrorPolicy, validRecoverySlot } from './agent-error-policy.mjs';
import type { ActionReceipt } from '../banking-core/contracts';
import { validBankingConversation, type BankingConversation } from './banking-conversation-contract';

export type BankingReply = { text: string; style: 'concise' | 'friendly' | 'professional'; safetyNotices: string[] };
export type BankingChoice = { optionId: string; label: string };
export type WealthScreeningInputs = { investable_amount_minor: number; max_risk_level: 'R1' | 'R2' | 'R3'; liquidity_requirement: 'T+0' | 'T+1' | 'AT_MATURITY' };
export type SavingsPlanInputs = { saved_amount_minor: number } | { month: string; saved_amount_minor: number; income_minor: number; category_expenses_minor: Record<string, number> };
export type BankingAgentData = {
  wealthHandoffToken?: string;
  conversation?: BankingConversation;
  reply?: BankingReply;
  kind?: 'clarification';
  status: string;
  action?: string;
  question?: string;
  slot?: string;
  source?: string;
  choices?: BankingChoice[];
  continuationToken?: string;
  goal?: { target_amount_minor: number; deadline: string };
  recentSource?: 'repository' | 'user_provided';
  recent?: { month: string; income_minor: number; category_expenses_minor: Record<string, number> };
  requiredMonth?: string;
  categories?: string[];
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
  outcomePending?: boolean;
  error?: { code?: string; message?: string; uncertain?: boolean; category?: string; retryable?: boolean; nextAction?: string; context?: string };
  /** UI lifecycle only; never grants Core confirmation or execution authority. */
  coreStage?: import('./flow-machine').CoreOperationStage;
  /** Browser history is display-only until a new authoritative response arrives. */
  historySnapshot?: boolean;
  recovery?: BankingAgentData;
};

export class BankingAgentError extends ApiError {
  constructor(code: string, message: string, public recovery: BankingAgentData | undefined, requestId: string, public policy = agentErrorPolicy(code, { hasRecovery: !!recovery, hasChoices: !!recovery?.choices?.length }), public conversation?: BankingConversation) {
    super(code, message, policy.nextAction === 'query_status', requestId);
  }
}

export type BankingAgentRequest = {
  wealthInputs?: WealthScreeningInputs;
  conversationToken?: string;
  conversationRevision?: number;
  taskId?: string;
  taskMode?: 'auto' | 'new' | 'continue' | 'resume' | 'sync';
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  message?: string;
  continuationToken?: string;
  choice?: { optionId: string };
  replyStyle?: BankingReply['style'];
  planInputs?: SavingsPlanInputs;
};

export type BankingResponseDiagnostic = ResponseFailure & {
  event: 'banking_response_validation_failed'; stage: 'http' | 'envelope' | 'bill'; requestId: string;
};

/** Clarifications without selectable options stay as plain chat prompts. */
export function hasBankingChoices(data?: BankingAgentData): boolean {
  return Array.isArray(data?.choices) && data.choices.length > 0;
}

export async function askBankingAgent(
  body: BankingAgentRequest,
  accessCode: string,
  signal: AbortSignal,
  options: { onDiagnostic?: (entry: BankingResponseDiagnostic) => void } = {},
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
  const invalid = (failure: ResponseFailure, stage: BankingResponseDiagnostic['stage']): never => {
    const id = payload?.requestId ?? response.headers.get('x-request-id');
    const requestId = typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id) ? id : 'unavailable';
    const entry: BankingResponseDiagnostic = { event: 'banking_response_validation_failed', stage, requestId, ...failure };
    try {
      if (options.onDiagnostic) options.onDiagnostic(entry);
      else if (process.env.NODE_ENV === 'development') console.warn(JSON.stringify(entry));
    } catch { /* Diagnostics cannot bypass validation. */ }
    throw new ApiError('BANKING_AGENT_RESPONSE_ERROR', 'Banking Agent 返回格式异常。', false, requestId);
  };
  try { payload = await response.json(); } catch { return invalid({ reason: 'INVALID_HTTP_RESPONSE', path: '$' }, 'http'); }
  if (response.status === 401) throw new ApiError('UNAUTHORIZED', '访问验证失败，请检查演示访问码后重试。');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return invalid({ reason: 'INVALID_REPLY_ENVELOPE', path: '$' }, 'envelope');
  if (['ACCESS_NOT_CONFIGURED', 'CONTINUATION_CONFIG_ERROR', 'SERVICE_UNAVAILABLE'].includes(payload?.code || '')) throw new ApiError('SERVICE_UNAVAILABLE', '服务暂时不可用，请联系演示维护者。');
  const validReply = (reply: BankingReply | undefined): reply is BankingReply => !!reply && typeof reply.text === 'string' && ['concise', 'friendly', 'professional'].includes(reply.style) && Array.isArray(reply.safetyNotices) && reply.safetyNotices.every(n => typeof n === 'string');
  if ((payload.data?.conversation !== undefined && !validBankingConversation(payload.data.conversation)) ||
      (response.ok && body.conversationToken !== undefined && !payload.data?.conversation)) return invalid({ reason: 'INVALID_REPLY_ENVELOPE', path: 'data.conversation' }, 'envelope');
  const session = payload.data?.conversation;
  if (session && ((body.conversationToken !== undefined && session.token !== body.conversationToken) ||
      (response.ok && body.conversationRevision !== undefined && session.revision < body.conversationRevision) ||
      (response.ok && ['continue', 'resume'].includes(body.taskMode || '') && body.taskId !== undefined && session.currentTask?.taskId !== body.taskId &&
        !(payload.data?.status === 'goal_plan' && payload.data?.data?.verification_status === 'verified' && typeof payload.data?.wealthHandoffToken === 'string' && session.currentTask?.action === 'wealth.recommend' && session.currentTask?.status === 'awaiting_input')))) return invalid({ reason: 'INVALID_REPLY_ENVELOPE', path: 'data.conversation' }, 'envelope');
  if (!response.ok && payload.data?.recovery !== undefined) {
    const c = payload.data.recovery;
    if (!['invalid_input', 'invalid_choice', 'business_conflict', 'missing_information'].includes(agentErrorPolicy(payload.code).category) || payload.data.error?.uncertain === true ||
        !validReply(payload.reply) || !c || typeof c !== 'object' || typeof payload.requestId !== 'string' || !['error', 'core_error', 'card_error'].includes(payload.data.status) || payload.data.error?.code !== payload.code ||
        c.kind !== 'clarification' || c.status !== 'needs_clarification' || !validRecoverySlot(c.action, c.slot) ||
        typeof c.continuationToken !== 'string' || c.continuationToken.length > 10000 || !/^(?:tfm1\.[\w-]{43}\.[\w-]{43}|[\w-]{16}\.[\w-]{22}\.[\w-]+)$/.test(c.continuationToken) || typeof c.question !== 'string' || !c.question || c.question.length > 1000 ||
        !Array.isArray(c.choices) || (['card_ref', 'source_account_ref', 'payee_ref', 'target_account_ref', 'transfer_type'].includes(c.slot ?? '') && !c.choices.length) || c.choices.some(v => !v || typeof v.optionId !== 'string' || !v.optionId || typeof v.label !== 'string' || !v.label || Object.keys(v).some(k => !['optionId', 'label'].includes(k))) ||
        new Set(c.choices.map(v => v.optionId)).size !== c.choices.length || Object.keys(c).some(k => !['kind', 'status', 'action', 'slot', 'question', 'source', 'choices', 'continuationToken'].includes(k))) throw new ApiError('BANKING_AGENT_RESPONSE_ERROR', 'Banking Agent 恢复凭据格式异常。');
    if (payload.data.error?.category !== undefined && !validAgentErrorPolicy(payload.data.error, true, !!c.choices?.length)) return invalid({ reason: 'INVALID_REPLY_ENVELOPE', path: 'data.error' }, 'envelope');
    throw new BankingAgentError(payload.code!, payload.reply?.text || payload.message || '请修改当前请求。', { ...c, reply: payload.reply, conversation: payload.data.conversation }, payload.requestId, undefined, payload.data.conversation);
  }
  if (!response.ok) {
    const error = payload.data?.error;
    if (error?.category !== undefined && (error.code !== payload.code || !validAgentErrorPolicy(error))) return invalid({ reason: 'INVALID_REPLY_ENVELOPE', path: 'data.error' }, 'envelope');
    throw new BankingAgentError(typeof payload.code === 'string' ? payload.code : 'BANKING_AGENT_ERROR', typeof payload.message === 'string' ? payload.message : 'Banking Agent 请求失败', undefined, payload.requestId ?? '', agentErrorPolicy(payload.code, { uncertain: error?.uncertain === true }), payload.data?.conversation);
  }
  if (!payload.data || !['OK', 'NEEDS_CLARIFICATION', 'NEEDS_PLAN_INPUTS', 'UNSUPPORTED'].includes(payload.code || '')) return invalid({ reason: 'INVALID_REPLY_ENVELOPE', path: 'data' }, 'envelope');
  const reply = payload.reply;
  if (!validReply(reply)) return invalid({ reason: 'INVALID_REPLY_ENVELOPE', path: 'reply' }, 'envelope');
  const data = payload.data;
  if (body.taskMode === 'sync' && data.status !== 'conversation_state') return invalid({ reason: 'INVALID_REPLY_ENVELOPE', path: 'data.status' }, 'envelope');
  if (typeof data !== 'object' || Array.isArray(data) || typeof payload.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(payload.requestId) ||
      (data.data !== undefined && (!data.data || typeof data.data !== 'object' || Array.isArray(data.data)))) return invalid({ reason: 'INVALID_REPLY_ENVELOPE', path: 'data' }, 'envelope');
  if (data.status === 'bill_result') {
    const failure = billResponseFailure(data);
    if (failure) return invalid(failure, 'bill');
  }
  if (data.evidence !== undefined && (!Array.isArray(data.evidence) || data.evidence.some(e => !e || typeof e !== 'object' || Array.isArray(e)))) return invalid({ reason: 'INVALID_EVIDENCE', path: 'data.evidence' }, 'envelope');
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
  const internalPreview = data.preview as Record<string, unknown> | undefined;
  const internalTransferValid = internalPreview?.kind === 'internal_transfer' &&
    typeof internalPreview.source_account_id === 'string' && !!internalPreview.source_account_id &&
    typeof internalPreview.target_account_id === 'string' && !!internalPreview.target_account_id &&
    internalPreview.source_account_id !== internalPreview.target_account_id &&
    typeof internalPreview.source_account_name === 'string' && typeof internalPreview.target_account_name === 'string' &&
    Number.isSafeInteger(internalPreview.amount_minor) && Number(internalPreview.amount_minor) > 0 && internalPreview.currency === 'CNY' &&
    nonnegative(internalPreview.source_available_balance_minor) && nonnegative(internalPreview.source_estimated_balance_after_minor) &&
    nonnegative(internalPreview.target_available_balance_minor) && nonnegative(internalPreview.target_estimated_balance_after_minor) &&
    Number(internalPreview.source_estimated_balance_after_minor) === Number(internalPreview.source_available_balance_minor) - Number(internalPreview.amount_minor) &&
    Number(internalPreview.target_estimated_balance_after_minor) === Number(internalPreview.target_available_balance_minor) + Number(internalPreview.amount_minor);
  const coreTransferEffect = Array.isArray(internalPreview?.exactEffects) ? internalPreview.exactEffects[0] as Record<string, unknown> | undefined : undefined;
  const internalCoreTransferValid = coreTransferEffect?.kind === 'transfer_internal' &&
    typeof coreTransferEffect.fromAccountId === 'string' && typeof coreTransferEffect.toAccountId === 'string' && coreTransferEffect.fromAccountId !== coreTransferEffect.toAccountId &&
    typeof coreTransferEffect.accountName === 'string' && typeof coreTransferEffect.targetAccountName === 'string' && coreTransferEffect.currency === 'CNY' &&
    Number.isSafeInteger(coreTransferEffect.amountFen) && Number(coreTransferEffect.amountFen) > 0 &&
    ['sourceBalanceBeforeFen', 'sourceBalanceAfterFen', 'sourceAvailableBalanceAfterFen', 'targetBalanceBeforeFen', 'targetBalanceAfterFen', 'targetAvailableBalanceAfterFen'].every(key => nonnegative(coreTransferEffect[key])) &&
    Number(coreTransferEffect.sourceBalanceBeforeFen) - Number(coreTransferEffect.sourceBalanceAfterFen) === Number(coreTransferEffect.amountFen) &&
    Number(coreTransferEffect.targetBalanceAfterFen) - Number(coreTransferEffect.targetBalanceBeforeFen) === Number(coreTransferEffect.amountFen);
  const recent = data.data?.recent as { month?: string; income_minor?: number; category_expenses_minor?: Record<string, number> } | undefined;
  const calculation = data.data?.calculation as Record<string, unknown> | undefined;
  const advice = data.data?.advice as { proposed_expense_minor?: number; feasible?: boolean; remaining_gap_minor?: number; observations?: unknown[]; caveats?: unknown[]; category_budgets?: Array<{ category: string; suggested_minor: number }> } | undefined;
  const screening = data.data?.screening_context as Record<string, unknown> | undefined;
  const validScreening = data.data?.screening_context === undefined || (!!screening && !Array.isArray(screening) && data.action === 'wealth.recommend' && data.data?.kind === 'recommendation' && Object.keys(screening).sort().join(',') === 'investable_amount_minor,liquidity_requirement,max_risk_level,source,target_date' && screening.source === 'verified_savings_plan' && typeof screening.target_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(screening.target_date) && Number.isSafeInteger(screening.investable_amount_minor) && Number(screening.investable_amount_minor) >= 1 && Number(screening.investable_amount_minor) <= 1_000_000_000 && ['R1', 'R2', 'R3'].includes(String(screening.max_risk_level)) && ['T+0', 'T+1', 'AT_MATURITY'].includes(String(screening.liquidity_requirement)));
  const verifiedSavings = data.data?.verification_status === 'verified' && (data.wealthHandoffToken === undefined || typeof data.wealthHandoffToken === 'string' && /^[\w-]{16}\.[\w-]{22}\.[\w-]+$/.test(data.wealthHandoffToken)) && !!recent && !!calculation && !!advice &&
    /^\d{4}-(0[1-9]|1[0-2])$/.test(recent.month || '') && nonnegative(recent.income_minor) &&
    !!recent.category_expenses_minor && Object.values(recent.category_expenses_minor).every(nonnegative) &&
    nonnegative(calculation.target_amount_minor) && nonnegative(calculation.saved_amount_minor) && nonnegative(calculation.remaining_minor) &&
    typeof calculation.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(calculation.deadline) &&
    calculation.remaining_minor === Math.max(0, Number(calculation.target_amount_minor) - Number(calculation.saved_amount_minor)) &&
    Array.isArray(calculation.opportunity_dates) && (calculation.opportunity_dates.length > 0 || calculation.remaining_minor === 0) && calculation.opportunity_dates.every((date: unknown) => typeof date === 'string' && /^\d{4}-\d{2}-01$/.test(date)) &&
    nonnegative(calculation.required_monthly_minor) && calculation.required_monthly_minor === (calculation.opportunity_dates.length ? Math.ceil(Number(calculation.remaining_minor) / calculation.opportunity_dates.length) : 0) &&
    nonnegative(calculation.observed_income_minor) && nonnegative(calculation.observed_expense_minor) &&
    calculation.observed_expense_minor === Object.values(recent.category_expenses_minor).reduce((sum, amount) => sum + amount, 0) &&
    calculation.observed_income_minor === recent.income_minor &&
    calculation.observed_surplus_minor === Number(calculation.observed_income_minor) - Number(calculation.observed_expense_minor) &&
    calculation.monthly_gap_minor === Math.max(0, Number(calculation.required_monthly_minor) - Number(calculation.observed_surplus_minor)) &&
    Array.isArray(advice.observations) && Array.isArray(advice.caveats) && advice.caveats.every(item => typeof item === 'string') &&
    Array.isArray(advice.category_budgets) && advice.category_budgets.length === Object.keys(recent.category_expenses_minor).length &&
    new Set(advice.category_budgets.map(item => item.category)).size === advice.category_budgets.length &&
    advice.category_budgets.every(item => item.category in recent.category_expenses_minor! && nonnegative(item.suggested_minor)) &&
    advice.proposed_expense_minor === advice.category_budgets.reduce((sum, item) => sum + item.suggested_minor, 0) &&
    advice.remaining_gap_minor === Math.max(0, Number(advice.proposed_expense_minor) + Number(calculation.required_monthly_minor) - Number(calculation.observed_income_minor)) &&
    advice.feasible === (advice.remaining_gap_minor === 0) && ['repository', 'user_provided'].includes(String(data.data?.recent_source)) &&
    data.evidence?.some(item => item.source === (data.data?.recent_source === 'repository' ? 'synthetic_demo_only' : 'user_provided'));
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
  const enhancedSubscriptionValid = !subscriptionSummary && !subscriptionMethodology || (!!subscriptionSummary && !!subscriptionMethodology && nonnegative(subscriptionSummary.activeCount) && nonnegative(subscriptionSummary.activeMonthlyFeeFen) && nonnegative(subscriptionSummary.potentiallyUnusedCount) && nonnegative(subscriptionSummary.potentiallyUnusedMonthlyFeeFen) && nonnegative(subscriptionSummary.potentialAnnualSavingsFen) && subscriptionSummary.potentialAnnualSavingsFen === Number(subscriptionSummary.potentiallyUnusedMonthlyFeeFen) * 12 && subscriptionMethodology.usesRepositoryFlag === true && subscriptionMethodology.usesLastUsedDate === true && subscriptionMethodology.highConfidenceInactivityDays === 90 && subscriptionMethodology.historicalSubscriptionState === false && subscriptionMethodology.savingsEstimateMonths === 12 && typeof subscriptionMethodology.limitation === 'string');
  const valid = typeof payload.requestId === 'string' && trialMetadataValid && (
    (payload.code === 'OK' && data.status === 'conversation_state' && !!data.conversation) ||
    (payload.code === 'UNSUPPORTED' && data.status === 'unsupported') ||
    (payload.code === 'OK' && data.status === 'cancelled') ||
    (payload.code === 'OK' && data.status === 'purchase_request' && data.action === 'scenario.plan_purchase' && data.data?.slots !== null && typeof data.data?.slots === 'object' && data.data?.synthetic_demo_only === true) ||
    (payload.code === 'NEEDS_CLARIFICATION' && data.status === 'needs_clarification' && typeof data.question === 'string' && typeof data.continuationToken === 'string' && Array.isArray(data.choices) && data.choices.every(choice => typeof choice.optionId === 'string' && typeof choice.label === 'string')) ||
    (payload.code === 'NEEDS_PLAN_INPUTS' && data.status === 'needs_plan_inputs' && data.action === 'orchestrator.goal' && nonnegative(data.goal?.target_amount_minor) && typeof data.goal?.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.goal.deadline) && /^\d{4}-(0[1-9]|1[0-2])$/.test(data.requiredMonth || '') && typeof data.continuationToken === 'string' && Array.isArray(data.categories) && data.categories.length > 0 && data.categories.every(category => typeof category === 'string' && !!category.trim()) && new Set(data.categories).size === data.categories.length && (data.recentSource === 'user_provided' || (data.recentSource === 'repository' && data.recent?.month === data.requiredMonth && nonnegative(data.recent?.income_minor) && !!data.recent?.category_expenses_minor && data.categories.every(category => nonnegative(data.recent?.category_expenses_minor[category]))))) ||
    (payload.code === 'OK' && data.status === 'needs_wealth_inputs' && data.action === 'wealth.recommend' && typeof data.continuationToken === 'string' && /^[\w-]{16}\.[\w-]{22}\.[\w-]+$/.test(data.continuationToken) && typeof data.data?.target_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.data.target_date) && data.data.execution_allowed === false) ||
    (payload.code === 'OK' && data.status === 'bill_result') ||
    (payload.code === 'OK' && data.status === 'card_result' && ['card.get', 'card.security_review'].includes(data.action || '') && typeof card?.id === 'string' && typeof card.name === 'string' && ['active', 'frozen'].includes(String(card.status)) && Number.isSafeInteger(card.monthlyBudgetFen) && Number(card.monthlyBudgetFen) >= 0 && Number.isSafeInteger(card.monthlySpentFen) && Number(card.monthlySpentFen) >= 0 && typeof card.onlinePaymentsEnabled === 'boolean' && Array.isArray(card.blockedCategories) && (card.alertThresholdFen === null || nonnegative(card.alertThresholdFen)) && (card.balanceReminderAmountFen === null || nonnegative(card.balanceReminderAmountFen)) && (card.balanceReminderPercent === null || Number.isSafeInteger(card.balanceReminderPercent) && Number(card.balanceReminderPercent) >= 1 && Number(card.balanceReminderPercent) <= 100) && !(card.balanceReminderAmountFen !== null && card.balanceReminderPercent !== null) && Number.isSafeInteger(card.version) && cardEvidenceValid && (data.action !== 'card.security_review' || (data.data?.execution_allowed === false && data.data?.requires_explicit_user_request_to_freeze === true && Array.isArray(data.data?.guidance)))) ||
    (payload.code === 'OK' && data.status === 'wealth_result' && data.action?.startsWith('wealth.') && typeof data.data?.kind === 'string' && data.data?.synthetic_demo_only === true && typeof data.data?.as_of === 'string' && typeof data.data?.context_snapshot_id === 'string' && Array.isArray(data.data?.evidence) && validScreening) ||
    (payload.code === 'OK' && data.status === 'awaiting_confirmation' && ['wealth.subscribe', 'wealth.redeem'].includes(data.action || '') && typeof data.operationId === 'string' && typeof cardPreview?.previewHash === 'string' && /^[a-f0-9]{64}$/.test(cardPreview.previewHash) && Array.isArray(cardPreview.stepIds) && cardPreview.stepIds.length === 1 && cardEffect?.kind === 'wealth_change' && cardEffect.action === data.action && Number.isSafeInteger(cardEffect.amountFen) && data.risk?.allowed === true && data.risk?.riskLevel === 'L3' && Array.isArray(data.evidence)) ||
    (payload.code === 'OK' && data.status === 'subscription_result' && data.action === 'subscription.list' && listEvidence && enhancedSubscriptionValid && Array.isArray(subscriptions) && subscriptions.every(s => s && typeof s.id === 'string' && typeof s.name === 'string' && nonnegative(s.monthlyFeeFen) && ['active', 'cancelled'].includes(s.status) && typeof s.lastUsedDate === 'string' && typeof s.isPotentiallyUnused === 'boolean' && (s.unusedReason === undefined || typeof s.unusedReason === 'string') && (s.inactivityDays === undefined || nonnegative(s.inactivityDays)) && s.recognition && ['high', 'medium', 'not_flagged'].includes(s.recognition.confidence) && Array.isArray(s.recognition.signals) && s.recognition.signals.length === 3 && s.recognition.signals.every((signal: unknown) => typeof signal === 'string'))) ||
    (payload.code === 'OK' && data.status === 'product_result' && data.action === 'product.list' && listEvidence && Array.isArray(products) && products.every(p => p && typeof p.id === 'string' && typeof p.name === 'string' && ['R1', 'R2', 'R3'].includes(p.riskLevel) && nonnegative(p.expectedYield) && nonnegative(p.minimumAmountFen) && nonnegative(p.durationDays) && ['T+0', 'T+1', 'AT_MATURITY'].includes(p.liquidity) && p.currency === 'CNY' && p.isSynthetic === true)) ||
    (payload.code === 'OK' && ['wealth_recommendation', 'wealth_comparison'].includes(data.status) && ['wealth.recommend', 'wealth.compare'].includes(data.action || '') && Array.isArray(wealthProducts) && wealthProducts.every(p => typeof p.product_ref === 'string' && typeof p.name === 'string' && ['R1', 'R2', 'R3'].includes(String(p.risk_level)) && nonnegative(p.expected_yield_bps) && nonnegative(p.minimum_amount_minor) && nonnegative(p.duration_days) && ['T+0', 'T+1', 'AT_MATURITY'].includes(String(p.liquidity)) && p.currency === 'CNY') && Array.isArray(data.evidence)) ||
    (payload.code === 'OK' && data.status === 'risk_assessment_required' && data.action === 'wealth.assess_risk' && data.data?.status === 'requires_user_questionnaire' && data.data?.model_may_answer_for_user === false) ||
    (payload.code === 'OK' && data.status === 'goal_plan' && data.action === 'orchestrator.goal' && data.data?.execution_allowed === false && Array.isArray(data.data?.steps) && Array.isArray(data.evidence) && (verifiedSavings || (data.data?.verification_status === undefined && data.data?.targetAmountFen == null && data.data?.deadline == null))) ||
    (payload.code === 'OK' && data.status === 'scenario_rule_preview' && scenarioAction && data.data?.requires_confirmation === true && typeof data.operationId === 'string' && typeof data.continuationToken === 'string' && typeof scenarioPreview?.previewHash === 'string' && /^[a-f0-9]{64}$/.test(scenarioPreview.previewHash) && Array.isArray(scenarioPreview.stepIds) && scenarioPreview.stepIds.length === 1 && scenarioEffect?.kind === 'scenario_rule_change' && scenarioEffect.action === data.action && typeof scenarioEffect.ruleId === 'string' && scenarioAfter?.id === scenarioEffect.ruleId && scenarioRule?.id === scenarioEffect.ruleId && data.risk?.allowed === true) ||
    (payload.code === 'OK' && data.status === 'scenario_rule' && scenarioAction && typeof data.operationId === 'string' && typeof scenarioRule?.id === 'string' && scenarioReceipt?.status === 'succeeded' && scenarioReceipt.action === data.action && scenarioReceiptEffect?.kind === 'scenario_rule_change' && scenarioReceiptEffect.action === data.action && scenarioReceiptAfter?.id === scenarioRule.id) ||
    (payload.code === 'OK' && data.status === 'scenario_event_review' && data.action === 'scenario.review_event' && data.data?.inherited_confirmation === false) ||
    (payload.code === 'OK' && data.status === 'awaiting_confirmation' && ['card.set_budget', 'card.set_controls', 'card.freeze', 'card.unfreeze'].includes(data.action || '') && typeof data.operationId === 'string' && typeof cardPreview?.previewHash === 'string' && /^[a-f0-9]{64}$/.test(cardPreview.previewHash) && Array.isArray(cardPreview?.stepIds) && cardPreview.stepIds.length === 1 && cardEffect?.kind === 'card_change' && cardEffect.action === data.action && typeof cardEffect.cardId === 'string' && typeof cardEffect.cardName === 'string' && Number.isSafeInteger(cardEffect.cardVersion) && Number.isSafeInteger(cardEffect.previewGeneration) && ['active', 'frozen'].includes(String(before?.status)) && Number.isSafeInteger(before?.monthlyBudgetFen) && Number(before?.monthlyBudgetFen) >= 0 && typeof before?.onlinePaymentsEnabled === 'boolean' && Array.isArray(before?.blockedCategories) && (before?.alertThresholdFen === null || nonnegative(before?.alertThresholdFen)) && (before?.balanceReminderAmountFen === null || nonnegative(before?.balanceReminderAmountFen)) && (before?.balanceReminderPercent === null || Number.isSafeInteger(before?.balanceReminderPercent) && Number(before?.balanceReminderPercent) >= 1 && Number(before?.balanceReminderPercent) <= 100) && !(before?.balanceReminderAmountFen !== null && before?.balanceReminderPercent !== null) && ['active', 'frozen'].includes(String(after?.status)) && Number.isSafeInteger(after?.monthlyBudgetFen) && Number(after?.monthlyBudgetFen) >= 0 && typeof after?.onlinePaymentsEnabled === 'boolean' && Array.isArray(after?.blockedCategories) && (after?.alertThresholdFen === null || nonnegative(after?.alertThresholdFen)) && (after?.balanceReminderAmountFen === null || nonnegative(after?.balanceReminderAmountFen)) && (after?.balanceReminderPercent === null || Number.isSafeInteger(after?.balanceReminderPercent) && Number(after?.balanceReminderPercent) >= 1 && Number(after?.balanceReminderPercent) <= 100) && !(after?.balanceReminderAmountFen !== null && after?.balanceReminderPercent !== null) && data.risk?.allowed === true && cardEvidenceValid) ||
    (payload.code === 'OK' && data.status === 'awaiting_confirmation' && data.action === 'transfer.create' && typeof data.operationId === 'string' && typeof data.continuationToken === 'string' && typeof data.preview?.previewHash === 'string' && /^[a-f0-9]{64}$/.test(data.preview.previewHash) && typeof data.preview?.summary === 'string' && Array.isArray(data.preview?.exactEffects) && data.preview.exactEffects.length === 1 && data.risk?.allowed === true && (coreTransferEffect?.kind === 'transfer_out' || internalCoreTransferValid)) ||
    (payload.code === 'OK' && data.status === 'internal_transfer_recognized' && data.action === 'transfer.create' && data.previewOnly === true && data.executionAllowed === false && internalTransferValid)
  );
  if (!valid) return invalid({ reason: 'INVALID_REPLY_ENVELOPE', path: 'data.status' }, 'envelope');
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
    throw new ApiError('BANKING_AGENT_NETWORK_ERROR', '执行结果待核实，请保留原操作编号查询。', true);
  }
  let payload: { code?: string; message?: string; requestId?: string; data?: unknown };
  try { payload = await response.json(); } catch { throw new ApiError('BANKING_AGENT_RESPONSE_ERROR', '执行桥返回格式异常，请查询原操作。', true); }
  if (response.status === 401) throw new ApiError('UNAUTHORIZED', '访问验证失败，请检查演示访问码后重试。');
  if (response.status === 503 && ['ACCESS_NOT_CONFIGURED', 'DATABASE_NOT_CONFIGURED'].includes(payload?.code || '')) throw new ApiError('SERVICE_UNAVAILABLE', '执行服务未配置，请联系演示维护者。');
  if (!payload || !response.ok || payload.code !== 'OK') {
    const safeRejection = !response.ok && response.status < 500 && ['VALIDATION_ERROR', 'FORBIDDEN', 'CONFIRMATION_REQUIRED', 'CONFIRMATION_INVALID', 'INVALID_STATE', 'PREVIEW_EXPIRED', 'PREVIEW_STALE', 'INSUFFICIENT_BALANCE', 'LIMIT_EXCEEDED'].includes(payload?.code || '');
    throw new ApiError(String(payload?.code || 'EXECUTE_TRIAL_ERROR'), payload?.message || '试点转账执行失败', !safeRejection);
  }
  const receipt = payload.data;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
    typeof (receipt as ActionReceipt).operationId !== 'string' ||
    !['succeeded', 'failed', 'cancelled'].includes(String((receipt as ActionReceipt).status)) ||
    !Array.isArray((receipt as ActionReceipt).effects)) throw new ApiError('BANKING_AGENT_RESPONSE_ERROR', '执行桥回执格式异常。', true);
  return receipt as ActionReceipt;
}

export type TrialVerificationStart = { challengeId: string; expiresAt: string; remainingAttempts: number; deliveryHint: string };

/** 经服务端「执行桥」为高风险试点转账发起 OTP 挑战。验证码走受控测试渠道，响应不含验证码。 */
export async function startTrialVerification(
  trialOperationId: string,
  previewHash: string,
  accessCode: string,
  signal: AbortSignal,
): Promise<TrialVerificationStart> {
  let response: Response;
  try {
    response = await fetch('/api/execute-trial', {
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      headers: { 'Content-Type': 'application/json', 'X-Saveflow-Access': accessCode },
      body: JSON.stringify({ action: 'verification.start', trialOperationId, previewHash }),
    });
  } catch {
    throw new ApiError('BANKING_AGENT_NETWORK_ERROR', '验证服务连接失败，请稍后重试。');
  }
  let payload: { code?: string; message?: string; requestId?: string; data?: unknown };
  try { payload = await response.json(); } catch { throw new ApiError('BANKING_AGENT_RESPONSE_ERROR', '验证服务返回格式异常。'); }
  if (response.status === 401) throw new ApiError('UNAUTHORIZED', '访问验证失败，请检查演示访问码后重试。');
  if (!payload || !response.ok || payload.code !== 'OK') throw new ApiError(String(payload?.code || 'VERIFICATION_START_ERROR'), payload?.message || '验证码发起失败');
  const data = payload.data as Record<string, unknown> | undefined;
  if (!data || typeof data.challengeId !== 'string' || typeof data.expiresAt !== 'string') throw new ApiError('BANKING_AGENT_RESPONSE_ERROR', '验证挑战格式异常。');
  return { challengeId: data.challengeId, expiresAt: data.expiresAt, remainingAttempts: Number(data.remainingAttempts) || 0, deliveryHint: String(data.deliveryHint || '') };
}

/** 经服务端「执行桥」校验 OTP。验证码只在这里发送给执行桥，绝不进入聊天历史或模型上下文。 */
export async function verifyTrialVerification(
  trialOperationId: string,
  previewHash: string,
  challengeId: string,
  code: string,
  accessCode: string,
  signal: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/execute-trial', {
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      headers: { 'Content-Type': 'application/json', 'X-Saveflow-Access': accessCode },
      body: JSON.stringify({ action: 'verification.verify', trialOperationId, previewHash, challengeId, code }),
    });
  } catch {
    throw new ApiError('BANKING_AGENT_NETWORK_ERROR', '验证服务连接失败，请稍后重试。');
  }
  let payload: { code?: string; message?: string; requestId?: string };
  try { payload = await response.json(); } catch { throw new ApiError('BANKING_AGENT_RESPONSE_ERROR', '验证服务返回格式异常。'); }
  if (response.status === 401) throw new ApiError('UNAUTHORIZED', '访问验证失败，请检查演示访问码后重试。');
  if (!payload || !response.ok || payload.code !== 'OK') throw new ApiError(String(payload?.code || 'VERIFICATION_ERROR'), payload?.message || '验证码校验失败');
}

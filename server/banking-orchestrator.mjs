import { dispatchParsedIntent, handleBillSummary, handleCard, handleGoal, handleSubscriptionList, handleTransfer, prepareTransferPreview, transferRepository } from '../src/agent/runtime.mjs';
import { issueContinuationToken, verifyContinuationToken } from '../src/agent/clarification/continuation-token.mjs';
import { resolveChoice } from '../src/agent/clarification/choice-resolver.mjs';
import { buildParsedIntent, mergeSlots } from '../src/agent/clarification/merge-intent.mjs';
import { billClarificationQuestion } from '../src/lib/trueforge-routing.mjs';
import { validateParsedIntent, ParsedIntentValidationError } from '../src/agent/validate-parsed-intent.mjs';
import { dispatchBanking } from '../src/banking-core/dispatch.mjs';
import { createWealthSkill } from '../src/skills/wealth/wealth-skill.mjs';
import { handleWealth } from '../src/agent/handlers/wealth-handler.mjs';
import { createInMemoryScenarioStore, createScenarioSkill } from '../src/skills/scenario/scenario-skill.mjs';
import { agentErrorPolicy } from '../src/lib/agent-error-policy.mjs';
import { calculateSavingsGoal, validatePlanInputs, validateSavedAmount } from '../src/agent/savings-plan.mjs';
import { requestSavingsAdvice, verifySavingsAdvice } from './savings-advisor.mjs';
import { understandingContext } from './understanding-context.mjs';
import { collectSavingsData } from './savings-data.mjs';
import { buildFinancialAnalysisContext } from './financial-analysis-context.mjs';
import { purchaseNeedsReservation, purchaseMissingQuestions } from '../src/lib/purchase-flow.mjs';

const scenarioStores = new Map();
const transferTypeChoices = [
  { optionId: 'transfer-type-internal', label: '本人账户互转', rawValue: 'internal' },
  { optionId: 'transfer-type-external', label: '转给他人', rawValue: 'external' },
];
function scenarioStoreFor(scope) {
  if (!scenarioStores.has(scope)) scenarioStores.set(scope, createInMemoryScenarioStore([{ id: 'event_balance_2026_09_01', type: 'balance_changed', trusted: true, occurred_at: '2026-09-01T00:00:00+08:00', source: 'synthetic_demo_event_bus' }]));
  return scenarioStores.get(scope);
}

function errorData(code, message) {
  return { status: 'error', error: { code, message } };
}

function inputError(code, message, status) {
  return Object.assign(new Error(message), { code, status, userMessage: message });
}

export function statusFor(code) {
  if (code?.startsWith('CONVERSATION_')) return code.endsWith('CAPACITY') || code === 'CONVERSATION_CORE_UNAVAILABLE' ? 503 : 409;
  if (code === 'CONTINUATION_STALE') return 409;
  if (code === 'UNAUTHORIZED') return 401;
  if (code === 'FORBIDDEN') return 403;
  if (code === 'REQUEST_TOO_LARGE') return 413;
  if (code === 'CARD_NOT_FOUND') return 404;
  if (code === 'CARD_AMBIGUOUS' || code === 'INVALID_STATE') return 409;
  if (code === 'LIMIT_EXCEEDED') return 422;
  if (code === 'MODEL_TIMEOUT') return 504;
  if (code === 'MODEL_RATE_LIMIT') return 429;
  if (['MODEL_AUTH_ERROR', 'MODEL_UPSTREAM_ERROR', 'MODEL_UNAVAILABLE', 'SKILL_ERROR', 'ADVICE_REVIEW_FAILED'].includes(code)) return 502;
  if (['ACCESS_NOT_CONFIGURED', 'MODEL_NOT_CONFIGURED', 'MODEL_CONFIG_ERROR', 'CONTINUATION_CONFIG_ERROR'].includes(code)) return 503;
  return 400;
}

const clarificationQuestions = {
  amount: '要转多少钱？例如 500 元。',
  source_account_ref: '要从哪个账户转出？',
  target_account_ref: '要转入哪个本人账户？',
  payee_ref: '要转给谁？',
  transfer_type: '这笔转账是转给本人其他账户，还是转给他人？请选择一种方式。',
  card_ref: '请选择要查看或操作的卡片。',
  goal: '你希望这笔理财帮你实现什么？例如：未来 6 个月争取获得一些额外收益、1 年内存下 1 万元、准备应急金，或为旅行和大额购物做准备。请说说金额、用途或时间，知道多少说多少。',
  max_risk_level: '你最多能接受多大的波动？可以只回复 R1、R2、R3，或直接说：① 尽量稳妥（R1）——用波动示例理解，短期可能约亏 0%–2%；② 能接受小幅波动（R2）——阶段亏损可能约 2%–10%；③ 能接受较大波动（R3）——亏损可能超过 10%，极端情况下可能更多。百分比只是帮助理解的演示尺度，不是实际产品的亏损上限。',
  horizon_days: '你计划把这笔钱放多久？请尽量按月回答，例如“3 个月”“半年”或“12 个月”。',
  liquidity_requirement: '这笔钱最快需要什么时候能取出？例如：随时可能要用、可以等到下一个工作日，或在计划结束前都不需要取。',
  product_refs: '请提供至少两个要比较的理财产品名称。',
  assessment_scope: '是否要开始投资适当性风险测评？',
  trigger: '请说明规则在什么事件或日期触发。',
  conditions: '请说明规则生效条件。',
  proposed_steps: '请说明触发后希望获得哪些只读建议。',
  authorization_scope: '当前规则只允许 suggest_only（仅生成建议），请确认。',
  rule_ref: '请提供要修改或停用的规则编号。',
  changes: '请说明要修改的规则内容。',
  event_ref: '请提供要复核的可信事件编号。',
  goal_text: '请说明希望分析或规划的财务目标。',
};

function questionFor(action, slot, message, slots = {}) {
  if (action === 'orchestrator.goal' && slot === 'amount') return '希望存到的准确目标金额是多少？';
  if (action === 'orchestrator.goal' && slot === 'deadline') return '希望在哪一天完成目标？';
  if (slot === 'month' && action === 'bill.summary') return billClarificationQuestion(slots.year ? `${slots.year}年账单` : slots.monthNumber ? `${slots.monthNumber}月账单` : message);
  return slot === 'amount' && action === 'card.set_budget'
    ? '新的月消费预算是多少元？例如 1000 元。'
    : clarificationQuestions[slot] || '请补充必要信息。';
}

function continuationSecret(env) {
  return env.CONTINUATION_TOKEN_SECRET;
}

function tokenError(error) {
  return Object.assign(new Error(error instanceof Error ? error.message : '续接凭据无效'), { code: 'CONTINUATION_INVALID', status: 400 });
}

function issueState({ action, slots, pendingSlot, question, choices = [], selections = {}, operation, recentSource, recentSnapshotId, env, now }) {
  return issueContinuationToken({ action, slots, pendingSlot, question, choices, selections, operation, recentSource, recentSnapshotId }, continuationSecret(env), now(), ['__plan_inputs', '__wealth_screening'].includes(pendingSlot) ? 30 * 60_000 : 5 * 60_000);
}

async function accountChoices(repository) {
  return (await repository.getAccounts()).filter(account => account.status === 'active').map(account => ({
    optionId: `opt_${crypto.randomUUID()}`,
    label: `${account.name}（可用 ¥${(account.availableBalanceFen / 100).toFixed(2)}）`,
    entityId: account.id,
    rawValue: account.name,
  }));
}

function payeeChoices(candidates) {
  return candidates.map(candidate => ({
    optionId: `opt_${crypto.randomUUID()}`,
    label: `${candidate.name}（${candidate.accountNoMasked || '账户信息已脱敏'}）`,
    entityId: candidate.id,
    rawValue: candidate.name,
  }));
}

function cardChoices(cards) {
  return cards.map((card, index) => ({
    optionId: `opt_${crypto.randomUUID()}`,
    label: `${card.name}（卡片 ${index + 1}）`,
    entityId: card.id,
    rawValue: card.name,
  }));
}

function eligibleCards(action, cards) {
  return cards.filter(card => action === 'card.unfreeze' ? card.status === 'frozen' : action === 'card.freeze' ? card.status === 'active' : true);
}

function clarificationResponse(reply, { action, slot, question, choices = [], slots, selections = {}, env, now, message, source }) {
  const token = issueState({ action, slots, pendingSlot: slot, question, choices, selections, env, now });
  return reply(200, 'NEEDS_CLARIFICATION', question, {
    kind: 'clarification', status: 'needs_clarification', action, question, slot, ...(source ? { source } : {}), choices: choices.map(({ optionId, label }) => ({ optionId, label })), continuationToken: token,
    ...(message ? { message } : {}),
  });
}

function nextMissingSlot(intent) {
  const order = intent.action === 'transfer.create'
    ? ['transfer_type', 'source_account_ref', 'target_account_ref', 'payee_ref', 'amount']
    : intent.action.startsWith('card.') ? ['card_ref', 'amount'] : ['month'];
  return order.find(slot => intent.missingSlots?.includes(slot)) || intent.missingSlots?.[0];
}

/** Shared clarification and preview workflow. The only Core capability used is prepare(). */
export async function runBankingConversation(body, {
  core, repository = core.repository, env = process.env, now = Date.now, timezone = 'Asia/Shanghai',
  parseIntent, initialIntent, expectedAction, fetchImpl = fetch, requestId = crypto.randomUUID(), origin = 'user_requested', scenarioHandler, scenarioScope = 'fixed_mock_user', savingsAdvisor = requestSavingsAdvice, conversation, resumeOnly = false,
}) {
  let replyContext = {};
  const reply = (httpStatus, code, message, data) => ({ httpStatus, code, message, data, replyContext });
  const wealthReadHandler = (raw, financialContext) => createWealthSkill(repository)(raw, financialContext ? { financialContext } : {});
  const wealthHandler = async raw => {
    const extended = ['wealth.subscribe', 'wealth.redeem'].includes(raw.action) ||
      (raw.action === 'wealth.recommend' && raw.goal && typeof raw.goal === 'object') ||
      (raw.action === 'wealth.assess_risk' && ['investment', 'portfolio'].includes(raw.assessment_scope));
    if (!extended) {
      if (raw.action === 'wealth.recommend') {
        const financial = await buildFinancialAnalysisContext(repository, { now, timezone });
        return wealthReadHandler(raw, financial);
      }
      return wealthReadHandler(raw);
    }
    const { action, ...slots } = raw;
    return handleWealth({ action, slots }, repository, core.wealthPorts, selections);
  };
  const eventStore = scenarioStoreFor(scenarioScope);
  const scenarioStore = { ...eventStore, getRule: ruleId => core.getScenarioRule(ruleId) };
  const activeScenarioHandler = scenarioHandler ?? createScenarioSkill({ store: scenarioStore, contextProvider: async () => {
    const [context, accounts, subscriptions] = await Promise.all([repository.getContextInfo(), repository.getAccounts(), repository.getSubscriptions()]);
    return { as_of: context.asOf, available_balance_minor: accounts.filter(item => item.status === 'active').reduce((sum, item) => sum + item.availableBalanceFen, 0), active_subscription_count: subscriptions.filter(item => item.status === 'active').length };
  } });
  if (typeof continuationSecret(env) !== 'string' || continuationSecret(env).length < 16) {
    throw Object.assign(new Error('续接令牌密钥未配置'), { code: 'CONTINUATION_CONFIG_ERROR', status: 503 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw inputError('INVALID_REQUEST', '请求体必须是对象', 400);
  const allowed = ['message', 'history', 'consent', 'continuationToken', 'choice', 'replyStyle', 'planInputs', 'wealthInputs'];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw inputError('INVALID_REQUEST', '请求包含未注册字段', 400);
  const continuing = body.continuationToken !== undefined;
  if (body.planInputs !== undefined && (!continuing || body.message !== undefined || body.choice !== undefined)) throw inputError('INVALID_REQUEST', '储蓄数据只能随目标续接单独提交', 400);
  if (body.wealthInputs !== undefined && (!continuing || body.message !== undefined || body.choice !== undefined || body.planInputs !== undefined)) throw inputError('INVALID_REQUEST', '理财筛选条件只能随计划续接单独提交', 400);
  if (body.choice !== undefined && (!continuing || body.message !== undefined)) throw inputError('INVALID_REQUEST', 'choice 必须与 continuationToken 一起提交，且不能同时提交 message', 400);
  if (continuing && (typeof body.continuationToken !== 'string' || body.continuationToken.length > 10000)) throw inputError('CONTINUATION_INVALID', '续接凭据无效', 400);
  if (!continuing && !initialIntent && (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 2000)) throw inputError('INVALID_REQUEST', 'message 必须是 1-2000 字符的文本', 400);
  if (continuing && body.message !== undefined && (typeof body.message !== 'string' || body.message.length > 2000)) throw inputError('INVALID_REQUEST', 'message 格式无效', 400);
  if (continuing && !resumeOnly && body.message === undefined && body.planInputs === undefined && body.wealthInputs === undefined && (!body.choice || typeof body.choice !== 'object')) throw inputError('INVALID_REQUEST', '续接请求需要 message、choice、planInputs 或 wealthInputs', 400);
  if (body.choice !== undefined && (!body.choice || typeof body.choice !== 'object' || Array.isArray(body.choice) || typeof body.choice.optionId !== 'string' || !body.choice.optionId.trim() || Object.keys(body.choice).some(key => key !== 'optionId'))) throw inputError('INVALID_REQUEST', 'choice 只能包含非空 optionId', 400);
  if (body.consent !== undefined && body.consent !== true) throw inputError('INVALID_REQUEST', 'consent 必须明确为 true', 400);
  const history = body.history ?? [];
  if (!Array.isArray(history) || history.length > 12 || history.some(item => !item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 2000)) throw inputError('INVALID_REQUEST', 'history 格式无效', 400);

  const financialContext = typeof repository.getContextInfo === 'function' ? await repository.getContextInfo() : undefined;
  const modelOptions = { env, fetchImpl, requestId, now, timezone, financialContext };
  let parsed;
  let selections = {};
  let continuation;
  // Renew only authenticated drafts. Frontend labels/IDs are never accepted here.
  const recover = async (state, code, message, slot = state?.pendingSlot) => {
    if (!state || !slot || slot.startsWith('__') || state.operation) return undefined;
    const slots = { ...state.slots };
    delete slots[slot];
    const selected = { ...(state.selections ?? {}) }; delete selected[slot];
    let choices = [];
    if (slot === 'card_ref') {
      const cards = await repository.getCards();
      choices = cardChoices(eligibleCards(state.action, cards));
    } else if (slot === 'source_account_ref' || slot === 'target_account_ref') choices = await accountChoices(repository);
    else if (slot === 'payee_ref') choices = payeeChoices((await repository.getPayees()).filter(payee => payee.status === 'active'));
    else if (slot === 'transfer_type') choices = transferTypeChoices;
    if (['card_ref', 'source_account_ref', 'payee_ref', 'transfer_type'].includes(slot) && !choices.length) return undefined;
    const question = `${message} ${questionFor(state.action, slot, '', slots)}`;
    return clarificationResponse(reply, { action: state.action, slot, question, choices, slots, selections: selected, env, now, source: 'resolver' }).data;
  };
  const failure = async (code, message, state, slot) => {
    const recovery = await recover(state, code, message, slot);
    return reply(statusFor(code), code, message, { status: 'error', action: state?.action,
      error: { code, message }, ...(recovery ? { recovery } : {}) });
  };
  try {
  if (continuing) {
    try { continuation = verifyContinuationToken(body.continuationToken, continuationSecret(env), now()); }
    catch (error) { throw tokenError(error); }
    if (continuation.conversation && !conversation) throw Object.assign(new Error('HTTP task credential cannot cross adapters'), { code: 'CONTINUATION_ACTION_MISMATCH', status: 400 });
    replyContext = { slots: continuation.slots };
    if (continuation.pendingSlot !== '__scenario_confirmation' && body.message && /^(?:确认|确认转账|确认执行|执行|同意)[。！!]?\s*$/.test(body.message.trim())) throw inputError('CONFIRMATION_REQUIRED', '聊天文字不能确认执行，请在页面核对预览并完成所需确认与验证。', 403);
    if (continuation.pendingSlot !== '__scenario_confirmation' && body.message && /^(?:取消|取消(?:本次)?(?:转账|操作)|不用了)[。！!]?\s*$/.test(body.message.trim())) {
      if (conversation?.taskControl) {
        const controlled = await conversation.taskControl({ kind: 'task_control', control: { command: 'undo', target: 'current' } });
        if (controlled.status === 'cancelled') return reply(200, 'OK', '本次转账已取消，未执行资金操作。', { status: 'cancelled', action: continuation.action });
        if (controlled.status === 'blocked') return reply(409, 'CONVERSATION_OPERATION_LOCKED', '这笔转账正在核实中，暂时不能撤回。为避免重复扣款，请先查询转账结果。', { status: 'operation_status_unknown', action: continuation.action, nextAction: 'query_status' });
        if (controlled.status === 'already_succeeded') return reply(409, 'CONVERSATION_TASK_FINISHED', '这笔转账已经完成，不能通过聊天撤回。', { status: 'completed', action: continuation.action, nextAction: 'query_status' });
        if (controlled.status === 'needs_clarification') return reply(200, 'NEEDS_CLARIFICATION', '请说明要取消哪一笔尚未完成的业务。', { status: 'needs_clarification', action: continuation.action });
        return reply(409, 'CONVERSATION_TASK_FINISHED', '这笔转账已结束，无法重复取消。', { status: 'ended', action: continuation.action });
      }
      return reply(200, 'OK', '本次会话已取消，未执行资金或卡片操作。', { status: 'cancelled', action: continuation.action });
    }
    if (expectedAction && continuation.action !== expectedAction) throw Object.assign(new Error('续接凭据与当前工具动作不一致'), { code: 'CONTINUATION_ACTION_MISMATCH', status: 400 });
    if (body.planInputs !== undefined) {
      if (continuation.action !== 'orchestrator.goal' || continuation.pendingSlot !== '__plan_inputs' || !continuation.slots.amount || !continuation.slots.deadline) throw inputError('CONTINUATION_INVALID', '储蓄数据与当前目标不匹配', 400);
      const currentDate = understandingContext({ now, timezone }).currentDate;
      const financial = await collectSavingsData(repository, currentDate);
      if (continuation.recentSource !== financial.recentSource ||
        continuation.recentSnapshotId !== (financial.context.snapshotId || financial.context.asOf || '')) throw inputError('SOURCE_CHANGED', '账单数据已更新，请重新发起目标请求。', 409);
      if (!financial.categories.length) throw inputError('CAPABILITY_UNAVAILABLE', '没有可用的分类账单数据', 503);
      const normalized = financial.recent
        ? { savedAmountMinor: validateSavedAmount(body.planInputs), incomeMinor: financial.recent.income_minor, categoryExpensesMinor: financial.recent.category_expenses_minor }
        : validatePlanInputs(body.planInputs, { currentDate, categories: financial.categories });
      const calculation = calculateSavingsGoal({ targetAmountMinor: continuation.slots.amount.amount_minor, deadline: continuation.slots.deadline, ...normalized, currentDate });
      const recent = financial.recent || { month: normalized.month, income_minor: normalized.incomeMinor, category_expenses_minor: normalized.categoryExpensesMinor };
      const facts = { recent, history: financial.history, sources: financial.sources, required_monthly_minor: calculation.required_monthly_minor };
      const candidate = await savingsAdvisor(facts, { env, fetchImpl });
      const advice = verifySavingsAdvice(candidate, facts);
      const generic = await handleGoal({ slots: continuation.slots }, repository);
      const wealthHandoffToken = core.wealthPorts ? issueState({ action: 'wealth.recommend', slots: { goal: { kind: 'steady_growth', target_date: calculation.deadline } }, pendingSlot: '__wealth_screening', env, now }) : undefined;
      return reply(200, 'OK', '储蓄计划已核算', { status: 'goal_plan', action: 'orchestrator.goal', data: {
        ...generic.data, verification_status: 'verified', recent_month: recent.month, recent, recent_source: financial.recentSource,
        calculation, advice, execution_allowed: false,
      }, ...(wealthHandoffToken ? { wealthHandoffToken } : {}), evidence: [...generic.evidence, { source: financial.recentSource === 'repository' ? financial.context.dataSource : 'user_provided', asOf: financial.sources.recent_as_of, entityIds: [] }] });
    }
    if (body.wealthInputs !== undefined) {
      if (continuation.action !== 'wealth.recommend' || continuation.pendingSlot !== '__wealth_screening' || continuation.slots.goal?.kind !== 'steady_growth' || typeof continuation.slots.goal.target_date !== 'string') throw inputError('CONTINUATION_INVALID', '理财筛选与已核验计划不匹配', 400);
      const inputs = body.wealthInputs;
      if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || Object.keys(inputs).sort().join(',') !== 'investable_amount_minor,liquidity_requirement,max_risk_level' || !['R1', 'R2', 'R3'].includes(inputs.max_risk_level) || !Number.isSafeInteger(inputs.investable_amount_minor) || inputs.investable_amount_minor < 1 || inputs.investable_amount_minor > 1_000_000_000 || !['T+0', 'T+1', 'AT_MATURITY'].includes(inputs.liquidity_requirement)) throw inputError('WEALTH_INPUT_INVALID', '请填写有效的独立可投资金额、风险上限和取用要求。', 400);
      const goal = { ...continuation.slots.goal, max_risk_level: inputs.max_risk_level };
      const constraints = { investable_amount: { amount_minor: inputs.investable_amount_minor, currency: 'CNY' }, ...(inputs.liquidity_requirement === 'AT_MATURITY' ? {} : { max_settlement_days: inputs.liquidity_requirement === 'T+0' ? 0 : 1 }) };
      const result = await wealthHandler({ action: 'wealth.recommend', goal, constraints });
      if (!result.ok) return reply(statusFor(result.error?.code), result.error?.code || 'SKILL_ERROR', result.error?.message || '理财筛选失败', { status: 'wealth_error', action: 'wealth.recommend', error: result.error });
      return reply(200, 'OK', result.data.kind === 'questionnaire_required' ? '请先完成风险测评' : '按已核验目标完成只读理财筛选', { status: 'wealth_result', action: 'wealth.recommend', data: result.data.kind === 'recommendation' ? { ...result.data, screening_context: { target_date: goal.target_date, investable_amount_minor: inputs.investable_amount_minor, max_risk_level: inputs.max_risk_level, liquidity_requirement: inputs.liquidity_requirement, source: 'verified_savings_plan' } } : result.data, evidence: result.data.evidence });
    }
    if (resumeOnly && continuation.pendingSlot === '__wealth_screening') {
      if (continuation.action !== 'wealth.recommend' || continuation.slots.goal?.kind !== 'steady_growth' || typeof continuation.slots.goal.target_date !== 'string') throw inputError('CONTINUATION_INVALID', '理财筛选与已核验计划不匹配', 400);
      return reply(200, 'OK', '请重新填写独立可投资金额、风险上限和取用要求，再进行只读筛选。', { status: 'needs_wealth_inputs', action: 'wealth.recommend', continuationToken: body.continuationToken, data: { target_date: continuation.slots.goal.target_date, execution_allowed: false } });
    }
    if (continuation.pendingSlot === '__wealth_screening') throw inputError('WEALTH_INPUT_REQUIRED', '请在理财筛选表单中填写独立可投资金额、风险上限和取用要求。', 400);
    if (continuation.pendingSlot === '__scenario_confirmation') {
      if (!continuation.operation) throw inputError('CONTINUATION_INVALID', '规则操作续接信息无效', 400);
      const answer = String(body.message || '').trim();
      if (/^(?:取消|拒绝|不确认|算了)[。！]?$/.test(answer)) {
        const decision = await core.decide(continuation.operation.operationId, { previewHash: continuation.operation.previewHash, decision: 'reject', confirmedStepIds: [] });
        if (!decision.ok) return reply(statusFor(decision.error.code), decision.error.code, decision.error.message, { status: 'core_error', action: continuation.action, operationId: continuation.operation.operationId, error: decision.error });
        return reply(200, 'OK', '已取消规则变更，未保存任何修改', { status: 'cancelled', action: continuation.action, operationId: continuation.operation.operationId });
      }
      if (/^(?:确认|确认保存|同意|保存规则)[。！]?$/.test(answer)) throw inputError('CONFIRMATION_REQUIRED', '聊天文字不能确认执行。请在原规则预览中查询状态、核对明细，并使用页面确认按钮。', 403);
    }
    if (resumeOnly) {
      parsed = buildParsedIntent(continuation.action, continuation.slots);
      selections = { ...continuation.selections };
    } else if (body.message) {
      parsed = validateParsedIntent(await parseIntent(body.message, { ...modelOptions, history,
        context: { action: continuation.action, slots: continuation.slots, pendingSlot: continuation.pendingSlot, question: continuation.question,
          choices: continuation.choices.map(({ optionId, label, rawValue }) => ({ optionId, label, rawValue })) } }));
      if (['clarify', 'unsupported'].includes(parsed.action)) {
        const code = continuation.pendingSlot === 'amount' ? 'INVALID_AMOUNT' : 'INVALID_CHOICE';
        const message = parsed.action === 'unsupported' ? '暂不支持本次输入，之前的业务仍可继续，请重新选择或补充信息。' : '当前输入未能补全这一步，请重新选择或补充信息。';
        const recovery = await recover(continuation, code, message);
        if (recovery) return reply(200, 'NEEDS_CLARIFICATION', recovery.question, { ...recovery, error: { code, message, ...agentErrorPolicy(code, { hasRecovery: true, hasChoices: !!recovery.choices.length }) } });
        return failure(code, message, continuation);
      }
      // A signed continuation is the authoritative draft. Preserve its unchanged
      // transfer slots when a model returns only the newly supplied value.
      // Never preserve the slot currently being answered (especially amount),
      // so an omitted/invalid replacement cannot silently reuse stale input.
      if (parsed.action === 'transfer.create' && continuation.action === 'transfer.create') {
        const parsedChoice = parsed.choice;
        const slots = { ...continuation.slots };
        delete slots[continuation.pendingSlot];
        Object.assign(slots, parsed.slots);
        const answer = body.message.trim();
        if (/^(?:重新选择|改选|更换)(?:付款)?账户[。！]?$/u.test(answer)) delete slots.source_account_ref;
        if (/^(?:重新选择|改选|更换)收款人[。！]?$/u.test(answer)) {
          delete slots.payee_ref;
          delete slots.target_account_ref;
          slots.transfer_type = 'external';
        }
        if (slots.transfer_type === 'internal') delete slots.payee_ref;
        if (slots.transfer_type === 'external') delete slots.target_account_ref;
        if ('payee_ref' in parsed.slots) {
          delete slots.target_account_ref;
          slots.transfer_type = 'external';
        }
        if ('target_account_ref' in parsed.slots) {
          delete slots.payee_ref;
          slots.transfer_type = 'internal';
        }
        parsed = buildParsedIntent('transfer.create', slots);
        if (parsedChoice) parsed.choice = parsedChoice;
      }
      // A model cannot convert an opaque candidate selection into entity IDs.
      // Keep server selections only while their raw references remain unchanged.
      if (parsed.action === continuation.action) {
        selections = { ...continuation.selections };
        for (const key of Object.keys(selections)) if (parsed.slots[key] !== continuation.slots[key]) delete selections[key];
      }
      if (parsed.choice) {
        const selected = resolveChoice(parsed.choice, continuation.choices);
        if (!selected || parsed.action !== continuation.action || (!continuation.pendingSlot.endsWith('_ref') && continuation.pendingSlot !== 'transfer_type') || parsed.slots[continuation.pendingSlot] !== (selected.rawValue || selected.label)) throw inputError('INVALID_CHOICE', '选项不存在或已失效', 400);
        if (continuation.pendingSlot !== 'transfer_type') selections[continuation.pendingSlot] = { entityId: selected.entityId, optionId: selected.optionId };
      }
    } else {
      const selected = resolveChoice(body.choice, continuation.choices);
      if (!selected) return failure('INVALID_CHOICE', '选项不存在或已失效，请重新选择。', continuation);
      selections = { ...continuation.selections };
      if (continuation.pendingSlot !== 'transfer_type') selections[continuation.pendingSlot] = { entityId: selected.entityId, optionId: selected.optionId };
      parsed = buildParsedIntent(continuation.action, mergeSlots(continuation.slots, { [continuation.pendingSlot]: selected.rawValue || selected.label }));
    }
  } else {
    parsed = initialIntent ?? await parseIntent(body.message, { ...modelOptions, history });
  }
  // Apply exactly the same boundary to all configured/injected understanders.
  parsed = validateParsedIntent(parsed);
  if (conversation) {
    parsed = await conversation.acceptIntent(parsed, modelOptions);
    if (continuation && parsed.action !== continuation.action) selections = {};
  }
  replyContext = { slots: parsed.slots };
  if (expectedAction && parsed.action !== expectedAction) throw Object.assign(new Error('工具动作不一致'), { code: 'CONTINUATION_ACTION_MISMATCH', status: 400 });
  if (!continuing && parsed.choice) throw inputError('INVALID_CHOICE', '当前请求没有可选择的候选项', 400);
  if (parsed.action === 'scenario.plan_purchase') {
    const purchaseSlots = parsed.slots ?? {};
    const needsReservation = purchaseNeedsReservation(purchaseSlots);
    const missing = needsReservation ? purchaseMissingQuestions(purchaseSlots) : [];
    const purchaseMessage = !needsReservation
      ? '已生成平台搜索链接。按现在就买处理，不预留预算、不设置提醒。'
      : missing.length
        ? '已生成平台搜索链接。你提到了未来时间，需要预留预算与提醒；还差几项信息，见下方卡片。'
        : '已生成平台搜索链接。预算与提醒信息已齐，请在下方卡片核对并确认预留。';
    return reply(200, 'OK', purchaseMessage, {
      status: 'purchase_request', action: parsed.action, data: { slots: parsed.slots, synthetic_demo_only: true },
    });
  }
  if (parsed.action === 'orchestrator.goal' && (parsed.slots.amount || parsed.slots.deadline)) {
    for (const slot of ['amount', 'deadline']) if (!parsed.slots[slot]) return clarificationResponse(reply, { action: parsed.action, slot, question: questionFor(parsed.action, slot, body.message, parsed.slots), slots: parsed.slots, env, now });
    const currentDate = understandingContext({ now, timezone }).currentDate;
    const nextFullMonthStart = new Date(Date.UTC(Number(currentDate.slice(0, 4)), Number(currentDate.slice(5, 7)), 1)).toISOString().slice(0, 10);
    if (parsed.slots.deadline < nextFullMonthStart) throw inputError('DEADLINE_TOO_SOON', '截止日前没有可安排的完整月，请延长目标期限。', 400);
    const financial = await collectSavingsData(repository, currentDate);
    if (!financial.categories.length) throw inputError('CAPABILITY_UNAVAILABLE', '没有可用的分类账单数据', 503);
    const continuationToken = issueState({ action: parsed.action, slots: parsed.slots, pendingSlot: '__plan_inputs', recentSource: financial.recentSource, recentSnapshotId: financial.context.snapshotId || financial.context.asOf || '', env, now });
    return reply(200, 'NEEDS_PLAN_INPUTS', financial.recent ? '请补充本目标已存金额' : '请补充近期分类收支和本目标已存金额', { status: 'needs_plan_inputs', action: parsed.action, goal: { target_amount_minor: parsed.slots.amount.amount_minor, deadline: parsed.slots.deadline }, requiredMonth: financial.requiredMonth, categories: financial.categories, recentSource: financial.recentSource, ...(financial.recent ? { recent: financial.recent } : {}), continuationToken });
  }
  if (parsed.action === 'subscription.list') {
    const result = await handleSubscriptionList(parsed, repository);
    return reply(200, 'OK', '订阅分析已生成。', { status: 'subscription_result', action: result.action, data: result.data, evidence: result.evidence });
  }
  if (parsed.action === 'product.list') {
    const result = await dispatchBanking(parsed.action, {}, { repository });
    if (!result.ok) return reply(502, 'SKILL_ERROR', '只读查询失败，请稍后重试。', errorData('SKILL_ERROR', '只读查询失败，请稍后重试。'));
    const context = await repository.getContextInfo();
    return reply(200, 'OK', '只读查询完成。', { status: 'product_result', action: parsed.action,
      data: { products: result.data, context },
      evidence: [{ source: context.dataSource, asOf: context.asOf, entityIds: result.data.map(item => item.id) }] });
  }
  const dependencies = {
    billHandler: intent => handleBillSummary(intent, repository),
    transferHandler: intent => handleTransfer(intent, transferRepository(repository, selections)),
    cardHandler: intent => handleCard(intent, repository, selections),
    wealthHandler,
    scenarioHandler: activeScenarioHandler,
    goalHandler: intent => handleGoal(intent, repository),
    subscriptionHandler: intent => handleSubscriptionList(intent, repository),
  };
  const dispatched = await dispatchParsedIntent(parsed, dependencies);
  const prepareTransfer = typeof core.prepare === 'function'
    ? { prepare: request => core.prepare({ ...request, origin }) }
    : { prepare: async () => ({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Banking Core prepare 未配置', uncertain: true } }) };
  const result = await prepareTransferPreview(dispatched, prepareTransfer);

  if (result.ok && result.kind === 'bill_result') return reply(200, 'OK', '账单统计已生成', { status: 'bill_result', action: result.action, data: result.data, evidence: result.evidence });
  if (result.ok && result.kind === 'subscription_result') return reply(200, 'OK', '订阅分析已生成', { status: 'subscription_result', action: result.action, data: result.data, evidence: result.evidence });
  if (result.ok && result.kind === 'card_result') return reply(200, 'OK', '卡片信息已查询', { status: 'card_result', action: result.action, data: result.data, evidence: result.evidence });
  if (result.ok && ['wealth_recommendation', 'wealth_comparison', 'risk_assessment_required'].includes(result.kind)) return reply(200, 'OK', result.kind === 'wealth_comparison' ? '理财产品对比已生成' : result.kind === 'wealth_recommendation' ? '理财条件筛选已生成' : '需要完成风险测评', { status: result.kind, action: result.action, data: result.kind === 'wealth_comparison' ? { ...result.data, kind: 'comparison' } : result.data, evidence: result.evidence });
  if (result.ok && result.kind === 'wealth_result') return reply(200, 'OK', '模拟理财结果已生成', { status: 'wealth_result', action: result.action, data: result.data, evidence: result.data.evidence });
  if (result.ok && result.kind === 'wealth_action_request') {
    const prepared = await core.prepare(result.data.request);
    if (!prepared.ok) return reply(statusFor(prepared.error.code), prepared.error.code, prepared.error.message, { status: 'core_error', action: result.action, ...(prepared.operationId ? { operationId: prepared.operationId } : {}), error: prepared.error });
    return reply(200, 'OK', '模拟理财正式预览已生成，等待页面单独确认', { status: 'awaiting_confirmation', action: result.action, operationId: prepared.data.operationId, preview: prepared.data.preview, risk: prepared.data.risk, evidence: result.data.evidence });
  }
  if (result.ok && result.kind === 'goal_plan') return reply(200, 'OK', '只读财务规划已生成', { status: 'goal_plan', action: result.action, data: result.data, evidence: result.evidence });
  if (result.ok && result.kind === 'scenario_event_review') return reply(200, 'OK', '可信事件复核已生成', { status: 'scenario_event_review', action: result.action, data: result.data, evidence: result.evidence });
  if (result.ok && result.kind === 'scenario_action_request') {
    const prepared = await core.prepare(result.data.request);
    if (!prepared.ok) return reply(statusFor(prepared.error.code), prepared.error.code, prepared.error.message, { status: 'core_error', action: result.action, ...(prepared.operationId ? { operationId: prepared.operationId } : {}), error: prepared.error });
    const operation = { operationId: prepared.data.operationId, previewHash: prepared.data.preview.previewHash, stepIds: prepared.data.preview.stepIds };
    const continuationToken = issueState({ action: result.action, slots: parsed.slots, pendingSlot: '__scenario_confirmation', operation, env, now });
    return reply(200, 'OK', '规则变更正式预览已生成，尚未保存', { status: 'scenario_rule_preview', action: result.action, operationId: prepared.data.operationId, preview: prepared.data.preview, risk: prepared.data.risk, data: { change: result.data.change, rule: prepared.data.preview.exactEffects[0]?.after, requires_confirmation: true }, continuationToken });
  }
  if (result.ok && result.kind === 'card_action_request') {
    const prepared = await core.prepare(result.data.request);
    if (!prepared.ok) {
      if (!prepared.error.uncertain && ['business_conflict', 'invalid_choice', 'invalid_input'].includes(agentErrorPolicy(prepared.error.code).category)) return failure(prepared.error.code, prepared.error.message, { action: result.action, slots: parsed.slots, selections }, result.action === 'card.set_budget' ? 'amount' : 'card_ref');
      return reply(statusFor(prepared.error.code), prepared.error.code, prepared.error.message, { status: 'core_error', action: result.action, ...(prepared.operationId ? { operationId: prepared.operationId } : {}), error: prepared.error });
    }
    const continuationToken = issueState({ action: result.action, slots: parsed.slots, pendingSlot: result.action === 'card.set_budget' ? 'amount' : 'card_ref', selections, env, now });
    return reply(200, 'OK', '卡片正式预览已生成，等待页面确认', { status: 'awaiting_confirmation', action: result.action, operationId: prepared.data.operationId, preview: prepared.data.preview, risk: prepared.data.risk, evidence: result.data.evidence, continuationToken });
  }
  if (result.ok && result.kind === 'transfer_preview') {
    const continuationToken = issueState({ action: 'transfer.create', slots: parsed.slots, pendingSlot: 'amount', selections, env, now });
    const settings = await repository.getDemoSettings();
    const currentMonth = (await repository.getContextInfo()).currentMonth;
    const amountMinor = result.data.preview.exactEffects[0]?.amountFen ?? 0;
    const monthExpenseCount = (await repository.getTransactions({ month: currentMonth })).filter(transaction => transaction.type === 'expense' || transaction.type === 'transfer_out').length;
    const context = {
      monthlyIncomeFen: settings.monthlyIncomeFen,
      incomeRatioPercent: settings.monthlyIncomeFen > 0 ? Math.round((amountMinor / settings.monthlyIncomeFen) * 1000) / 10 : 0,
      expenseCountThisMonth: monthExpenseCount + 1,
    };
    return reply(200, 'OK', '转账正式预览已生成，等待用户确认', { status: result.data.state, action: result.action, operationId: result.data.operationId, preview: result.data.preview, risk: result.data.risk, context, continuationToken });
  }
  if (result.kind === 'needs_clarification') {
    replyContext.reason = result.reason;
    const action = result.action || parsed.action;
    const slots = parsed.slots || {};
    const slot = result.slot || nextMissingSlot(parsed) || (result.candidates ? 'payee_ref' : undefined);
    // Re-read even resolver candidates: states/eligibility may have changed since resolution.
    const cards = slot === 'card_ref' ? eligibleCards(action, await repository.getCards()) : [];
    const choices = slot === 'card_ref' ? cardChoices(cards.filter(card => !result.candidates?.length || result.candidates.some(candidate => candidate.id === card.id))) : result.candidates ? payeeChoices(result.candidates) : slot === 'source_account_ref' || slot === 'target_account_ref' ? await accountChoices(repository) : slot === 'payee_ref' && !slots.payee_ref ? payeeChoices((await repository.getPayees()).filter(payee => payee.status === 'active')) : slot === 'transfer_type' ? transferTypeChoices : [];
    return clarificationResponse(reply, {
      action,
      slot,
      question: slot === 'card_ref' && !choices.length ? '当前没有符合条件的卡片。可以输入“查看我的卡”查询卡片状态，或发起其他业务。' : result.question || questionFor(action, slot, body.message, slots),
      choices,
      slots,
      selections,
      env, now,
      source: result.source,
    });
  }
  if (result.kind === 'unsupported') return reply(200, 'UNSUPPORTED', '暂不支持该请求', { status: result.kind });
  if (result.kind === 'skill_error') return reply(502, 'SKILL_ERROR', 'Skill 处理失败，请稍后重试。', errorData('SKILL_ERROR', 'Skill 处理失败，请稍后重试。'));
  if (result.kind === 'card_error' || (result.kind === 'core_error' && result.action?.startsWith('card.'))) {
    let message = result.error.message;
    if (!result.error.uncertain && ['business_conflict', 'invalid_choice', 'invalid_input'].includes(agentErrorPolicy(result.error.code).category)) {
      const card = result.cardId ? await repository.getCard(result.cardId) : (await repository.getCards()).find(card => card.id === selections.card_ref?.entityId || card.name === parsed.slots.card_ref);
      if (card && result.action === 'card.unfreeze' && card.status === 'active') message = `${card.name}当前处于正常使用状态，无需解冻。你可以选择其他已冻结的卡片，或输入“查看我的卡”查询卡片状态。`;
      else if (card && result.action === 'card.freeze' && card.status === 'frozen') message = `${card.name}已经冻结，无需重复冻结。可选择其他正常卡片，或输入“查看我的卡”查询卡片状态。`;
      const slot = result.action === 'card.set_budget' ? 'amount' : 'card_ref';
      const response = await failure(result.error.code, message, { action: result.action, slots: parsed.slots, selections }, slot);
      if (!response.data.recovery) response.message = response.data.error.message = `${message} 当前没有符合条件的其他选项，请修改请求。`;
      return response;
    }
    return reply(statusFor(result.error.code), result.error.code, message, { status: 'card_error', action: result.action, error: result.error });
  }
  if (result.kind === 'wealth_error') return reply(statusFor(result.error.code), result.error.code, result.error.message, { status: 'wealth_error', action: result.action, error: result.error });
  if (result.kind === 'core_error') {
    let recovery;
    let continuationToken;
    if (result.action === 'transfer.create' && result.error.code === 'INSUFFICIENT_BALANCE') {
      const resolved = await transferRepository(repository, selections).queryAccount(parsed.slots.source_account_ref);
      const account = resolved && await repository.getAccount(resolved.id);
      const choices = await accountChoices(repository);
      if (account && Number.isSafeInteger(account.availableBalanceFen) && account.availableBalanceFen >= 0 && choices.length) {
        const question = `${account.name}可用余额为 ¥${(account.availableBalanceFen / 100).toFixed(2)}，不足以转出 ¥${(parsed.slots.amount.amount_minor / 100).toFixed(2)}。请重新选择付款账户，或修改金额；已保留收款人和转账草稿。`;
        continuationToken = issueState({ action: result.action, slots: parsed.slots, pendingSlot: 'source_account_ref', choices, selections, env, now });
        recovery = { kind: 'clarification', status: 'needs_clarification', action: result.action, slot: 'source_account_ref', question,
          choices: choices.map(({ optionId, label }) => ({ optionId, label })) };
      }
    }
    return reply(statusFor(result.error.code), result.error.code, result.error.message, { status: 'core_error', action: result.action,
      ...(result.operationId ? { operationId: result.operationId } : {}), error: result.error,
      ...(recovery ? { recovery, continuationToken } : {}) });
  }
  return reply(500, 'INTERNAL_ERROR', '未取得可靠结果', errorData('INTERNAL_ERROR', '未取得可靠结果'));
  } catch (error) {
    const code = error instanceof ParsedIntentValidationError ? 'MODEL_FORMAT_ERROR' : error?.code;
    // A token for another tool/action is an authorization mismatch, not a bad selection.
    if (code === 'CONTINUATION_ACTION_MISMATCH') throw error;
    const policy = agentErrorPolicy(code);
    if (continuation && ['invalid_input', 'invalid_choice'].includes(policy.category)) {
      if (continuation.choices.length && continuation.pendingSlot?.endsWith('_ref')) return failure('INVALID_CHOICE', '没有找到匹配的选项，请从当前有效列表中重新选择。', continuation);
      return failure(code, policy.category === 'invalid_input' ? '输入格式或数值不符合要求，请修正后继续。' : '没有找到有效选项，请重新选择。', continuation);
    }
    throw error;
  }
}


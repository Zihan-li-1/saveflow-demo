// Shared policy over machine codes only. Unknown errors never authorize a retry.
const groups = {
  invalid_input: ['INVALID_REQUEST', 'VALIDATION_ERROR', 'INVALID_AMOUNT', 'MODEL_FORMAT_ERROR', 'TRUEFORGE_FORMAT_ERROR', 'CONTINUATION_ACTION_MISMATCH'],
  missing_information: ['MISSING_SLOTS'],
  invalid_choice: ['INVALID_CHOICE', 'CARD_NOT_FOUND', 'PAYEE_NOT_FOUND', 'ACCOUNT_NOT_FOUND', 'CARD_AMBIGUOUS'],
  business_conflict: ['INVALID_STATE', 'INSUFFICIENT_BALANCE', 'PREVIEW_STALE', 'PREVIEW_EXPIRED', 'BELOW_MINIMUM_AMOUNT', 'INSUFFICIENT_HOLDING', 'CONVERSATION_OPERATION_LOCKED'],
  restricted: ['FORBIDDEN', 'UNAUTHORIZED', 'ACCOUNT_BLOCKED', 'PAYEE_BLOCKED', 'LIMIT_EXCEEDED', 'SUITABILITY_FAILED', 'REDEMPTION_RESTRICTED', 'CONFIRMATION_REQUIRED', 'CONFIRMATION_INVALID', 'CAPABILITY_UNAVAILABLE', 'PREVIEW_ONLY'],
  session_expired: ['CONTINUATION_INVALID', 'CONTINUATION_STALE', 'CONVERSATION_NOT_FOUND', 'CONVERSATION_EXPIRED', 'CONVERSATION_TASK_NOT_FOUND', 'CONVERSATION_TASK_EXPIRED', 'CONVERSATION_TASK_MISMATCH', 'CONVERSATION_TASK_FINISHED', 'CONVERSATION_ACTION_MISMATCH', 'CONVERSATION_REVISION_CONFLICT'],
  transient: ['BANKING_AGENT_NETWORK_ERROR', 'NETWORK_ERROR', 'TIMEOUT', 'MODEL_TIMEOUT', 'MODEL_RATE_LIMIT', 'MODEL_UPSTREAM_ERROR', 'MODEL_UNAVAILABLE', 'TRUEFORGE_UNAVAILABLE', 'TRUEFORGE_TIMEOUT', 'RATE_LIMIT'],
};

export function validRecoverySlot(action, slot) {
  const slots = {
    'transfer.create': ['amount', 'payee_ref', 'source_account_ref'], 'bill.summary': ['month'],
    'card.get': ['card_ref'], 'card.freeze': ['card_ref'], 'card.unfreeze': ['card_ref'],
    'card.set_budget': ['card_ref', 'amount'], 'card.set_controls': ['card_ref'], 'card.security_review': ['card_ref', 'issue_type'],
    'wealth.recommend': ['goal', 'max_risk_level', 'horizon_days', 'liquidity_requirement'],
    'wealth.compare': ['product_refs'], 'wealth.assess_risk': ['assessment_scope'],
    'orchestrator.goal': ['goal_text', 'amount', 'deadline'],
  };
  return Object.hasOwn(slots, action) && slots[action].includes(slot);
}

export function agentErrorPolicy(code, { hasRecovery = false, hasChoices = hasRecovery, uncertain = false } = {}) {
  const category = Object.entries(groups).find(([, codes]) => codes.includes(code))?.[0] ?? 'internal';
  const nextAction = uncertain ? 'query_status' : hasRecovery ? hasChoices ? 'choose_option' : 'edit_input' :
    category === 'transient' ? 'retry_request' : category === 'session_expired' ? 'restart_flow' :
    ['invalid_input', 'missing_information', 'invalid_choice'].includes(category) ? 'edit_input' :
    category === 'restricted' ? 'contact_support' : 'new_request';
  return { category, retryable: category === 'transient' && !uncertain, nextAction,
    context: category === 'session_expired' || category === 'restricted' || (category === 'business_conflict' && !hasRecovery) ? 'clear' : 'preserve' };
}

export function validAgentErrorPolicy(error, hasRecovery = false, hasChoices = hasRecovery) {
  if (!error || typeof error.code !== 'string') return false;
  const expected = agentErrorPolicy(error.code, { hasRecovery, hasChoices, uncertain: error.uncertain === true });
  return Object.entries(expected).every(([key, value]) => error[key] === value);
}

export function agentErrorHint(policy) {
  return {
    choose_option: '请使用下方新选项继续；修改后仍需重新生成并确认预览。',
    edit_input: '请修改输入或补充信息，也可以直接提出新的完整请求。',
    restart_flow: '本次续接已失效，请重新描述要办理的业务；无需清空聊天记录。',
    retry_request: '可以重试理解或查询请求；不会自动确认或执行金融操作。',
    query_status: '操作结果待核实，请查询原操作状态，勿重复提交。',
    contact_support: '当前请求受到限制，请核对权限或联系银行；可继续其他查询。',
    new_request: '请重新描述或选择其他可行操作，也可以继续查询。',
  }[policy.nextAction] ?? '请继续输入新的请求。';
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const text = value => typeof value === 'string' && value.trim().length > 0;
// Only these static labels may reach diagnostics. Never log model text or facts.
const failures = {
  facts_invalid: ['facts', '分析依据无效'],
  history_invalid: ['facts', '历史依据无效'],
  history_total_invalid: ['facts', '历史分类合计超出安全整数范围'],
  shape_top_fields: ['shape', '模型建议顶层字段无效'],
  shape_observations: ['shape', '模型观察字段或类型无效'],
  shape_budgets: ['shape', '模型预算字段或类型无效'],
  shape_caveats: ['shape', '模型风险说明字段或类型无效'],
  shape_self_review: ['shape', '模型自检字段或类型无效'],
  self_review_failed: ['semantic_review', '模型自检未通过'],
  observation_coverage: ['semantic_review', '消费观察缺少可信依据'],
  observation_evidence: ['semantic_review', '消费趋势缺少跨月依据'],
  trend_mismatch: ['semantic_review', '消费趋势与流水不符'],
  budget_coverage_or_amount: ['semantic_review', '分类预算不完整或金额无效'],
  fixed_cost_reduction: ['semantic_review', '固定开销不得无依据下降'],
  caveats_invalid: ['semantic_review', '风险说明无效'],
  budget_total_invalid: ['semantic_review', '分类建议总额无效'],
  json_invalid: ['json_parse', '储蓄建议不是有效 JSON。'],
  output_invalid: ['model_output', '储蓄建议格式无效。'],
  turn_output_invalid: ['model_output', '储蓄建议未完整返回'],
};
export const adviceReviewFailed = message => {
  const reason = Object.hasOwn(failures, message) ? message : Object.keys(failures).find(key => failures[key][1] === message);
  throw Object.assign(new Error(reason ? failures[reason][1] : '储蓄建议未通过复核'), {
    code: 'ADVICE_REVIEW_FAILED', savingsReview: reason ? { stage: failures[reason][0], reason } : undefined,
  });
};
export function savingsFailureDiagnostic(error) {
  const reason = error?.savingsReview?.reason;
  if (Object.hasOwn(failures, reason ?? '')) return { stage: failures[reason][0], reason, code: error.code === 'MODEL_FORMAT_ERROR' ? error.code : 'ADVICE_REVIEW_FAILED' };
  const codes = ['MODEL_FORMAT_ERROR', 'TRUEFORGE_TIMEOUT', 'TRUEFORGE_UNAVAILABLE', 'TRUEFORGE_CONFIG_ERROR', 'TRUEFORGE_AGENT_POLICY_ERROR', 'TRUEFORGE_TURN_FAILED', 'TRUEFORGE_FORMAT_ERROR'];
  return { stage: 'model_transport', reason: 'model_request_failed', code: codes.includes(error?.code) ? error.code : 'ADVICE_REVIEW_FAILED' };
}
export const prose = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
export const adviceMoney = value => Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000_000;
const qualitative = value => prose(value) && !/[0-9０-９\p{Sc}]/u.test(value);
const refs = value => Array.isArray(value) && value.length >= 1 && value.length <= 8 && value.every(text);
const reviewKeys = ['passed', 'data_coverage', 'category_evidence', 'fixed_costs', 'budget_totals', 'uncertainty', 'failed_items'];

// Shape validation is separate from semantic review. A model's self-check is data.
export function validateSavingsAdviceShape(advice) {
  if (!keys(advice, ['observations', 'category_budgets', 'caveats', 'self_review'])) adviceReviewFailed('shape_top_fields');
  if (!Array.isArray(advice.observations) || advice.observations.some(item =>
        !keys(item, ['category', 'trend', 'evidence_refs', 'reason', 'uncertain']) || !text(item.category) ||
        !['up', 'down', 'flat'].includes(item.trend) || !refs(item.evidence_refs) || !qualitative(item.reason) || item.uncertain !== true)) adviceReviewFailed('shape_observations');
  if (!Array.isArray(advice.category_budgets) || advice.category_budgets.some(item =>
        !keys(item, ['category', 'suggested_minor', 'reason', 'evidence_refs']) || !text(item.category) ||
        !adviceMoney(item.suggested_minor) || !qualitative(item.reason) || !refs(item.evidence_refs))) adviceReviewFailed('shape_budgets');
  if (!Array.isArray(advice.caveats) || advice.caveats.length > 5 || advice.caveats.some(item => !prose(item))) adviceReviewFailed('shape_caveats');
  if (!keys(advice.self_review, reviewKeys) || reviewKeys.slice(0, -1).some(key => typeof advice.self_review[key] !== 'boolean') ||
      !Array.isArray(advice.self_review.failed_items) || advice.self_review.failed_items.some(item => typeof item !== 'string')) adviceReviewFailed('shape_self_review');
  return advice;
}

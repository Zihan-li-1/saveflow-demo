const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const text = value => typeof value === 'string' && value.trim().length > 0;
export const adviceReviewFailed = message => { throw Object.assign(new Error(message), { code: 'ADVICE_REVIEW_FAILED' }); };
export const prose = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
export const adviceMoney = value => Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000_000;
const qualitative = value => prose(value) && !/[0-9０-９\p{Sc}]/u.test(value);
const refs = value => Array.isArray(value) && value.length >= 1 && value.length <= 8 && value.every(text);
const reviewKeys = ['passed', 'data_coverage', 'category_evidence', 'fixed_costs', 'budget_totals', 'uncertainty', 'failed_items'];

// Shape validation is separate from semantic review. A model's self-check is data.
export function validateSavingsAdviceShape(advice) {
  if (!keys(advice, ['observations', 'category_budgets', 'caveats', 'self_review']) ||
      !Array.isArray(advice.observations) || advice.observations.some(item =>
        !keys(item, ['category', 'trend', 'evidence_refs', 'reason', 'uncertain']) || !text(item.category) ||
        !['up', 'down', 'flat'].includes(item.trend) || !refs(item.evidence_refs) || !qualitative(item.reason) || item.uncertain !== true) ||
      !Array.isArray(advice.category_budgets) || advice.category_budgets.some(item =>
        !keys(item, ['category', 'suggested_minor', 'reason', 'evidence_refs']) || !text(item.category) ||
        !adviceMoney(item.suggested_minor) || !qualitative(item.reason) || !refs(item.evidence_refs)) ||
      !Array.isArray(advice.caveats) || advice.caveats.length > 5 || advice.caveats.some(item => !prose(item)) ||
      !keys(advice.self_review, reviewKeys) || reviewKeys.slice(0, -1).some(key => typeof advice.self_review[key] !== 'boolean') ||
      !Array.isArray(advice.self_review.failed_items) || advice.self_review.failed_items.some(item => typeof item !== 'string')) {
    adviceReviewFailed('模型建议字段或类型无效');
  }
  return advice;
}

import { runSavingsAdvice } from './trueforge-savings-runtime.mjs';
export { savingsAdviceAgentSpec } from './trueforge-savings-runtime.mjs';
import { validateSavingsAdviceShape, adviceReviewFailed as fail, adviceMoney as money, prose } from './savings-advice-contract.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');

export function validateSavingsFacts(facts) {
  if (!object(facts?.recent?.category_expenses_minor) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(facts.recent.month || '') || !money(facts.recent.income_minor) ||
    Object.entries(facts.recent.category_expenses_minor).some(([category, value]) => !prose(category) || !money(value)) || !Array.isArray(facts.history) || !money(facts.required_monthly_minor) ||
    !object(facts.sources) || !['repository', 'user_provided'].includes(facts.sources.recent) || !prose(facts.sources.recent_as_of) || !prose(facts.sources.history) || !prose(facts.sources.history_as_of)) fail('分析依据无效');
  const months = new Set();
  for (const item of facts.history) {
    if (!object(item) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(item.month || '') || item.month >= facts.recent.month || months.has(item.month) ||
        !object(item.category_expenses_minor) || Object.entries(item.category_expenses_minor).some(([category, value]) => !prose(category) || !money(value))) fail('历史依据无效');
    months.add(item.month);
  }
}

export function calculateSavingsEvidence(facts) {
  validateSavingsFacts(facts);
  const comparisons = [];
  const category_evidence = Object.keys(facts.recent.category_expenses_minor).map(category => {
    const history = facts.history.filter(month => Object.hasOwn(month.category_expenses_minor, category)).sort((a, b) => b.month.localeCompare(a.month));
    const allowed_evidence_refs = [`recent:${category}`, ...history.map(month => `history:${month.month}:${category}`)];
    const evidence_refs = allowed_evidence_refs.slice(0, 3);
    if (history.length) {
      const total = history.reduce((sum, month) => sum + BigInt(month.category_expenses_minor[category]), 0n);
      if (total > BigInt(Number.MAX_SAFE_INTEGER)) fail('history_total_invalid');
      const count = BigInt(history.length);
      const difference = BigInt(facts.recent.category_expenses_minor[category]) * count - total;
      // Compare exact integer ratios, without rounding the mean or ten-percent boundary.
      const threshold = total > 10000n * count ? total : 10000n * count;
      const trend = difference * 10n > threshold ? 'up' : difference * 10n < -threshold ? 'down' : 'flat';
      const baseline = Number(total) / history.length;
      comparisons.push({ category, history_month_count: history.length, history_total_minor: Number(total),
        history_average_minor: baseline, threshold_minor: Math.max(1000, baseline * .1),
        delta_minor: facts.recent.category_expenses_minor[category] - baseline, trend, evidence_refs });
    }
    return { category, evidence_refs, allowed_evidence_refs };
  });
  return { comparisons, category_evidence };
}

export function verifySavingsAdvice(advice, facts) {
  validateSavingsAdviceShape(advice);
  const trusted = calculateSavingsEvidence(facts);
  if (advice.self_review.failed_items.length || ['passed', 'data_coverage', 'category_evidence', 'fixed_costs', 'budget_totals', 'uncertainty'].some(key => advice.self_review[key] !== true)) fail('模型自检未通过');
  const categories = Object.keys(facts.recent.category_expenses_minor);
  const evidence = new Set(trusted.category_evidence.flatMap(item => item.allowed_evidence_refs));
  const refsValid = refs => Array.isArray(refs) && refs.length > 0 && refs.length <= 8 && refs.every(ref => typeof ref === 'string' && evidence.has(ref));
  const sameCategoryRefs = item => item.evidence_refs.every(ref => trusted.category_evidence.find(entry => entry.category === item.category)?.allowed_evidence_refs.includes(ref));
  const comparable = trusted.comparisons.map(item => item.category);
  if (advice.observations.length !== comparable.length || new Set(advice.observations.map(item => item.category)).size !== comparable.length ||
      advice.observations.some(item => !comparable.includes(item.category) || !refsValid(item.evidence_refs))) fail('消费观察缺少可信依据');
  for (const item of advice.observations) {
    if (!item.evidence_refs.includes(`recent:${item.category}`) ||
      !item.evidence_refs.some(ref => facts.history.some(month => ref === `history:${month.month}:${item.category}` && Object.hasOwn(month.category_expenses_minor, item.category))) ||
      !sameCategoryRefs(item)) fail('消费趋势缺少跨月依据');
    if (item.trend !== trusted.comparisons.find(comparison => comparison.category === item.category).trend) fail('消费趋势与流水不符');
  }
  if (!Array.isArray(advice.category_budgets) || advice.category_budgets.length !== categories.length ||
    new Set(advice.category_budgets.map(item => item.category)).size !== categories.length ||
    advice.category_budgets.some(item => !keys(item, ['category', 'suggested_minor', 'reason', 'evidence_refs']) || !categories.includes(item.category) || !money(item.suggested_minor) || !refsValid(item.evidence_refs) || !sameCategoryRefs(item) || !item.evidence_refs.includes(`recent:${item.category}`))) fail('分类预算不完整或金额无效');
  for (const item of advice.category_budgets) if (['房租', '通信'].includes(item.category) && item.suggested_minor < facts.recent.category_expenses_minor[item.category]) fail('固定开销不得无依据下降');
  if (!Array.isArray(advice.caveats) || advice.caveats.length > 5 || advice.caveats.some(item => !prose(item))) fail('风险说明无效');
  const proposed = advice.category_budgets.reduce((sum, item) => sum + item.suggested_minor, 0);
  if (!Number.isSafeInteger(proposed)) fail('分类建议总额无效');
  const remainingGap = Math.max(0, proposed + facts.required_monthly_minor - facts.recent.income_minor);
  // Model prose is not evidence. Expose only descriptions derived from checked numbers and references.
  const recentLabel = facts.sources.recent === 'repository' ? '演示账单中的最近月支出' : '你填写的最近月支出';
  const observedHistory = category => facts.history.map(month => month.category_expenses_minor[category]).filter(money);
  const observations = advice.observations.map(item => ({ ...item,
    reason: `${recentLabel}${item.trend === 'up' ? '高于' : item.trend === 'down' ? '低于' : '接近'}${observedHistory(item.category).length}个有该类别记录的历史演示月份平均额；没有记录的月份不计为零。` }));
  const category_budgets = advice.category_budgets.map(item => {
    const previous = observedHistory(item.category);
    const direction = item.suggested_minor < facts.recent.category_expenses_minor[item.category] ? '下调' : item.suggested_minor > facts.recent.category_expenses_minor[item.category] ? '上调' : '保持';
    const baseline = previous.length ? `历史有该类别记录的${previous.length}个月月均约¥${(previous.reduce((sum, value) => sum + value, 0) / previous.length / 100).toFixed(2)}；` : '历史没有该类别的可比记录；';
    return { ...item, reason: `${baseline}根据最近月该类别支出，模型提出${direction}预算，实际能否执行需要你确认。` };
  });
  const caveats = [facts.sources?.recent === 'repository' ? '近期收支来自演示账单快照，并非真实银行账户。' : '近期收入和支出由用户填写，未与真实账户核对。', '历史分类数据来自合成演示账单，不能预测未来消费。', '本计划不保证达成目标或取得投资收益。'];
  return { observations, category_budgets, caveats,
    proposed_expense_minor: proposed, feasible: remainingGap === 0, remaining_gap_minor: remainingGap };
}

export async function requestSavingsAdvice(facts, options = {}) {
  const trusted = calculateSavingsEvidence(facts);
  // Explicit nested projection: extra fields must never leave the server.
  const aggregate = {
    recent: { month: facts.recent.month, income_minor: facts.recent.income_minor, category_expenses_minor: { ...facts.recent.category_expenses_minor } },
    sources: Object.fromEntries(['recent', 'recent_as_of', 'history', 'history_as_of'].map(key => [key, facts.sources[key]])),
    required_monthly_minor: facts.required_monthly_minor,
    ...trusted,
  };
  return runSavingsAdvice(aggregate, options);
}

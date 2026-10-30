// @ts-check

export const WEALTH_ACTIONS = Object.freeze([
  'wealth.recommend', 'wealth.compare', 'wealth.assess_risk',
  'wealth.subscribe', 'wealth.redeem',
]);

const RISK_ORDER = Object.freeze({ R1: 1, R2: 2, R3: 3 });
const LIQUIDITY_ORDER = Object.freeze({ 'T+0': 0, 'T+1': 1, AT_MATURITY: 2 });

export class WealthSkillError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = 'WealthSkillError'; this.code = code; }
  toJSON() { return { code: this.code, message: this.message, uncertain: false }; }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** @param {Record<string, any>} value @param {string[]} allowed @param {string[]} [required] */
function exactKeys(value, allowed, required = allowed) {
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new WealthSkillError('VALIDATION_ERROR', '字段缺失或包含未注册字段');
  }
}
/** @param {unknown} value @param {string} field */
function nonEmpty(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new WealthSkillError('VALIDATION_ERROR', `${field} 必须是非空字符串`);
}
/** @param {unknown} value */
function amount(value) {
  if (!isObject(value)) throw new WealthSkillError('VALIDATION_ERROR', 'amount 必须是对象');
  exactKeys(value, ['amount_minor', 'currency']);
  if (!Number.isSafeInteger(value.amount_minor) || Number(value.amount_minor) <= 0) throw new WealthSkillError('VALIDATION_ERROR', 'amount_minor 必须是正整数分');
  if (value.currency !== 'CNY') throw new WealthSkillError('VALIDATION_ERROR', '当前 Mock 只支持 CNY');
}

/** @param {unknown} value @returns {Record<string, any>} */
export function validateWealthAction(value) {
  if (!isObject(value)) throw new WealthSkillError('VALIDATION_ERROR', '理财动作必须是对象');
  nonEmpty(value.action, 'action');
  if (!WEALTH_ACTIONS.includes(String(value.action))) throw new WealthSkillError('UNKNOWN_ACTION', '未注册的理财动作');
  if (value.action === 'wealth.recommend') {
    exactKeys(value, ['action', 'goal', 'max_risk_level', 'horizon_days', 'liquidity_requirement', 'amount'], ['action', 'goal', 'max_risk_level', 'horizon_days', 'liquidity_requirement']);
    nonEmpty(value.goal, 'goal');
    if (!Object.hasOwn(RISK_ORDER, String(value.max_risk_level))) throw new WealthSkillError('VALIDATION_ERROR', 'max_risk_level 必须是 R1、R2 或 R3');
    if (!Number.isSafeInteger(value.horizon_days) || Number(value.horizon_days) < 0 || Number(value.horizon_days) > 3650) throw new WealthSkillError('VALIDATION_ERROR', 'horizon_days 必须是 0 到 3650 的整数');
    if (!Object.hasOwn(LIQUIDITY_ORDER, String(value.liquidity_requirement))) throw new WealthSkillError('VALIDATION_ERROR', 'liquidity_requirement 无效');
    if (Object.hasOwn(value, 'amount')) amount(value.amount);
  } else if (value.action === 'wealth.compare') {
    exactKeys(value, ['action', 'product_refs']);
    if (!Array.isArray(value.product_refs) || value.product_refs.length < 2 || value.product_refs.length > 10 || new Set(value.product_refs).size !== value.product_refs.length) throw new WealthSkillError('VALIDATION_ERROR', 'product_refs 必须包含 2 到 10 个不重复产品');
    value.product_refs.forEach((/** @type {unknown} */ ref) => nonEmpty(ref, 'product_ref'));
  } else if (value.action === 'wealth.assess_risk') {
    exactKeys(value, ['action', 'assessment_scope']);
    if (value.assessment_scope !== 'investment_suitability') throw new WealthSkillError('VALIDATION_ERROR', 'assessment_scope 无效');
  } else if (value.action === 'wealth.subscribe') {
    exactKeys(value, ['action', 'product_ref', 'amount', 'source_account_ref']);
    nonEmpty(value.product_ref, 'product_ref'); nonEmpty(value.source_account_ref, 'source_account_ref'); amount(value.amount);
  } else {
    exactKeys(value, ['action', 'holding_ref', 'quantity_or_amount']);
    nonEmpty(value.holding_ref, 'holding_ref'); amount(value.quantity_or_amount);
  }
  return value;
}

/** @param {import('../../banking-core/contracts').InvestmentProduct} product */
function productView(product) {
  return {
    product_ref: product.id, name: product.name, category: product.category, product_code: product.displayCode, risk_level: product.riskLevel,
    expected_yield_bps: product.expectedYield, liquidity: product.liquidity,
    minimum_amount_minor: product.minimumAmountFen, duration_days: product.durationDays,
    currency: product.currency, synthetic: product.isSynthetic,
  };
}

/** @param {number} fen @returns {string} */
function fenToYuanText(fen) {
  const abs = Math.abs(Number(fen) || 0);
  return `${fen < 0 ? '-' : ''}¥${(abs / 100).toFixed(2)}`;
}

/** @param {import('../../banking-core/contracts').FinancialContextRepository} repository */
export function createWealthSkill(repository) {
  if (!repository || typeof repository.getInvestmentProducts !== 'function' || typeof repository.getContextInfo !== 'function') throw new TypeError('Wealth Skill 需要 FinancialContextRepository');
  return async function runWealthAction(/** @type {unknown} */ raw, /** @type {{financialContext?: any}} */ options = {}) {
    try {
      const input = validateWealthAction(raw);
      /** @type {any} */
      const financialContext = options.financialContext;
      if (input.action === 'wealth.subscribe' || input.action === 'wealth.redeem') {
        return { ok: false, kind: 'unsupported', action: input.action, error: { code: 'CAPABILITY_UNAVAILABLE', message: input.action === 'wealth.subscribe' ? '当前没有风险测评、适当性校验和理财申购执行能力，仅可提供产品比较与建议。' : '当前没有可信持仓与赎回执行能力，不能生成赎回成功结果。', uncertain: false } };
      }
      const context = await repository.getContextInfo();
      /** @type {Array<{source:string,as_of:string,entity_ids:string[]}>} */
      const evidence = [{ source: 'financial_context.investment_products', as_of: context.asOf, entity_ids: [] }];
      if (input.action === 'wealth.assess_risk') {
        return { ok: true, kind: 'risk_assessment_required', action: input.action, data: { assessment_scope: input.assessment_scope, status: 'requires_user_questionnaire', model_may_answer_for_user: false, recommendation_allowed_before_completion: false }, evidence };
      }
      const products = await repository.getInvestmentProducts();
      if (input.action === 'wealth.compare') {
        /** @type {Array<import('../../banking-core/contracts').InvestmentProduct | undefined>} */
        const selected = input.product_refs.map((/** @type {string} */ ref) => {
          const normalized = ref.trim();
          const matches = products.filter(product => product.id === normalized || product.name === normalized || product.name.replace(/^模拟/, '') === normalized.replace(/^模拟/, ''));
          if (matches.length > 1) throw new WealthSkillError('PRODUCT_AMBIGUOUS', `产品「${normalized}」匹配到多项，请提供完整名称`);
          return matches[0];
        });
        if (selected.some(product => !product)) throw new WealthSkillError('PRODUCT_NOT_FOUND', '至少一个理财产品不存在或不可访问');
        const resolved = /** @type {Array<import('../../banking-core/contracts').InvestmentProduct>} */ (selected);
        evidence[0].entity_ids = resolved.map(product => product.id);
        return { ok: true, kind: 'wealth_comparison', action: input.action, data: { products: resolved.map(productView), methodology: { expected_yield_is_guaranteed: false, ranking_applied: false }, disclaimer: '预期收益不代表实际收益；本结果使用模拟产品数据，不构成投资建议。' }, evidence };
      }
      const maxRisk = RISK_ORDER[/** @type {'R1'|'R2'|'R3'} */ (input.max_risk_level)];
      const maxLiquidityDelay = LIQUIDITY_ORDER[/** @type {'T+0'|'T+1'|'AT_MATURITY'} */ (input.liquidity_requirement)];
      const eligible = products.filter(product => RISK_ORDER[product.riskLevel] <= maxRisk && LIQUIDITY_ORDER[product.liquidity] <= maxLiquidityDelay && product.durationDays <= input.horizon_days && (!input.amount || product.minimumAmountFen <= input.amount.amount_minor));
      evidence[0].entity_ids = eligible.map(product => product.id);
      const financial = /** @type {any} */ (financialContext);
      const hasSummary = !!financial?.summary;
      const summary = financial?.summary;
      const coverage = financial?.coverage;
      const months = Array.isArray(financial?.range?.months) ? financial.range.months : [];
      // 账单状态归类：无上下文 / 不可用 / 部分覆盖 / 可用。只陈述「观察到什么」，绝不据此改写风险或金额。
      const billState = !financial?.status ? 'none' : !summary ? 'unavailable' : String(financial.status);
      const baseStep = eligible.length ? '完成正式风险测评后再决定是否申购。' : '放宽期限、流动性或金额条件前，请先确认新的约束。';
      /** @type {string} */
      let note;
      /** @type {string} */
      let nextStep = baseStep;
      if (billState === 'none') {
        note = '本次未传入账单流水分析，推荐仅按你声明的风险、期限与流动性条件筛选。';
      } else if (billState === 'unavailable') {
        note = '当前没有可用的账单流水，本次推荐未使用账单分析作为依据；风险、期限与流动性仅按你声明的条件筛选。';
      } else {
        // 有可观察账单依据：只描述观察到的现金流，不推断风险，不把净现金流当作可投资金额。
        const netText = summary.netCashFlowFen > 0 ? '净流入为正' : summary.netCashFlowFen < 0 ? '净流出（支出大于收入）' : '收支接近';
        note = `最近 ${months.length} 个月账单显示：收入 ${fenToYuanText(summary.totalIncomeFen)}、消费支出 ${fenToYuanText(summary.totalExpenseFen)}、净现金流 ${fenToYuanText(summary.netCashFlowFen)}（${netText}，收入减消费支出、不含转账）。这是观察到的历史现金流，不是可投资金额，也不能据此判断你的风险承受能力。`;
        if (billState === 'partial') {
          const missing = Array.isArray(coverage?.missingMonths) && coverage.missingMonths.length ? `（缺 ${coverage.missingMonths.join('、')}）` : '';
          note += ` 账单覆盖不完整${missing}，以上现金流仅代表可观察到的入账记录，不代表完整财务能力；缺月或无记录不代表零支出。`;
          nextStep = `${baseStep} 若希望推荐更贴合你的账单，可先补充更完整月份的账单。`;
        } else {
          nextStep = `${baseStep} 可结合账单现金流确认可用于投资的金额，再决定是否申购。`;
        }
      }
      /** @type {any} */
      const billBasis = billState === 'none' ? undefined : {
        status: billState === 'unavailable' ? 'unavailable' : financial.status, range: financial.range,
        ...(summary ? { summary } : {}),
        coverage: financial.coverage, source: financial.source, note,
      };
      return { ok: true, kind: 'wealth_recommendation', action: input.action, data: {
        goal: input.goal,
        constraints: { max_risk_level: input.max_risk_level, horizon_days: input.horizon_days, liquidity_requirement: input.liquidity_requirement, amount: input.amount ?? null },
        products: eligible.map(productView),
        no_match: eligible.length === 0,
        ...(billBasis ? { bill_basis: billBasis } : {}),
        methodology: { filters_only: true, personalized_suitability_completed: false, risk_level_source: 'user_declared_constraint', financial_analysis_used: hasSummary, net_cash_flow_is_investable: false },
        next_step: nextStep,
        disclaimer: '这是按用户声明条件生成的产品筛选，不是个性化投资建议，预期收益不保证。',
      }, evidence };
    } catch (error) {
      const safe = error instanceof WealthSkillError ? error : new WealthSkillError('INTERNAL_ERROR', '理财 Skill 未能生成可靠结果');
      return { ok: false, kind: 'skill_error', error: safe.toJSON() };
    }
  };
}

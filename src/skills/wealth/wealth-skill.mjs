// @ts-check

export const WEALTH_ACTIONS = Object.freeze([
  'wealth.recommend',
  'wealth.compare',
  'wealth.assess_risk',
  'wealth.subscribe',
  'wealth.redeem',
]);

const ACTION_SET = new Set(WEALTH_ACTIONS);
const RISK_RANK = Object.freeze({ R1: 1, R2: 2, R3: 3 });
const LIQUIDITY_DAYS = Object.freeze({ 'T+0': 0, 'T+1': 1, AT_MATURITY: Number.POSITIVE_INFINITY });
const DISCLAIMER = 'Synthetic demo only. Displayed expected yield is illustrative and not guaranteed.';
/** @param {string} level */
function riskRank(level) { return RISK_RANK[/** @type {keyof typeof RISK_RANK} */ (level)] ?? Number.POSITIVE_INFINITY; }

export class WealthSkillError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'WealthSkillError';
    this.code = code;
    this.uncertain = false;
  }
  toJSON() { return { code: this.code, message: this.message, uncertain: this.uncertain }; }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

/** @param {Record<string, unknown>} value @param {string[]} expected */
function exactKeys(value, expected) {
  const actual = Object.keys(value);
  if (actual.some(key => !expected.includes(key)) || expected.some(key => !Object.hasOwn(value, key))) {
    throw new WealthSkillError('VALIDATION_ERROR', '字段缺失或包含未授权字段');
  }
}

/** @param {unknown} value @param {string} label */
function validId(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new WealthSkillError('VALIDATION_ERROR', `${label} 格式无效`);
}

/** @param {unknown} value */
function validateMoney(value) {
  if (!isObject(value)) throw new WealthSkillError('VALIDATION_ERROR', '金额必须是对象');
  exactKeys(value, ['amount_minor', 'currency']);
  if (!Number.isSafeInteger(value.amount_minor) || Number(value.amount_minor) <= 0 || Number(value.amount_minor) > 1000000000) throw new WealthSkillError('VALIDATION_ERROR', 'amount_minor 必须是 1–1000000000 的整数分');
  if (value.currency !== 'CNY') throw new WealthSkillError('VALIDATION_ERROR', '当前 Mock 仅支持 CNY');
}

/** @param {unknown} value */
function validateQuantity(value) {
  if (!isObject(value)) throw new WealthSkillError('VALIDATION_ERROR', 'quantity_or_amount 必须是对象');
  if (value.kind === 'amount') {
    exactKeys(value, ['kind', 'amount_minor', 'currency']);
    validateMoney({ amount_minor: value.amount_minor, currency: value.currency });
    return;
  }
  if (value.kind === 'units') {
    exactKeys(value, ['kind', 'units_milli']);
    if (!Number.isSafeInteger(value.units_milli) || Number(value.units_milli) <= 0 || Number(value.units_milli) > 1000000000) throw new WealthSkillError('VALIDATION_ERROR', 'units_milli 必须是 1–1000000000 的正整数');
    return;
  }
  throw new WealthSkillError('VALIDATION_ERROR', '赎回单位必须明确为 amount 或 units');
}

/** @param {unknown} value */
function validateGoal(value) {
  if (!isObject(value)) throw new WealthSkillError('VALIDATION_ERROR', 'goal 必须是对象');
  const allowed = ['kind', 'target_date', 'max_risk_level'];
  if (Object.keys(value).some(key => !allowed.includes(key)) || !Object.hasOwn(value, 'kind')) throw new WealthSkillError('VALIDATION_ERROR', 'goal 字段无效');
  if (!['capital_preservation', 'steady_growth', 'short_term_purchase'].includes(String(value.kind))) throw new WealthSkillError('VALIDATION_ERROR', 'goal.kind 无效');
  if (value.target_date !== undefined) {
    const date = typeof value.target_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.target_date) ? new Date(`${value.target_date}T00:00:00Z`) : null;
    if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.target_date) throw new WealthSkillError('VALIDATION_ERROR', 'target_date 无效');
  }
  if (value.max_risk_level !== undefined && !Object.hasOwn(RISK_RANK, String(value.max_risk_level))) throw new WealthSkillError('VALIDATION_ERROR', 'max_risk_level 无效');
}

/** @param {unknown} value */
function validateConstraints(value) {
  if (value === undefined) return;
  if (!isObject(value) || Object.keys(value).some(key => !['investable_amount', 'max_settlement_days'].includes(key))) throw new WealthSkillError('VALIDATION_ERROR', 'constraints 字段无效');
  if (value.investable_amount !== undefined) validateMoney(value.investable_amount);
  if (value.max_settlement_days !== undefined && (!Number.isSafeInteger(value.max_settlement_days) || Number(value.max_settlement_days) < 0 || Number(value.max_settlement_days) > 365)) throw new WealthSkillError('VALIDATION_ERROR', 'max_settlement_days 无效');
}

/** @param {unknown} value @param {RegExp} serviceIdPattern @param {string} label */
function validateRawRef(value, serviceIdPattern, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || serviceIdPattern.test(value.trim())) throw new WealthSkillError('VALIDATION_ERROR', `${label} 必须保留用户称呼，不能使用服务端 ID`);
}

/** Validate the model-facing action fragment. It never accepts IDs or authorization fields. @param {unknown} value */
export function validateWealthIntent(value) {
  if (!isObject(value)) throw new WealthSkillError('VALIDATION_ERROR', 'Wealth 动作必须是对象');
  exactKeys(value, ['action', 'slots']);
  if (typeof value.action !== 'string' || !ACTION_SET.has(value.action)) throw new WealthSkillError('UNKNOWN_ACTION', '未注册的 Wealth 动作');
  if (!isObject(value.slots)) throw new WealthSkillError('VALIDATION_ERROR', 'slots 必须是对象');
  const slots = value.slots;
  switch (value.action) {
    case 'wealth.recommend':
      if (Object.keys(slots).some(key => !['goal', 'constraints'].includes(key)) || !Object.hasOwn(slots, 'goal')) throw new WealthSkillError('VALIDATION_ERROR', 'recommend slots 无效');
      validateGoal(slots.goal); validateConstraints(slots.constraints); break;
    case 'wealth.compare': {
      exactKeys(slots, ['product_refs']);
      if (!Array.isArray(slots.product_refs) || slots.product_refs.length < 2 || slots.product_refs.length > 5 || new Set(slots.product_refs).size !== slots.product_refs.length) throw new WealthSkillError('VALIDATION_ERROR', 'product_refs 必须包含 2–5 个唯一产品');
      for (const item of slots.product_refs) validateRawRef(item, /^product[_-]/i, 'product_ref');
      break;
    }
    case 'wealth.assess_risk':
      exactKeys(slots, ['assessment_scope']);
      if (!['investment', 'portfolio'].includes(String(slots.assessment_scope))) throw new WealthSkillError('VALIDATION_ERROR', 'assessment_scope 无效');
      break;
    case 'wealth.subscribe':
      exactKeys(slots, ['product_ref', 'amount', 'source_account_ref']);
      validateRawRef(slots.product_ref, /^product[_-]/i, 'product_ref');
      validateRawRef(slots.source_account_ref, /^acc[_-]/i, 'source_account_ref');
      validateMoney(slots.amount);
      break;
    case 'wealth.redeem':
      exactKeys(slots, ['holding_ref', 'quantity_or_amount']);
      validateRawRef(slots.holding_ref, /^holding[_-]/i, 'holding_ref');
      validateQuantity(slots.quantity_or_amount);
      break;
  }
  return value;
}

/** @param {unknown} value */
export function validateResolvedWealthIntent(value) {
  if (!isObject(value)) throw new WealthSkillError('VALIDATION_ERROR', 'ResolvedIntent 必须是对象');
  exactKeys(value, ['intent_id', 'action', 'state', 'resolved_slots', 'references', 'missing_slots']);
  validId(value.intent_id, 'intent_id');
  if (typeof value.action !== 'string' || !ACTION_SET.has(value.action)) throw new WealthSkillError('UNKNOWN_ACTION', '未注册的 Wealth 动作');
  if (value.state !== 'ready_for_planning' || !Array.isArray(value.missing_slots) || value.missing_slots.length) throw new WealthSkillError('VALIDATION_ERROR', '动作尚未完成实体解析');
  if (!isObject(value.resolved_slots) || !Array.isArray(value.references)) throw new WealthSkillError('VALIDATION_ERROR', 'ResolvedIntent 结构无效');
  const slots = value.resolved_slots;
  const references = value.references;
  for (const reference of references) {
    if (!isObject(reference)) throw new WealthSkillError('VALIDATION_ERROR', 'reference 无效');
    exactKeys(reference, ['slot', 'entity_type', 'entity_id', 'source']);
    validId(reference.entity_id, 'entity_id');
    if (!['financial_context', 'user_selection', 'tool_result'].includes(String(reference.source))) throw new WealthSkillError('VALIDATION_ERROR', 'reference.source 无效');
  }
  /** @param {string} slot @param {string} type @param {string} id */
  const requireReference = (slot, type, id) => {
    const match = references.find(reference => reference.slot === slot && reference.entity_type === type && reference.entity_id === id);
    if (!match) throw new WealthSkillError('VALIDATION_ERROR', `${slot} 引用与 resolved_slots 不一致`);
  };
  switch (value.action) {
    case 'wealth.recommend':
      if (Object.keys(slots).some(key => !['goal', 'constraints'].includes(key)) || !Object.hasOwn(slots, 'goal') || references.length) throw new WealthSkillError('VALIDATION_ERROR', 'recommend ResolvedIntent 无效');
      validateGoal(slots.goal); validateConstraints(slots.constraints); break;
    case 'wealth.compare':
      exactKeys(slots, ['product_ids']);
      if (!Array.isArray(slots.product_ids) || slots.product_ids.length < 2 || slots.product_ids.length > 5 || new Set(slots.product_ids).size !== slots.product_ids.length) throw new WealthSkillError('VALIDATION_ERROR', 'product_ids 必须包含 2–5 个唯一产品');
      for (const id of slots.product_ids) { validId(id, 'product_id'); requireReference('product_refs', 'investment_product', String(id)); }
      if (references.length !== slots.product_ids.length) throw new WealthSkillError('VALIDATION_ERROR', '产品引用数量不一致');
      break;
    case 'wealth.assess_risk':
      exactKeys(slots, ['assessment_scope']);
      if (!['investment', 'portfolio'].includes(String(slots.assessment_scope)) || references.length) throw new WealthSkillError('VALIDATION_ERROR', 'risk ResolvedIntent 无效');
      break;
    case 'wealth.subscribe':
      exactKeys(slots, ['product_id', 'amount', 'source_account_id']); validId(slots.product_id, 'product_id'); validId(slots.source_account_id, 'source_account_id'); validateMoney(slots.amount);
      requireReference('product_ref', 'investment_product', String(slots.product_id)); requireReference('source_account_ref', 'account', String(slots.source_account_id));
      if (references.length !== 2) throw new WealthSkillError('VALIDATION_ERROR', '申购引用数量不一致');
      break;
    case 'wealth.redeem':
      exactKeys(slots, ['holding_id', 'quantity_or_amount']); validId(slots.holding_id, 'holding_id'); validateQuantity(slots.quantity_or_amount);
      requireReference('holding_ref', 'investment_holding', String(slots.holding_id));
      if (references.length !== 1) throw new WealthSkillError('VALIDATION_ERROR', '赎回引用数量不一致');
      break;
  }
  return value;
}

/** @param {string} expiresAt @param {string} asOf */
function isExpired(expiresAt, asOf) { return !expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(asOf); }

/** @param {Record<string, unknown>} context @param {string[]} entityIds @param {Array<{source:string,as_of:string,entity_ids:string[]}>} [extraEvidence] */
function metadata(context, entityIds, extraEvidence = []) {
  return {
    as_of: context.asOf,
    context_snapshot_id: context.snapshotId,
    evidence: [{ source: 'financial_context', as_of: context.asOf, entity_ids: entityIds }, ...extraEvidence],
    synthetic_demo_only: context.dataSource === 'synthetic_demo_only',
  };
}

/** @param {Record<string, unknown>} assessment @param {string} asOf @param {string} scope */
function validAssessment(assessment, asOf, scope) {
  return assessment?.source === 'trusted_ui' && assessment.assessment_scope === scope && Object.hasOwn(RISK_RANK, String(assessment.risk_level)) && !isExpired(String(assessment.expires_at), asOf);
}

/** @param {Record<string, any>} ports */
function trustedQuestionnaire(ports) {
  const questionnaire = ports.questionnaire;
  if (!questionnaire || questionnaire.source !== 'trusted_ui' || typeof questionnaire.route !== 'string' || !questionnaire.route.startsWith('/')) throw new WealthSkillError('CAPABILITY_UNAVAILABLE', '可信风险测评入口未配置');
  return structuredClone(questionnaire);
}

/** @param {Record<string, unknown>} product */
function productView(product) {
  return {
    product_id: product.id,
    name: product.name,
    risk_level: product.riskLevel,
    expected_yield_bps: product.expectedYield,
    liquidity: product.liquidity,
    minimum_amount: { amount_minor: product.minimumAmountFen, currency: product.currency },
    duration_days: product.durationDays,
  };
}

/**
 * Wealth Skill boundary. It awaits MaybePromise repository methods and never executes writes.
 * @param {import('../../banking-core/contracts.js').FinancialContextRepository} repository
 * @param {Record<string, any>} ports
 * @param {unknown} value
 */
export async function runResolvedWealthIntent(repository, ports, value) {
  try {
    const intent = validateResolvedWealthIntent(value);
    const slots = /** @type {Record<string, any>} */ (intent.resolved_slots);
    const [context, products] = await Promise.all([repository.getContextInfo(), repository.getInvestmentProducts()]);
    const evaluationTime = typeof ports.now === 'function' ? ports.now() : new Date().toISOString();
    if (typeof evaluationTime !== 'string' || !Number.isFinite(Date.parse(evaluationTime))) throw new WealthSkillError('CAPABILITY_UNAVAILABLE', '可信时钟不可用');
    const meta = metadata(context, []);

    if (intent.action === 'wealth.assess_risk') {
      const assessment = await ports.getRiskAssessment?.();
      if (!validAssessment(assessment, evaluationTime, slots.assessment_scope)) return { ok: true, data: { kind: 'questionnaire_required', questionnaire: trustedQuestionnaire(ports), ...meta } };
      return { ok: true, data: { kind: 'risk_assessment', assessment: structuredClone(assessment), ...metadata(context, [], [{ source: 'trusted_ui', as_of: assessment.completed_at, entity_ids: [assessment.assessment_id] }]) } };
    }

    if (intent.action === 'wealth.recommend') {
      if (slots.goal.kind === 'capital_preservation') throw new WealthSkillError('NO_MATCHING_PRODUCT', '当前 Mock 没有可验证保本的产品');
      if (slots.goal.target_date && Date.parse(`${slots.goal.target_date}T23:59:59+08:00`) < Date.parse(evaluationTime)) throw new WealthSkillError('VALIDATION_ERROR', '目标日期已过');
      const assessment = await ports.getRiskAssessment?.();
      if (!validAssessment(assessment, evaluationTime, 'investment')) return { ok: true, data: { kind: 'questionnaire_required', questionnaire: trustedQuestionnaire(ports), ...meta } };
      const maxRisk = slots.goal.max_risk_level && riskRank(slots.goal.max_risk_level) < riskRank(assessment.risk_level) ? slots.goal.max_risk_level : assessment.risk_level;
      const maxSettlement = slots.constraints?.max_settlement_days ?? (slots.goal.kind === 'short_term_purchase' ? 1 : Number.POSITIVE_INFINITY);
      const investable = slots.constraints?.investable_amount?.amount_minor ?? Number.POSITIVE_INFINITY;
      const targetDays = slots.goal.target_date ? Math.max(0, Math.ceil((Date.parse(`${slots.goal.target_date}T00:00:00+08:00`) - Date.parse(evaluationTime)) / 86400000)) : Number.POSITIVE_INFINITY;
      const matches = [];
      const excluded = [];
      const disclosureEvidence = [];
      for (const product of products) {
        const disclosure = await ports.getDisclosure?.(product.id);
        if (disclosure) disclosureEvidence.push({ source: 'product_disclosure', as_of: `${disclosure.version}T00:00:00+08:00`, entity_ids: [product.id] });
        const reasons = [];
        if (!disclosure || disclosure.status !== 'active' || isExpired(disclosure.expires_at, evaluationTime)) reasons.push('DISCLOSURE_UNAVAILABLE');
        if (riskRank(product.riskLevel) > riskRank(maxRisk)) reasons.push('RISK_TOO_HIGH');
        if (LIQUIDITY_DAYS[product.liquidity] > maxSettlement) reasons.push('LIQUIDITY_TOO_SLOW');
        if (product.durationDays > targetDays) reasons.push('TERM_TOO_LONG');
        if (product.minimumAmountFen > investable) reasons.push('BELOW_MINIMUM_AMOUNT');
        if (reasons.length) excluded.push({ product_id: product.id, reason_codes: reasons });
        else matches.push(productView(product));
      }
      if (!matches.length) throw new WealthSkillError('NO_MATCHING_PRODUCT', '没有产品同时满足风险、金额、期限和流动性约束');
      return { ok: true, data: { kind: 'recommendation', matches, excluded, disclaimer: DISCLAIMER, ...metadata(context, products.map(item => item.id), [{ source: 'trusted_ui', as_of: assessment.completed_at, entity_ids: [assessment.assessment_id] }, ...disclosureEvidence]) } };
    }

    if (intent.action === 'wealth.compare') {
      const ids = /** @type {string[]} */ (slots.product_ids);
      if (ids.length < 2 || ids.length > 5 || new Set(ids).size !== ids.length) throw new WealthSkillError('VALIDATION_ERROR', '比较必须包含 2–5 个唯一产品');
      const selected = ids.map(id => products.find(product => product.id === id));
      if (selected.some(item => !item)) throw new WealthSkillError('PRODUCT_NOT_FOUND', '指定产品不存在');
      return { ok: true, data: { kind: 'comparison', products: selected.map(product => productView(/** @type {NonNullable<typeof product>} */ (product))), disclaimer: DISCLAIMER, ...metadata(context, ids) } };
    }

    if (intent.action === 'wealth.subscribe') {
      const product = products.find(item => item.id === slots.product_id);
      if (!product) throw new WealthSkillError('PRODUCT_NOT_FOUND', '产品不存在');
      const [assessment, disclosure, rule, account] = await Promise.all([
        ports.getRiskAssessment?.(), ports.getDisclosure?.(product.id), ports.getOperationRule?.(product.id), repository.getAccount(slots.source_account_id),
      ]);
      if (!validAssessment(assessment, evaluationTime, 'investment')) throw new WealthSkillError('RISK_ASSESSMENT_REQUIRED', '缺少有效风险测评');
      if (riskRank(product.riskLevel) > riskRank(assessment.risk_level)) throw new WealthSkillError('SUITABILITY_FAILED', '产品风险高于用户测评等级');
      if (!disclosure || disclosure.status !== 'active' || isExpired(disclosure.expires_at, evaluationTime)) throw new WealthSkillError('DISCLOSURE_EXPIRED', '产品披露不存在或已过期');
      if (!rule?.subscription_enabled) throw new WealthSkillError('CAPABILITY_UNAVAILABLE', '当前产品不支持 Mock 申购');
      if (slots.amount.amount_minor < product.minimumAmountFen) throw new WealthSkillError('BELOW_MINIMUM_AMOUNT', '申购金额低于产品最低金额');
      if (!account) throw new WealthSkillError('ACCOUNT_NOT_FOUND', '来源账户不存在');
      if (account.status !== 'active') throw new WealthSkillError('ACCOUNT_UNAVAILABLE', '来源账户当前不可用');
      if (account.availableBalanceFen < slots.amount.amount_minor) throw new WealthSkillError('INSUFFICIENT_BALANCE', '账户可用余额不足');
      return { ok: true, data: { kind: 'action_request', request: { action: 'wealth.subscribe', input: { productId: product.id, amountFen: slots.amount.amount_minor, currency: 'CNY', sourceAccountId: account.id } }, requirements: { minimumRiskLevel: 'L3', explicitUserConfirmation: true, executionOwner: 'banking_core' }, disclosure: structuredClone(disclosure), ...metadata(context, [product.id, account.id], [{ source: 'trusted_ui', as_of: assessment.completed_at, entity_ids: [assessment.assessment_id] }, { source: 'product_disclosure', as_of: `${disclosure.version}T00:00:00+08:00`, entity_ids: [product.id] }]) } };
    }

    const holdings = /** @type {Array<{id:string,product_id:string,lock_until?:string,amount_fen:number,units_milli:number}>|undefined} */ (await ports.getHoldings?.());
    const holding = holdings?.find(item => item.id === slots.holding_id);
    if (!holding) throw new WealthSkillError('HOLDING_NOT_FOUND', '持仓不存在');
    const product = products.find(item => item.id === holding.product_id);
    const rule = await ports.getOperationRule?.(holding.product_id);
    if (!product || !rule?.redemption_enabled) throw new WealthSkillError('CAPABILITY_UNAVAILABLE', '当前产品不支持 Mock 赎回');
    if (holding.lock_until && Date.parse(holding.lock_until) > Date.parse(evaluationTime)) throw new WealthSkillError('REDEMPTION_RESTRICTED', '持仓仍在锁定期');
    const quantity = slots.quantity_or_amount;
    if (quantity.kind === 'amount' && quantity.amount_minor > holding.amount_fen) throw new WealthSkillError('INSUFFICIENT_HOLDING', '赎回金额超过持仓');
    if (quantity.kind === 'units' && quantity.units_milli > holding.units_milli) throw new WealthSkillError('INSUFFICIENT_HOLDING', '赎回份额超过持仓');
    const input = quantity.kind === 'amount'
      ? { holdingId: holding.id, quantityKind: 'amount', amountFen: quantity.amount_minor, currency: 'CNY' }
      : { holdingId: holding.id, quantityKind: 'units', unitsMilli: quantity.units_milli };
    return { ok: true, data: { kind: 'action_request', request: { action: 'wealth.redeem', input }, requirements: { minimumRiskLevel: 'L3', explicitUserConfirmation: true, executionOwner: 'banking_core' }, ...metadata(context, [holding.id, holding.product_id], [{ source: 'wealth_holdings_mock', as_of: context.asOf, entity_ids: [holding.id] }]) } };
  } catch (error) {
    const safe = error instanceof WealthSkillError ? error : new WealthSkillError('INTERNAL_ERROR', 'Wealth Skill 未能生成可靠结果');
    return { ok: false, error: safe.toJSON() };
  }
}

/** Commerce remains a separate capability; this only creates a Wealth goal.
 * @param {{item:{item_id:string,quote_version:string},purchase_date:string,cashflow:{investable_amount_minor:number}}} input */
export function planLargePurchase({ item, purchase_date, cashflow }) {
  return {
    action: 'wealth.recommend',
    suggested_slots: { goal: { kind: 'short_term_purchase', target_date: purchase_date, max_risk_level: 'R2' }, constraints: { investable_amount: { amount_minor: cashflow.investable_amount_minor, currency: 'CNY' }, max_settlement_days: 1 } },
    source: { item_id: item.item_id, quote_version: item.quote_version },
    execution_allowed: false,
  };
}

/** Creates separately confirmed redemption and order stages; it never purchases an item.
 * @param {{quote:{item_id:string,price_minor:number},upcoming_obligations_minor:number,available_cash_minor:number,card_available_minor:number,redeemable_holding?:{holding_id:string,amount_minor:number,settlement:string}}} input */
export function planCheckoutLiquidity({ quote, upcoming_obligations_minor, available_cash_minor, card_available_minor, redeemable_holding }) {
  const obligationGap = Math.max(0, upcoming_obligations_minor - available_cash_minor);
  const cashAfterObligations = Math.max(0, available_cash_minor - upcoming_obligations_minor);
  const purchaseGap = Math.max(0, quote.price_minor - cashAfterObligations - card_available_minor);
  const shortfall = obligationGap + purchaseGap;
  if (shortfall > 0 && (!redeemable_holding || redeemable_holding.amount_minor < shortfall)) return { shortfall_minor: shortfall, steps: [], can_proceed: false, atomic: false, rollback_redemption_on_order_failure: false };
  const steps = [];
  if (shortfall > 0 && redeemable_holding) {
    steps.push({ action: 'wealth.redeem', holding_id: redeemable_holding.holding_id, amount_minor: shortfall, settlement: redeemable_holding.settlement, confirmation_scope: 'redemption_only' });
    steps.push({ action: 'wealth.redemption.settlement.wait', holding_id: redeemable_holding.holding_id, settlement: redeemable_holding.settlement });
  }
  steps.push({ action: 'commerce.quote.refresh', item_id: quote.item_id, require_inventory_refresh: true });
  steps.push({ action: 'commerce.order.preview', item_id: quote.item_id, confirmation_scope: 'order_only' });
  return { shortfall_minor: shortfall, steps, can_proceed: true, atomic: false, rollback_redemption_on_order_failure: false };
}

/** @param {{event:{event_id:string,type:string,status:string,source?:string,amount_minor:number,currency:string},state:{processed_event_ids:Set<string>},isTrustedEvent?:(event:object)=>boolean}} input */
export function handleRefundInvestment({ event, state, isTrustedEvent }) {
  if (state.processed_event_ids.has(event.event_id)) return { duplicate: true, subscription_candidate: null };
  if (typeof isTrustedEvent !== 'function' || !isTrustedEvent(event) || event.type !== 'refund.settled' || event.status !== 'settled' || event.source !== 'commerce_mock' || !Number.isSafeInteger(event.amount_minor) || event.amount_minor <= 0 || event.currency !== 'CNY') return { duplicate: false, subscription_candidate: null };
  state.processed_event_ids.add(event.event_id);
  return { duplicate: false, subscription_candidate: { amount: { amount_minor: event.amount_minor, currency: event.currency }, origin_event_id: event.event_id, requires_user_review: true } };
}

/** @param {{event:{event_id:string,type:string,status:string,source?:string,amount_minor:number,currency:string},state:{processed_event_ids:Set<string>,accumulated_minor:number},threshold_minor:number,isTrustedEvent?:(event:object)=>boolean}} input */
export function handleRoundUpInvestment({ event, state, threshold_minor, isTrustedEvent }) {
  if (state.processed_event_ids.has(event.event_id)) return { duplicate: true, subscription_candidate: null, executed: false };
  if (typeof isTrustedEvent !== 'function' || !isTrustedEvent(event) || event.type !== 'transaction.posted' || event.status !== 'posted' || event.source !== 'financial_context' || !Number.isSafeInteger(event.amount_minor) || event.amount_minor <= 0 || event.currency !== 'CNY' || !Number.isSafeInteger(threshold_minor) || threshold_minor <= 0) return { duplicate: false, subscription_candidate: null, executed: false };
  state.processed_event_ids.add(event.event_id);
  const roundUp = (100 - (event.amount_minor % 100)) % 100;
  state.accumulated_minor += roundUp;
  if (state.accumulated_minor < threshold_minor) return { duplicate: false, subscription_candidate: null, executed: false };
  const amount = state.accumulated_minor;
  return { duplicate: false, subscription_candidate: { amount: { amount_minor: amount, currency: 'CNY' }, origin_event_id: event.event_id, requires_user_review: true }, executed: false };
}

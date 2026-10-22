// @ts-check

export const CARD_ACTIONS = Object.freeze([
  'card.get',
  'card.set_budget',
  'card.set_controls',
  'card.security_review',
  'card.freeze',
  'card.unfreeze',
]);

const ACTION_SET = new Set(CARD_ACTIONS);

export class CardSkillError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'CardSkillError';
    this.code = code;
    this.uncertain = false;
  }

  toJSON() {
    return { code: this.code, message: this.message, uncertain: this.uncertain };
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {Record<string, unknown>} value @param {string[]} expected */
function requireExactKeys(value, expected) {
  const actual = Object.keys(value);
  if (actual.some(key => !expected.includes(key)) || expected.some(key => !Object.hasOwn(value, key))) {
    throw new CardSkillError('VALIDATION_ERROR', '字段缺失或包含未注册字段');
  }
}

/** @param {unknown} amount */
function validateAmount(amount) {
  if (!isObject(amount)) throw new CardSkillError('VALIDATION_ERROR', 'amount 必须是对象');
  requireExactKeys(amount, ['amount_minor', 'currency']);
  if (!Number.isSafeInteger(amount.amount_minor) || Number(amount.amount_minor) < 0 || Number(amount.amount_minor) > 10_000_000) {
    throw new CardSkillError('VALIDATION_ERROR', 'amount_minor 必须是 0 到 10000000 的整数分');
  }
  if (amount.currency !== 'CNY') throw new CardSkillError('VALIDATION_ERROR', '当前 Mock 只支持 CNY');
}

const INCIDENT_TYPES = new Set(['card_details_exposed', 'unauthorized_transaction', 'device_lost']);
/** @param {Record<string, any>} slots @param {boolean} [resolved] */
function validateControls(slots, resolved = false) {
  const cardKey = resolved ? 'card_id' : 'card_ref';
  const allowed = [cardKey, 'online_payments_enabled', 'blocked_categories', 'alert_amount'];
  if (Object.keys(slots).some(key => !allowed.includes(key)) || !Object.hasOwn(slots, cardKey)) throw new CardSkillError('VALIDATION_ERROR', '安全设置字段无效');
  if (!['online_payments_enabled', 'blocked_categories', 'alert_amount'].some(key => Object.hasOwn(slots, key))) throw new CardSkillError('VALIDATION_ERROR', '至少说明一项要修改的安全设置');
  if ('online_payments_enabled' in slots && typeof slots.online_payments_enabled !== 'boolean') throw new CardSkillError('VALIDATION_ERROR', '线上支付开关必须是布尔值');
  if ('blocked_categories' in slots && (!Array.isArray(slots.blocked_categories) || slots.blocked_categories.length > 10 || slots.blocked_categories.some((value) => typeof value !== 'string' || !value.trim() || value.length > 32) || new Set(slots.blocked_categories).size !== slots.blocked_categories.length)) throw new CardSkillError('VALIDATION_ERROR', '禁用交易类别格式无效');
  if ('alert_amount' in slots && slots.alert_amount !== null) {
    validateAmount(slots.alert_amount);
    if (slots.alert_amount.amount_minor < 1) throw new CardSkillError('VALIDATION_ERROR', '单笔提醒金额必须大于 0 分');
  }
}

/**
 * Validate the action + slots fragment carried by A's ParsedIntent.
 * This boundary rejects legacy intents and model-supplied authorization fields.
 * @param {unknown} value
 */
export function validateCardIntent(value) {
  if (!isObject(value)) throw new CardSkillError('VALIDATION_ERROR', '卡片动作必须是对象');
  requireExactKeys(value, ['action', 'slots']);
  if (typeof value.action !== 'string' || !ACTION_SET.has(value.action)) {
    throw new CardSkillError('UNKNOWN_ACTION', '未注册的卡片动作');
  }
  if (!isObject(value.slots)) throw new CardSkillError('VALIDATION_ERROR', 'slots 必须是对象');
  const slots = value.slots;
  if (value.action === 'card.set_controls') validateControls(slots);
  else requireExactKeys(slots, value.action === 'card.set_budget' ? ['card_ref', 'amount'] : value.action === 'card.security_review' ? ['card_ref', 'issue_type'] : ['card_ref']);
  if (typeof slots.card_ref !== 'string' || !slots.card_ref.trim() || slots.card_ref.length > 128) {
    throw new CardSkillError('VALIDATION_ERROR', 'card_ref 必须是非空卡片称谓');
  }
  if (/^card[_-][a-z0-9_-]+$/i.test(slots.card_ref.trim())) {
    throw new CardSkillError('VALIDATION_ERROR', '模型 slots 应保留用户称谓，不能编造卡片实体 ID');
  }
  if (value.action === 'card.set_budget') {
    validateAmount(slots.amount);
  }
  if (value.action === 'card.security_review' && !INCIDENT_TYPES.has(String(slots.issue_type))) throw new CardSkillError('VALIDATION_ERROR', '安全事件类型无效');
  return value;
}

/** @param {unknown} value */
export function validateResolvedCardIntent(value) {
  if (!isObject(value)) throw new CardSkillError('VALIDATION_ERROR', 'ResolvedIntent 必须是对象');
  requireExactKeys(value, ['intent_id', 'action', 'state', 'resolved_slots', 'references', 'missing_slots']);
  if (typeof value.intent_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.intent_id)) {
    throw new CardSkillError('VALIDATION_ERROR', 'intent_id 格式无效');
  }
  if (typeof value.action !== 'string' || !ACTION_SET.has(value.action)) {
    throw new CardSkillError('UNKNOWN_ACTION', '未注册的卡片动作');
  }
  if (value.state !== 'ready_for_planning') throw new CardSkillError('VALIDATION_ERROR', '动作尚未完成实体解析');
  if (!Array.isArray(value.missing_slots) || value.missing_slots.length !== 0) {
    throw new CardSkillError('VALIDATION_ERROR', 'ready_for_planning 时 missing_slots 必须为空');
  }
  if (!isObject(value.resolved_slots)) throw new CardSkillError('VALIDATION_ERROR', 'resolved_slots 必须是对象');
  const slots = value.resolved_slots;
  if (value.action === 'card.set_controls') validateControls(slots, true);
  else requireExactKeys(slots, value.action === 'card.set_budget' ? ['card_id', 'amount'] : value.action === 'card.security_review' ? ['card_id', 'issue_type'] : ['card_id']);
  if (typeof slots.card_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(slots.card_id)) {
    throw new CardSkillError('VALIDATION_ERROR', 'card_id 格式无效');
  }
  if (value.action === 'card.set_budget') {
    validateAmount(slots.amount);
  }
  if (value.action === 'card.security_review' && !INCIDENT_TYPES.has(String(slots.issue_type))) throw new CardSkillError('VALIDATION_ERROR', '安全事件类型无效');
  if (!Array.isArray(value.references) || value.references.length !== 1 || !isObject(value.references[0])) {
    throw new CardSkillError('VALIDATION_ERROR', '必须提供唯一卡片实体引用');
  }
  const reference = value.references[0];
  requireExactKeys(reference, ['slot', 'entity_type', 'entity_id', 'source']);
  if (reference.slot !== 'card_ref' || reference.entity_type !== 'card' || reference.entity_id !== slots.card_id) {
    throw new CardSkillError('VALIDATION_ERROR', '卡片引用与 resolved_slots.card_id 不一致');
  }
  if (!['financial_context', 'user_selection', 'tool_result'].includes(String(reference.source))) {
    throw new CardSkillError('VALIDATION_ERROR', '卡片引用来源无效');
  }
  return value;
}

/**
 * Resolve a user-facing card reference against the existing project repository.
 * It never guesses when zero or multiple cards match.
 * @param {{getCards:()=>Array<{id:string,name:string}>|Promise<Array<{id:string,name:string}>>,getContextInfo?:()=>Record<string,unknown>|Promise<Record<string,unknown>>}} repository
 * @param {string} rawReference
 */
export async function resolveCardReference(repository, rawReference) {
  if (!repository || typeof repository.getCards !== 'function') {
    throw new CardSkillError('VALIDATION_ERROR', 'repository.getCards 不可用');
  }
  if (typeof rawReference !== 'string' || !rawReference.trim() || rawReference.length > 128) {
    throw new CardSkillError('VALIDATION_ERROR', '卡片称谓无效');
  }
  const ref = rawReference.trim();
  const cards = await repository.getCards();
  const matches = cards.filter(card => card.name === ref);
  if (matches.length !== 1) {
    return {
      kind: 'needs_clarification',
      reason: matches.length ? 'CARD_AMBIGUOUS' : 'CARD_NOT_FOUND',
      candidates: matches.map(card => ({ id: card.id, name: card.name })),
    };
  }
  const card = matches[0];
  const context = typeof repository.getContextInfo === 'function'
    ? await repository.getContextInfo()
    : undefined;
  return {
    kind: 'resolved',
    cardId: card.id,
    reference: {
      slot: 'card_ref',
      entity_type: 'card',
      entity_id: card.id,
      source: 'financial_context',
    },
    evidence: {
      source: 'financial_context',
      asOf: context?.asOf ?? null,
    },
  };
}

/**
 * E-owned Skill boundary. Reads are answered from the existing repository. Writes are
 * converted to B's camelCase/Fen naming and returned as action requests. This function
 * cannot confirm, execute, or mutate a card.
 * @param {{getCards:()=>Array<{id:string,name:string,accountId:string,status:'active'|'frozen',monthlyBudgetFen:number,monthlySpentFen:number}>|Promise<Array<{id:string,name:string,accountId:string,status:'active'|'frozen',monthlyBudgetFen:number,monthlySpentFen:number}>>,getContextInfo:()=>Record<string,unknown>|Promise<Record<string,unknown>>}} repository
 * @param {unknown} value
 */
export async function runResolvedCardIntent(repository, value) {
  try {
    const intent = validateResolvedCardIntent(value);
    const slots = /** @type {Record<string, any> & {card_id:string}} */ (intent.resolved_slots);
    const cards = await repository.getCards();
    const card = cards.find(candidate => candidate.id === slots.card_id);
    if (!card) throw new CardSkillError('CARD_NOT_FOUND', '当前用户无法访问该卡片');

    if (intent.action === 'card.get') {
      const context = await repository.getContextInfo();
      return { ok: true, data: { kind: 'query', card: structuredClone(card), context: structuredClone(context) } };
    }

    if (intent.action === 'card.security_review') {
      const issue = String(slots.issue_type);
      const guidance = issue === 'unauthorized_transaction'
        ? ['先核对交易商户和时间', '若不是本人交易，建议立即冻结虚拟卡', '联系发卡银行发起争议交易处理']
        : issue === 'device_lost'
          ? ['先从可信设备退出丢失设备的登录', '建议冻结虚拟卡并检查近期交易', '联系银行确认是否支持更换虚拟卡号']
          : ['建议冻结虚拟卡，避免旧卡片信息继续使用', '检查近期交易', '联系银行确认是否支持注销或更换虚拟卡号'];
      return { ok: true, data: { kind: 'security_review', card: structuredClone(card), issue_type: issue, severity: 'high', guidance, recommended_action: 'card.freeze', execution_allowed: false, requires_explicit_user_request_to_freeze: true, product_capability_notice: '注销或更换虚拟卡号取决于发卡银行及具体产品规则。' } };
    }

    if (intent.action === 'card.set_budget') {
      const amountFen = slots.amount.amount_minor;
      if (amountFen === card.monthlyBudgetFen) throw new CardSkillError('INVALID_STATE', '新预算与当前预算相同');
      return {
        ok: true,
        data: {
          kind: 'action_request',
          request: {
            action: 'card.set_budget',
            input: { cardId: card.id, monthlyBudgetFen: amountFen },
          },
          warnings: amountFen < card.monthlySpentFen ? [`当前已超预算 ¥${((card.monthlySpentFen - amountFen) / 100).toFixed(2)}；预算不会阻止消费。`] : [],
          requirements: { minimumRiskLevel: 'L2', explicitUserConfirmation: true, executionOwner: 'banking_core' },
        },
      };
    }


    if (intent.action === 'card.set_controls') {
      return { ok: true, data: { kind: 'action_request', request: { action: 'card.set_controls', input: { cardId: card.id, ...('online_payments_enabled' in slots ? { onlinePaymentsEnabled: slots.online_payments_enabled } : {}), ...('blocked_categories' in slots ? { blockedCategories: slots.blocked_categories } : {}), ...('alert_amount' in slots ? { alertThresholdFen: slots.alert_amount === null ? null : slots.alert_amount.amount_minor } : {}) } }, requirements: { minimumRiskLevel: 'L2', explicitUserConfirmation: true, executionOwner: 'banking_core' } } };
    }

    if (intent.action === 'card.freeze' && card.status !== 'active') {
      throw new CardSkillError('INVALID_STATE', '卡片已冻结');
    }
    if (intent.action === 'card.unfreeze' && card.status !== 'frozen') {
      throw new CardSkillError('INVALID_STATE', '卡片当前未冻结');
    }
    return {
      ok: true,
      data: {
        kind: 'action_request',
        request: { action: intent.action, input: { cardId: card.id } },
        requirements: {
          minimumRiskLevel: intent.action === 'card.unfreeze' ? 'L3' : 'L2',
          explicitUserConfirmation: true,
          executionOwner: 'banking_core',
        },
      },
    };
  } catch (error) {
    const safe = error instanceof CardSkillError
      ? error
      : new CardSkillError('INTERNAL_ERROR', '卡片 Skill 未能生成可靠结果');
    return { ok: false, error: safe.toJSON() };
  }
}

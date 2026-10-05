// @ts-check

export const CARD_ACTIONS = Object.freeze([
  'card.get',
  'card.set_limit',
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
  requireExactKeys(slots, value.action === 'card.set_limit' ? ['card_ref', 'limit_type', 'amount'] : ['card_ref']);
  if (typeof slots.card_ref !== 'string' || !slots.card_ref.trim() || slots.card_ref.length > 128) {
    throw new CardSkillError('VALIDATION_ERROR', 'card_ref 必须是非空卡片称谓');
  }
  if (/^card[_-][a-z0-9_-]+$/i.test(slots.card_ref.trim())) {
    throw new CardSkillError('VALIDATION_ERROR', '模型 slots 应保留用户称谓，不能编造卡片实体 ID');
  }
  if (value.action === 'card.set_limit') {
    if (slots.limit_type !== 'monthly_total') throw new CardSkillError('VALIDATION_ERROR', '当前只支持 monthly_total');
    validateAmount(slots.amount);
  }
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
  requireExactKeys(slots, value.action === 'card.set_limit' ? ['card_id', 'limit_type', 'amount'] : ['card_id']);
  if (typeof slots.card_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(slots.card_id)) {
    throw new CardSkillError('VALIDATION_ERROR', 'card_id 格式无效');
  }
  if (value.action === 'card.set_limit') {
    if (slots.limit_type !== 'monthly_total') throw new CardSkillError('VALIDATION_ERROR', '当前只支持 monthly_total');
    validateAmount(slots.amount);
  }
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
 * @param {{getCards:()=>Array<{id:string,name:string,accountId:string,status:'active'|'frozen',monthlyLimitFen:number,monthlySpentFen:number}>|Promise<Array<{id:string,name:string,accountId:string,status:'active'|'frozen',monthlyLimitFen:number,monthlySpentFen:number}>>,getContextInfo:()=>Record<string,unknown>|Promise<Record<string,unknown>>}} repository
 * @param {unknown} value
 */
export async function runResolvedCardIntent(repository, value) {
  try {
    const intent = validateResolvedCardIntent(value);
    const slots = /** @type {{card_id:string,limit_type?:'monthly_total',amount:{amount_minor:number,currency:'CNY'}}} */ (intent.resolved_slots);
    const cards = await repository.getCards();
    const card = cards.find(candidate => candidate.id === slots.card_id);
    if (!card) throw new CardSkillError('CARD_NOT_FOUND', '当前用户无法访问该卡片');

    if (intent.action === 'card.get') {
      const context = await repository.getContextInfo();
      return { ok: true, data: { kind: 'query', card: structuredClone(card), context: structuredClone(context) } };
    }

    if (intent.action === 'card.set_limit') {
      const amountFen = slots.amount.amount_minor;
      if (card.status !== 'active') throw new CardSkillError('INVALID_STATE', '冻结卡不能调整限额');
      if (amountFen < card.monthlySpentFen) throw new CardSkillError('LIMIT_EXCEEDED', '新限额不能低于本月已消费金额');
      if (amountFen === card.monthlyLimitFen) throw new CardSkillError('INVALID_STATE', '新限额与当前限额相同');
      return {
        ok: true,
        data: {
          kind: 'action_request',
          request: {
            action: 'card.set_limit',
            input: { cardId: card.id, limitType: 'monthly_total', amountFen, currency: 'CNY' },
          },
          requirements: { minimumRiskLevel: 'L2', explicitUserConfirmation: true, executionOwner: 'banking_core' },
        },
      };
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

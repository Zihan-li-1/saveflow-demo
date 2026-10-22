// @ts-check
export const SCENARIO_ACTIONS = Object.freeze(['scenario.create_rule', 'scenario.update_rule', 'scenario.disable_rule', 'scenario.review_event']);
const SAFE_STEP_ACTIONS = new Set(['bill.analyze', 'bill.report', 'subscription.list', 'wealth.recommend', 'wealth.compare', 'card.get']);

export class ScenarioSkillError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = 'ScenarioSkillError'; this.code = code; }
  toJSON() { return { code: this.code, message: this.message, uncertain: false }; }
}
/** @param {unknown} value @returns {value is Record<string, any>} */
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** @param {Record<string, any>} value @param {string[]} allowed @param {string[]} [required] */
function exactKeys(value, allowed, required = allowed) {
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new ScenarioSkillError('VALIDATION_ERROR', '字段缺失或包含未注册字段');
}
/** @param {unknown} value @param {string} field */
function ref(value, field) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new ScenarioSkillError('VALIDATION_ERROR', `${field} 格式无效`); }
/** @param {unknown} value */
function trigger(value) {
  if (!isObject(value)) throw new ScenarioSkillError('VALIDATION_ERROR', 'trigger 必须是对象');
  exactKeys(value, ['type', 'value']);
  if (!['manual', 'date', 'financial_event'].includes(String(value.type)) || typeof value.value !== 'string' || !value.value.trim() || value.value.length > 256) throw new ScenarioSkillError('VALIDATION_ERROR', 'trigger 无效');
}
/** @param {unknown} value */
function conditions(value) {
  if (!isObject(value) || Object.keys(value).length > 20 || Object.values(value).some(item => !['string', 'number', 'boolean'].includes(typeof item))) throw new ScenarioSkillError('VALIDATION_ERROR', 'conditions 只能包含简单条件值');
}
/** @param {unknown} value */
function steps(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) throw new ScenarioSkillError('VALIDATION_ERROR', 'proposed_steps 必须包含 1 到 10 步');
  for (const step of value) {
    if (!isObject(step)) throw new ScenarioSkillError('VALIDATION_ERROR', '步骤必须是对象');
    exactKeys(step, ['action', 'parameters']);
    if (!SAFE_STEP_ACTIONS.has(String(step.action))) throw new ScenarioSkillError('UNSAFE_STEP', '场景规则只能保存只读建议步骤，不能预授权资金或控制变更');
    if (!isObject(step.parameters)) throw new ScenarioSkillError('VALIDATION_ERROR', '步骤 parameters 必须是对象');
  }
}

/** @param {unknown} value @returns {Record<string, any>} */
export function validateScenarioAction(value) {
  if (!isObject(value) || !SCENARIO_ACTIONS.includes(String(value.action))) throw new ScenarioSkillError('UNKNOWN_ACTION', '未注册的跨场景动作');
  if (value.action === 'scenario.create_rule') {
    exactKeys(value, ['action', 'trigger', 'conditions', 'proposed_steps', 'authorization_scope']);
    trigger(value.trigger); conditions(value.conditions); steps(value.proposed_steps);
    if (value.authorization_scope !== 'suggest_only') throw new ScenarioSkillError('VALIDATION_ERROR', '场景规则当前只允许 suggest_only 授权范围');
  } else if (value.action === 'scenario.update_rule') {
    exactKeys(value, ['action', 'rule_ref', 'changes']); ref(value.rule_ref, 'rule_ref');
    if (!isObject(value.changes) || Object.keys(value.changes).length === 0) throw new ScenarioSkillError('VALIDATION_ERROR', 'changes 不能为空');
    exactKeys(value.changes, ['trigger', 'conditions', 'proposed_steps'], []);
    if (Object.hasOwn(value.changes, 'trigger')) trigger(value.changes.trigger);
    if (Object.hasOwn(value.changes, 'conditions')) conditions(value.changes.conditions);
    if (Object.hasOwn(value.changes, 'proposed_steps')) steps(value.changes.proposed_steps);
  } else {
    exactKeys(value, ['action', value.action === 'scenario.disable_rule' ? 'rule_ref' : 'event_ref']);
    ref(value[value.action === 'scenario.disable_rule' ? 'rule_ref' : 'event_ref'], value.action === 'scenario.disable_rule' ? 'rule_ref' : 'event_ref');
  }
  return value;
}

/** @param {Array<Record<string, any>>} [seedEvents] */
export function createInMemoryScenarioStore(seedEvents = []) {
  const rules = new Map();
  const events = new Map(seedEvents.map(event => [event.id, structuredClone(event)]));
  const reviews = new Map();
  return {
    getRule: (/** @type {string} */ id) => structuredClone(rules.get(id)),
    putRule: (/** @type {Record<string, any>} */ rule) => { rules.set(rule.id, structuredClone(rule)); },
    getEvent: (/** @type {string} */ id) => structuredClone(events.get(id)),
    getEventReview: (/** @type {string} */ id) => structuredClone(reviews.get(id)),
    putEventReview: (/** @type {string} */ id, /** @type {Record<string, any>} */ review) => { reviews.set(id, structuredClone(review)); },
  };
}

/** @param {{store:{getRule:(id:string)=>any,putRule:(rule:any)=>any,getEvent:(id:string)=>any,getEventReview?:(id:string)=>any,putEventReview?:(id:string,review:any)=>any},now?:()=>string,id?:()=>string,contextProvider?:()=>any}} dependencies */
export function createScenarioSkill({ store, contextProvider = async () => null }) {
  if (!store || typeof store.getRule !== 'function' || typeof store.getEvent !== 'function') throw new TypeError('Scenario Skill 需要规则与事件 Store');
  return async function runScenarioAction(/** @type {unknown} */ raw) {
    try {
      const input = validateScenarioAction(raw);
      if (input.action === 'scenario.create_rule') {
        const proposed = { status: 'active', trigger: structuredClone(input.trigger), conditions: structuredClone(input.conditions), proposed_steps: structuredClone(input.proposed_steps), authorization_scope: 'suggest_only' };
        return { ok: true, kind: 'scenario_action_request', action: input.action, data: { change: 'create', rule: proposed, requires_confirmation: true, execution_policy: '规则只生成建议；任何写操作仍须重新预览并确认。', request: { action: input.action, input: { trigger: input.trigger, conditions: input.conditions, proposed_steps: input.proposed_steps, authorization_scope: 'suggest_only' } } } };
      }
      if (input.action === 'scenario.update_rule' || input.action === 'scenario.disable_rule') {
        const rule = await store.getRule(input.rule_ref);
        if (!rule) throw new ScenarioSkillError('RULE_NOT_FOUND', '找不到可访问的场景规则');
        const updated = input.action === 'scenario.disable_rule' ? { ...rule, status: 'disabled' } : { ...rule, ...structuredClone(input.changes) };
        return { ok: true, kind: 'scenario_action_request', action: input.action, data: { change: input.action === 'scenario.disable_rule' ? 'disable' : 'update', before: rule, rule: updated, requires_confirmation: true, request: input.action === 'scenario.disable_rule' ? { action: input.action, input: { ruleRef: input.rule_ref } } : { action: input.action, input: { ruleRef: input.rule_ref, changes: input.changes } } } };
      }
      const event = await store.getEvent(input.event_ref);
      if (!event || event.trusted !== true) throw new ScenarioSkillError('EVENT_NOT_TRUSTED', '事件不存在或不是可信事件源，不能触发场景复核');
      const previousReview = typeof store.getEventReview === 'function' ? await store.getEventReview(event.id) : undefined;
      if (previousReview) return { ok: true, kind: 'scenario_event_review', action: input.action, data: { ...previousReview.data, duplicate: true }, evidence: previousReview.evidence };
      const rule = event.rule_ref ? await store.getRule(event.rule_ref) : undefined;
      if (event.rule_ref && (!rule || rule.status !== 'active')) throw new ScenarioSkillError('RULE_INACTIVE', '事件关联规则不存在或已停用');
      const financialContext = await contextProvider();
      const review = { data: { event: structuredClone(event), rule: rule ?? null, financial_context: financialContext, proposed_steps: rule?.proposed_steps ?? [], inherited_confirmation: false, duplicate: false, next_step: '已重新读取当前财务上下文并生成建议；涉及资金或控制变更时必须另行预览和确认。' }, evidence: [{ source: 'trusted_event_store', as_of: event.occurred_at, entity_ids: [event.id, ...(rule ? [rule.id] : [])] }] };
      if (typeof store.putEventReview === 'function') await store.putEventReview(event.id, review);
      return { ok: true, kind: 'scenario_event_review', action: input.action, ...review };
    } catch (error) {
      const safe = error instanceof ScenarioSkillError ? error : new ScenarioSkillError('INTERNAL_ERROR', '跨场景 Skill 未能生成可靠结果');
      return { ok: false, kind: 'skill_error', error: safe.toJSON() };
    }
  };
}

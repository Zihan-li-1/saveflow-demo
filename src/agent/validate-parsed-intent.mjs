import { validCalendarDate, validTimezone } from '../lib/calendar.mjs';
import { validateWealthIntent } from '../skills/wealth/wealth-action-skill.mjs';
import { validatePurchaseAction } from '../skills/scenario/purchase-contract.mjs';
import { transferDirection } from './transfer-direction.mjs';

export const PARSED_INTENT_SCHEMA_VERSION = '1.0.0';
export const PARSED_INTENT_ACTIONS = Object.freeze([
  'transfer.create',
  'bill.summary',
  'subscription.list',
  'card.get',
  'card.set_budget',
  'card.set_controls',
  'card.security_review',
  'card.freeze',
  'card.unfreeze',
  'product.list',
  'wealth.recommend',
  'wealth.compare',
  'wealth.assess_risk',
  'wealth.subscribe',
  'wealth.redeem',
  'scenario.create_rule',
  'scenario.plan_purchase',
  'scenario.update_rule',
  'scenario.disable_rule',
  'scenario.review_event',
  'orchestrator.goal',
  'clarify',
  'unsupported',
]);

const TOP_LEVEL_KEYS = ['schemaVersion', 'action', 'slots', 'missingSlots', 'status', 'choice'];
const TRANSFER_SLOT_KEYS = ['payee_ref', 'amount', 'source_account_ref', 'target_account_ref', 'transfer_type'];
const BILL_SLOT_KEYS = ['month', 'period', 'year', 'monthNumber'];
const CARD_SLOT_KEYS = ['card_ref', 'amount'];
const WEALTH_SLOTS = {
  'wealth.recommend': ['goal', 'constraints'],
  'wealth.compare': ['product_refs'],
  'wealth.assess_risk': ['assessment_scope'],
  'wealth.subscribe': ['product_ref', 'amount', 'source_account_ref'],
  'wealth.redeem': ['holding_ref', 'quantity_or_amount'],
};
const WEALTH_RECOMMEND_SLOT_KEYS = ['goal', 'max_risk_level', 'horizon_days', 'liquidity_requirement', 'amount'];
const SCENARIO_CREATE_SLOT_KEYS = ['trigger', 'conditions', 'proposed_steps', 'authorization_scope'];

export class ParsedIntentValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParsedIntentValidationError';
  }
}

function fail(message) {
  throw new ParsedIntentValidationError(message);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, path) {
  if (!isRecord(value)) fail(`${path} must be an object`);
  return value;
}

function rejectUnknownKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path} contains unknown fields`);
  }
}

function requireNonEmptyString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${path} must be a non-empty string`);
  return value;
}

function requireRawReference(value, path) {
  const reference = requireNonEmptyString(value, path);
  if (path === 'slots.payee_ref' && /^payee[_-][a-z0-9_-]+$/i.test(reference.trim())) {
    fail(`${path} must be a raw user reference, not a payee entity ID`);
  }
  if (path === 'slots.source_account_ref' && /^(acc|account)[_-][a-z0-9_-]+$/i.test(reference.trim())) {
    fail(`${path} must be a raw user reference, not an account entity ID`);
  }
  if (path === 'slots.target_account_ref' && /^(acc|account)[_-][a-z0-9_-]+$/i.test(reference.trim())) {
    fail(`${path} must be a raw user reference, not an account entity ID`);
  }
  if (path === 'slots.card_ref' && /^card[_-][a-z0-9_-]+$/i.test(reference.trim())) {
    fail(`${path} must be a raw user reference, not a card entity ID`);
  }
  if (path === 'slots.product_ref' && /^product[_-][a-z0-9_-]+$/i.test(reference.trim())) fail(`${path} must be a raw user reference`);
  if (path === 'slots.holding_ref' && /^holding[_-][a-z0-9_-]+$/i.test(reference.trim())) fail(`${path} must be a raw user reference`);
  if (path === 'slots.product_refs' && /^product[_-][a-z0-9_-]+$/i.test(reference.trim())) fail(`${path} must be a raw user reference`);
  return reference;
}

function requireMissingSlots(value, expected) {
  if (!Array.isArray(value) || value.some((slot) => typeof slot !== 'string')) {
    fail('missingSlots must be an array of strings');
  }
  const actual = value;
  if (new Set(actual).size !== actual.length) fail('missingSlots must not contain duplicates');
  if (actual.length !== expected.length || expected.some((slot) => !actual.includes(slot))) {
    fail(`missingSlots must exactly match: ${expected.join(', ') || 'none'}`);
  }
}

function requireStatus(value, expected) {
  if (value !== expected) fail(`status must be ${expected}`);
}

function validateAmount(value, { allowZero = false, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const amount = requireRecord(value, 'slots.amount');
  rejectUnknownKeys(amount, ['amount_minor', 'currency'], 'slots.amount');
  if (!Number.isSafeInteger(amount.amount_minor) || amount.amount_minor < (allowZero ? 0 : 1) || amount.amount_minor > maximum) {
    fail('slots.amount.amount_minor is outside the allowed integer minor-unit range');
  }
  if (amount.currency !== 'CNY') fail('slots.amount.currency must be CNY');
}

function validateCard(input, slots) {
  const isLimit = input.action === 'card.set_budget';
  const isControls = input.action === 'card.set_controls';
  const isReview = input.action === 'card.security_review';
  const allowed = isLimit ? CARD_SLOT_KEYS : isControls ? ['card_ref', 'online_payments_enabled', 'blocked_categories', 'alert_amount', 'balance_reminder_amount', 'balance_reminder_percentage'] : isReview ? ['card_ref', 'issue_type'] : ['card_ref'];
  rejectUnknownKeys(slots, allowed, 'slots');
  if ('card_ref' in slots) {
    requireRawReference(slots.card_ref, 'slots.card_ref');
    if (slots.card_ref.length > 128) fail('slots.card_ref must be at most 128 characters');
  }
  if (isLimit) {
    if ('amount' in slots) validateAmount(slots.amount, { allowZero: true, maximum: 10_000_000 });
  }
  if (isControls) {
    if ('online_payments_enabled' in slots && typeof slots.online_payments_enabled !== 'boolean') fail('slots.online_payments_enabled must be boolean');
    if ('blocked_categories' in slots && (!Array.isArray(slots.blocked_categories) || slots.blocked_categories.length > 10 || slots.blocked_categories.some(value => typeof value !== 'string' || !value.trim() || value.length > 32) || new Set(slots.blocked_categories).size !== slots.blocked_categories.length)) fail('slots.blocked_categories is invalid');
    if ('alert_amount' in slots && slots.alert_amount !== null) validateAmount(slots.alert_amount, { maximum: 10_000_000 });
    if ('balance_reminder_amount' in slots && slots.balance_reminder_amount !== null) validateAmount(slots.balance_reminder_amount, { allowZero: true, maximum: 10_000_000 });
    if ('balance_reminder_percentage' in slots && slots.balance_reminder_percentage !== null && (!Number.isSafeInteger(slots.balance_reminder_percentage) || slots.balance_reminder_percentage < 1 || slots.balance_reminder_percentage > 100)) fail('slots.balance_reminder_percentage must be an integer from 1 to 100');
    if (slots.balance_reminder_amount != null && slots.balance_reminder_percentage != null) fail('balance reminder must use amount or percentage, not both');
  }
  if (isReview && 'issue_type' in slots && !['card_details_exposed', 'unauthorized_transaction', 'device_lost'].includes(slots.issue_type)) fail('slots.issue_type is invalid');
  const required = isLimit ? CARD_SLOT_KEYS : isReview ? ['card_ref', 'issue_type'] : ['card_ref'];
  const hasControl = ['online_payments_enabled', 'blocked_categories', 'alert_amount', 'balance_reminder_amount', 'balance_reminder_percentage'].some(key => key in slots);
  if (isControls && 'card_ref' in slots && !hasControl) fail('card.set_controls requires at least one control value');
  const missing = required.filter(slot => !(slot in slots));
  requireMissingSlots(input.missingSlots, missing);
  requireStatus(input.status, missing.length === 0 ? 'ready_for_resolution' : 'needs_clarification');
}

function validateTransfer(input, slots) {
  const internal = 'target_account_ref' in slots;
  const external = 'payee_ref' in slots;
  rejectUnknownKeys(slots, TRANSFER_SLOT_KEYS, 'slots');
  if ('transfer_type' in slots && !['internal', 'external'].includes(slots.transfer_type)) fail('slots.transfer_type must be internal or external');
  if (internal && external) fail('slots must not contain both payee_ref and target_account_ref');
  if ((slots.transfer_type === 'internal' && external) || (slots.transfer_type === 'external' && internal)) fail('transfer_type does not match the receiving party');
  if (external) requireRawReference(slots.payee_ref, 'slots.payee_ref');
  if (internal) requireRawReference(slots.target_account_ref, 'slots.target_account_ref');
  if ('amount' in slots) validateAmount(slots.amount);
  if ('source_account_ref' in slots) requireRawReference(slots.source_account_ref, 'slots.source_account_ref');
  // 对外转账用 payee_ref，本人账户互转用 target_account_ref；两者互斥。
  // 方向判定（含 transfer_type）统一走 transfer-direction.mjs 的权威定义；
  // 上面的 internal/external 仅用于「互斥/匹配」的合法性校验（严格按 *_ref 是否存在）。
  const direction = transferDirection(slots);
  const directionKey = direction === 'internal' ? 'target_account_ref' : direction === 'external' ? 'payee_ref' : 'transfer_type';
  const required = directionKey === 'transfer_type' ? ['transfer_type', 'amount', 'source_account_ref'] : ['amount', 'source_account_ref', directionKey];
  const missing = required.filter((slot) => !(slot in slots));
  requireMissingSlots(input.missingSlots, missing);
  requireStatus(input.status, missing.length === 0 ? 'ready_for_resolution' : 'needs_clarification');
}

function validateBill(input, slots) {
  rejectUnknownKeys(slots, BILL_SLOT_KEYS, 'slots');
  if ('year' in slots && (!Number.isInteger(slots.year) || slots.year < 1900 || slots.year > 2099)) fail('slots.year must be an explicit year');
  if ('monthNumber' in slots && (!Number.isInteger(slots.monthNumber) || slots.monthNumber < 1 || slots.monthNumber > 12)) fail('slots.monthNumber must be 1-12');
  if (('month' in slots || 'period' in slots) && ('year' in slots || 'monthNumber' in slots)) fail('slots.month cannot coexist with partial period slots');
  if ('year' in slots && 'monthNumber' in slots) fail('complete periods must use slots.month');
  if ('month' in slots && 'period' in slots) fail('slots must contain either month or period, not both');
  if ('month' in slots) {
    const month = requireNonEmptyString(slots.month, 'slots.month');
    if (!validCalendarDate(`${month}-01`)) fail('slots.month must use supported YYYY-MM format');
  }
  if ('period' in slots) {
    const period = requireRecord(slots.period, 'slots.period');
    rejectUnknownKeys(period, ['start_date', 'end_date', 'timezone', 'label'], 'slots.period');
    for (const field of ['start_date', 'end_date', 'label']) requireNonEmptyString(period[field], `slots.period.${field}`);
    if (!validTimezone(period.timezone)) fail('slots.period.timezone must be a valid timezone');
    if (!validCalendarDate(period.start_date) || !validCalendarDate(period.end_date) || period.start_date > period.end_date) fail('slots.period date range is invalid');
    const days = (Date.parse(`${period.end_date}T00:00:00Z`) - Date.parse(`${period.start_date}T00:00:00Z`)) / 86_400_000;
    if (days >= 366 || period.label.length > 80) fail('slots.period exceeds the supported range');
  }
  const missing = 'month' in slots || 'period' in slots ? [] : ['month'];
  requireMissingSlots(input.missingSlots, missing);
  requireStatus(input.status, missing.length === 0 ? 'ready_for_resolution' : 'needs_clarification');
}

function validateWealth(input, slots) {
  if (input.action === 'wealth.recommend') {
    rejectUnknownKeys(slots, WEALTH_RECOMMEND_SLOT_KEYS, 'slots');
    if ('goal' in slots) requireNonEmptyString(slots.goal, 'slots.goal');
    if ('max_risk_level' in slots && !['R1', 'R2', 'R3'].includes(slots.max_risk_level)) fail('slots.max_risk_level is invalid');
    if ('horizon_days' in slots && (!Number.isSafeInteger(slots.horizon_days) || slots.horizon_days < 0 || slots.horizon_days > 3650)) fail('slots.horizon_days is invalid');
    if ('liquidity_requirement' in slots && !['T+0', 'T+1', 'AT_MATURITY'].includes(slots.liquidity_requirement)) fail('slots.liquidity_requirement is invalid');
    if ('amount' in slots) validateAmount(slots.amount);
    const required = ['goal', 'max_risk_level', 'horizon_days', 'liquidity_requirement'];
    const missing = required.filter(slot => !(slot in slots));
    requireMissingSlots(input.missingSlots, missing);
    requireStatus(input.status, missing.length ? 'needs_clarification' : 'ready_for_resolution');
    return;
  }
  if (input.action === 'wealth.compare') {
    rejectUnknownKeys(slots, ['product_refs'], 'slots');
    if ('product_refs' in slots && (!Array.isArray(slots.product_refs) || slots.product_refs.length < 2 || slots.product_refs.length > 10 || new Set(slots.product_refs).size !== slots.product_refs.length || slots.product_refs.some(ref => typeof ref !== 'string' || !ref.trim() || ref.length > 128))) fail('slots.product_refs must contain 2-10 unique raw product references');
    const missing = 'product_refs' in slots ? [] : ['product_refs'];
    requireMissingSlots(input.missingSlots, missing); requireStatus(input.status, missing.length ? 'needs_clarification' : 'ready_for_resolution');
    return;
  }
  rejectUnknownKeys(slots, ['assessment_scope'], 'slots');
  if ('assessment_scope' in slots && slots.assessment_scope !== 'investment_suitability') fail('slots.assessment_scope is invalid');
  const missing = 'assessment_scope' in slots ? [] : ['assessment_scope'];
  requireMissingSlots(input.missingSlots, missing); requireStatus(input.status, missing.length ? 'needs_clarification' : 'ready_for_resolution');
}

function validateScenario(input, slots) {
  const action = input.action;
  const validateTrigger = value => {
    const trigger = requireRecord(value, 'slots.trigger'); rejectUnknownKeys(trigger, ['type', 'value'], 'slots.trigger');
    if (!['manual', 'date', 'financial_event'].includes(trigger.type)) fail('slots.trigger.type is invalid');
    requireNonEmptyString(trigger.value, 'slots.trigger.value');
  };
  const validateConditions = value => {
    const conditions = requireRecord(value, 'slots.conditions');
    if (Object.keys(conditions).length > 20 || Object.values(conditions).some(item => !['string', 'number', 'boolean'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item)))) fail('slots.conditions is invalid');
  };
  const validateSteps = value => {
    const safe = ['bill.analyze', 'bill.report', 'subscription.list', 'wealth.recommend', 'wealth.compare', 'card.get'];
    if (!Array.isArray(value) || value.length < 1 || value.length > 10) fail('slots.proposed_steps is invalid');
    for (const candidate of value) {
      const step = requireRecord(candidate, 'slots.proposed_steps[]'); rejectUnknownKeys(step, ['action', 'parameters'], 'slots.proposed_steps[]');
      if (!safe.includes(step.action)) fail('slots.proposed_steps contains an unsafe action');
      requireRecord(step.parameters, 'slots.proposed_steps[].parameters');
    }
  };
  if (action === 'scenario.create_rule') {
    rejectUnknownKeys(slots, SCENARIO_CREATE_SLOT_KEYS, 'slots');
    if ('trigger' in slots) validateTrigger(slots.trigger);
    if ('conditions' in slots) validateConditions(slots.conditions);
    if ('proposed_steps' in slots) validateSteps(slots.proposed_steps);
    if ('authorization_scope' in slots && slots.authorization_scope !== 'suggest_only') fail('slots.authorization_scope must be suggest_only');
    const required = SCENARIO_CREATE_SLOT_KEYS;
    const missing = required.filter(slot => !(slot in slots));
    requireMissingSlots(input.missingSlots, missing); requireStatus(input.status, missing.length ? 'needs_clarification' : 'ready_for_resolution');
    return;
  }
  if (action === 'scenario.update_rule') {
    rejectUnknownKeys(slots, ['rule_ref', 'changes'], 'slots');
    if ('rule_ref' in slots) requireNonEmptyString(slots.rule_ref, 'slots.rule_ref');
    if ('changes' in slots) {
      const changes = requireRecord(slots.changes, 'slots.changes'); rejectUnknownKeys(changes, ['trigger', 'conditions', 'proposed_steps'], 'slots.changes');
      if (!Object.keys(changes).length) fail('slots.changes must not be empty');
      if ('trigger' in changes) validateTrigger(changes.trigger);
      if ('conditions' in changes) validateConditions(changes.conditions);
      if ('proposed_steps' in changes) validateSteps(changes.proposed_steps);
    }
    const missing = ['rule_ref', 'changes'].filter(slot => !(slot in slots));
    requireMissingSlots(input.missingSlots, missing); requireStatus(input.status, missing.length ? 'needs_clarification' : 'ready_for_resolution');
    return;
  }
  const key = action === 'scenario.disable_rule' ? 'rule_ref' : 'event_ref';
  rejectUnknownKeys(slots, [key], 'slots');
  if (key in slots) requireNonEmptyString(slots[key], `slots.${key}`);
  const missing = key in slots ? [] : [key];
  requireMissingSlots(input.missingSlots, missing); requireStatus(input.status, missing.length ? 'needs_clarification' : 'ready_for_resolution');
}

function validateGoal(input, slots) {
  rejectUnknownKeys(slots, ['goal_text', 'horizon', 'constraints', 'amount', 'deadline'], 'slots');
  if ('goal_text' in slots) requireNonEmptyString(slots.goal_text, 'slots.goal_text');
  if ('amount' in slots) validateAmount(slots.amount, { maximum: 100_000_000 });
  if ('deadline' in slots && !validCalendarDate(slots.deadline)) fail('slots.deadline must be a real supported date');
  const missing = 'goal_text' in slots ? [] : ['goal_text'];
  // Goal details are optional for general read-only advice. A model can still
  // explicitly request a precise amount/date while retaining known details.
  if (Array.isArray(input.missingSlots)) for (const slot of input.missingSlots) {
    if (['amount', 'deadline'].includes(slot) && !(slot in slots)) missing.push(slot);
  }
  requireMissingSlots(input.missingSlots, missing); requireStatus(input.status, missing.length ? 'needs_clarification' : 'ready_for_resolution');

}

function validateWealthExtended(input, slots) {
  const action = input.action;
  const allowed = WEALTH_SLOTS[action];
  rejectUnknownKeys(slots, allowed, 'slots');
  // Use the Skill's strict validator only when all required slots are present.
  // This preserves the existing multi-turn parser contract for incomplete requests.
  const required = action === 'wealth.recommend' ? ['goal'] : action === 'wealth.compare' ? ['product_refs'] : allowed;
  const missing = required.filter(slot => !(slot in slots));
  requireMissingSlots(input.missingSlots, missing);
  requireStatus(input.status, missing.length ? 'needs_clarification' : 'ready_for_resolution');
  for (const [key, value] of Object.entries(slots)) {
    if (['product_ref', 'holding_ref', 'source_account_ref'].includes(key)) requireRawReference(value, `slots.${key}`);
    if (key === 'product_refs') {
      if (!Array.isArray(value) || value.length < 2 || value.length > 5 || new Set(value).size !== value.length) fail('slots.product_refs requires 2–5 unique references');
      value.forEach(item => requireRawReference(item, 'slots.product_refs'));
    }
    if (key === 'amount') validateAmount(value, { maximum: 1_000_000_000 });
  }
  if (!missing.length) {
    try { validateWealthIntent({ action, slots }); }
    catch (error) { fail(error instanceof Error ? error.message : 'invalid Wealth intent'); }
  }
}

export function validateParsedIntent(value) {
  const input = requireRecord(value, 'ParsedIntent');
  rejectUnknownKeys(input, TOP_LEVEL_KEYS, 'ParsedIntent');
  if ('choice' in input) {
    const choice = requireRecord(input.choice, 'choice');
    rejectUnknownKeys(choice, ['optionId'], 'choice');
    requireNonEmptyString(choice.optionId, 'choice.optionId');
    if (choice.optionId.length > 128) fail('choice.optionId is too long');
  }
  if (input.schemaVersion !== PARSED_INTENT_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${PARSED_INTENT_SCHEMA_VERSION}`);
  }
  if (typeof input.action !== 'string' || !PARSED_INTENT_ACTIONS.includes(input.action)) {
    fail('action is not registered in ParsedIntent v1');
  }

  const slots = requireRecord(input.slots, 'slots');
  switch (input.action) {
    case 'scenario.plan_purchase':
      try { validatePurchaseAction(input.action, slots); } catch { fail('invalid purchase slots'); }
      if ('funding_account_ref' in slots && /^(?:acc|account)[_-]/i.test(slots.funding_account_ref)) fail('funding_account_ref must be raw user wording');
      requireMissingSlots(input.missingSlots, []);
      requireStatus(input.status, 'ready_for_resolution');
      break;
    case 'transfer.create':
      validateTransfer(input, slots);
      break;
    case 'bill.summary':
      validateBill(input, slots);
      break;
    case 'card.get':
    case 'card.set_budget':
    case 'card.set_controls':
    case 'card.security_review':
    case 'card.freeze':
    case 'card.unfreeze':
      validateCard(input, slots);
      break;
    case 'wealth.recommend':
    case 'wealth.compare':
    case 'wealth.assess_risk':
      if ((input.action === 'wealth.recommend' && typeof slots.goal === 'object') || (input.action === 'wealth.assess_risk' && ['investment', 'portfolio'].includes(slots.assessment_scope))) validateWealthExtended(input, slots);
      else validateWealth(input, slots);
      break;
    case 'wealth.subscribe':
    case 'wealth.redeem':
      validateWealthExtended(input, slots);
      break;
    case 'scenario.create_rule':
    case 'scenario.update_rule':
    case 'scenario.disable_rule':
    case 'scenario.review_event':
      validateScenario(input, slots);
      break;
    case 'orchestrator.goal':
      validateGoal(input, slots);
      break;
    case 'clarify':
      rejectUnknownKeys(slots, [], 'slots');
      requireMissingSlots(input.missingSlots, ['action']);
      requireStatus(input.status, 'needs_clarification');
      break;
    case 'subscription.list':
    case 'product.list':
      rejectUnknownKeys(slots, [], 'slots');
      requireMissingSlots(input.missingSlots, []);
      requireStatus(input.status, 'ready_for_resolution');
      break;
    case 'unsupported':
      rejectUnknownKeys(slots, [], 'slots');
      requireMissingSlots(input.missingSlots, []);
      requireStatus(input.status, 'unsupported');
      break;
  }
  return input;
}

export function isParsedIntent(value) {
  try {
    validateParsedIntent(value);
    return true;
  } catch {
    return false;
  }
}

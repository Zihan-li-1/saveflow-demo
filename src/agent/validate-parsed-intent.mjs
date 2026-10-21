export const PARSED_INTENT_SCHEMA_VERSION = '1.0.0';
export const PARSED_INTENT_ACTIONS = Object.freeze([
  'transfer.create',
  'bill.summary',
  'card.get',
  'card.set_budget',
  'card.freeze',
  'card.unfreeze',
  'wealth.recommend',
  'wealth.compare',
  'wealth.assess_risk',
  'scenario.create_rule',
  'scenario.update_rule',
  'scenario.disable_rule',
  'scenario.review_event',
  'orchestrator.goal',
  'clarify',
  'unsupported',
]);

const TOP_LEVEL_KEYS = ['schemaVersion', 'action', 'slots', 'missingSlots', 'status'];
const TRANSFER_SLOT_KEYS = ['payee_ref', 'amount', 'source_account_ref'];
const BILL_SLOT_KEYS = ['month'];
const CARD_SLOT_KEYS = ['card_ref', 'amount'];
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
  if (path === 'slots.card_ref' && /^card[_-][a-z0-9_-]+$/i.test(reference.trim())) {
    fail(`${path} must be a raw user reference, not a card entity ID`);
  }
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
  rejectUnknownKeys(slots, isLimit ? CARD_SLOT_KEYS : ['card_ref'], 'slots');
  if ('card_ref' in slots) {
    requireRawReference(slots.card_ref, 'slots.card_ref');
    if (slots.card_ref.length > 128) fail('slots.card_ref must be at most 128 characters');
  }
  if (isLimit) {
    if ('amount' in slots) validateAmount(slots.amount, { allowZero: true, maximum: 10_000_000 });
  }
  const required = isLimit ? CARD_SLOT_KEYS : ['card_ref'];
  const missing = required.filter(slot => !(slot in slots));
  requireMissingSlots(input.missingSlots, missing);
  requireStatus(input.status, missing.length === 0 ? 'ready_for_resolution' : 'needs_clarification');
}

function validateTransfer(input, slots) {
  rejectUnknownKeys(slots, TRANSFER_SLOT_KEYS, 'slots');
  if ('payee_ref' in slots) requireRawReference(slots.payee_ref, 'slots.payee_ref');
  if ('amount' in slots) validateAmount(slots.amount);
  if ('source_account_ref' in slots) requireRawReference(slots.source_account_ref, 'slots.source_account_ref');
  const missing = TRANSFER_SLOT_KEYS.filter((slot) => !(slot in slots));
  requireMissingSlots(input.missingSlots, missing);
  requireStatus(input.status, missing.length === 0 ? 'ready_for_resolution' : 'needs_clarification');
}

function validateBill(input, slots) {
  rejectUnknownKeys(slots, BILL_SLOT_KEYS, 'slots');
  if ('month' in slots) {
    const month = requireNonEmptyString(slots.month, 'slots.month');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('slots.month must use YYYY-MM format');
  }
  const missing = 'month' in slots ? [] : ['month'];
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
  rejectUnknownKeys(slots, ['goal_text', 'horizon', 'constraints'], 'slots');
  if ('goal_text' in slots) requireNonEmptyString(slots.goal_text, 'slots.goal_text');
  const missing = 'goal_text' in slots ? [] : ['goal_text'];
  requireMissingSlots(input.missingSlots, missing); requireStatus(input.status, missing.length ? 'needs_clarification' : 'ready_for_resolution');
}

export function validateParsedIntent(value) {
  const input = requireRecord(value, 'ParsedIntent');
  rejectUnknownKeys(input, TOP_LEVEL_KEYS, 'ParsedIntent');
  if (input.schemaVersion !== PARSED_INTENT_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${PARSED_INTENT_SCHEMA_VERSION}`);
  }
  if (typeof input.action !== 'string' || !PARSED_INTENT_ACTIONS.includes(input.action)) {
    fail('action is not registered in ParsedIntent v1');
  }

  const slots = requireRecord(input.slots, 'slots');
  switch (input.action) {
    case 'transfer.create':
      validateTransfer(input, slots);
      break;
    case 'bill.summary':
      validateBill(input, slots);
      break;
    case 'card.get':
    case 'card.set_budget':
    case 'card.freeze':
    case 'card.unfreeze':
      validateCard(input, slots);
      break;
    case 'wealth.recommend':
    case 'wealth.compare':
    case 'wealth.assess_risk':
      validateWealth(input, slots);
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

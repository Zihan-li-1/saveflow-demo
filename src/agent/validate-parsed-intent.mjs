export const PARSED_INTENT_SCHEMA_VERSION = '1.0.0';
export const PARSED_INTENT_ACTIONS = Object.freeze([
  'transfer.create',
  'bill.summary',
  'card.get',
  'card.set_budget',
  'card.freeze',
  'card.unfreeze',
  'clarify',
  'unsupported',
]);

const TOP_LEVEL_KEYS = ['schemaVersion', 'action', 'slots', 'missingSlots', 'status'];
const TRANSFER_SLOT_KEYS = ['payee_ref', 'amount', 'source_account_ref'];
const BILL_SLOT_KEYS = ['month'];
const CARD_SLOT_KEYS = ['card_ref', 'amount'];

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

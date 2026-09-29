import { validateParsedIntent } from '../validate-parsed-intent.mjs';

const required = {
  'transfer.create': ['payee_ref', 'amount', 'source_account_ref'],
  'bill.summary': ['month'],
};

export function buildParsedIntent(action, slots) {
  const needed = required[action] ?? [];
  const missingSlots = needed.filter(slot => slots[slot] === undefined || slots[slot] === null || slots[slot] === '');
  const candidate = {
    schemaVersion: '1.0.0', action, slots, missingSlots,
    status: missingSlots.length ? 'needs_clarification' : 'ready_for_resolution',
  };
  return validateParsedIntent(candidate);
}

export function mergeSlots(slots, updates) {
  const merged = { ...slots, ...updates };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged;
}

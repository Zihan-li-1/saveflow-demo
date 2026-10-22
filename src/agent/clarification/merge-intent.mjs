import { validateParsedIntent } from '../validate-parsed-intent.mjs';

const required = {
  'transfer.create': ['payee_ref', 'amount', 'source_account_ref'],
  'bill.summary': ['month'],
  'card.get': ['card_ref'],
  'card.set_budget': ['card_ref', 'amount'],
  'card.set_controls': ['card_ref'],
  'card.security_review': ['card_ref', 'issue_type'],
  'card.freeze': ['card_ref'],
  'card.unfreeze': ['card_ref'],
  'wealth.recommend': ['goal', 'max_risk_level', 'horizon_days', 'liquidity_requirement'],
  'wealth.compare': ['product_refs'],
  'wealth.subscribe': ['product_ref', 'amount', 'source_account_ref'],
  'wealth.redeem': ['holding_ref', 'quantity_or_amount'],
  'wealth.assess_risk': ['assessment_scope'],
  'scenario.create_rule': ['trigger', 'conditions', 'proposed_steps', 'authorization_scope'],
  'scenario.update_rule': ['rule_ref', 'changes'],
  'scenario.disable_rule': ['rule_ref'],
  'scenario.review_event': ['event_ref'],
  'orchestrator.goal': ['goal_text'],
};

export function buildParsedIntent(action, slots) {
  const needed = required[action] ?? [];
  const missingSlots = action === 'bill.summary' && (slots.month !== undefined || slots.period !== undefined) ? [] : needed.filter(slot => slots[slot] === undefined || slots[slot] === null || slots[slot] === '');
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

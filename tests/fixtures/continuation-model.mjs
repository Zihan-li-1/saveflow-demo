// Offline transport fixture for pre-existing workflow regression tests only.
// This is not an understanding implementation or evidence of model semantics.
import { parseClarificationAnswer } from '../../server/banking-clarification-parser.mjs';
import { buildParsedIntent, mergeSlots } from '../../src/agent/clarification/merge-intent.mjs';
import { resolveChoice } from '../../src/agent/clarification/choice-resolver.mjs';

export function continuationModel(message, { context }) {
  if (message === '查账单') return buildParsedIntent('bill.summary', {});
  const selected = resolveChoice(message, context.choices ?? []);
  if (selected) return { ...buildParsedIntent(context.action, { ...context.slots, [context.pendingSlot]: selected.rawValue }), choice: { optionId: selected.optionId } };
  const answer = parseClarificationAnswer(message, { action: context.action, slot: context.pendingSlot, slots: context.slots, choices: [] });
  return buildParsedIntent(context.action, answer.kind === 'slot' ? mergeSlots(context.slots, answer.updates) : context.slots);
}

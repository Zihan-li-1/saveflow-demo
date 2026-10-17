import { randomUUID } from 'node:crypto';
import { resolveCardReference, runResolvedCardIntent, validateCardIntent } from '../../skills/card/card-skill.mjs';

/** Resolve a validated card intent against the current repository. No card write is executed here. */
export async function handleCard(intent, repository, selections = {}) {
  validateCardIntent({ action: intent.action, slots: intent.slots });
  const selected = selections.card_ref;
  const resolution = selected?.entityId
    ? { kind: 'resolved', cardId: selected.entityId, reference: { slot: 'card_ref', entity_type: 'card', entity_id: selected.entityId, source: 'user_selection' } }
    : await resolveCardReference(repository, intent.slots.card_ref);
  if (resolution.kind !== 'resolved') {
    return { ok: false, kind: 'needs_clarification', action: intent.action, source: 'resolver', slot: 'card_ref', question: resolution.reason === 'CARD_AMBIGUOUS' ? '找到多张同名卡，请选择。' : '请选择要操作的卡片。', candidates: resolution.candidates };
  }

  const resolvedSlots = { card_id: resolution.cardId };
  if (intent.action === 'card.set_budget') {
    resolvedSlots.amount = intent.slots.amount;
  }
  const result = await runResolvedCardIntent(repository, {
    intent_id: `intent_${randomUUID()}`, action: intent.action, state: 'ready_for_planning',
    resolved_slots: resolvedSlots, references: [resolution.reference], missing_slots: [],
  });
  if (!result.ok) return { ok: false, kind: 'card_error', action: intent.action, error: result.error };

  const context = await repository.getContextInfo();
  const evidence = [{ source: context.dataSource, asOf: context.asOf, entityIds: [resolution.cardId] }];
  if (result.data.kind === 'query') {
    return { ok: true, kind: 'card_result', action: intent.action, data: result.data, evidence };
  }

  return {
    ok: true, kind: 'card_action_request', action: intent.action,
    data: { ...result.data, evidence },
  };
}

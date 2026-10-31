import { ConversationContext } from './contracts.mjs';
import { redact, containsSecrets } from '../agent-framework/safety.mjs';

export function routingContext(run, trusted = {}) {
  const steps = run?.routing?.execution_plan?.steps ?? run?.plan?.steps ?? [];
  const collected = Object.fromEntries(steps.slice(0, 10).map(step => [step.step_id, step.arguments]));
  if (run?.request?.arguments) collected.current = run.request.arguments;
  if (trusted.slots) collected.current = trusted.slots;
  const known = Object.fromEntries(Object.values(collected).flatMap(args => Object.entries(args ?? {}).filter(([key]) => key.endsWith('_ref') || key === 'product_refs')));
  const candidate = {
    active_goal: String(trusted.active_goal ?? run?.original_query ?? '').slice(0, 4000), known_entities: known, collected_parameters: collected,
    previous_intent: trusted.action ?? run?.intent ?? null,
    pending_question: (trusted.pendingSlot ? [trusted.pendingSlot] : run?.missing_fields ?? []).slice(0, 20), pending_step: run?.current_step ?? null,
    state: run?.state ?? null, plan: steps.slice(0, 10).map(step => ({ step_id: step.step_id, skill_name: step.skill_name, status: step.status ?? 'pending' })),
  };
  // Never include run IDs, tokens, raw results, full history or confirmation credentials in the LLM context.
  return ConversationContext.parse(containsSecrets(candidate) ? { ...candidate, known_entities: {}, collected_parameters: {} } : redact(candidate));
}

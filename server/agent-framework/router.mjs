import { IntentUnderstanding } from '../intent-routing/service.mjs';

// Explicit structured requests remain deterministic. Natural language uses the isolated semantic pipeline.
export class IntentRouter {
  constructor({ registry, model, now, timezone, traceOptions } = {}) {
    this.registry = registry;
    this.understanding = registry ? new IntentUnderstanding({ registry, model, now, timezone, traceOptions }) : null;
  }
  async route(request, context = {}) {
    let selected = request.skill_name;
    if (!selected && request.arguments?.action) {
      selected = this.registry?.list().find(def => def.capabilities?.some(cap => cap.action === request.arguments.action))?.name;
      // Unknown explicit actions remain subject to the host registry validation.
      if (!selected) selected = request.arguments.action.split('.')[0];
    }
    if (selected || request.steps) return { intent: selected ?? 'explicit_sequence', confidence: 1, selected_skills: request.steps?.map(step => step.skill_name) ?? [selected], extracted_arguments: structuredClone(request.arguments), missing_fields: [], requires_confirmation: false };
    if (!this.understanding) return { intent: 'unknown', confidence: 0, selected_skills: [], extracted_arguments: {}, missing_fields: ['skill_name'], requires_confirmation: false };
    const result = await this.understanding.route(request.query, context);
    return { ...result, intent: result.intent_analysis?.normalized_intent ?? 'unknown', confidence: result.decision === 'MATCHED' ? 1 : 0,
      extracted_arguments: result.execution_plan.steps[0]?.arguments ?? {}, requires_confirmation: result.execution_plan.steps.some(step => this.registry.get(step.skill_name).operation(step.arguments) !== 'READ_ONLY') };
  }
}

import { matchingSchema, RoutingError, validateStage } from './contracts.mjs';
export class CapabilityMatcher {
  constructor(model) { this.model = model; }
  async match(analysis, definitions, signal) {
    const schema = matchingSchema(definitions);
    const result = validateStage(schema, await this.model.complete('matching', { intent_analysis: analysis, skill_definitions: definitions }, schema, signal), 'matching');
    const tasks = new Set(analysis.tasks.map(task => task.task_id)); const seen = new Set();
    for (const item of [...result.matches, ...result.unmatched_tasks]) {
      if (!tasks.has(item.task_id) || seen.has(item.task_id)) throw new RoutingError('matching', 'TASK_COVERAGE_MISMATCH');
      seen.add(item.task_id);
      if (item.skill_name && !definitions.find(def => def.name === item.skill_name)?.capabilities.some(cap => cap.id === item.capability)) throw new RoutingError('matching', 'UNREGISTERED_CAPABILITY');
    }
    if (seen.size !== tasks.size) throw new RoutingError('matching', 'TASK_COVERAGE_MISMATCH');
    return result;
  }
}

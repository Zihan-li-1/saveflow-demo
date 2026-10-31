import { randomUUID } from 'node:crypto';
import { StepInput } from '../agent-framework/models.mjs';
import { RoutingError } from './contracts.mjs';
import { containsSecrets } from '../agent-framework/safety.mjs';

export function validateTaskGraph(analysis) {
  const tasks = new Map(analysis.tasks.map(task => [task.task_id, task]));
  if (tasks.size !== analysis.tasks.length) throw new RoutingError('understanding', 'INVALID_TASK_GRAPH');
  const sorted = []; const active = new Set(); const done = new Set();
  function visit(task) {
    if (done.has(task.task_id)) return;
    if (active.has(task.task_id)) throw new RoutingError('understanding', 'INVALID_TASK_GRAPH');
    active.add(task.task_id);
    for (const dep of task.depends_on) { if (!tasks.has(dep)) throw new RoutingError('understanding', 'INVALID_TASK_GRAPH'); visit(tasks.get(dep)); }
    active.delete(task.task_id); done.add(task.task_id); sorted.push(task);
  }
  analysis.tasks.forEach(visit); return sorted;
}
function evidenceValid(item, value, { message, context, calendar }, schema) {
  if (item.source === 'contract') return schema.properties?.[item.field]?.const === value;
  if (item.source === 'calendar') return item.field === 'month' && typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && !!calendar.currentDate && item.quote.length > 0 && message.includes(item.quote);
  if (item.source === 'context') return Object.values(context.collected_parameters).some(args => JSON.stringify(args?.[item.field]) === JSON.stringify(value));
  if (!item.quote || !message.includes(item.quote)) return false;
  if (item.field.endsWith('_ref')) return typeof value === 'string' && item.quote.includes(value);
  if (item.field === 'product_refs') return Array.isArray(value) && value.every(ref => typeof ref === 'string' && message.includes(ref));
  return true; // Semantic number/date conversion is proposed by the model; Adapter validates its domain contract.
}
export class TaskPlanner {
  constructor(registry) { this.registry = registry; }
  build(analysis, matching, extracted, definitions, grounding) {
    const tasks = validateTaskGraph(analysis); const entries = new Map();
    for (const item of extracted.tasks) { if (entries.has(item.task_id) || !matching.matches.some(match => match.task_id === item.task_id)) throw new RoutingError('extraction', 'TASK_COVERAGE_MISMATCH'); entries.set(item.task_id, item); }
    if (entries.size !== matching.matches.length) throw new RoutingError('extraction', 'TASK_COVERAGE_MISMATCH');
    const missing = []; const steps = [];
    for (const task of tasks) {
      const match = matching.matches.find(item => item.task_id === task.task_id);
      if (!match) continue;
      const cap = definitions.find(def => def.name === match.skill_name).capabilities.find(item => item.id === match.capability);
      const extractedTask = entries.get(task.task_id); const args = { ...extractedTask.arguments };
      const invalid = [];
      if (args.action && args.action !== cap.action) invalid.push('action');
      delete args.action;
      for (const [field, value] of Object.entries(args)) {
        if (containsSecrets({ [field]: value }) || !Object.hasOwn(cap.input_schema.properties, field) || !extractedTask.evidence.some(item => item.field === field && evidenceValid(item, value, grounding, cap.input_schema))) { delete args[field]; invalid.push(field); }
      }
      args.action = cap.action; // action comes exclusively from the Registry match.
      const adapter = this.registry.get(match.skill_name);
      const validation = adapter.validate({ request_id: randomUUID(), run_id: randomUUID(), step_id: task.task_id, idempotency_key: randomUUID(), arguments: args });
      const fields = [...new Set([...invalid, ...extractedTask.missing_fields, ...(validation.missing_fields ?? [])])];
      if (!validation.valid && !fields.length) fields.push('arguments');
      for (const field of fields) missing.push({ task_id: task.task_id, field, question: `请补充或核对 ${match.skill_name} 的 ${field}。` });
      // An unsupported predecessor remains in the partial draft; it is a capability
      // gap, not a field the user can fill. The host never executes partial drafts.
      steps.push(StepInput.parse({ step_id: task.task_id, skill_name: match.skill_name, arguments: args, dependencies: task.depends_on, mappings: [] }));
    }
    return { steps, missing };
  }
}

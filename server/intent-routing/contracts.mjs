import { z } from 'zod';
const text = z.string().min(1).max(1000);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const record = z.record(z.string(), z.unknown());
export const RouteDecision = z.enum(['MATCHED', 'CLARIFICATION_REQUIRED', 'PARTIALLY_SUPPORTED', 'UNSUPPORTED']);
export const IntentAnalysis = z.object({
  user_goal: text, normalized_intent: text,
  tasks: z.array(z.object({ task_id: id, goal: text, required_capability: text, depends_on: z.array(id).max(10) }).strict()).max(10),
  entities: record, constraints: record,
  missing_information: z.array(z.object({ task_id: id.nullable(), field: text, question: text }).strict()).max(20),
  unsupported_parts: z.array(z.object({ capability: text, reason: text }).strict()).max(10),
}).strict();
export const ConversationContext = z.object({
  active_goal: z.string().max(4000), known_entities: record, collected_parameters: record,
  previous_intent: z.string().nullable(), pending_question: z.array(z.string()).max(20), pending_step: z.string().nullable(),
  state: z.string().nullable(), plan: z.array(record).max(10),
}).strict();
export const ParameterExtraction = z.object({ tasks: z.array(z.object({
  task_id: id, arguments: record,
  evidence: z.array(z.object({ field: text, source: z.enum(['user_message', 'context', 'calendar', 'contract']), quote: z.string().max(1000) }).strict()).max(30),
  missing_fields: z.array(text).max(20),
}).strict()).max(10) }).strict();
export function matchingSchema(definitions) {
  const names = definitions.map(item => item.name);
  const capabilities = definitions.flatMap(item => item.capabilities.map(cap => cap.id));
  return z.object({ matches: z.array(z.object({ task_id: id, skill_name: names.length ? z.enum(names) : z.never(), capability: capabilities.length ? z.enum(capabilities) : z.never(), confidence: z.number().min(0).max(1), reason: text }).strict()).max(10),
    unmatched_tasks: z.array(z.object({ task_id: id, capability: text, reason: text, clarification_required: z.boolean() }).strict()).max(10) }).strict();
}
export class RoutingError extends Error {
  constructor(stage, code) { super(code); this.stage = stage; this.code = code; }
}
export function validateStage(schema, value, stage) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RoutingError(stage, 'INVALID_STRUCTURED_OUTPUT');
  return parsed.data;
}

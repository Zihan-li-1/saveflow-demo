import { z } from 'zod';

export const STATES = ['CREATED', 'UNDERSTANDING', 'COLLECTING_INPUT', 'PLANNING', 'READY_TO_EXECUTE', 'WAITING_CONFIRMATION', 'EXECUTING', 'AGGREGATING', 'SUCCEEDED', 'FAILED', 'CANCELLED'];
export const ERROR_CODES = ['INVALID_REQUEST', 'MISSING_REQUIRED_FIELD', 'SKILL_NOT_FOUND', 'SKILL_VALIDATION_FAILED', 'SKILL_TIMEOUT', 'SKILL_EXECUTION_FAILED', 'CONFIRMATION_REQUIRED', 'CONFIRMATION_MISMATCH', 'INVALID_STATE_TRANSITION', 'DUPLICATE_REQUEST', 'EXTERNAL_SERVICE_ERROR', 'INTERNAL_ERROR', 'RUN_NOT_FOUND', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_READY'];
export class AgentError extends Error {
  constructor(code, details = {}) { super(code); this.code = ERROR_CODES.includes(code) ? code : 'INTERNAL_ERROR'; this.details = details; }
  toJSON() { return { code: this.code, message: this.code, ...this.details }; }
}
export const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const args = z.record(z.string(), z.unknown());
export const StepInput = z.object({ step_id: id, skill_name: id, arguments: args, dependencies: z.array(id).default([]), mappings: z.array(z.object({ from_step: id, from_field: z.string().regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/), to_field: id }).strict()).default([]) }).strict();
export const AgentRequest = z.object({ session_id: id, query: z.string().min(1).max(4000), skill_name: id.optional(), arguments: args.default({}), steps: z.array(StepInput).min(1).max(10).optional() }).strict();
export const SkillRequest = z.object({ request_id: id, run_id: id, step_id: id, idempotency_key: id, arguments: args });
export const SkillResult = z.object({ status: z.enum(['succeeded', 'failed', 'partial']), data: z.unknown(), user_message: z.string(), error: z.unknown().nullable(), retryable: z.boolean(), metadata: args, audit: z.array(args) });
export const SkillDefinition = z.object({ name: id, version: z.string(), description: z.string(), input_schema: args, output_schema: args, operation_type: z.enum(['READ_ONLY', 'WRITE', 'SENSITIVE_WRITE']) });
export const ExecutionStep = StepInput.extend({ status: z.enum(['pending', 'running', 'succeeded', 'failed', 'partial']), result: z.unknown().nullable(), error: z.unknown().nullable() });
export const ExecutionPlan = z.object({ steps: z.array(ExecutionStep) });
export const AuditEvent = z.object({ event: z.string(), run_id: id, at: z.string(), version: z.number().int(), from: z.enum(STATES), to: z.enum(STATES) });
export const AgentRun = z.object({ run_id: id, user_id: id, session_id: id, original_query: z.string(), intent: z.string().nullable(), state: z.enum(STATES), plan: ExecutionPlan.nullable(), current_step: id.nullable(), result: z.unknown().nullable(), error: z.unknown().nullable(), created_at: z.string(), updated_at: z.string(), version: z.number().int(), audit: z.array(AuditEvent), confirmations: z.array(args) }).passthrough();
export const AgentResponse = z.object({ request_id: id, run_id: id.nullable(), state: z.string().nullable(), data: z.unknown(), error: z.unknown().nullable() });
export const fail = (code, details) => { throw new AgentError(code, details); };

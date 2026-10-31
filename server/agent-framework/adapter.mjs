import { z } from 'zod';
import { SkillRequest, SkillResult } from './models.mjs';
import { redact, containsSecrets } from './safety.mjs';

export class SkillAdapter {
  constructor({ name, description, schema, invoke, health, operation = () => 'READ_ONLY', version = '1.0.0', validate }) {
    Object.assign(this, { name, description, schema, invoke, health, operation, version, businessValidate: validate });
    this.operation_type = 'READ_ONLY';
  }
  definition() { return { name: this.name, version: this.version, description: this.description, input_schema: z.toJSONSchema(this.schema), output_schema: z.toJSONSchema(SkillResult), operation_type: this.operation_type }; }
  validate(request) {
    if (!SkillRequest.safeParse(request).success || containsSecrets(request.arguments)) return { valid: false, missing_fields: [], error: { code: 'INVALID_REQUEST' } };
    if (!request.arguments.action && this.schema.type === 'union') return { valid: false, missing_fields: ['action'], error: { code: 'MISSING_REQUIRED_FIELD' } };
    const parsed = this.schema.safeParse(request.arguments);
    if (!parsed.success) {
      const missing = parsed.error.issues.filter(issue => issue.code === 'invalid_type' && issue.path.reduce((obj, key) => obj?.[key], request.arguments) === undefined).map(issue => issue.path.join('.'));
      return { valid: false, missing_fields: missing, error: { code: missing.length ? 'MISSING_REQUIRED_FIELD' : 'SKILL_VALIDATION_FAILED' } };
    }
    try { this.businessValidate?.(parsed.data); } catch { return { valid: false, missing_fields: [], error: { code: 'SKILL_VALIDATION_FAILED' } }; }
    return { valid: true, arguments: parsed.data, missing_fields: [] };
  }
  async health_check() { try { await this.health(); return { status: 'ready' }; } catch { return { status: 'unavailable' }; } }
  async execute(request) {
    const validation = this.validate(request);
    if (!validation.valid) return this.failure(validation.error.code, false, { missing_fields: validation.missing_fields });
    try {
      const raw = await this.invoke(validation.arguments, request);
      if (raw?.kind === 'needs_clarification') return this.failure('MISSING_REQUIRED_FIELD', false, { missing_fields: raw.missingSlots ?? [raw.slot ?? 'arguments'] });
      if (raw?.ok !== true) return this.failure('SKILL_EXECUTION_FAILED', false);
      // action_request / transfer_resolution are proposals, never payment receipts.
      return { status: 'succeeded', data: redact(raw.data), user_message: 'Skill 调用完成；操作提案不代表金融操作已执行。', error: null, retryable: false,
        metadata: { kind: raw.kind ?? raw.data?.kind, evidence: redact(raw.evidence ?? []), financial_execution: false }, audit: [{ event: 'skill_completed', request_id: request.request_id, run_id: request.run_id, step_id: request.step_id }] };
    } catch (error) {
      const retryable = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'PLATFORM_UNAVAILABLE'].includes(error?.code);
      return this.failure(retryable ? 'EXTERNAL_SERVICE_ERROR' : 'SKILL_EXECUTION_FAILED', retryable);
    }
  }
  failure(code, retryable = false, metadata = {}) { return { status: 'failed', data: null, user_message: code, error: { code, message: code }, retryable, metadata, audit: [] }; }
}

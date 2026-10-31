import { randomUUID } from 'node:crypto';
import { AgentError, AgentRequest, StepInput, SkillResult, fail, id } from './models.mjs';
import { AgentStateMachine } from './state-machine.mjs';
import { IntentRouter } from './router.mjs';
import { ResultAggregator } from './aggregator.mjs';
import { digest, redact, containsSecrets } from './safety.mjs';

const terminal = state => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(state);
const blankStep = step => ({ ...step, status: 'pending', result: null, error: null });
const safeError = error => error instanceof AgentError ? error.toJSON() : { code: 'INTERNAL_ERROR', message: 'INTERNAL_ERROR' };
export class AgentOrchestrator {
  constructor({ registry, repository, router = new IntentRouter(), machine = new AgentStateMachine(), aggregator = new ResultAggregator(), timeoutMs = 5000, maxRetries = 1 }) {
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3 || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) fail('INVALID_REQUEST');
    Object.assign(this, { registry, repository, router, machine, aggregator, timeoutMs, maxRetries });
  }
  async save(run) { await this.repository.save(run, run.version); }
  async transition(run, state) { this.machine.transition(run, state); await this.save(run); }
  async create(owner, raw, key, requestId = randomUUID()) {
    const parsed = AgentRequest.safeParse(raw);
    if (!parsed.success || !id.safeParse(owner).success || !id.safeParse(key).success || containsSecrets(raw)) fail('INVALID_REQUEST');
    if (raw.steps && raw.skill_name) fail('INVALID_REQUEST');
    const request = parsed.data;
    const now = new Date().toISOString();
    const created = await this.repository.create({ run_id: randomUUID(), user_id: owner, session_id: request.session_id, original_query: redact(request.query), intent: null,
      state: 'CREATED', plan: null, current_step: null, result: null, error: null, created_at: now, updated_at: now, version: 0,
      request, request_id: requestId, audit: [], confirmations: [], executions: {}, busy: true, missing_fields: [] }, digest(key), digest(request));
    if (!created.created) return created.run; // Query existing execution; never replay on client retry.
    const run = created.run;
    return this.guarded(run, async () => { await this.transition(run, 'UNDERSTANDING'); await this.plan(run); });
  }
  async get(owner, runId) { const run = await this.repository.get(owner, runId); run.cancel_requested = await this.repository.cancellationRequested(owner, runId); return run; }
  async claim(owner, runId, state) {
    const run = await this.get(owner, runId);
    if (terminal(run.state) || (state && run.state !== state)) fail('INVALID_STATE_TRANSITION');
    if (run.busy) fail('DUPLICATE_REQUEST');
    run.busy = true; await this.save(run); return run;
  }
  async guarded(run, work) {
    try { await work(); }
    catch (error) {
      if (error?.code === 'DUPLICATE_REQUEST') throw error;
      if (['UNDERSTANDING', 'PLANNING', 'EXECUTING', 'AGGREGATING'].includes(run.state)) { run.error = safeError(error); await this.transition(run, 'FAILED'); }
      else throw error;
    } finally { run.busy = false; await this.save(run); }
    return run;
  }
  skillRequest(run, step, argumentsValue = step.arguments) {
    return { request_id: run.request_id, run_id: run.run_id, step_id: step.step_id, idempotency_key: digest({ run: run.run_id, step: step.step_id, args: argumentsValue }), arguments: argumentsValue };
  }
  async plan(run) {
    const routed = await this.router.route(structuredClone(run.request));
    run.intent = typeof routed.intent === 'string' ? routed.intent : 'unknown';
    if (!Number.isFinite(routed.confidence) || routed.confidence < 0.8 || !Array.isArray(routed.selected_skills) || !routed.selected_skills.length) {
      run.missing_fields = ['skill_name'];
      if (run.state !== 'COLLECTING_INPUT') await this.transition(run, 'COLLECTING_INPUT');
      return;
    }
    if (run.state !== 'PLANNING') await this.transition(run, 'PLANNING');
    const inputs = run.request.steps ?? [{ step_id: 'step_1', skill_name: routed.selected_skills[0], arguments: routed.extracted_arguments, dependencies: [], mappings: [] }];
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 10 || (!run.request.steps && routed.selected_skills.length !== 1)) fail('INVALID_REQUEST');
    const previous = run.plan;
    const steps = inputs.map(input => { const parsed = StepInput.safeParse(input); if (!parsed.success) fail('INVALID_REQUEST'); return blankStep(parsed.data); });
    const seen = new Set(); const missing = [];
    for (const step of steps) {
      if (seen.has(step.step_id) || step.dependencies.some(dep => !seen.has(dep))) fail('INVALID_REQUEST');
      const adapter = this.registry.get(step.skill_name);
      if (containsSecrets(step.arguments)) fail('INVALID_REQUEST');
      const targets = new Set();
      for (const map of step.mappings) {
        if (!step.dependencies.includes(map.from_step) || !seen.has(map.from_step) || targets.has(map.to_field) || ['__proto__', 'constructor', 'prototype', 'action'].includes(map.to_field) || map.from_field.split('.').some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) fail('INVALID_REQUEST');
        if (Object.hasOwn(step.arguments, map.to_field)) fail('INVALID_REQUEST'); targets.add(map.to_field);
      }
      if (!['READ_ONLY', 'WRITE', 'SENSITIVE_WRITE'].includes(adapter.operation(step.arguments))) fail('INVALID_REQUEST');
      // A dynamic write must not be confirmed before its concrete arguments exist.
      if (step.mappings.length && adapter.operation(step.arguments) !== 'READ_ONLY') fail('INVALID_REQUEST');
      const validation = adapter.validate(this.skillRequest(run, step));
      if (!validation.valid) {
        const unresolved = validation.missing_fields.filter(field => !targets.has(field.split('.')[0]));
        if (validation.error.code !== 'MISSING_REQUIRED_FIELD') fail(validation.error.code);
        missing.push(...unresolved.map(field => `${step.step_id}.${field}`));
      }
      const old = previous?.steps.find(item => item.step_id === step.step_id && item.skill_name === step.skill_name && digest(item.arguments) === digest(step.arguments) && digest(item.mappings) === digest(step.mappings));
      if (old?.status === 'succeeded') Object.assign(step, old);
      seen.add(step.step_id);
    }
    run.plan = { steps }; run.missing_fields = missing; run.error = null; run.confirmations = [];
    if (missing.length) { await this.transition(run, 'COLLECTING_INPUT'); return; }
    await this.transition(run, 'READY_TO_EXECUTE');
    for (const step of steps.filter(item => item.status !== 'succeeded')) {
      const adapter = this.registry.get(step.skill_name); const operation = adapter.operation(step.arguments);
      if (operation !== 'READ_ONLY') run.confirmations.push({ run_id: run.run_id, step_id: step.step_id, operation_type: operation,
        operation_summary: `${adapter.name}: ${step.arguments.action}; ${adapter.description}`, arguments_digest: digest(step.arguments),
        idempotency_key: this.skillRequest(run, step).idempotency_key, confirmation_status: 'pending', confirmed_at: null });
    }
    if (run.confirmations.length) await this.transition(run, 'WAITING_CONFIRMATION');
    else await this.execute(run);
  }
  async input(owner, runId, input, requestId = randomUUID()) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['arguments', 'skill_name', 'step_id'].includes(key)) || containsSecrets(input)) fail('INVALID_REQUEST');
    if (input.arguments !== undefined && (!input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments))) fail('INVALID_REQUEST');
    const run = await this.claim(owner, runId, 'COLLECTING_INPUT');
    return this.guarded(run, async () => {
      run.request_id = requestId;
      const candidate = structuredClone(run.request);
      if (candidate.steps) {
        const step = candidate.steps.find(item => item.step_id === input.step_id);
        if (!step || run.plan?.steps.find(item => item.step_id === input.step_id)?.status === 'succeeded') fail('INVALID_REQUEST');
        step.arguments = { ...step.arguments, ...input.arguments };
      } else {
        candidate.arguments = { ...candidate.arguments, ...input.arguments };
        if (input.skill_name) candidate.skill_name = input.skill_name;
      }
      if (!AgentRequest.safeParse(candidate).success) fail('INVALID_REQUEST');
      run.request = candidate;
      await this.plan(run);
    });
  }
  async confirm(owner, runId, input, requestId = randomUUID()) {
    const run = await this.claim(owner, runId, 'WAITING_CONFIRMATION');
    return this.guarded(run, async () => {
      const record = run.confirmations.find(item => item.step_id === input?.step_id);
      const step = run.plan.steps.find(item => item.step_id === input?.step_id);
      if (!record || input.run_id !== run.run_id || input.arguments_digest !== digest(step.arguments) || input.arguments_digest !== record.arguments_digest || input.idempotency_key !== record.idempotency_key || input.operation_type !== record.operation_type || input.operation_summary !== record.operation_summary || input.confirmed !== true) fail('CONFIRMATION_MISMATCH');
      record.confirmation_status = 'confirmed'; record.confirmed_at = new Date().toISOString(); run.request_id = requestId; run.error = null; await this.save(run);
      if (run.confirmations.every(item => item.confirmation_status === 'confirmed')) await this.execute(run);
    });
  }
  async cancel(owner, runId) {
    const current = await this.get(owner, runId);
    if (terminal(current.state)) fail('INVALID_STATE_TRANSITION');
    await this.repository.requestCancel(owner, runId);
    if (current.busy) return { ...current, cancel_requested: true };
    const run = await this.claim(owner, runId);
    return this.guarded(run, async () => { await this.transition(run, 'CANCELLED'); });
  }
  async cancelled(run) {
    if (!await this.repository.cancellationRequested(run.user_id, run.run_id)) return false;
    run.cancel_requested = true; await this.transition(run, 'CANCELLED'); return true;
  }
  async execute(run) {
    if (!['READY_TO_EXECUTE', 'WAITING_CONFIRMATION'].includes(run.state)) fail('INVALID_STATE_TRANSITION');
    await this.transition(run, 'EXECUTING');
    for (const step of run.plan.steps) {
      if (await this.cancelled(run)) return;
      if (step.status === 'succeeded') continue;
      run.current_step = step.step_id;
      const adapter = this.registry.get(step.skill_name); const argumentsValue = structuredClone(step.arguments);
      for (const dep of step.dependencies) if (run.plan.steps.find(item => item.step_id === dep)?.status !== 'succeeded') fail('SKILL_EXECUTION_FAILED');
      for (const map of step.mappings) {
        const source = run.plan.steps.find(item => item.step_id === map.from_step);
        const value = map.from_field.split('.').reduce((obj, key) => obj && Object.hasOwn(obj, key) ? obj[key] : undefined, source.result.data);
        if (value === undefined || value !== null && typeof value === 'object') fail('SKILL_VALIDATION_FAILED');
        argumentsValue[map.to_field] = value;
      }
      const request = this.skillRequest(run, step, argumentsValue); const validation = adapter.validate(request);
      if (!validation.valid) { run.missing_fields = validation.missing_fields.map(field => `${step.step_id}.${field}`); if (run.missing_fields.length) { await this.transition(run, 'COLLECTING_INPUT'); return; } fail(validation.error.code); }
      const operation = adapter.operation(argumentsValue);
      if (operation !== 'READ_ONLY' && !run.confirmations.some(item => item.step_id === step.step_id && item.arguments_digest === digest(argumentsValue) && item.idempotency_key === request.idempotency_key && item.operation_type === operation && item.confirmation_status === 'confirmed')) fail('CONFIRMATION_REQUIRED');
      const existing = run.executions[request.idempotency_key];
      if (existing) {
        if (existing.result?.error?.code === 'MISSING_REQUIRED_FIELD') {
          run.missing_fields = (existing.result.metadata.missing_fields ?? ['arguments']).map(field => `${step.step_id}.${field}`);
          await this.transition(run, 'COLLECTING_INPUT'); return;
        }
        // A durable started record is an unknown outcome, never permission to replay.
        fail('SKILL_EXECUTION_FAILED');
      }
      step.status = 'running';
      run.executions[request.idempotency_key] = { status: 'started', step_id: step.step_id, attempts: 0 }; await this.save(run);
      let result;
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        run.executions[request.idempotency_key].attempts++; await this.save(run);
        result = await this.call(adapter, request);
        if (result.status !== 'failed' || !result.retryable || operation !== 'READ_ONLY' || result.error?.code === 'SKILL_TIMEOUT') break;
      }
      step.result = redact(result); step.status = result.status; step.error = result.error;
      run.executions[request.idempotency_key].status = result.status;
      run.executions[request.idempotency_key].result = redact(result); await this.save(run);
      if (await this.cancelled(run)) return;
      if (result.error?.code === 'MISSING_REQUIRED_FIELD') {
        run.missing_fields = (result.metadata.missing_fields ?? ['arguments']).map(field => `${step.step_id}.${field}`);
        await this.transition(run, 'COLLECTING_INPUT'); return;
      }
      if (result.status !== 'succeeded') { run.error = result.error ?? { code: 'SKILL_EXECUTION_FAILED', message: 'SKILL_EXECUTION_FAILED' }; await this.transition(run, 'FAILED'); return; }
    }
    await this.transition(run, 'AGGREGATING'); run.result = this.aggregator.aggregate(run.plan); await this.transition(run, 'SUCCEEDED');
  }
  async call(adapter, request) {
    let timer;
    const controller = new AbortController();
    try {
      const result = await Promise.race([Promise.resolve().then(() => adapter.execute({ ...request, signal: controller.signal })), new Promise(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve({ status: 'failed', data: null, user_message: 'SKILL_TIMEOUT', error: { code: 'SKILL_TIMEOUT', message: 'SKILL_TIMEOUT' }, retryable: false, metadata: { outcome_unknown: true }, audit: [] }); }, this.timeoutMs);
      })]);
      if (!SkillResult.safeParse(result).success) throw new Error('invalid result');
      return result;
    } catch { return { status: 'failed', data: null, user_message: 'SKILL_EXECUTION_FAILED', error: { code: 'SKILL_EXECUTION_FAILED', message: 'SKILL_EXECUTION_FAILED' }, retryable: false, metadata: {}, audit: [] }; }
    finally { clearTimeout(timer); }
  }
}

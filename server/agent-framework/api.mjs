import { randomUUID, timingSafeEqual } from 'node:crypto';
import { AgentError, fail } from './models.mjs';
import { redact } from './safety.mjs';

export function httpStatus(code) {
  if (!code) return 200;
  if (code === 'UNAUTHORIZED') return 401;
  if (code === 'FORBIDDEN') return 403;
  if (['RUN_NOT_FOUND', 'SKILL_NOT_FOUND'].includes(code)) return 404;
  if (['DUPLICATE_REQUEST', 'INVALID_STATE_TRANSITION', 'CONFIRMATION_REQUIRED', 'CONFIRMATION_MISMATCH'].includes(code)) return 409;
  if (code === 'SKILL_TIMEOUT') return 504;
  if (code === 'EXTERNAL_SERVICE_ERROR') return 502;
  if (code === 'NOT_READY') return 503;
  if (code === 'INTERNAL_ERROR') return 500;
  return 422;
}
async function readBody(request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') fail('INVALID_REQUEST');
  const reader = request.body?.getReader(); if (!reader) fail('INVALID_REQUEST');
  const chunks = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 16384) { await reader.cancel(); fail('INVALID_REQUEST'); } chunks.push(value); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('INVALID_REQUEST'); }
  } finally { reader.releaseLock(); }
}
export function createAgentApi({ orchestrator, registry, repository, env = process.env }) {
  return async function handle(request) {
    const request_id = randomUUID(); let run_id = null; let state = null;
    const reply = (data, error = null, status = httpStatus(error?.code)) => Response.json({ request_id, run_id, state, data: redact(data), error }, { status, headers: { 'Cache-Control': 'no-store' } });
    try {
      const path = new URL(request.url).pathname.replace(/\/$/, ''); const method = request.method;
      if (path === '/health' && method === 'GET') return reply({ status: 'alive' });
      const expected = env.SAVEFLOW_ACCESS_CODE; const actual = request.headers.get('X-Saveflow-Access') ?? '';
      if (!expected || expected.length < 16) fail('NOT_READY');
      if (Buffer.byteLength(expected) !== Buffer.byteLength(actual) || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) fail('UNAUTHORIZED');
      if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) fail('FORBIDDEN');
      // Same private, single synthetic-user scope as the existing banking API. Never trust body user_id.
      const owner = 'agent_demo_user';
      if (path === '/ready' && method === 'GET') {
        const storage = await repository.health(); const skills = await registry.health();
        return skills.every(item => item.status === 'ready') ? reply({ ...storage, skills }) : reply({ ...storage, skills }, { code: 'NOT_READY', message: 'NOT_READY' });
      }
      if (path === '/api/v1/skills' && method === 'GET') return reply(registry.list());
      const schema = path.match(/^\/api\/v1\/skills\/([A-Za-z0-9_-]+)\/schema$/);
      if (schema && method === 'GET') return reply(registry.schema(schema[1]));
      let run;
      if (path === '/api/v1/agent/runs' && method === 'POST') run = await orchestrator.create(owner, await readBody(request), request.headers.get('Idempotency-Key'), request_id);
      else {
        const match = path.match(/^\/api\/v1\/agent\/runs\/([A-Za-z0-9_-]+)(?:\/(input|confirm|cancel))?$/);
        if (!match) return reply(null, { code: 'INVALID_REQUEST', message: 'INVALID_REQUEST' }, 404);
        run_id = match[1];
        if (!match[2] && method === 'GET') run = await orchestrator.get(owner, run_id);
        else if (match[2] && method === 'POST') {
          const body = await readBody(request);
          run = match[2] === 'cancel' ? await orchestrator.cancel(owner, run_id) : await orchestrator[match[2]](owner, run_id, body, request_id);
        } else return reply(null, { code: 'INVALID_REQUEST', message: 'INVALID_REQUEST' }, 405);
      }
      run_id = run.run_id; state = run.state;
      return reply({ current_step: run.current_step, result: run.result, plan: run.plan, missing_fields: run.missing_fields, confirmations: run.confirmations, version: run.version, busy: run.busy, cancel_requested: run.cancel_requested ?? false }, run.error, run.cancel_requested && run.busy ? 202 : httpStatus(run.error?.code));
    } catch (error) {
      const safe = error instanceof AgentError ? error.toJSON() : { code: 'INTERNAL_ERROR', message: 'INTERNAL_ERROR' };
      return reply(null, safe);
    }
  };
}

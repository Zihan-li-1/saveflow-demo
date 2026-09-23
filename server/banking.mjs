import { timingSafeEqual } from 'node:crypto';
import { bankingCore } from '../src/banking-core/core.mjs';
import { BankingError } from '../src/banking-core/errors.mjs';
import { dispatchBanking } from '../src/banking-core/dispatch.mjs';
import { legacyRequest } from '../src/banking-core/legacy-adapter.mjs';
import { WIRE_VERSION, fromWire, toWire } from '../src/banking-core/wire.mjs';
import { canonical } from '../src/banking-core/errors.mjs';

async function bodyJson(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new BankingError('VALIDATION_ERROR', '需要 application/json');
  const reader = request.body?.getReader();
  if (!reader) throw new BankingError('VALIDATION_ERROR', '请求体不能为空');
  let bytes = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > 16384) { await reader.cancel(); throw new BankingError('VALIDATION_ERROR', '请求体超过 16KB'); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new BankingError('VALIDATION_ERROR', 'JSON 格式无效'); }
  } finally { reader.releaseLock(); }
}

/** Private, single synthetic-user demo. Auth establishes the Mock identity; body cannot set it.
 * In-memory state is NOT a bank ledger and is NOT shared between serverless instances. */
export async function handleBanking(request, { env = process.env, core = bankingCore } = {}) {
  const legacy = new URL(request.url).pathname === '/api/saveflow';
  const requestId = legacy ? request.headers.get('X-Request-ID') || crypto.randomUUID() : crypto.randomUUID();
  const reply = (body, status = 200) => Response.json(legacy ? { requestId, ...body } : { schema_version: WIRE_VERSION, request_id: requestId, ...toWire(body) }, { status, headers: { 'Cache-Control': 'no-store', 'X-Saveflow-Data-Source': 'synthetic_demo_only' } });
  try {
    if (request.method !== 'POST') return reply({ code: 'METHOD_NOT_ALLOWED', message: '仅支持 POST' }, 405);
    const expected = env.SAVEFLOW_ACCESS_CODE;
    if (!expected || expected.length < 16) return reply({ code: 'ACCESS_NOT_CONFIGURED', message: '请配置服务端演示访问码' }, 503);
    const access = request.headers.get('X-Saveflow-Access') ?? '';
    if (Buffer.byteLength(access) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(access), Buffer.from(expected))) throw new BankingError('UNAUTHORIZED', '演示访问码无效');
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) throw new BankingError('FORBIDDEN', '不允许跨来源请求');
    const body = await bodyJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BankingError('VALIDATION_ERROR', '请求体必须为对象');
    if (legacy) {
      const { action, ...input } = body;
      const data = legacyRequest(action, input, request.headers.get('Idempotency-Key') ?? '', core);
      return reply({ code: 'OK', message: '请求成功', data });
    }
    if (Object.keys(body).some(k => !['schema_version', 'action', 'input'].includes(k)) || body.schema_version !== WIRE_VERSION || typeof body.action !== 'string') throw new BankingError('VALIDATION_ERROR', '协议须为 schema_version 1.1.0、action、input');
    // Reject camelCase on the wire, including attempts to smuggle confirmed/risk overrides.
    if (body.input && Object.keys(body.input).some(k => /[A-Z]/.test(k))) throw new BankingError('VALIDATION_ERROR', '传输字段必须使用 snake_case');
    const input = fromWire(body.input);
    if (canonical(toWire(input)) !== canonical(body.input)) throw new BankingError('VALIDATION_ERROR', '请使用标准 snake_case 和 amount_minor 字段');
    if (body.action === 'action.execute' && request.headers.get('Idempotency-Key') !== input?.operationId) throw new BankingError('IDEMPOTENCY_CONFLICT', '执行须携带与原操作相同的 Idempotency-Key', true);
    const result = await dispatchBanking(body.action, input, core);
    if (!result.ok) return reply({ code: result.error.code, message: result.error.message, error: result.error, operationId: result.operationId }, statusCode(result.error.code));
    return reply({ code: 'OK', message: 'Mock 请求成功', data: result.data });
  } catch (error) {
    const safe = error instanceof BankingError ? error : new BankingError('INTERNAL_ERROR', '未取得可靠结果，请查询原操作', true);
    return reply({ code: safe.code, message: safe.message, error: safe.toJSON() }, statusCode(safe.code));
  }
}
function statusCode(code) {
  if (code === 'UNAUTHORIZED') return 401;
  if (code === 'FORBIDDEN') return 403;
  if (code === 'INTERNAL_ERROR') return 500;
  if (['IDEMPOTENCY_CONFLICT', 'PREVIEW_STALE', 'PREVIEW_EXPIRED', 'INVALID_STATE'].includes(code)) return 409;
  return 400;
}

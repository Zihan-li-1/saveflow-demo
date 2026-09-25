import { timingSafeEqual } from 'node:crypto';
import { bankingCore } from '../src/banking-core/core.mjs';
import { BankingIntentParserError, parseBankingIntent as defaultParseBankingIntent } from './banking-intent-parser.mjs';
import { ParsedIntentValidationError } from '../src/agent/validate-parsed-intent.mjs';
import { dispatchParsedIntent, handleBillSummary, handleTransfer, prepareTransferPreview, transferRepository } from '../src/agent/runtime.mjs';

const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const visits = new Map();

function clientKey(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'global';
}

function allowRequest(request, now = Date.now()) {
  const key = clientKey(request);
  const recent = (visits.get(key) ?? []).filter(at => at > now - RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) { visits.set(key, recent); return false; }
  recent.push(now); visits.set(key, recent); return true;
}

function statusFor(code) {
  if (code === 'UNAUTHORIZED') return 401;
  if (code === 'FORBIDDEN') return 403;
  if (code === 'REQUEST_TOO_LARGE') return 413;
  if (code === 'MODEL_TIMEOUT') return 504;
  if (code === 'MODEL_RATE_LIMIT') return 429;
  if (['MODEL_AUTH_ERROR', 'MODEL_UPSTREAM_ERROR', 'MODEL_UNAVAILABLE', 'SKILL_ERROR'].includes(code)) return 502;
  if (['ACCESS_NOT_CONFIGURED', 'MODEL_NOT_CONFIGURED', 'MODEL_CONFIG_ERROR'].includes(code)) return 503;
  return 400;
}

function publicMessage(code, fallback) {
  return {
    MODEL_TIMEOUT: '模型请求超时。', MODEL_RATE_LIMIT: '模型请求过于频繁，请稍后重试。',
    MODEL_FORMAT_ERROR: '模型结果格式无效，请重新描述请求。', MODEL_AUTH_ERROR: '模型服务鉴权失败。',
    MODEL_UPSTREAM_ERROR: '模型服务暂时不可用，请稍后重试。', MODEL_UNAVAILABLE: '模型服务暂时不可用，请稍后重试。',
    SKILL_ERROR: 'Skill 处理失败，请稍后重试。',
  }[code] ?? fallback;
}

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error('请求体不能为空'), { code: 'INVALID_REQUEST' });
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw Object.assign(new Error('请求体超过 16KB'), { code: 'REQUEST_TOO_LARGE' });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求体必须是有效 JSON'), { code: 'INVALID_REQUEST' }); }
}

function responseEnvelope(requestId, code, message, data) {
  return { code, message, requestId, ...(data ? { data } : {}) };
}

function errorData(code, message) {
  return { status: 'error', error: { code, message } };
}

/** Banking Agent: Parser -> Dispatcher -> Skill -> Core formal preview. */
export async function handleBankingAgent(
  request,
  { env = process.env, core = bankingCore, repository = core.repository, parseIntent = defaultParseBankingIntent, fetchImpl = fetch, now = Date.now } = {},
) {
  const requestId = crypto.randomUUID();
  const reply = (status, code, message, data) => Response.json(
    responseEnvelope(requestId, code, message, data),
    { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } },
  );
  try {
    if (request.method !== 'POST') return reply(405, 'METHOD_NOT_ALLOWED', '只支持 POST');
    if (!allowRequest(request, now())) return reply(429, 'RATE_LIMIT', '每分钟最多 10 次请求，请稍后再试。');
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return reply(415, 'INVALID_REQUEST', '请使用 application/json');
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) return reply(403, 'FORBIDDEN', '不允许跨来源请求');

    const expected = env.SAVEFLOW_ACCESS_CODE;
    if (!expected || expected.length < 16) return reply(503, 'ACCESS_NOT_CONFIGURED', '请配置服务端演示访问码');
    const supplied = Buffer.from(request.headers.get('x-saveflow-access') || '');
    const expectedBytes = Buffer.from(expected);
    if (supplied.length !== expectedBytes.length || !timingSafeEqual(supplied, expectedBytes)) return reply(401, 'UNAUTHORIZED', '演示访问码无效');

    const body = await readBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, 'INVALID_REQUEST', '请求体必须是对象');
    if (Object.keys(body).some(key => !['message', 'history', 'consent'].includes(key))) return reply(400, 'INVALID_REQUEST', '请求只接受 message、history 和 consent');
    if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 2000) return reply(400, 'INVALID_REQUEST', 'message 必须是 1-2000 字符的文本');
    if (body.consent !== undefined && body.consent !== true) return reply(400, 'INVALID_REQUEST', 'consent 必须明确为 true');
    const history = body.history ?? [];
    if (!Array.isArray(history) || history.length > 12 || history.some(item => !item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 2000)) return reply(400, 'INVALID_REQUEST', 'history 格式无效');

    const parsed = await parseIntent(body.message, { history, env, fetchImpl });
    const dependencies = {
      billHandler: intent => handleBillSummary(intent, repository),
      transferHandler: intent => handleTransfer(intent, transferRepository(repository)),
    };
    const dispatched = await dispatchParsedIntent(parsed, dependencies);
    const result = await prepareTransferPreview(dispatched, core);

    if (result.ok && result.kind === 'bill_result') return reply(200, 'OK', '账单统计已生成', { status: 'bill_result', action: result.action, data: result.data, evidence: result.evidence });
    if (result.ok && result.kind === 'transfer_preview') return reply(200, 'OK', '转账正式预览已生成，等待用户确认', { status: result.data.state, action: result.action, operationId: result.data.operationId, preview: result.data.preview, risk: result.data.risk });
    if (result.kind === 'needs_clarification') return reply(200, 'NEEDS_CLARIFICATION', '需要补充或确认信息', { status: result.kind, ...result });
    if (result.kind === 'unsupported') return reply(200, 'UNSUPPORTED', '暂不支持该请求', { status: result.kind });
    if (result.kind === 'skill_error') return reply(502, 'SKILL_ERROR', 'Skill 处理失败，请稍后重试。', errorData('SKILL_ERROR', 'Skill 处理失败，请稍后重试。'));
    if (result.kind === 'core_error') return reply(statusFor(result.error.code), result.error.code, result.error.message, { status: 'core_error', action: result.action, ...(result.operationId ? { operationId: result.operationId } : {}), error: result.error });
    return reply(500, 'INTERNAL_ERROR', '未取得可靠结果', errorData('INTERNAL_ERROR', '未取得可靠结果'));
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : error instanceof BankingIntentParserError || error instanceof ParsedIntentValidationError ? 'MODEL_FORMAT_ERROR' : 'MODEL_UNAVAILABLE';
    const message = error instanceof BankingIntentParserError ? error.message : publicMessage(code, '请求未取得可靠结果，请稍后重试。');
    return reply(Number.isInteger(error?.status) ? error.status : statusFor(code), code, message, errorData(code, message));
  }
}

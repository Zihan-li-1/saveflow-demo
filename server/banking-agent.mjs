import { createHash, timingSafeEqual } from 'node:crypto';
import { getConfiguredBankingCore } from '../src/banking-core/postgres-store.mjs';
import { BankingIntentParserError, parseBankingIntent as defaultParseBankingIntent } from './banking-intent-parser.mjs';
import { ParsedIntentValidationError } from '../src/agent/validate-parsed-intent.mjs';
import { runBankingConversation, statusFor } from './banking-orchestrator.mjs';
import { parseTrueforgeBankingIntent } from './trueforge-banking-runtime.mjs';
import { bankingReply, validateReplyStyle } from './banking-reply.mjs';

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

function publicMessage(code, fallback) {
  return {
    CONTINUATION_CONFIG_ERROR: '澄清续接服务未配置。',
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

function responseEnvelope(requestId, code, message, data, style, replyContext) {
  return { code, message, requestId, reply: bankingReply({ code, message, data, replyContext }, style), ...(data ? { data } : {}) };
}

function errorData(code, message) {
  return { status: 'error', error: { code, message } };
}

// Status only: never include values, lengths, hashes or request headers in logs.
export function bankingAuthConfigStatus(env = process.env) {
  const state = value => typeof value !== 'string' || !value ? 'missing' : value.length < 16 ? 'invalid' : 'configured';
  return { accessCode: state(env.SAVEFLOW_ACCESS_CODE), continuationSecret: state(env.CONTINUATION_TOKEN_SECRET) };
}

/** One configured understanding boundary -> validated intent -> Skill -> Core. */
export async function handleBankingAgent(
  request,
  options = {},
) {
  const { env = process.env, fetchImpl = fetch, now = Date.now } = options;
  let style = 'concise';
  const requestId = crypto.randomUUID();
  const reply = (status, code, message, data, replyContext) => Response.json(
    responseEnvelope(requestId, code, message, data, style, replyContext),
    { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } },
  );
  const authFailure = (category, status, code, message) => {
    const diagnostic = { event: 'banking_auth_failure', category, requestId };
    if (options.onAuthDiagnostic) options.onAuthDiagnostic(diagnostic);
    else console.warn(JSON.stringify(diagnostic));
    return reply(status, code, message);
  };
  try {
    if (request.method !== 'POST') return reply(405, 'METHOD_NOT_ALLOWED', '只支持 POST');
    if (!allowRequest(request, now())) return reply(429, 'RATE_LIMIT', '每分钟最多 10 次请求，请稍后再试。');
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return reply(415, 'INVALID_REQUEST', '请使用 application/json');
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) return reply(403, 'FORBIDDEN', '不允许跨来源请求');

    const expected = env.SAVEFLOW_ACCESS_CODE;
    const configStatus = bankingAuthConfigStatus(env);
    if (configStatus.accessCode !== 'configured') return authFailure(`ACCESS_CONFIG_${configStatus.accessCode.toUpperCase()}`, 503, 'SERVICE_UNAVAILABLE', '服务暂时不可用，请联系演示维护者。');
    const supplied = Buffer.from(request.headers.get('x-saveflow-access') || '');
    const expectedBytes = Buffer.from(expected);
    if (supplied.length !== expectedBytes.length || !timingSafeEqual(supplied, expectedBytes)) return authFailure(supplied.length ? 'ACCESS_MISMATCH' : 'ACCESS_HEADER_MISSING', 401, 'UNAUTHORIZED', '访问验证失败，请检查演示访问码后重试。');
    // Configuration details are only available after authentication succeeds.
    if (configStatus.continuationSecret !== 'configured') return authFailure(`CONTINUATION_CONFIG_${configStatus.continuationSecret.toUpperCase()}`, 503, 'CONTINUATION_CONFIG_ERROR', '服务暂时不可用，请联系演示维护者。');

    const body = await readBody(request);
    style = validateReplyStyle(body?.replyStyle);
    const implementation = env.SAVEFLOW_BANKING_RUNTIME || 'trueforge';
    if (!['trueforge', 'legacy-qwen'].includes(implementation)) throw Object.assign(new Error('Runtime configuration'), { code: 'BANKING_RUNTIME_CONFIG_ERROR', status: 503 });
    // Dependency injection is for tests/hosts, never supplied by the request.
    const parseIntent = options.parseIntent ?? (implementation === 'legacy-qwen' ? defaultParseBankingIntent :
      (message, context) => parseTrueforgeBankingIntent(message, { ...context, signal: request.signal, client: options.trueforgeRuntimeClient }));
    // Retired MCP pilot tokens cannot silently enter another implementation.
    if (/^tf[mb]1\./.test(body?.continuationToken || '')) throw Object.assign(new Error('Retired continuation'), { code: 'CONTINUATION_INVALID', status: 400, userMessage: '旧试点会话已失效，请开始新请求。' });
    const core = options.core ?? await getConfiguredBankingCore(env);
    const repository = options.repository ?? core.repository;
    const scenarioScope = createHash('sha256').update(`${expected}:${clientKey(request)}`).digest('hex');
    const result = await runBankingConversation(body, { core, repository, env, now, timezone: options.timezone ?? 'Asia/Shanghai', parseIntent, fetchImpl, requestId, scenarioHandler: options.scenarioHandler, scenarioScope });
    const data = result.data?.recovery ? { ...result.data, recovery: { ...result.data.recovery, continuationToken: result.data.continuationToken } } : result.data;
    return reply(result.httpStatus, result.code, result.message, data, result.replyContext);
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : error instanceof BankingIntentParserError || error instanceof ParsedIntentValidationError ? 'MODEL_FORMAT_ERROR' : error?.message?.includes('DATABASE_URL') ? 'DATABASE_NOT_CONFIGURED' : 'MODEL_UNAVAILABLE';
    const message = error.userMessage ?? (error instanceof BankingIntentParserError ? error.message : publicMessage(code, '请求未取得可靠结果，请稍后重试。'));
    return reply(Number.isInteger(error?.status) ? error.status : code === 'DATABASE_NOT_CONFIGURED' ? 503 : statusFor(code), code, message, errorData(code, message));
  }
}

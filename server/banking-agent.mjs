import { timingSafeEqual } from 'node:crypto';
import { bankingCore } from '../src/banking-core/core.mjs';
import { BankingIntentParserError, parseBankingIntent as defaultParseBankingIntent } from './banking-intent-parser.mjs';
import { ParsedIntentValidationError } from '../src/agent/validate-parsed-intent.mjs';
import { dispatchParsedIntent, handleBillSummary, handleTransfer, prepareTransferPreview, transferRepository } from '../src/agent/runtime.mjs';
import { issueContinuationToken, verifyContinuationToken } from '../src/agent/clarification/continuation-token.mjs';
import { resolveChoice } from '../src/agent/clarification/choice-resolver.mjs';
import { buildParsedIntent, mergeSlots } from '../src/agent/clarification/merge-intent.mjs';
import { isBillTask, isTransferTask, parseClarificationAnswer } from './banking-clarification-parser.mjs';

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
  if (['ACCESS_NOT_CONFIGURED', 'MODEL_NOT_CONFIGURED', 'MODEL_CONFIG_ERROR', 'CONTINUATION_CONFIG_ERROR'].includes(code)) return 503;
  return 400;
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

function responseEnvelope(requestId, code, message, data) {
  return { code, message, requestId, ...(data ? { data } : {}) };
}

function errorData(code, message) {
  return { status: 'error', error: { code, message } };
}

const clarificationQuestions = {
  amount: '要转多少钱？例如 500 元。',
  month: '想看哪个月的账单？例如 2026 年 8 月。',
  source_account_ref: '要从哪个账户转出？',
  payee_ref: '要转给谁？',
};

function continuationSecret(env) {
  return env.CONTINUATION_TOKEN_SECRET;
}

function tokenError(error) {
  return Object.assign(new Error(error instanceof Error ? error.message : '续接凭据无效'), { code: 'CONTINUATION_INVALID', status: 400 });
}

function issueState({ action, slots, pendingSlot, choices = [], selections = {}, env, now }) {
  return issueContinuationToken({ action, slots, pendingSlot, choices, selections }, continuationSecret(env), now());
}

function accountChoices(repository) {
  return repository.getAccounts().filter(account => account.status === 'active').map(account => ({
    optionId: `opt_${crypto.randomUUID()}`,
    label: account.name,
    entityId: account.id,
    rawValue: account.name,
  }));
}

function payeeChoices(candidates) {
  return candidates.map(candidate => ({
    optionId: `opt_${crypto.randomUUID()}`,
    label: `${candidate.name}（${candidate.accountNoMasked || '账户信息已脱敏'}）`,
    entityId: candidate.id,
    rawValue: candidate.name,
  }));
}

function clarificationResponse(reply, { action, slot, question, choices = [], slots, selections = {}, env, now, message, source }) {
  const token = issueState({ action, slots, pendingSlot: slot, choices, selections, env, now });
  return reply(200, 'NEEDS_CLARIFICATION', question, {
    kind: 'clarification', status: 'needs_clarification', action, question, slot, ...(source ? { source } : {}), choices: choices.map(({ optionId, label }) => ({ optionId, label })), continuationToken: token,
    ...(message ? { message } : {}),
  });
}

function nextMissingSlot(intent) {
  const order = intent.action === 'transfer.create'
    ? ['source_account_ref', 'payee_ref', 'amount']
    : ['month'];
  return order.find(slot => intent.missingSlots?.includes(slot)) || intent.missingSlots?.[0];
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
    const allowed = ['message', 'history', 'consent', 'continuationToken', 'choice'];
    if (Object.keys(body).some(key => !allowed.includes(key))) return reply(400, 'INVALID_REQUEST', '请求包含未注册字段');
    const continuing = body.continuationToken !== undefined;
    if (continuing && (typeof body.continuationToken !== 'string' || body.continuationToken.length > 10000)) return reply(400, 'CONTINUATION_INVALID', '续接凭据无效');
    if (!continuing && (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 2000)) return reply(400, 'INVALID_REQUEST', 'message 必须是 1-2000 字符的文本');
    if (continuing && body.message !== undefined && (typeof body.message !== 'string' || body.message.length > 2000)) return reply(400, 'INVALID_REQUEST', 'message 格式无效');
    if (continuing && body.message === undefined && (!body.choice || typeof body.choice !== 'object')) return reply(400, 'INVALID_REQUEST', '续接请求需要 message 或 choice');
    if (body.choice !== undefined && (!body.choice || typeof body.choice !== 'object' || Array.isArray(body.choice) || typeof body.choice.optionId !== 'string')) return reply(400, 'INVALID_REQUEST', 'choice 格式无效');
    if (body.consent !== undefined && body.consent !== true) return reply(400, 'INVALID_REQUEST', 'consent 必须明确为 true');
    const history = body.history ?? [];
    if (!Array.isArray(history) || history.length > 12 || history.some(item => !item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 2000)) return reply(400, 'INVALID_REQUEST', 'history 格式无效');

    let parsed;
    let selections = {};
    let continuation;
    if (continuing) {
      try { continuation = verifyContinuationToken(body.continuationToken, continuationSecret(env), now()); }
      catch (error) { throw tokenError(error); }
      if (body.message && ((isBillTask(body.message) && continuation.action === 'transfer.create') || (isTransferTask(body.message) && continuation.action === 'bill.summary'))) {
        parsed = await parseIntent(body.message, { history, env, fetchImpl });
      } else {
        if (body.choice && !resolveChoice(body.choice, continuation.choices)) throw Object.assign(new Error('选项不存在或已失效'), { code: 'INVALID_CHOICE', status: 400 });
        const answer = parseClarificationAnswer(body.message || '', { slot: continuation.pendingSlot, choices: continuation.choices, choice: body.choice, now: now() });
        if (answer.kind === 'choice') {
          const selected = resolveChoice(body.choice || body.message, continuation.choices);
          if (!selected) throw Object.assign(new Error('选项不存在或已失效'), { code: 'INVALID_CHOICE', status: 400 });
          selections = { ...continuation.selections, [continuation.pendingSlot]: { entityId: selected.entityId, optionId: selected.optionId } };
          parsed = buildParsedIntent(continuation.action, mergeSlots(continuation.slots, { [continuation.pendingSlot]: selected.rawValue || selected.label }));
        } else if (answer.kind === 'slot') {
          parsed = buildParsedIntent(continuation.action, mergeSlots(continuation.slots, answer.updates));
          selections = continuation.selections || {};
        } else {
          return clarificationResponse(reply, {
            action: continuation.action,
            slot: continuation.pendingSlot,
            question: clarificationQuestions[continuation.pendingSlot] || '请补充必要信息。',
            choices: continuation.choices,
            slots: continuation.slots,
            selections: continuation.selections || {},
            env, now,
            message: '无法识别这次回答，请从候选项中选择或重新描述。',
            source: 'parser',
          });
        }
      }
    } else {
      parsed = await parseIntent(body.message, { history, env, fetchImpl });
    }
    const dependencies = {
      billHandler: intent => handleBillSummary(intent, repository),
      transferHandler: intent => handleTransfer(intent, transferRepository(repository, selections)),
    };
    const dispatched = await dispatchParsedIntent(parsed, dependencies);
    const prepareTransfer = typeof core.prepare === 'function'
      ? { prepare: core.prepare.bind(core) }
      : { prepare: async () => ({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Banking Core prepare 未配置', uncertain: true } }) };
    const result = await prepareTransferPreview(dispatched, prepareTransfer);

    if (result.ok && result.kind === 'bill_result') return reply(200, 'OK', '账单统计已生成', { status: 'bill_result', action: result.action, data: result.data, evidence: result.evidence });
    if (result.ok && result.kind === 'transfer_preview') return reply(200, 'OK', '转账正式预览已生成，等待用户确认', { status: result.data.state, action: result.action, operationId: result.data.operationId, preview: result.data.preview, risk: result.data.risk });
    if (result.kind === 'needs_clarification') {
      const action = result.action || parsed.action;
      const slots = parsed.slots || {};
      const slot = result.slot || nextMissingSlot(parsed) || (result.candidates ? 'payee_ref' : undefined);
      const choices = result.candidates ? payeeChoices(result.candidates) : slot === 'source_account_ref' ? accountChoices(repository) : [];
      return clarificationResponse(reply, {
        action,
        slot,
        question: result.question || clarificationQuestions[slot] || '请补充必要信息。',
        choices,
        slots,
        selections,
        env, now,
        source: result.source,
      });
    }
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

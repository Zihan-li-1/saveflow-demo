import { timingSafeEqual } from 'node:crypto';
import { getConfiguredBankingCore } from '../src/banking-core/postgres-store.mjs';
import { BankingIntentParserError, parseBankingIntent as defaultParseBankingIntent } from './banking-intent-parser.mjs';
import { ParsedIntentValidationError } from '../src/agent/validate-parsed-intent.mjs';
import { dispatchParsedIntent, handleBillSummary, handleCard, handleTransfer, prepareTransferPreview, transferRepository } from '../src/agent/runtime.mjs';
import { issueContinuationToken, verifyContinuationToken } from '../src/agent/clarification/continuation-token.mjs';
import { resolveChoice } from '../src/agent/clarification/choice-resolver.mjs';
import { buildParsedIntent, mergeSlots } from '../src/agent/clarification/merge-intent.mjs';
import { isBillTask, isCardTask, isTransferTask, parseClarificationAnswer } from './banking-clarification-parser.mjs';
import { handleWealth } from '../src/agent/handlers/wealth-handler.mjs';

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
  if (code === 'CARD_NOT_FOUND') return 404;
  if (code === 'PRODUCT_NOT_FOUND' || code === 'HOLDING_NOT_FOUND') return 404;
  if (code === 'CARD_AMBIGUOUS' || code === 'INVALID_STATE') return 409;
  if (code === 'LIMIT_EXCEEDED') return 422;
  if (code === 'MODEL_TIMEOUT') return 504;
  if (code === 'MODEL_RATE_LIMIT') return 429;
  if (['MODEL_AUTH_ERROR', 'MODEL_UPSTREAM_ERROR', 'MODEL_UNAVAILABLE', 'SKILL_ERROR'].includes(code)) return 502;
  if (['ACCESS_NOT_CONFIGURED', 'MODEL_NOT_CONFIGURED', 'MODEL_CONFIG_ERROR', 'CONTINUATION_CONFIG_ERROR', 'CAPABILITY_UNAVAILABLE'].includes(code)) return 503;
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
  card_ref: '请选择要查看或操作的卡片。',
  product_ref: '请说出要申购的模拟理财产品名称。',
  product_refs: '请提供两到五个要比较的模拟理财产品名称。',
  holding_ref: '请说出要赎回的持仓对应产品名称。',
  quantity_or_amount: '请明确赎回金额或份额，例如“赎回 100 元”。',
  goal: '请说明理财目标，例如短期购物或稳健增长。',
  assessment_scope: '请说明投资风险测评或组合测评。',
};

function questionFor(action, slot) {
  return slot === 'amount' && action === 'card.set_budget'
    ? '新的月消费预算是多少元？例如 1000 元。'
    : clarificationQuestions[slot] || '请补充必要信息。';
}

function continuationSecret(env) {
  return env.CONTINUATION_TOKEN_SECRET;
}

function tokenError(error) {
  return Object.assign(new Error(error instanceof Error ? error.message : '续接凭据无效'), { code: 'CONTINUATION_INVALID', status: 400 });
}

function issueState({ action, slots, pendingSlot, choices = [], selections = {}, env, now }) {
  return issueContinuationToken({ action, slots, pendingSlot, choices, selections }, continuationSecret(env), now());
}

async function accountChoices(repository) {
  return (await repository.getAccounts()).filter(account => account.status === 'active').map(account => ({
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

function cardChoices(cards) {
  return cards.map((card, index) => ({
    optionId: `opt_${crypto.randomUUID()}`,
    label: `${card.name}（卡片 ${index + 1}）`,
    entityId: card.id,
    rawValue: card.name,
  }));
}

function wealthChoices(items) {
  return items.map(item => ({ optionId: `opt_${crypto.randomUUID()}`, label: item.name, entityId: item.id, rawValue: item.name }));
}

async function wealthHoldingCandidates(repository, ports) {
  const [holdings, products] = await Promise.all([ports?.getHoldings?.() ?? [], repository.getInvestmentProducts()]);
  return holdings.map(item => ({ ...item, name: products.find(product => product.id === item.product_id)?.name ?? item.id }));
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
    : intent.action.startsWith('card.') ? ['card_ref', 'amount']
    : intent.action.startsWith('wealth.') ? ['product_ref', 'product_refs', 'holding_ref', 'source_account_ref', 'amount', 'quantity_or_amount', 'goal', 'assessment_scope'] : ['month'];
  return order.find(slot => intent.missingSlots?.includes(slot)) || intent.missingSlots?.[0];
}

function switchesTask(message, continuation) {
  if (isBillTask(message) && continuation.action !== 'bill.summary') return true;
  if (isTransferTask(message) && continuation.action !== 'transfer.create') return true;
  if (!isCardTask(message)) return false;
  if (!continuation.action.startsWith('card.')) return true;
  if (/解冻|解除冻结/.test(message)) return continuation.action !== 'card.unfreeze';
  if (/冻结|锁卡/.test(message)) return continuation.action !== 'card.freeze';
  if (/预算/.test(message) && /调整|修改|设置|改成/.test(message)) return continuation.action !== 'card.set_budget';
  if (/查(?:询|看)?.{0,4}(?:银行卡|卡片)|卡片?信息/.test(message)) return continuation.action !== 'card.get';
  return false;
}

/** Banking Agent: Parser -> Dispatcher -> Skill -> Core formal preview. */
export async function handleBankingAgent(
  request,
  options = {},
) {
  const { env = process.env, parseIntent = defaultParseBankingIntent, fetchImpl = fetch, now = Date.now } = options;
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
    if (typeof continuationSecret(env) !== 'string' || continuationSecret(env).length < 16) return reply(503, 'CONTINUATION_CONFIG_ERROR', '请配置服务端续接令牌密钥');
    const supplied = Buffer.from(request.headers.get('x-saveflow-access') || '');
    const expectedBytes = Buffer.from(expected);
    if (supplied.length !== expectedBytes.length || !timingSafeEqual(supplied, expectedBytes)) return reply(401, 'UNAUTHORIZED', '演示访问码无效');

    const core = options.core ?? await getConfiguredBankingCore(env);
    const repository = options.repository ?? core.repository;

    const body = await readBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, 'INVALID_REQUEST', '请求体必须是对象');
    const allowed = ['message', 'history', 'consent', 'continuationToken', 'choice'];
    if (Object.keys(body).some(key => !allowed.includes(key))) return reply(400, 'INVALID_REQUEST', '请求包含未注册字段');
    const continuing = body.continuationToken !== undefined;
    if (body.choice !== undefined && (!continuing || body.message !== undefined)) return reply(400, 'INVALID_REQUEST', 'choice 必须与 continuationToken 一起提交，且不能同时提交 message');
    if (continuing && (typeof body.continuationToken !== 'string' || body.continuationToken.length > 10000)) return reply(400, 'CONTINUATION_INVALID', '续接凭据无效');
    if (!continuing && (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 2000)) return reply(400, 'INVALID_REQUEST', 'message 必须是 1-2000 字符的文本');
    if (continuing && body.message !== undefined && (typeof body.message !== 'string' || body.message.length > 2000)) return reply(400, 'INVALID_REQUEST', 'message 格式无效');
    if (continuing && body.message === undefined && (!body.choice || typeof body.choice !== 'object')) return reply(400, 'INVALID_REQUEST', '续接请求需要 message 或 choice');
    if (body.choice !== undefined && (!body.choice || typeof body.choice !== 'object' || Array.isArray(body.choice) || typeof body.choice.optionId !== 'string' || !body.choice.optionId.trim() || Object.keys(body.choice).some(key => key !== 'optionId'))) return reply(400, 'INVALID_REQUEST', 'choice 只能包含非空 optionId');
    if (body.consent !== undefined && body.consent !== true) return reply(400, 'INVALID_REQUEST', 'consent 必须明确为 true');
    const history = body.history ?? [];
    if (!Array.isArray(history) || history.length > 12 || history.some(item => !item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 2000)) return reply(400, 'INVALID_REQUEST', 'history 格式无效');

    let parsed;
    let selections = {};
    let continuation;
    if (continuing) {
      try { continuation = verifyContinuationToken(body.continuationToken, continuationSecret(env), now()); }
      catch (error) { throw tokenError(error); }
      if (body.message && switchesTask(body.message, continuation)) {
        parsed = await parseIntent(body.message, { history, env, fetchImpl, requestId });
      } else {
        if (body.choice && !resolveChoice(body.choice, continuation.choices)) throw Object.assign(new Error('选项不存在或已失效'), { code: 'INVALID_CHOICE', status: 400 });
        const answer = parseClarificationAnswer(body.message || '', { action: continuation.action, slot: continuation.pendingSlot, choices: continuation.choices, choice: body.choice, now: now() });
        if (answer.kind === 'choice') {
          const selected = resolveChoice(body.choice || body.message, continuation.choices);
          if (!selected) throw Object.assign(new Error('选项不存在或已失效'), { code: 'INVALID_CHOICE', status: 400 });
          selections = { ...continuation.selections, [continuation.pendingSlot]: { entityId: selected.entityId, optionId: selected.optionId } };
          parsed = buildParsedIntent(continuation.action, mergeSlots(continuation.slots, { [continuation.pendingSlot]: selected.rawValue || selected.label }));
        } else if (answer.kind === 'slot') {
          parsed = buildParsedIntent(continuation.action, mergeSlots(continuation.slots, answer.updates));
          selections = { ...continuation.selections };
          for (const slot of Object.keys(answer.updates)) delete selections[slot];
        } else {
          return clarificationResponse(reply, {
            action: continuation.action,
            slot: continuation.pendingSlot,
            question: questionFor(continuation.action, continuation.pendingSlot),
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
      parsed = await parseIntent(body.message, { history, env, fetchImpl, requestId });
    }
    const dependencies = {
      billHandler: intent => handleBillSummary(intent, repository),
      transferHandler: intent => handleTransfer(intent, transferRepository(repository, selections)),
      cardHandler: intent => handleCard(intent, repository, selections),
      wealthHandler: intent => handleWealth(intent, repository, core.wealthPorts, selections),
    };
    const dispatched = await dispatchParsedIntent(parsed, dependencies);
    const prepareTransfer = typeof core.prepare === 'function'
      ? { prepare: core.prepare.bind(core) }
      : { prepare: async () => ({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Banking Core prepare 未配置', uncertain: true } }) };
    const result = await prepareTransferPreview(dispatched, prepareTransfer);

    if (result.ok && result.kind === 'bill_result') return reply(200, 'OK', '账单统计已生成', { status: 'bill_result', action: result.action, data: { ...result.data, month: parsed.slots.month }, evidence: result.evidence });
    if (result.ok && result.kind === 'card_result') return reply(200, 'OK', '卡片信息已查询', { status: 'card_result', action: result.action, data: result.data, evidence: result.evidence });
    if (result.ok && result.kind === 'wealth_result') return reply(200, 'OK', '模拟理财信息已生成', { status: 'wealth_result', action: result.action, data: result.data, evidence: result.data.evidence });
    if (result.ok && result.kind === 'wealth_action_request') {
      const prepared = await core.prepare(result.data.request);
      if (!prepared.ok) return reply(statusFor(prepared.error.code), prepared.error.code, prepared.error.message, { status: 'core_error', action: result.action, ...(prepared.operationId ? { operationId: prepared.operationId } : {}), error: prepared.error });
      return reply(200, 'OK', '模拟理财正式预览已生成，等待页面单独确认', { status: 'awaiting_confirmation', action: result.action, operationId: prepared.data.operationId, preview: prepared.data.preview, risk: prepared.data.risk, disclosure: result.data.disclosure, evidence: result.data.evidence });
    }
    if (result.ok && result.kind === 'card_action_request') {
      const prepared = await core.prepare(result.data.request);
      if (!prepared.ok) return reply(statusFor(prepared.error.code), prepared.error.code, prepared.error.message, { status: 'core_error', action: result.action, ...(prepared.operationId ? { operationId: prepared.operationId } : {}), error: prepared.error });
      return reply(200, 'OK', '卡片正式预览已生成，等待页面确认', { status: 'awaiting_confirmation', action: result.action, operationId: prepared.data.operationId, preview: prepared.data.preview, risk: prepared.data.risk, evidence: result.data.evidence });
    }
    if (result.ok && result.kind === 'transfer_preview') {
      const continuationToken = issueState({ action: 'transfer.create', slots: parsed.slots, pendingSlot: 'amount', selections, env, now });
      return reply(200, 'OK', '转账正式预览已生成，等待用户确认', { status: result.data.state, action: result.action, operationId: result.data.operationId, preview: result.data.preview, risk: result.data.risk, continuationToken });
    }
    if (result.kind === 'needs_clarification') {
      const action = result.action || parsed.action;
      const slots = parsed.slots || {};
      const slot = result.slot || nextMissingSlot(parsed) || (result.candidates ? 'payee_ref' : undefined);
      const choices = slot === 'card_ref' ? cardChoices(result.candidates?.length ? result.candidates : await repository.getCards())
        : action.startsWith('wealth.') && ['product_ref', 'holding_ref', 'source_account_ref'].includes(slot) ? wealthChoices(result.candidates?.length ? result.candidates : slot === 'product_ref' ? await repository.getInvestmentProducts() : slot === 'holding_ref' ? await wealthHoldingCandidates(repository, core.wealthPorts) : await repository.getAccounts())
        : result.candidates ? payeeChoices(result.candidates) : slot === 'source_account_ref' ? await accountChoices(repository) : slot === 'payee_ref' && !slots.payee_ref ? payeeChoices((await repository.getPayees()).filter(payee => payee.status === 'active')) : [];
      return clarificationResponse(reply, {
        action,
        slot,
        question: result.question || questionFor(action, slot),
        choices,
        slots,
        selections,
        env, now,
        source: result.source,
      });
    }
    if (result.kind === 'unsupported') return reply(200, 'UNSUPPORTED', '暂不支持该请求', { status: result.kind });
    if (result.kind === 'skill_error') return reply(502, 'SKILL_ERROR', 'Skill 处理失败，请稍后重试。', errorData('SKILL_ERROR', 'Skill 处理失败，请稍后重试。'));
    if (result.kind === 'card_error') return reply(statusFor(result.error.code), result.error.code, result.error.message, { status: 'card_error', action: result.action, error: result.error });
    if (result.kind === 'wealth_error') return reply(statusFor(result.error.code), result.error.code, result.error.message, { status: 'wealth_error', action: result.action, error: result.error });
    if (result.kind === 'core_error') return reply(statusFor(result.error.code), result.error.code, result.error.message, { status: 'core_error', action: result.action, ...(result.operationId ? { operationId: result.operationId } : {}), error: result.error });
    return reply(500, 'INTERNAL_ERROR', '未取得可靠结果', errorData('INTERNAL_ERROR', '未取得可靠结果'));
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : error instanceof BankingIntentParserError || error instanceof ParsedIntentValidationError ? 'MODEL_FORMAT_ERROR' : error?.message?.includes('DATABASE_URL') ? 'DATABASE_NOT_CONFIGURED' : 'MODEL_UNAVAILABLE';
    const message = error instanceof BankingIntentParserError ? error.message : publicMessage(code, '请求未取得可靠结果，请稍后重试。');
    return reply(Number.isInteger(error?.status) ? error.status : code === 'DATABASE_NOT_CONFIGURED' ? 503 : statusFor(code), code, message, errorData(code, message));
  }
}

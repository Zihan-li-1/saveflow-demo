import { createHash, timingSafeEqual } from 'node:crypto';
import { getConfiguredBankingCore } from '../src/banking-core/postgres-store.mjs';
import { BankingIntentParserError, parseBankingIntent as defaultParseBankingIntent } from './banking-intent-parser.mjs';
import { ParsedIntentValidationError } from '../src/agent/validate-parsed-intent.mjs';
import { runBankingConversation, statusFor } from './banking-orchestrator.mjs';
import { parseTrueforgeBankingIntent } from './trueforge-banking-runtime.mjs';
import { bankingReply, validateReplyStyle } from './banking-reply.mjs';
import { agentErrorPolicy } from '../src/lib/agent-error-policy.mjs';
import { openBankingConversation, bankingRouteContext } from './banking-conversation.mjs';
import { runReadOnlyPlanner } from './read-only-planner.mjs';
import { createPlanningRuntimeClient } from './planning-runtime.mjs';
import { createAgentDiagnostics, diagnosticCategory } from './agent-diagnostics.mjs';
import { routeConversation, validateChatHistory, validateConversationRoute } from './conversation-route.mjs';
import { buildCapabilityCatalog, buildSkillOverview, publicCapabilityCatalog, capabilityIntroduction } from './agent-capability-catalog.mjs';

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
  // Netlify supplies a streamed body. Next.js App Router may expose the same
  // Web Request with only the standard text/json reader, so keep one bounded
  // compatibility path instead of duplicating the adapter.
  if (!reader) {
    let raw;
    try { raw = await request.text(); } catch { throw Object.assign(new Error('请求体不能为空'), { code: 'INVALID_REQUEST' }); }
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) throw Object.assign(new Error('请求体超过 16KB'), { code: 'REQUEST_TOO_LARGE' });
    try { return JSON.parse(raw); } catch { throw Object.assign(new Error('请求体必须是有效 JSON'), { code: 'INVALID_REQUEST' }); }
  }
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
  if (!['OK', 'NEEDS_CLARIFICATION', 'UNSUPPORTED'].includes(code)) {
    data = { ...(data ?? { status: 'error' }), error: { ...data?.error, code, message,
      ...agentErrorPolicy(code, { hasRecovery: !!data?.recovery, hasChoices: !!data?.recovery?.choices?.length, uncertain: data?.error?.uncertain === true }) } };
  }
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
  const requestId = crypto.randomUUID();
  const diagnostics = createAgentDiagnostics(env, requestId, options.diagnosticSink);
  diagnostics.emit('agent_request_received', { mode: 'banking', hasContinuation: false });
  let style = 'concise';
  let conversation;
  const reply = (status, code, message, data, replyContext) => {
    diagnostics.emit('agent_response_sent', { httpStatus: status, code, status: data?.status || 'unknown', responseSource: data?.status === 'error' ? 'error' : data?.status === 'conversation_reply' ? 'conversation' : 'business' });
    const metadata = conversation?.metadata();
    const envelope = responseEnvelope(requestId, code, message, metadata ? { ...(data ?? { status: 'error' }), conversation: metadata } : data, style, replyContext);
    const response = Response.json(
      envelope,
      { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Request-ID': requestId } },
    );
    conversation?.remember(response, envelope);
    return response;
  };
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('请求体必须为对象'), { code: 'INVALID_REQUEST', status: 400 });
    const invalidFields = Object.keys(body).some(key => !['message', 'history', 'chatHistory', 'consent', 'continuationToken', 'choice', 'replyStyle', 'planInputs', 'wealthInputs', 'planning', 'planningConstraints', 'conversationToken', 'conversationRevision', 'taskId', 'taskMode'].includes(key));
    const chatHistory = validateChatHistory(body.chatHistory);
    delete body.chatHistory;
    if (body.consent !== undefined && body.consent !== true) throw Object.assign(new Error('consent 必须明确为 true'), { code: 'INVALID_REQUEST', status: 400 });
    if (body.message !== undefined && (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 2000)) throw Object.assign(new Error('message 必须是 1-2000 字符'), { code: 'INVALID_REQUEST', status: 400 });
    if (body?.planning !== undefined && typeof body.planning !== 'boolean') throw Object.assign(new Error('planning 必须是布尔值'), { code: 'INVALID_REQUEST', status: 400 });
    if (body?.planningConstraints !== undefined) {
      const c = body.planningConstraints;
      const valid = c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).every(key => ['max_risk_level', 'horizon_days', 'liquidity_requirement', 'amount', 'no_modifications', 'notes'].includes(key)) &&
        (c.max_risk_level === undefined || ['R1', 'R2', 'R3'].includes(c.max_risk_level)) &&
        (c.horizon_days === undefined || Number.isSafeInteger(c.horizon_days) && c.horizon_days >= 0 && c.horizon_days <= 3650) &&
        (c.liquidity_requirement === undefined || ['T+0', 'T+1', 'AT_MATURITY'].includes(c.liquidity_requirement)) &&
        (c.no_modifications === undefined || c.no_modifications === true) &&
        (c.notes === undefined || typeof c.notes === 'string' && c.notes.length <= 500) &&
        (c.amount === undefined || c.amount && typeof c.amount === 'object' && !Array.isArray(c.amount) && Object.keys(c.amount).every(key => ['amount_minor', 'currency'].includes(key)) && Number.isSafeInteger(c.amount.amount_minor) && c.amount.amount_minor > 0 && c.amount.currency === 'CNY');
      if (!valid) throw Object.assign(new Error('planningConstraints 不符合只读约束契约'), { code: 'INVALID_REQUEST', status: 400 });
    }
    if ((body?.planning === true || body?.taskMode === 'plan') && (body?.continuationToken || body?.taskId || body?.choice || body?.planInputs || body?.wealthInputs)) throw Object.assign(new Error('只读规划必须作为独立任务发起'), { code: 'INVALID_REQUEST', status: 400 });
    diagnostics.emit('agent_request_received', { mode: 'banking', hasContinuation: typeof body?.continuationToken === 'string' });
    style = validateReplyStyle(body?.replyStyle);
    const implementation = env.SAVEFLOW_BANKING_RUNTIME || 'trueforge';
    if (!['trueforge', 'legacy-qwen'].includes(implementation)) throw Object.assign(new Error('Runtime configuration'), { code: 'BANKING_RUNTIME_CONFIG_ERROR', status: 503 });
    // Dependency injection is for tests/hosts, never supplied by the request.
    const explicitCancel = typeof body?.message === 'string' && /^(?:取消|取消(?:本次)?(?:转账|操作)|不用了)[。！!]?$/.test(body.message.trim());
    const skippedModelReason = body?.choice ? 'choice_option_id' : body?.taskMode === 'sync' ? 'session_sync' : body?.continuationToken && explicitCancel ? 'explicit_cancel' : undefined;
    diagnostics.emit('agent_model_route', { selected: implementation === 'legacy-qwen' ? 'qwen' : 'trueforge', modelCallPrepared: !skippedModelReason, ...(skippedModelReason ? { skippedModelReason } : {}) });
    const parseIntent = options.parseIntent ?? (implementation === 'legacy-qwen' ? ((message, context) => defaultParseBankingIntent(message, { ...context, onDiagnostic: diagnostics.emit })) :
      (message, context) => parseTrueforgeBankingIntent(message, { ...context, signal: request.signal, client: options.trueforgeRuntimeClient, onDiagnostic: diagnostics.emit }));
    // Conversation binding rejects retired/unbound tokens before any understanding.
    let core, coreError;
    try { core = options.core ?? await getConfiguredBankingCore(env); } catch (error) { coreError = error; }
    if (invalidFields) {
      if (core) {
        // Preserve authenticated recovery metadata on rejected business fields.
        conversation = openBankingConversation(body, { core, env, now, parseIntent, conversationHost: options.conversationHost });
        await conversation.begin();
      }
      throw Object.assign(new Error('请求包含无效字段'), { code: 'INVALID_REQUEST', status: 400 });
    }
    // An injected business parser is an explicit business-only host used by the
    // existing harness. Production and route tests use the semantic outer boundary.
    let route;
    const naturalTurn = typeof body.message === 'string' && !body.choice && !body.planInputs && !body.wealthInputs && !['sync', 'resume', 'continue', 'plan'].includes(body.taskMode) && body.planning !== true;
    if (naturalTurn && (options.routeConversation || options.conversationRuntimeClient || implementation === 'trueforge' && !options.parseIntent && !options.trueforgeRuntimeClient)) {
      if (/^(?:确认|确认转账|确认执行|执行|同意|确认保存|保存规则)[。！!]?\s*$/.test(body.message.trim())) throw Object.assign(new Error('聊天文字不能确认执行，请使用页面确认按钮。'), { code: 'CONFIRMATION_REQUIRED', userMessage: '聊天文字不能确认执行，请使用页面确认按钮。', status: 403 });
      const catalog = await buildCapabilityCatalog({ core, repository: options.repository ?? core?.repository, env });
      const taskContext = core ? bankingRouteContext(body, { core, env, now, conversationHost: options.conversationHost }) : undefined;
      route = validateConversationRoute(await (options.routeConversation ?? routeConversation)(body.message, { env, fetchImpl, client: options.conversationRuntimeClient, signal: request.signal, chatHistory, catalog: publicCapabilityCatalog(catalog), hasContinuation: !!body.continuationToken, taskContext, replyStyle: style }));
      if (['conversation_reply', 'clarify', 'unsupported'].includes(route.kind)) {
        const text = route.kind === 'conversation_reply' && route.topic === 'capabilities' ? capabilityIntroduction(catalog) : route.text;
        // No ConversationState adapter, task transition, or Core mutation is opened.
        if (route.kind === 'conversation_reply' && route.topic === 'capabilities') {
          try { return reply(200, 'OK', text, { status: 'capability_overview', capabilityOverview: buildSkillOverview(catalog) }); }
          catch { /* Degrade to trusted text without inventing capabilities. */ }
        }
        return reply(200, 'OK', text, { status: 'conversation_reply' });
      }
      if (route.kind === 'planning_intent' || route.kind === 'business_intent' && route.continuation === 'new') {
        delete body.continuationToken; delete body.taskId;
        body.taskMode = route.kind === 'planning_intent' ? 'plan' : 'new';
      }
      // Chat context never donates slots, even to an authenticated continuation.
      body.history = [];
    }
    if (coreError) throw coreError;
    const repository = options.repository ?? core.repository;
    conversation = openBankingConversation(body, { core, env, now, parseIntent, conversationHost: options.conversationHost });
    const replay = await conversation.begin();
    if (replay) return replay;
    if (conversation.syncOnly) return reply(200, 'OK', '已核验服务端会话，历史预览不会自动执行。', { status: 'conversation_state' });
    if (route?.kind === 'task_control') {
      if (route.control.command !== 'undo') {
        const target = conversation.selectControlTarget(route.control);
        return reply(200, 'OK', target.taskId ? '请使用已验证的原任务凭据继续业务。' : target.status === 'ambiguous' ? '存在多笔待继续业务，请在待继续业务中明确选择。' : '没有找到可继续的任务，请重新开始业务。', { status: 'task_control', control: { ...target, command: route.control.command } });
      }
      const result = await conversation.taskControl({ kind: 'task_control', control: route.control });
      return reply(200, 'OK', result.status === 'cancelled' ? '原业务已取消，未执行资金操作。' : result.status === 'needs_clarification' ? '存在多笔业务，请明确选择要取消的任务。' : '原任务暂不能取消，请查询原业务状态。', { status: 'task_control', control: { status: result.status, command: 'undo' } });
    }
    if (body.planning === true || body.taskMode === 'plan') {
      const planningTask = await conversation.startPlanning(body.message, body.planningConstraints ?? {});
      let plan;
      try {
        const planningClient = options.planningRuntimeClient ?? createPlanningRuntimeClient({ env, fetchImpl });
        plan = await runReadOnlyPlanner({ message: body.message, history: [], constraints: body.planningConstraints ?? {}, repository, runtimeClient: planningClient, env, now, timezone: options.timezone ?? 'Asia/Shanghai', signal: request.signal, requestId, taskId: planningTask?.taskId, conversation: conversation.metadata() });
      } catch (error) { await conversation.endPlanning('cancelled'); throw error; }
      await conversation.endPlanning(['cancelled', 'partial', 'needs_clarification'].includes(plan.status) ? 'cancelled' : 'completed');
      return reply(200, 'OK', plan.status === 'business_intent' ? '这是单项业务请求，请直接描述要查询或办理的业务。' : plan.status === 'needs_clarification' ? plan.question : plan.analysis || plan.reason || '只读规划已完成', { status: plan.status, plan });
    }
    const scenarioScope = createHash('sha256').update(`${expected}:${clientKey(request)}`).digest('hex');
    const result = await conversation.finish(await runBankingConversation(conversation.body, { core: { ...core, prepare: request => conversation.prepare(request) }, repository, env, now, timezone: options.timezone ?? 'Asia/Shanghai', parseIntent, fetchImpl, requestId, scenarioHandler: options.scenarioHandler, scenarioScope, savingsAdvisor: options.savingsAdvisor, conversation, resumeOnly: conversation.resumeOnly, onDiagnostic: diagnostics.emit }));
    const data = result.data?.recovery ? { ...result.data, recovery: { ...result.data.recovery, continuationToken: result.data.recovery.continuationToken ?? result.data.continuationToken } } : result.data;
    return reply(result.httpStatus, result.code, result.message, data, result.replyContext);
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : error instanceof BankingIntentParserError || error instanceof ParsedIntentValidationError ? 'MODEL_FORMAT_ERROR' : error?.message?.includes('DATABASE_URL') ? 'DATABASE_NOT_CONFIGURED' : 'MODEL_UNAVAILABLE';
    const message = error.userMessage ?? (code.startsWith('CONVERSATION_') ? '会话已更新或暂时不可用，请重新选择或开始当前业务；聊天记录可以保留。' : error instanceof BankingIntentParserError ? error.message : publicMessage(code, '请求未取得可靠结果，请稍后重试。'));
    const data = errorData(code, message);
    diagnostics.emit('agent_model_response', { completed: false, success: false, errorCategory: diagnosticCategory(error) });
    if (error.uncertain) { data.error.uncertain = true; data.operationId = error.operationId; data.action = error.action; data.status = 'core_error'; }
    return reply(Number.isInteger(error?.status) ? error.status : code === 'DATABASE_NOT_CONFIGURED' ? 503 : statusFor(code), code, message, data);
  } finally {
    conversation?.release();
  }
}


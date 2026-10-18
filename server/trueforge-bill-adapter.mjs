import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createTrueforgeClient, trueforgeError } from './trueforge-client.mjs';
import { isBillTask, isCardTask, isTransferTask } from './banking-clarification-parser.mjs';
import { linkedToolResult } from './trueforge-tool-result.mjs';
import { matchBillQuery, YEAR_MONTH } from '../src/lib/trueforge-routing.mjs';

const MONTH = /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/;
const ANSWER = new RegExp(`^(${YEAR_MONTH})(?:的?账单)?[。！？!?]?$`);
const TOKEN_PREFIX = 'tfb1.';
const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const badResult = () => trueforgeError('TRUEFORGE_FORMAT_ERROR', '账单工具结果格式异常，未生成账单。');

function monthFrom(raw) {
  if (!raw) return undefined;
  if (/^\d{1,2}\s*月$/.test(raw)) {
    if (Number(raw.replace(/\s*月$/, '')) < 1 || Number(raw.replace(/\s*月$/, '')) > 12) throw trueforgeError('INVALID_MONTH', '请提供有效月份和年份。', 400);
    return undefined; // A month without a year must clarify, never guess the year.
  }
  const parts = raw.match(/^(\d{4})(?:\s*年\s*|-)(\d{1,2})\s*月?$/);
  const month = parts && `${parts[1]}-${parts[2].padStart(2, '0')}`;
  if (!month || !MONTH.test(month)) throw trueforgeError('INVALID_MONTH', '请提供有效年月，例如 2026 年 8 月。', 400);
  return month;
}

export function isTrueforgeContinuation(token) { return typeof token === 'string' && token.startsWith(TOKEN_PREFIX); }
export function isTrueforgeTaskSwitch(body) {
  return isTrueforgeContinuation(body?.continuationToken) && typeof body.message === 'string' &&
    !isBillTask(body.message) && (isCardTask(body.message) || isTransferTask(body.message));
}
export function shouldRouteTrueforgeBill(body, env) {
  return env.SAVEFLOW_TRUEFORGE_BILL_ENABLED === 'true' && object(body) &&
    ((isTrueforgeContinuation(body.continuationToken) && !isTrueforgeTaskSwitch(body)) || (body.continuationToken === undefined && !!matchBillQuery(body.message)));
}

// Parse only the exact, linked tool.response JSON; never parse model prose or turn output.
export function validateBillToolResult(turn, { serverName, expectedMonth }) {
  const result = linkedToolResult(turn, { tool: 'bill_summary', serverName, expectedArgs: expectedMonth === undefined ? {} : { month: expectedMonth } });
  if (result.ok === false) {
    if (expectedMonth === undefined && result.kind === 'needs_clarification' && result.error?.code === 'MISSING_MONTH' &&
        result.missingSlots?.length === 1 && result.missingSlots[0] === 'month') return { kind: 'needs_clarification' };
    if (result.kind === 'validation_error' && result.error?.code === 'INVALID_MONTH') throw trueforgeError('INVALID_MONTH', '账单工具拒绝了无效月份。', 400);
    throw trueforgeError('BILL_SUMMARY_FAILED', '账单工具调用失败，未取得可靠结果。');
  }
  const d = result.data, evidence = result.evidence;
  if (expectedMonth === undefined || result.ok !== true || result.kind !== 'bill_result' || result.action !== 'bill.summary' ||
      result.currency !== 'CNY' || result.amountUnit !== 'fen' || !object(d) || d.month !== expectedMonth || !MONTH.test(d.month) ||
      !nonnegative(d.totalIncomeFen) || !nonnegative(d.totalExpenseFen) || !nonnegative(d.transactionCount) ||
      !object(d.categoryTotals) || Object.entries(d.categoryTotals).some(([k, n]) => !k.trim() || !nonnegative(n)) ||
      Object.values(d.categoryTotals).reduce((a, b) => a + b, 0) !== d.totalExpenseFen ||
      !Array.isArray(evidence) || evidence.length !== 1 || !object(evidence[0]) ||
      evidence[0].source !== 'synthetic_demo_only' || typeof evidence[0].asOf !== 'string' || !Number.isFinite(Date.parse(evidence[0].asOf)) ||
      !Array.isArray(evidence[0].entityIds) || evidence[0].entityIds.length !== d.transactionCount ||
      evidence[0].entityIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(evidence[0].entityIds).size !== d.transactionCount ||
      (d.transactionCount === 0 && (d.totalIncomeFen !== 0 || d.totalExpenseFen !== 0 || Object.keys(d.categoryTotals).length !== 0))) throw badResult();
  // Copy only the established card fields; no operation IDs, model text or raw events.
  return { kind: 'bill_result', data: { month: d.month, totalIncomeFen: d.totalIncomeFen,
    totalExpenseFen: d.totalExpenseFen, transactionCount: d.transactionCount, categoryTotals: { ...d.categoryTotals } },
    evidence: [{ source: evidence[0].source, asOf: evidence[0].asOf, entityIds: [...evidence[0].entityIds] }] };
}

function validateBody(body) {
  if (!object(body) || Object.keys(body).some(k => !['message', 'history', 'consent', 'continuationToken', 'choice'].includes(k)) ||
      typeof body.message !== 'string' || !body.message.trim() || body.message.length > 2000 || body.choice !== undefined ||
      (body.consent !== undefined && body.consent !== true) ||
      (body.history !== undefined && (!Array.isArray(body.history) || body.history.length > 0))) {
    throw trueforgeError('INVALID_REQUEST', '账单试点需要有效消息和空 history。', 400);
  }
}

export function createTrueforgeBillAdapter({ env = process.env, client, now = Date.now, timeoutMs = 25000, ttlMs = 300000, maxSessions = 500 } = {}) {
  const secret = env.CONTINUATION_TOKEN_SECRET;
  if (typeof secret !== 'string' || secret.length < 16) throw trueforgeError('CONTINUATION_CONFIG_ERROR', '澄清续接服务未配置。', 503);
  const states = new Map();
  const mac = nonce => createHmac('sha256', secret).update(`saveflow-trueforge-bill-v1:${nonce}`).digest('base64url');
  const errorReply = error => {
    const safe = error?.userMessage ? error : trueforgeError('TRUEFORGE_UNAVAILABLE', '账单试点服务暂时不可用。');
    return { httpStatus: safe.status, code: safe.code, message: safe.userMessage, data: { status: 'error', error: { code: safe.code, message: safe.userMessage } } };
  };
  function clean() { for (const [key, value] of states) if (value.expiresAt <= now()) states.delete(key); }
  function lookup(token, scope) {
    clean();
    const parts = typeof token === 'string' ? token.split('.') : [];
    const tag = parts.length === 3 && /^[A-Za-z0-9_-]{43}$/.test(parts[1]) ? mac(parts[1]) : '';
    const supplied = Buffer.from(parts[2] || '');
    const entry = states.get(token);
    if (parts[0] !== 'tfb1' || !tag || supplied.length !== tag.length || !timingSafeEqual(supplied, Buffer.from(tag)) || !entry || entry.scope !== scope) {
      throw trueforgeError('CONTINUATION_INVALID', '账单续接凭据无效或已过期，请重新查账单。', 400);
    }
    return entry;
  }
  function clarification(sessionId, scope) {
    clean();
    if (states.size >= maxSessions) throw trueforgeError('TRUEFORGE_CAPACITY', '账单会话过多，请稍后再试。', 503);
    const nonce = randomBytes(32).toString('base64url');
    const token = `${TOKEN_PREFIX}${nonce}.${mac(nonce)}`;
    states.set(token, { sessionId, scope, expiresAt: now() + ttlMs });
    const question = '想看哪个月的账单？例如 2026 年 8 月。';
    return { httpStatus: 200, code: 'NEEDS_CLARIFICATION', message: question,
      data: { kind: 'clarification', status: 'needs_clarification', action: 'bill.summary', question, slot: 'month', choices: [], continuationToken: token } };
  }
  async function run(message, expectedMonth, scope, sessionId, parentSignal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 25000));
    const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
    let service;
    try {
      service = client ?? createTrueforgeClient({ env });
      sessionId ??= await service.createSession(signal);
      const turn = await service.runTurn(sessionId, JSON.stringify({ userMessage: message, toolArguments: expectedMonth === undefined ? {} : { month: expectedMonth } }), signal);
      const result = validateBillToolResult(turn, { serverName: env.TRUEFORGE_MCP_SERVER, expectedMonth });
      if (result.kind === 'needs_clarification') return clarification(sessionId, scope);
      return { httpStatus: 200, code: 'OK', message: '账单查询完成。', data: { status: 'bill_result', action: 'bill.summary', data: result.data, evidence: result.evidence } };
    } catch (error) {
      if (service && sessionId) await service.cancel(sessionId);
      return errorReply(signal.aborted ? trueforgeError('TRUEFORGE_TIMEOUT', '账单查询超时，请稍后重新查询。', 504) : error);
    } finally { clearTimeout(timer); }
  }
  return {
    discardForTaskSwitch(body, { scope }) {
      validateBody(body);
      if (!isTrueforgeTaskSwitch(body)) throw trueforgeError('INVALID_REQUEST', '请求不属于明确的任务切换。', 400);
      const entry = lookup(body.continuationToken, scope);
      if (entry.answer !== undefined) throw trueforgeError('CONTINUATION_CONSUMED', '账单续接凭据已使用，请重新开始请求。', 409);
      states.delete(body.continuationToken);
      const freshBody = { ...body };
      delete freshBody.continuationToken;
      return freshBody;
    },
    async handle(body, { scope, signal } = {}) {
      try {
        validateBody(body);
        if (typeof scope !== 'string' || !scope) throw trueforgeError('CONTINUATION_INVALID', '账单会话来源无效。', 400);
        const message = body.message.trim();
        if (body.continuationToken !== undefined) {
          const entry = lookup(body.continuationToken, scope);
          const match = ANSWER.exec(message);
          if (!match) throw trueforgeError('INVALID_REQUEST', '请补充明确年月；如需其他操作，请开始新请求。', 400);
          const month = monthFrom(match[1]);
          if (entry.answer !== undefined && entry.answer !== message) throw trueforgeError('CONTINUATION_CONSUMED', '账单续接凭据已使用，请重新查询。', 409);
          // Concurrent and repeated identical resumes share one turn and its response.
          entry.answer = message;
          entry.promise ??= run(message, month, scope, entry.sessionId, signal);
          return await entry.promise;
        }
        const match = matchBillQuery(message);
        if (!match) throw trueforgeError('INVALID_REQUEST', '账单试点只接受明确的账单查询。', 400);
        return await run(message, monthFrom(match[1]), scope, undefined, signal);
      } catch (error) { return errorReply(error); }
    },
  };
}

const adapters = new Map();
export function getTrueforgeBillAdapter(env) {
  const key = createHash('sha256').update(JSON.stringify([env.TRUEFORGE_BASE_URL, env.TRUEFORGE_MODEL,
    env.TRUEFORGE_MCP_SERVER, env.TRUEFORGE_TOKEN, env.CONTINUATION_TOKEN_SECRET])).digest('hex');
  if (!adapters.has(key)) {
    if (adapters.size >= 8) adapters.delete(adapters.keys().next().value);
    adapters.set(key, createTrueforgeBillAdapter({ env: { ...env } }));
  }
  return adapters.get(key);
}

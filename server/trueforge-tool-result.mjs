import { canonical } from '../src/banking-core/errors.mjs';
import { trueforgeError } from './trueforge-client.mjs';

export const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const nonnegativeInteger = v => Number.isSafeInteger(v) && v >= 0;
export const invalidToolResult = () => trueforgeError('TRUEFORGE_FORMAT_ERROR', '工具结果格式或来源异常，未生成业务卡片。');

// Only parse the linked MCP event. The model's output is deliberately absent here.
export function linkedToolResult(turn, { tool, serverName, expectedArgs }) {
  if (!isObject(turn) || turn.calls?.length !== 1 || turn.responses?.length !== 1) throw invalidToolResult();
  const call = turn.calls[0], response = turn.responses[0];
  if (!call.id || call.toolInfo?.type !== 'mcp' || call.toolInfo.name !== tool || call.function?.name !== tool ||
      call.toolInfo.serverName !== serverName || typeof call.toolInfo.serverId !== 'string' || !call.toolInfo.serverId ||
      response.type !== 'tool.response' || response.toolCallId !== call.id || response.threadId !== call.threadId ||
      typeof response.content !== 'string' || response.content.length > 65536) throw invalidToolResult();
  let args, result;
  try { args = JSON.parse(call.function.arguments); result = JSON.parse(response.content); } catch { throw invalidToolResult(); }
  if (!isObject(args) || canonical(args) !== canonical(expectedArgs) || !isObject(result)) throw invalidToolResult();
  if (Array.isArray(result.error)) {
    if (result.error.length !== 1 || result.error[0].type !== 'text') throw invalidToolResult();
    try { result = JSON.parse(result.error[0].text); } catch { throw trueforgeError('TRIAL_TOOL_FAILED', '工具调用失败，未取得可靠结果。'); }
    if (!isObject(result) || result.ok !== false) throw invalidToolResult();
  }
  return result;
}

export function validateEvidence(evidence, ids) {
  const e = evidence?.[0];
  if (!Array.isArray(evidence) || evidence.length !== 1 || !isObject(e) || e.source !== 'synthetic_demo_only' ||
      typeof e.asOf !== 'string' || !Number.isFinite(Date.parse(e.asOf)) || !Array.isArray(e.entityIds) ||
      e.entityIds.some(id => typeof id !== 'string' || !id) || new Set(e.entityIds).size !== e.entityIds.length ||
      (ids && canonical([...e.entityIds].sort()) !== canonical([...ids].sort()))) throw invalidToolResult();
  return structuredClone(evidence);
}

export async function withTrueforgeDeadline({ client, sessionId, signal: parentSignal, timeoutMs = 25000 }, run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 25000));
  const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
  try {
    sessionId ??= await client.createSession(signal);
    return await run(sessionId, signal);
  } catch (error) {
    if (sessionId) await client.cancel(sessionId);
    if (signal.aborted) throw trueforgeError('TRUEFORGE_TIMEOUT', '试点查询或预览超时，请重新开始请求。', 504);
    throw error;
  } finally { clearTimeout(timer); }
}

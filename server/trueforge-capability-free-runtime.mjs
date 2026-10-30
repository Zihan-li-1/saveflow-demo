import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import { canonical } from '../src/banking-core/errors.mjs';
import { trueforgeError } from './trueforge-client.mjs';

// Shared transport only: every caller supplies its own task-specific policy.
export function createCapabilityFreeRuntimeClient({ env = process.env, fetchImpl = fetch, sdk, spec } = {}) {
  let url;
  try { url = new URL(env.TRUEFORGE_BASE_URL); } catch { throw trueforgeError('TRUEFORGE_CONFIG_ERROR', 'Banking 理解服务未配置。', 503); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw trueforgeError('TRUEFORGE_CONFIG_ERROR', 'Banking 理解服务配置无效。', 503);
  }
  const sdkClient = sdk ?? new TrueForge({ baseUrl: url.origin, token: env.TRUEFORGE_TOKEN || undefined, fetch: fetchImpl, maxRetries: 0, timeoutInSeconds: 25 });
  function verify(session) {
    const s = session?.agent?.spec;
    if (!session?.id || session.shared !== false || !s || canonical(s.model) !== canonical(spec.model) || s.instructions !== spec.instructions ||
        canonical(s.responseFormat) !== canonical(spec.responseFormat) || s.mcpServers?.length !== 0 || s.skills?.length !== 0 || s.messages?.length ||
        canonical(s.config) !== canonical(spec.config)) throw trueforgeError('TRUEFORGE_AGENT_POLICY_ERROR', '理解服务权限配置不符合要求。');
    return session.id;
  }
  return {
    async createSession(signal) { return verify((await sdkClient.sessions.create({ agent: { spec } }, { abortSignal: signal, maxRetries: 0 })).data); },
    async runTurn(sessionId, message, signal) {
      if (verify((await sdkClient.sessions.get(sessionId, { abortSignal: signal, maxRetries: 0 })).data) !== sessionId) throw trueforgeError('TRUEFORGE_SESSION_ERROR', '理解会话无效。');
      const stream = await sdkClient.sessions.createTurnStream(sessionId, { input: [{ type: 'user.message', content: message }] }, { abortSignal: signal, maxRetries: 0 });
      const events = new Map();
      let terminal, turnId, count = 0, bytes = 0;
      for await (const { data: event } of stream.withMetadata()) {
        bytes += JSON.stringify(event).length;
        if (++count > 10000 || bytes > 262144) throw trueforgeError('TRUEFORGE_FORMAT_ERROR', '理解服务返回格式异常。');
        if (event.type === 'tool.response' || event.type?.startsWith('tool.') || event.toolCalls?.length || event.state?.requiredActions?.length) {
          throw trueforgeError('TRUEFORGE_AGENT_POLICY_ERROR', '理解阶段禁止工具调用或权限请求。');
        }
        if (isEventDelta(event)) {
          const base = events.get(event.id);
          if (!base) throw trueforgeError('TRUEFORGE_FORMAT_ERROR', '理解服务返回格式异常。');
          mergeEventDelta(base, event);
        } else {
          if (events.has(event.id)) throw trueforgeError('TRUEFORGE_FORMAT_ERROR', '理解服务返回重复事件。');
          events.set(event.id, event);
        }
        if (event.type === 'turn.created') turnId = event.turnId;
        if (event.type === 'turn.done') {
          if (terminal) throw trueforgeError('TRUEFORGE_FORMAT_ERROR', '理解服务返回重复终态。');
          terminal = event.state;
        }
      }
      const output = terminal?.output;
      // The live runtime regenerates createdAt for the terminal snapshot.
      // Compare every other field, including content, identity and permissions.
      const comparableMessage = value => {
        if (!value) return value;
        const copy = { ...value };
        delete copy.createdAt;
        return copy;
      };
      if (!turnId || terminal?.status !== 'done' || terminal.requiredActions?.length || output?.type !== 'model.message' || output.threadId !== 'main' ||
          output.toolCalls?.length || output.refusal || output.finishReason !== 'stop' || canonical(comparableMessage(events.get(output.id))) !== canonical(comparableMessage(output))) {
        throw trueforgeError('TRUEFORGE_TURN_FAILED', '理解服务未返回完整结果。');
      }
      if (typeof output.content === 'string') return output.content;
      if (Array.isArray(output.content) && output.content.every(p => p.type === 'text' && typeof p.text === 'string')) return output.content.map(p => p.text).join('');
      throw trueforgeError('TRUEFORGE_FORMAT_ERROR', '理解服务返回格式异常。');
    },
    async cancel(sessionId) { await sdkClient.sessions.cancel(sessionId, { abortSignal: AbortSignal.timeout(1000), timeoutInSeconds: 1, maxRetries: 0 }).catch(() => {}); },
  };
}

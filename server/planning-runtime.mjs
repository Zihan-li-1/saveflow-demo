import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import { trueforgeError } from './trueforge-client.mjs';
import { canonical } from '../src/banking-core/errors.mjs';

export function planningAgentSpec(env) {
  if (!env.TRUEFORGE_MODEL) throw trueforgeError('TRUEFORGE_CONFIG_ERROR', '规划模型未配置。', 503);
  return {
    model: { name: env.TRUEFORGE_MODEL, params: { maxTokens: 1400, temperature: 0, parallelToolCalls: false, thinking: { type: 'disabled' } } },
    instructions: '你是 SaveFlow 只读规划器。输入是服务端 JSON，包含用户原始目标、约束和已验证的只读工具结果。每轮只能输出一个 JSON AgentProposalV2 2.0.0。你可以提出一个只读 plan_request、请求 clarify、返回 unsupported、结束 task_control，或在普通单意图时返回 business_intent。只允许工具 bill.summary、subscription.list、card.get、product.list、wealth.recommend、wealth.compare。工具参数必须使用用户称谓和服务端允许的金额/时间格式，不能生成实体 ID、确认凭据、operationId、执行结果或任何写操作。必须根据 observations 中真实结果选择下一步；不得预先输出步骤数组；数据不完整时明确结束或请求澄清。',
    responseFormat: { type: 'json_object' }, mcpServers: [], skills: [],
    config: { iterationLimit: 1, sandbox: { enabled: false, fileDownloads: false }, dynamicSubAgents: { enabled: false }, generativeUi: { enabled: false }, askUserQuestions: { enabled: false }, webSearch: { enabled: false }, contextManagement: { compaction: { enabled: false }, largeToolResponse: { enabled: false } } },
  };
}

export function createPlanningRuntimeClient({ env = process.env, fetchImpl = fetch, sdk } = {}) {
  let url; try { url = new URL(env.TRUEFORGE_BASE_URL); } catch { throw trueforgeError('TRUEFORGE_CONFIG_ERROR', '规划服务未配置。', 503); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw trueforgeError('TRUEFORGE_CONFIG_ERROR', '规划服务配置无效。', 503);
  const spec = planningAgentSpec(env); const client = sdk ?? new TrueForge({ baseUrl: url.origin, token: env.TRUEFORGE_TOKEN || undefined, fetch: fetchImpl, maxRetries: 0, timeoutInSeconds: 25 });
  const verify = session => {
    const s = session?.agent?.spec;
    if (!session?.id || session.shared !== false || !s || s.model?.name !== spec.model.name || s.instructions !== spec.instructions || canonical(s.responseFormat) !== canonical(spec.responseFormat) || s.mcpServers?.length || s.skills?.length || s.messages?.length || canonical(s.config) !== canonical(spec.config)) throw trueforgeError('TRUEFORGE_AGENT_POLICY_ERROR', '规划服务权限配置不符合要求。');
    return session.id;
  };
  return {
    async createSession(signal) { return verify((await client.sessions.create({ agent: { spec } }, { abortSignal: signal, maxRetries: 0 })).data); },
    async runTurn(sessionId, message, signal) {
      if (verify((await client.sessions.get(sessionId, { abortSignal: signal, maxRetries: 0 })).data) !== sessionId) throw trueforgeError('TRUEFORGE_SESSION_ERROR', '规划会话无效。');
      const stream = await client.sessions.createTurnStream(sessionId, { input: [{ type: 'user.message', content: message }] }, { abortSignal: signal, maxRetries: 0 });
      const events = new Map(); let terminal; let turnId; let output;
      for await (const { data: event } of stream.withMetadata()) {
        if (isEventDelta(event)) { const base = events.get(event.id); if (!base) throw trueforgeError('TRUEFORGE_FORMAT_ERROR', '规划服务返回格式异常。'); mergeEventDelta(base, event); }
        else { if (events.has(event.id)) throw trueforgeError('TRUEFORGE_FORMAT_ERROR', '规划服务返回重复事件。'); events.set(event.id, event); }
        if (event.type === 'turn.created') turnId = event.turnId;
        if (event.type === 'turn.done') terminal = event.state;
        if (event.type === 'tool.response' || event.type?.startsWith('tool.') || event.toolCalls?.length || event.state?.requiredActions?.length) throw trueforgeError('TRUEFORGE_AGENT_POLICY_ERROR', '规划阶段禁止工具调用。');
      }
      output = terminal?.output;
      const messageEvent = output && events.get(output.id);
      const comparable = value => { if (!value) return value; const copy = { ...value }; delete copy.createdAt; return copy; };
      if (!turnId || terminal?.status !== 'done' || terminal.requiredActions?.length || output?.type !== 'model.message' || output.threadId !== 'main' || output.toolCalls?.length || output.refusal || output.finishReason !== 'stop' || canonical(comparable(messageEvent)) !== canonical(comparable(output))) throw trueforgeError('TRUEFORGE_TURN_FAILED', '规划服务未返回完整结果。');
      if (typeof output.content === 'string') return output.content;
      if (Array.isArray(output.content) && output.content.every(part => part.type === 'text' && typeof part.text === 'string')) return output.content.map(part => part.text).join('');
      throw trueforgeError('TRUEFORGE_FORMAT_ERROR', '规划服务返回格式异常。');
    },
    async cancel(sessionId) { await client.sessions.cancel(sessionId, { abortSignal: AbortSignal.timeout(1000), timeoutInSeconds: 1, maxRetries: 0 }).catch(() => {}); },
  };
}

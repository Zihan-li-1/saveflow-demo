import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import { trueforgeError } from './trueforge-client.mjs';
import { canonical } from '../src/banking-core/errors.mjs';

const planningOutputContract = `
输出契约（严格匹配，不得使用 type 或 proposalVersion）：顶层 schemaVersion 必须为 "2.0.0"，用 kind 区分分支。每轮只输出下列一种对象，省略其他分支字段，不要 Markdown 或 null。
读取示例：{"schemaVersion":"2.0.0","kind":"plan_request","plan_request":{"tool":"bill.summary","arguments":{"month":"2026-08"}}}
依赖示例：{"schemaVersion":"2.0.0","kind":"plan_request","plan_request":{"tool":"subscription.list","arguments":{},"depends_on":["bill.summary"]}}
结束示例：{"schemaVersion":"2.0.0","kind":"task_control","task_control":{"command":"finish","analysis":"根据已观察结果说明分析和局限。","evidence_tools":["bill.summary","subscription.list"]}}
澄清示例：{"schemaVersion":"2.0.0","kind":"clarify","clarify":{"question":"请选择有数据的月份。"}}
不支持示例：{"schemaVersion":"2.0.0","kind":"unsupported","unsupported":{"reason":"该请求需要未授权的写操作。"}}
工具 arguments 精确白名单：
bill.summary: {month:"YYYY-MM"} 或 {period:{start_date:"YYYY-MM-DD",end_date:"YYYY-MM-DD",timezone:"Asia/Shanghai",label:"期间说明"}}，二选一，不能带 user、start_date 顶层、字符串 period 或账户 ID。
subscription.list、product.list: {}。
card.get: {} 或 {card_ref:"用户原始卡片称谓"}。
wealth.compare: {product_refs:["原始称谓一","原始称谓二"]}，共2至5项。
wealth.recommend: {goal:"目标",max_risk_level:"R1|R2|R3",horizon_days:整数,liquidity_requirement:"T+0|T+1|AT_MATURITY"}，可选 amount:{amount_minor:整数分,currency:"CNY"}。风险、期限、流动性和金额必须与输入 task.constraints 明确提供的值完全相同；未提供则 clarify，不能自行补全。
plan_request 仅允许 tool、arguments、可选 depends_on（先前成功工具名称数组）及 reason；reason 不能放在 arguments 内。遇到缺数据，不把零记录当作零支出；先核验 coverage、availableMonths 和 observations，再给出有限结论。`;

export function planningAgentSpec(env) {
  if (!env.TRUEFORGE_MODEL) throw trueforgeError('TRUEFORGE_CONFIG_ERROR', '规划模型未配置。', 503);
  return {
    model: { name: env.TRUEFORGE_MODEL, params: { maxTokens: 1400, temperature: 0, parallelToolCalls: false, thinking: { type: 'disabled' } } },
    instructions: '你是 SaveFlow 只读规划器。解释今年、上个月和未写年份的月份时，以服务端 calendar.currentDate 和 calendar.timezone 为唯一日历基准。输入是服务端 JSON，包含用户原始目标、约束和已验证的只读工具结果。每轮只能输出一个 JSON AgentProposalV2 2.0.0。你可以提出一个只读 plan_request、请求 clarify、返回 unsupported、结束 task_control，或在普通单意图时返回 business_intent。只允许工具 bill.summary、subscription.list、card.get、product.list、wealth.recommend、wealth.compare。工具参数必须使用用户称谓和服务端允许的金额/时间格式，不能生成实体 ID、确认凭据、operationId、执行结果或任何写操作。必须根据 observations 中真实结果选择下一步；不得预先输出步骤数组。结束时 task_control.command=finish，并提供 analysis 文字和 evidence_tools 工具名称数组；只引用已成功观察的工具，不得编造金额或因果结论；数据不完整时明确说明。' + planningOutputContract,
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

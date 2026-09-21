import { ApiError, type Analysis } from './api/contracts';

export type AgentPlan = { monthlySavingFen: number; saveRateBps: number; category: string; targetAmountFen: number | null };
export type AgentReply = { intent: string; reply: string; needsClarification: boolean; plan: AgentPlan | null; analysis: Analysis; model: string; usage: { inputTokens: number; outputTokens: number } };
export type AgentTurn = { role: 'user' | 'assistant'; content: string };
export async function askQwen(message: string, history: AgentTurn[], accessCode: string, signal: AbortSignal): Promise<AgentReply> {
  let response: Response;
  try {
    response = await fetch('/api/agent', { method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), headers: { 'Content-Type': 'application/json', 'X-Saveflow-Access': accessCode }, body: JSON.stringify({ message, history: history.slice(-6), consent: true }) });
  } catch { throw new ApiError('MODEL_NETWORK_ERROR', '模型连接失败或超时，请稍后重试。'); }
  if (response.status === 404 || response.status === 405) throw new ApiError('MODEL_NOT_DEPLOYED', '模型服务尚未部署。本地请运行 npm run dev:qwen；Netlify 需要同时部署 Function。');
  let payload;
  try { payload = await response.json(); } catch { throw new ApiError('MODEL_RESPONSE_ERROR', response.status === 429 ? '请求过于频繁，请一分钟后重试。' : '模型接口返回格式异常。'); }
  if (!response.ok || payload.code !== 'OK') throw new ApiError(payload.code || 'MODEL_ERROR', payload.message || '模型请求失败');
  const data = payload.data;
  if (!data || typeof data.reply !== 'string' || typeof data.needsClarification !== 'boolean' || !data.analysis || !data.usage ||
    !Number.isSafeInteger(data.analysis.totalExpenseFen) || !Number.isInteger(data.analysis.subscriptionCount) ||
    (data.plan !== null && (!data.plan || !Number.isSafeInteger(data.plan.monthlySavingFen) || data.plan.monthlySavingFen <= 0 || data.plan.monthlySavingFen > 300000 || !Number.isInteger(data.plan.saveRateBps) || data.plan.saveRateBps < 0 || data.plan.saveRateBps > 10000 || !['日常消费', '餐饮', '购物', '交通', '娱乐', '订阅', '其他'].includes(data.plan.category)))) {
    throw new ApiError('MODEL_RESPONSE_ERROR', '模型建议未通过前端校验。');
  }
  return data as AgentReply;
}

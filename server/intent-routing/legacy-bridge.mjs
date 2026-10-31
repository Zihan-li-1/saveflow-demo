import { IntentUnderstanding } from './service.mjs';
import { buildParsedIntent } from '../../src/agent/clarification/merge-intent.mjs';

export function routingMessage(result) {
  const missing = result.missing_fields.map(item => item.question).join(' ');
  const unsupported = result.unsupported_parts.map(item => `${item.capability}：${item.reason}`).join('；');
  if (result.decision === 'UNSUPPORTED') return `当前不支持的能力：${unsupported || '该目标所需能力'}。未执行操作。`;
  if (result.decision === 'PARTIALLY_SUPPORTED') return `仅部分目标有对应能力。可规划：${result.selected_skills.join('、')}；不支持：${unsupported}。尚未执行，请明确是否只处理可支持部分。`;
  if (result.decision === 'CLARIFICATION_REQUIRED') return `${missing || '请补充目标。'}${unsupported ? ` 同时缺少能力：${unsupported}。` : ''}`;
  return `已识别 ${result.execution_plan.steps.length} 个步骤，尚未执行。`;
}
export async function recoverSemanticIntent(message, { registry, model, context, now, timezone, signal, env } = {}) {
  const service = new IntentUnderstanding({ registry, model, now, timezone, traceOptions: { env } });
  const result = await service.route(message, { trustedContext: context, signal });
  const step = result.execution_plan.steps[0];
  if (step && result.execution_plan.steps.length === 1 && !result.unsupported_parts.length && ['MATCHED', 'CLARIFICATION_REQUIRED'].includes(result.decision) && !result.missing_fields.some(item => ['goal', 'arguments', 'dependency', 'understanding'].includes(item.field))) {
    const { action, ...slots } = step.arguments;
    try { return { result, intent: buildParsedIntent(action, slots) }; } catch { /* The original authoritative validator still decides. */ }
  }
  return { result, intent: null };
}
export function semanticRoutingError(result) {
  return Object.assign(new Error('SEMANTIC_ROUTING_REVIEW'), { code: 'SEMANTIC_ROUTING_REVIEW', status: 200, userMessage: routingMessage(result), routing: result });
}

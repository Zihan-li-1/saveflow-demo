// Explicit model-response fixtures. These test routing contracts, NOT live LLM accuracy.
export const task = (task_id, goal, required_capability, depends_on = []) => ({ task_id, goal, required_capability, depends_on });
export const analysis = (query, tasks, missing_information = []) => ({ user_goal: query, normalized_intent: '用户目标', tasks, entities: {}, constraints: {}, missing_information, unsupported_parts: [] });
export const match = (task_id, skill_name, capability, confidence = 0.95) => ({ task_id, skill_name, capability, confidence, reason: '该任务语义符合已注册能力及其边界' });
export const extraction = (task_id, args, query, sources = {}) => ({ task_id, arguments: args, evidence: Object.keys(args).filter(field => field !== 'action').map(field => ({ field, source: sources[field] ?? 'user_message', quote: query })), missing_fields: [] });
export class MockSemanticModel {
  constructor(stages) { this.stages = stages; this.calls = []; }
  async complete(stage, input) { this.calls.push({ stage, input: structuredClone(input) }); const value = this.stages[stage]; if (typeof value === 'function') return value(input); return structuredClone(value); }
}
export const regressionCases = [
  {
    id: 'A', query: '帮我生成500元以内耳机的购物平台搜索链接', expected: 'UNSUPPORTED',
    stages: {
      understanding: analysis('生成预算范围内的耳机购物搜索链接', [task('search', '生成耳机购物搜索链接', 'headphone_shopping_search_links')]),
      matching: { matches: [], unmatched_tasks: [{ task_id: 'search', capability: 'headphone_shopping_search_links', reason: '五个统一 Skill 没有耳机搜索能力；既有购物子流程也仅支持鲜花和蛋糕', clarification_required: false }] },
      extraction: { tasks: [] },
    },
  },
  {
    id: 'B', query: '创建一条模拟规则：娱乐卡本月消费达到预算的80%时提醒我', expected: 'PARTIALLY_SUPPORTED',
    stages: {
      understanding: analysis('基于娱乐卡消费预算的阈值提醒', [task('snapshot', '查询娱乐卡预算和本月已消费', 'card_budget_snapshot'), task('monitor', '监听消费是否达到80%预算', 'budget_threshold_monitoring', ['snapshot']), task('notify', '达到条件后发提醒', 'notification_delivery', ['monitor'])]),
      matching: { matches: [match('snapshot', 'card', 'card_budget_snapshot')], unmatched_tasks: [
        { task_id: 'monitor', capability: 'budget_threshold_monitoring', reason: '规则提案不能替代已运行的阈值监听器', clarification_required: false },
        { task_id: 'notify', capability: 'notification_delivery', reason: '没有已注册的通知发送能力', clarification_required: false },
      ] },
      extraction: { tasks: [extraction('snapshot', { action: 'card.get', card_ref: '娱乐卡' }, '创建一条模拟规则：娱乐卡本月消费达到预算的80%时提醒我')] },
    },
  },
];

/**
 * A narrow safety fallback for the budget-threshold reminder demonstrated by
 * the capability catalog. It produces only a suggest-only rule draft; Core
 * preview and explicit confirmation are still required before saving it.
 */
export function budgetReminderRuleIntentFromMessage(message = '') {
  const text = String(message ?? '').trim();
  if (!/(?:创建|新增|设置).*(?:模拟)?规则/.test(text) || !/(?:提醒我|通知我)/.test(text)) return null;
  const percentMatch = /(?:预算|月预算)(?:的)?\s*(\d{1,3})\s*%/.exec(text);
  if (!percentMatch) return null;
  const thresholdPercent = Number(percentMatch[1]);
  if (!Number.isInteger(thresholdPercent) || thresholdPercent < 1 || thresholdPercent > 100) return null;
  const cardMatch = /(?:规则[：:\s]*)?([^，。,:：]{1,32}?卡)(?:本月|当月|这个月|月度)/.exec(text);
  if (!cardMatch) return null;
  const cardRef = cardMatch[1].replace(/^(?:创建|新增|设置)(?:一条|一个)?(?:模拟)?规则[：:\s]*/, '').trim();
  if (!cardRef) return null;
  return {
    schemaVersion: '1.0.0',
    action: 'scenario.create_rule',
    slots: {
      trigger: { type: 'financial_event', value: 'card_monthly_budget_usage_changed' },
      conditions: { card_ref: cardRef, budget_usage_percent_gte: thresholdPercent },
      proposed_steps: [{ action: 'notification.remind', parameters: { channel: 'in_app', message: `${cardRef}本月消费达到预算的 ${thresholdPercent}%` } }],
      authorization_scope: 'suggest_only',
    },
    missingSlots: [],
    status: 'ready_for_resolution',
  };
}

const DATE_WINDOW = /^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}-\d{2}:\d{2}$/;

/** 只有用户提到未来日期时间才进入预留预算与提醒流程；没提时间一律按现在就买。 */
export function purchaseNeedsReservation(slots = {}) {
  return typeof slots.date_expression === 'string' && slots.date_expression.trim() !== '';
}

/** 预算月份固定等于时间所在月份；用户没单独说预算月份时按日期推导。 */
export function deriveBudgetMonth(slots = {}) {
  if (slots.budget_month) return slots.budget_month;
  const match = /^(\d{4}-\d{2})/.exec(String(slots.date_expression ?? ''));
  return match ? match[1] : undefined;
}

/** 进入预留流程后仍缺少的信息：只给短提示和可选选项，不再整段追问。 */
export function purchaseMissingQuestions(slots = {}) {
  const questions = [];
  if (!Array.isArray(slots.items) || slots.items.length === 0) {
    questions.push({ field: 'items', prompt: '买什么？', options: ['鲜花', '蛋糕'] });
  }
  const precise = typeof slots.date_expression === 'string' && DATE_WINDOW.test(slots.date_expression.trim());
  if (!precise) questions.push({ field: 'date_expression', prompt: '哪天、哪个时间段？', hint: '例如 11月1日 09:00–12:00' });
  if (!slots.date_meaning) questions.push({ field: 'date_meaning', prompt: '届时怎么处理？', options: ['提醒我下单', '希望送达'] });
  if (!slots.budget) questions.push({ field: 'budget', prompt: '预留多少预算？', hint: '例如 500 元' });
  if (!slots.funding_account_ref) questions.push({ field: 'funding_account_ref', prompt: '从哪个账户预留？', hint: '例如 我的活期账户' });
  return questions;
}

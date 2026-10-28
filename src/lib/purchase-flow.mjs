const DATE_WINDOW = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})-(\d{2}:\d{2})$/;

/** 用户提到预算、预算月份或日期时间，即进入预留预算与提醒流程；否则按现在就买处理。 */
export function purchaseNeedsReservation(slots = {}) {
  return Boolean(slots.budget || slots.budget_month || (typeof slots.date_expression === 'string' && slots.date_expression.trim()));
}

/** 进入预留流程后仍缺少的必要信息，按顺序逐项追问。 */
export function purchaseMissingQuestions(slots = {}) {
  const questions = [];
  if (!Array.isArray(slots.items) || slots.items.length === 0) {
    questions.push({ field: 'items', question: '想买什么？鲜花、蛋糕，还是都要？' });
  }
  const precise = typeof slots.date_expression === 'string' && DATE_WINDOW.test(slots.date_expression.trim());
  if (!precise) questions.push({ field: 'date_expression', question: '具体是哪天、哪个时间段？（例如 2026-11-01 09:00-12:00）' });
  if (!slots.date_meaning) questions.push({ field: 'date_meaning', question: '是希望那天提醒你下单，还是希望那天送达？' });
  if (!slots.budget) questions.push({ field: 'budget', question: '要预留多少预算？' });
  if (!slots.funding_account_ref) questions.push({ field: 'funding_account_ref', question: '从哪个账户预留这笔钱？' });
  if (!slots.budget_month && !precise) questions.push({ field: 'budget_month', question: '这笔预算记在哪个月？' });
  return questions;
}

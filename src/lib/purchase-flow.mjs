import { localDate, validCalendarDate } from './calendar.mjs';

const DATE_WINDOW = /^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}-\d{2}:\d{2}$/;

/** Preserve partial dates: knowing the day does not imply knowing the time. */
export function purchaseDateFields(expression = '', currentDate = localDate(Date.now())) {
  const digits = '零一二三四五六七八九';
  const number = value => {
    if (/^\d+$/.test(value)) return Number(value);
    if (!/^(?:[一二三]?十[一二三四五六七八九]?|[一二三四五六七八九])$/.test(value)) return NaN;
    const [tens, units] = value.split('十');
    return value.includes('十') ? (tens ? digits.indexOf(tens) : 1) * 10 + (units ? digits.indexOf(units) : 0) : digits.indexOf(value);
  };
  const match = /^(?:(\d{4})[-/.年])?([\d一二三四五六七八九十]+)[-/.月]([\d一二三四五六七八九十]+)(?:日|号)?(?:\s+(\d{2}:\d{2})(?:-(\d{2}:\d{2}))?)?$/.exec(expression.trim());
  if (!match) return { date: '', start: '', end: '' };
  let year = Number(match[1] || currentDate.slice(0, 4));
  const monthDay = `${String(number(match[2])).padStart(2, '0')}-${String(number(match[3])).padStart(2, '0')}`;
  let date = `${year}-${monthDay}`;
  if (!match[1] && date < currentDate) date = `${++year}-${monthDay}`;
  if (!validCalendarDate(date)) return { date: '', start: '', end: '' };
  return { date, start: match[4] ?? '', end: match[5] ?? '' };
}

export function normalizePurchaseSlots(slots, currentDate) {
  const { date, start, end } = purchaseDateFields(slots.date_expression, currentDate);
  if (!date) return slots;
  return { ...slots, date_expression: `${date}${start ? ` ${start}${end ? `-${end}` : ''}` : ''}`, budget_month: date.slice(0, 7) };
}

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
  if (!precise) questions.push({ field: 'date_expression', prompt: '哪天、哪个时间段？' });
  if (!slots.date_meaning) questions.push({ field: 'date_meaning', prompt: '届时怎么处理？', options: ['提醒我下单', '希望送达'] });
  if (!slots.budget) questions.push({ field: 'budget', prompt: '预留多少预算？' });
  if (!slots.funding_account_ref) questions.push({ field: 'funding_account_ref', prompt: '用哪张卡预留？' });
  return questions;
}

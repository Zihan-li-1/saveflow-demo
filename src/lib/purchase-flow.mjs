import { localDate, validCalendarDate } from './calendar.mjs';

const DATE_WINDOW = /^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}-\d{2}:\d{2}$/;

/** Preserve partial dates: knowing the day does not imply knowing the time. Missing year means the current year. */
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
  const year = Number(match[1] || currentDate.slice(0, 4));
  const monthDay = `${String(number(match[2])).padStart(2, '0')}-${String(number(match[3])).padStart(2, '0')}`;
  const date = `${year}-${monthDay}`;
  if (!validCalendarDate(date)) return { date: '', start: '', end: '' };
  return { date, start: match[4] ?? '', end: match[5] ?? '' };
}

export function normalizePurchaseSlots(slots, currentDate) {
  const { date, start, end } = purchaseDateFields(slots.date_expression, currentDate);
  if (!date) return slots;
  return { ...slots, date_expression: `${date}${start ? ` ${start}${end ? `-${end}` : ''}` : ''}`, budget_month: date.slice(0, 7) };
}

const PURCHASE_ACTION = /(买|购买|订购|订|准备|预留|提醒)/;
const NON_PURCHASE = /(取消|退订|订阅|规则|比例|退款|退货|花呗|花销|转账|汇款|转给|订单|物流|快递|到货|进度|查询)/;
const CAPABILITY_QUESTION = /^(?:请问\s*)?(?:(?:你|我|这个应用|系统|SaveFlow)\s*)?(?:能不能|可不可以|能否|是否(?:能|可以)|能|可以|会).*(?:吗|么|[?？])\s*$/i;
const DATE_TEXT = /(\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*[日号]?|\d{1,2}\s*[.\-/月]\s*\d{1,2}\s*[日号]?|[一二三四五六七八九十]{1,3}\s*月\s*[一二三四五六七八九十]{1,3}\s*[日号])/;

/** 模型没把购物请求认成 scenario.plan_purchase 时的兜底：从用户原话重建购物意图，避免整条流程被模型一句话吞掉。 */
export function purchaseIntentFromMessage(message = '', currentDate = localDate(Date.now())) {
  const text = String(message ?? '');
  if (!text || NON_PURCHASE.test(text) || CAPABILITY_QUESTION.test(text) || !PURCHASE_ACTION.test(text)) return null;
  const items = [];
  if (/(鲜花|花束|玫瑰|郁金香|向日葵|康乃馨|百合|花)/.test(text)) items.push({ category: 'flowers', quantity: 1 });
  if (/蛋糕/.test(text)) items.push({ category: 'cake', quantity: 1 });
  if (!items.length) return null;
  const slots = { items };
  const fields = purchaseDateFields(DATE_TEXT.exec(text)?.[1] ?? '', currentDate);
  if (fields.date) slots.date_expression = `${fields.date}${fields.start ? ` ${fields.start}${fields.end ? `-${fields.end}` : ''}` : ''}`;
  if (/送达|送到/.test(text)) slots.date_meaning = 'deliver_on';
  else if (/提醒|下单/.test(text)) slots.date_meaning = 'order_on';
  return slots;
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


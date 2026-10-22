const TIMEZONE = 'Asia/Shanghai';
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function partsAt(now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  const value = type => Number(parts.find(part => part.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day') };
}
function lastDay(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function date(year, month, day) { return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`; }
function validDate(value) {
  const match = DATE.exec(value); if (!match) return false;
  const [, y, m, d] = match; const parsed = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return parsed.getUTCFullYear() === Number(y) && parsed.getUTCMonth() + 1 === Number(m) && parsed.getUTCDate() === Number(d);
}
function range(startDate, endDate, label) {
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate || (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000 >= 366) return null;
  return { period: { start_date: startDate, end_date: endDate, timezone: TIMEZONE, label } };
}

/** Resolve explicit or calendar-relative Chinese bill periods without model guessing. */
export function resolveBillPeriod(message, now = Date.now()) {
  if (typeof message !== 'string') return null;
  const text = message.trim();
  const explicitRange = text.match(/((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*(?:到|至|—|-|~|～)\s*((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (explicitRange) return range(date(Number(explicitRange[1]), Number(explicitRange[2]), Number(explicitRange[3])), date(Number(explicitRange[4]), Number(explicitRange[5]), Number(explicitRange[6])), `${explicitRange[1]}年${Number(explicitRange[2])}月${Number(explicitRange[3])}日至${explicitRange[4]}年${Number(explicitRange[5])}月${Number(explicitRange[6])}日`);
  const explicitMonth = text.match(/((?:19|20)\d{2})\s*(?:年|-|\/|\.)\s*(\d{1,2})\s*月?/);
  if (explicitMonth) {
    const month = Number(explicitMonth[2]);
    return month >= 1 && month <= 12 ? { month: `${explicitMonth[1]}-${String(month).padStart(2, '0')}` } : null;
  }

  const current = partsAt(now);
  const statedYear = text.match(/((?:19|20)\d{2})\s*年/)?.[1];
  const relativeYearOffset = /前年/.test(text) ? -2 : /去年/.test(text) ? -1 : /明年/.test(text) ? 1 : 0;
  const year = statedYear ? Number(statedYear) : current.year + relativeYearOffset;
  const season = text.match(/(春季|春天|夏季|夏天|秋季|秋天|冬季|冬天)/)?.[1];
  if (season) {
    if (/春/.test(season)) return range(date(year, 3, 1), date(year, 5, 31), `${year}年春季`);
    if (/夏/.test(season)) return range(date(year, 6, 1), date(year, 8, 31), `${year}年夏季`);
    if (/秋/.test(season)) return range(date(year, 9, 1), date(year, 11, 30), `${year}年秋季`);
    return range(date(year, 12, 1), date(year + 1, 2, lastDay(year + 1, 2)), `${year}年冬季`);
  }
  if (/上半年/.test(text)) return range(date(year, 1, 1), date(year, 6, 30), `${year}年上半年`);
  if (/下半年/.test(text)) return range(date(year, 7, 1), date(year, 12, 31), `${year}年下半年`);
  const quarter = text.match(/(?:第\s*)?([一二三四1-4])\s*季度|Q\s*([1-4])/i);
  if (quarter) {
    const map = { 一: 1, 二: 2, 三: 3, 四: 4 }; const q = Number(quarter[2] || map[quarter[1]] || quarter[1]); const startMonth = (q - 1) * 3 + 1;
    return range(date(year, startMonth, 1), date(year, startMonth + 2, lastDay(year, startMonth + 2)), `${year}年第${q}季度`);
  }
  if (/今年/.test(text)) return range(date(current.year, 1, 1), date(current.year, current.month, current.day), `${current.year}年至今`);
  if (/前年|去年|明年/.test(text)) return range(date(year, 1, 1), date(year, 12, 31), `${year}年全年`);
  if (statedYear && /全年|年度|一年|年账单/.test(text)) return range(date(year, 1, 1), date(year, 12, 31), `${year}年全年`);
  const recent = text.match(/(?:最近|近|过去|前)\s*(\d{1,2})\s*个?月/);
  if (recent) {
    const count = Number(recent[1]); if (count < 1 || count > 12) return null;
    const start = new Date(Date.UTC(current.year, current.month - count, 1));
    return range(date(start.getUTCFullYear(), start.getUTCMonth() + 1, 1), date(current.year, current.month, current.day), `最近${count}个月`);
  }
  if (/(上个|上月|这个月|本月)/.test(text)) {
    const offset = /上个|上月/.test(text) ? -1 : 0; const d = new Date(Date.UTC(current.year, current.month - 1 + offset, 1));
    return { month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` };
  }
  return null;
}

export function isExtendedBillPeriodQuery(message) {
  return typeof message === 'string' && /(春季|春天|夏季|夏天|秋季|秋天|冬季|冬天|上半年|下半年|季度|Q\s*[1-4]|今年|去年|前年|明年|全年|年度|最近\s*\d+\s*个?月|近\s*\d+\s*个?月|过去\s*\d+\s*个?月|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?\s*(?:到|至|—|-|~|～))/i.test(message);
}

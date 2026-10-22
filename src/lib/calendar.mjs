export function validTimezone(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value || /^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}

export function localDate(instant, timezone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  const part = type => parts.find(p => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function validCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  return year >= 1900 && year <= 2099 && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

/** Both endpoints include the entire local day. Used by memory and SQL queries. */
export function transactionMatchesPeriod(occurredAt, filter = {}) {
  const date = localDate(occurredAt, filter.timezone ?? 'Asia/Shanghai');
  return (!filter.month || date.startsWith(`${filter.month}-`)) &&
    (!filter.startDate || date >= filter.startDate) && (!filter.endDate || date <= filter.endDate);
}

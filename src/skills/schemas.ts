/** Intent Contracts v1.1 wire types. Public fields stay snake_case. */
export type CalendarMonthPeriod = {
  /** Calendar month after the resolver has interpreted phrases such as “这个月”. */
  month: string;
  timezone: string;
};

export type DateRangePeriod = {
  /** Inclusive local calendar dates after the resolver has interpreted the user's range. */
  start_date: string;
  end_date: string;
  timezone: string;
};

export type QueryPeriod = CalendarMonthPeriod | DateRangePeriod;

export type BillAnalyzeAction = {
  action: "bill.analyze";
  period: QueryPeriod;
  account_ref?: string;
};

export type SubscriptionListAction = {
  action: "subscription.list";
  period?: QueryPeriod;
};

/** Only the two read actions implemented by C are registered here. */
export type BillSkillAction = BillAnalyzeAction | SubscriptionListAction;

export function isCalendarMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function validateQueryPeriod(period: QueryPeriod): void {
  if (!period || typeof period !== "object") throw new TypeError("period 必须是月份或日期区间");
  if (typeof period.timezone !== "string" || !period.timezone.trim()) {
    throw new TypeError("period.timezone 不能为空");
  }
  try { new Intl.DateTimeFormat("zh-CN", { timeZone: period.timezone }); }
  catch { throw new TypeError("period.timezone 必须是有效的 IANA 时区"); }

  if ("month" in period) {
    if (!isCalendarMonth(period.month)) throw new TypeError("period.month 必须是 YYYY-MM");
    if ("start_date" in period || "end_date" in period) throw new TypeError("period 不能同时包含 month 和日期区间");
    return;
  }
  if (!("start_date" in period) || !("end_date" in period) ||
      !isCalendarDate(period.start_date) || !isCalendarDate(period.end_date)) {
    throw new TypeError("period.start_date 和 period.end_date 必须是有效的 YYYY-MM-DD");
  }
  const start = Date.parse(`${period.start_date}T00:00:00Z`);
  const end = Date.parse(`${period.end_date}T00:00:00Z`);
  if (start > end) throw new TypeError("period.start_date 不能晚于 period.end_date");
  if ((end - start) / 86_400_000 >= 366) throw new TypeError("自定义账单区间最多为 366 天");
}

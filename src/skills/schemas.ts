/** Intent Contracts v1.1 wire types. Public fields stay snake_case. */
export type QueryPeriod = {
  /** Calendar month after the resolver has interpreted phrases such as “这个月”. */
  month: string;
  timezone: string;
};

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

export function validateQueryPeriod(period: QueryPeriod): void {
  if (!period || !isCalendarMonth(period.month)) {
    throw new TypeError("period.month 必须是 YYYY-MM");
  }
  if (typeof period.timezone !== "string" || !period.timezone.trim()) {
    throw new TypeError("period.timezone 不能为空");
  }
}

import { localDate as calendarLocalDate } from "../../lib/calendar.mjs";
import type { FinancialContextRepository } from "../../banking-core/contracts";
import { summarizeBills } from "../../skills/bill/bill-skill";
import type { DispatchResult } from "../dispatch-result";
import type { BillSummaryIntent } from "../dispatcher";

export async function handleBillSummary(
  intent: BillSummaryIntent,
  repository: FinancialContextRepository,
): Promise<DispatchResult> {
  const month = intent.slots.month;
  const period = intent.slots.period;
  if (!month && !period) throw new Error("bill.summary requires a resolved time period before dispatch");

  const localDate = (occurredAt: string): string => calendarLocalDate(occurredAt, period?.timezone ?? "Asia/Shanghai");
  const transactions = month
    ? await repository.getTransactions({ month })
    : await repository.getTransactions({ startDate: period!.start_date, endDate: period!.end_date, timezone: period!.timezone });
  const summary = summarizeBills(transactions);
  const context = await repository.getContextInfo();
  const asOfDate = localDate(context.asOf);
  const startMonth = month ?? period!.start_date.slice(0, 7);
  const endMonth = month ?? period!.end_date.slice(0, 7);
  const months: string[] = [];
  let cursor = new Date(`${startMonth}-01T00:00:00Z`);
  while (months.length < 13) {
    const value = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`;
    months.push(value);
    if (value === endMonth) break;
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  const monthlyBreakdown = months.map(value => {
    const items = transactions.filter(transaction => localDate(transaction.occurredAt).startsWith(value));
    const [year, oneBasedMonth] = value.split("-").map(Number);
    const monthStart = `${value}-01`;
    const monthEnd = new Date(Date.UTC(year, oneBasedMonth, 0)).toISOString().slice(0, 10);
    const isPartialSelection = !!period && (period.start_date > monthStart || period.end_date < monthEnd);
    const status = !(context.availableMonths ?? []).includes(value) ? "unavailable" : monthStart > asOfDate ? "future" : monthEnd >= asOfDate || isPartialSelection ? "partial" : "complete";
    return { month: value, status, ...summarizeBills(items) };
  });

  return {
    ok: true,
    kind: "bill_result",
    action: "bill.summary",
    data: {
      ...summary,
      coverage: { status: "unverified", asOf: context.asOf, availableMonths: context.availableMonths ?? [], warning: "仅统计当前可用记录，数据覆盖未保证完整；无记录不代表没有支出。" },
      ...(month ? { month } : { period: { startDate: period!.start_date, endDate: period!.end_date, timezone: period!.timezone, label: period!.label } }),
      ...(!month ? { monthlyBreakdown } : {}),
    },
    evidence: [{
      source: context.dataSource,
      asOf: context.asOf,
      entityIds: transactions.map((transaction) => transaction.id),
    }],
  };
}

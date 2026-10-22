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

  const localDate = (occurredAt: string): string => {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(occurredAt));
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? "";
    return `${value("year")}-${value("month")}-${value("day")}`;
  };
  const transactions = month
    ? await repository.getTransactions({ month })
    : (await repository.getTransactions()).filter(transaction => {
        const value = localDate(transaction.occurredAt);
        return value >= period!.start_date && value <= period!.end_date;
      });
  const summary = summarizeBills(transactions);
  const context = await repository.getContextInfo();
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
    return { month: value, ...summarizeBills(items) };
  });

  return {
    ok: true,
    kind: "bill_result",
    action: "bill.summary",
    data: {
      ...summary,
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

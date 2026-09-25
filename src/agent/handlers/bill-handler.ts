import type { FinancialContextRepository } from "../../banking-core/contracts";
import { summarizeBills } from "../../skills/bill/bill-skill";
import type { DispatchResult } from "../dispatch-result";
import type { BillSummaryIntent } from "../dispatcher";

export async function handleBillSummary(
  intent: BillSummaryIntent,
  repository: FinancialContextRepository,
): Promise<DispatchResult> {
  const month = intent.slots.month;
  if (!month) throw new Error("bill.summary requires month before dispatch");

  const transactions = repository.getTransactions({ month });
  const summary = summarizeBills(transactions);
  const context = repository.getContextInfo();

  return {
    ok: true,
    kind: "bill_result",
    action: "bill.summary",
    data: summary,
    evidence: [{
      source: context.dataSource,
      asOf: context.asOf,
      entityIds: transactions.map((transaction) => transaction.id),
    }],
  };
}

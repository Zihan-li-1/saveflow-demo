import type { FinancialContextRepository } from "../../banking-core/contracts";
import { analyzeBills, listSubscriptions, summarizeBills } from "../../skills/bill/bill-skill";
import type { DispatchResult } from "../dispatch-result";
import type { BillSummaryIntent, SubscriptionListIntent } from "../dispatcher";

export async function handleBillSummary(
  intent: BillSummaryIntent,
  repository: FinancialContextRepository,
): Promise<DispatchResult> {
  const month = intent.slots.month;
  if (!month) throw new Error(`${intent.action} requires month before dispatch`);

  if (intent.action === "bill.analyze") {
    const [analysis, transactions] = await Promise.all([
      analyzeBills(repository, {
        action: "bill.analyze",
        period: { month, timezone: "Asia/Shanghai" },
      }),
      repository.getTransactions({ month }),
    ]);
    const summary = summarizeBills(transactions);
    return {
      ok: true,
      kind: "bill_result",
      action: "bill.analyze",
      data: {
        ...summary,
        month,
        comparisonMonth: "month" in analysis.comparison_period ? analysis.comparison_period.month : undefined,
        previousExpenseFen: analysis.previous_month_expense_minor,
        changeAmountFen: analysis.change_amount_minor,
        changeRateBps: analysis.change_rate_bps,
        categories: analysis.category_breakdown.map(item => ({
          category: item.category,
          amountFen: item.amount_minor,
          transactionCount: item.transaction_count,
        })),
        topIncreasedCategories: analysis.top_increased_categories.map(item => ({
          category: item.category,
          currentAmountFen: item.current_amount_minor,
          previousAmountFen: item.previous_amount_minor,
          increaseFen: item.increase_minor,
        })),
        unusualTransactions: analysis.unusual_transactions.map(item => ({
          transactionId: item.transaction_id,
          occurredAt: item.occurred_at,
          merchant: item.merchant,
          category: item.category,
          amountFen: item.amount_minor,
          reason: item.reason,
        })),
        methodology: analysis.methodology,
      },
      evidence: analysis.evidence.map(item => ({ source: item.source, asOf: item.as_of, entityIds: item.entity_ids })),
    };
  }

  const transactions = await repository.getTransactions({ month });
  const summary = summarizeBills(transactions);
  const context = await repository.getContextInfo();

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

export async function handleSubscriptionList(
  intent: SubscriptionListIntent,
  repository: FinancialContextRepository,
): Promise<DispatchResult> {
  const result = await listSubscriptions(repository, { action: intent.action });
  return {
    ok: true,
    kind: "subscription_result",
    action: "subscription.list",
    data: {
      subscriptions: result.subscriptions.map(item => ({
        id: item.subscription_id,
        name: item.name,
        monthlyFeeFen: item.monthly_fee_minor,
        status: item.status,
        lastUsedDate: item.last_used_date,
        isPotentiallyUnused: item.potentially_unused,
        mandateId: item.mandate_id,
      })),
      activeCount: result.active_count,
      activeMonthlyTotalFen: result.active_monthly_total_minor,
      potentiallyUnused: result.potentially_unused.map(item => ({
        id: item.subscription_id,
        name: item.name,
        monthlyFeeFen: item.monthly_fee_minor,
        status: item.status,
        lastUsedDate: item.last_used_date,
        isPotentiallyUnused: item.potentially_unused,
        mandateId: item.mandate_id,
      })),
      capabilities: {
        historicalSubscriptionState: result.capabilities.historical_subscription_state,
        cancelMerchantMembership: result.capabilities.cancel_merchant_membership,
        cancelBankDebit: result.capabilities.cancel_bank_debit,
      },
    },
    evidence: result.evidence.map(item => ({ source: item.source, asOf: item.as_of, entityIds: item.entity_ids })),
  };
}

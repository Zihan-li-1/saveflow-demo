
import type {
  FinancialContextRepository,
  Transaction,
  Subscription,
} from "../../banking-core/contracts";
import type {
  BillAnalyzeAction,
  SubscriptionListAction,
} from "../schemas";

// 账单汇总结果
export type BillSummary = {
  totalIncomeFen: number;
  totalExpenseFen: number;
  transactionCount: number;
  categoryTotals: Record<string, number>;
};

export type BillEvidence = {
  source: "financial_context.transactions" | "financial_context.subscriptions";
  as_of: string;
  entity_ids: string[];
};

export type CategoryAmount = {
  category: string;
  amount_minor: number;
  transaction_count: number;
};

export type CategoryIncrease = {
  category: string;
  current_amount_minor: number;
  previous_amount_minor: number;
  increase_minor: number;
};

export type UnusualTransaction = {
  transaction_id: string;
  occurred_at: string;
  merchant: string;
  category: string;
  amount_minor: number;
  currency: "CNY";
  reason: "largest_expense" | "at_least_twice_period_average";
};

export type BillAnalysis = {
  action: "bill.analyze";
  period: BillAnalyzeAction["period"];
  comparison_period: { month: string; timezone: string };
  account_id: string | null;
  currency: "CNY";
  current_month_expense_minor: number;
  previous_month_expense_minor: number;
  change_amount_minor: number;
  change_rate_bps: number | null;
  category_breakdown: CategoryAmount[];
  top_increased_categories: CategoryIncrease[];
  unusual_transactions: UnusualTransaction[];
  methodology: {
    expense_types: ["expense"];
    excluded_types: ["income", "transfer_out"];
    unusual_transaction_rule: string;
  };
  evidence: BillEvidence[];
};

export type SubscriptionItem = {
  subscription_id: string;
  name: string;
  monthly_fee_minor: number;
  currency: "CNY";
  status: "active" | "cancelled";
  last_used_date: string;
  potentially_unused: boolean;
  mandate_id: string | null;
};

export type SubscriptionList = {
  action: "subscription.list";
  period: SubscriptionListAction["period"] | null;
  currency: "CNY";
  subscriptions: SubscriptionItem[];
  active_count: number;
  active_monthly_total_minor: number;
  potentially_unused: SubscriptionItem[];
  capabilities: {
    historical_subscription_state: false;
    cancel_merchant_membership: false;
    cancel_bank_debit: false;
  };
  evidence: BillEvidence[];
};

function assertSafeNonNegativeFen(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} 必须是非负整数分`);
  }
}

function validatePeriod(period: BillAnalyzeAction["period"]): void {
  if (!period || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period.month)) {
    throw new TypeError("period.month 必须是 YYYY-MM");
  }
  if (typeof period.timezone !== "string" || !period.timezone.trim()) {
    throw new TypeError("period.timezone 不能为空");
  }
}

function previousCalendarMonth(month: string): string {
  const [year, oneBasedMonth] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, oneBasedMonth - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function expenseTransactions(transactions: Transaction[]): Transaction[] {
  return transactions.filter((transaction) => transaction.type === "expense");
}

function totalExpense(transactions: Transaction[]): number {
  return expenseTransactions(transactions).reduce((total, transaction) => {
    assertSafeNonNegativeFen(transaction.amountFen, "transaction.amountFen");
    return total + transaction.amountFen;
  }, 0);
}

function categoryMap(transactions: Transaction[]): Map<string, CategoryAmount> {
  const categories = new Map<string, CategoryAmount>();
  for (const transaction of expenseTransactions(transactions)) {
    assertSafeNonNegativeFen(transaction.amountFen, "transaction.amountFen");
    const existing = categories.get(transaction.category);
    categories.set(transaction.category, {
      category: transaction.category,
      amount_minor: (existing?.amount_minor ?? 0) + transaction.amountFen,
      transaction_count: (existing?.transaction_count ?? 0) + 1,
    });
  }
  return categories;
}

// 统计收入、支出和消费类别
export function summarizeBills(
  transactions: Transaction[]
): BillSummary {
  let totalIncomeFen = 0;
  let totalExpenseFen = 0;

  const categoryTotals: Record<string, number> = {};

  for (const transaction of transactions) {
    assertSafeNonNegativeFen(transaction.amountFen, "transaction.amountFen");
    if (transaction.type === "income") {
      totalIncomeFen += transaction.amountFen;
    }

    if (transaction.type === "expense") {
      totalExpenseFen += transaction.amountFen;

      categoryTotals[transaction.category] =
        (categoryTotals[transaction.category] ?? 0) +
        transaction.amountFen;
    }
  }

  return {
    totalIncomeFen,
    totalExpenseFen,
    transactionCount: transactions.length,
    categoryTotals,
  };
}

/** Executes the read-only bill.analyze action against Financial Context. */
export function analyzeBills(
  repository: FinancialContextRepository,
  input: BillAnalyzeAction
): BillAnalysis {
  validatePeriod(input.period);
  const context = repository.getContextInfo();
  const accountId = input.account_ref?.trim() || undefined;
  if (accountId && !repository.getAccount(accountId)) {
    throw new TypeError("account_ref 未匹配到可访问账户");
  }

  const previousMonth = previousCalendarMonth(input.period.month);
  const current = repository.getTransactions({ accountId, month: input.period.month });
  const previous = repository.getTransactions({ accountId, month: previousMonth });
  const currentTotal = totalExpense(current);
  const previousTotal = totalExpense(previous);
  const currentCategories = categoryMap(current);
  const previousCategories = categoryMap(previous);
  const categoryBreakdown = [...currentCategories.values()].sort(
    (a, b) => b.amount_minor - a.amount_minor || a.category.localeCompare(b.category)
  );
  const topIncreases = [...new Set([...currentCategories.keys(), ...previousCategories.keys()])]
    .map((category) => {
      const currentAmount = currentCategories.get(category)?.amount_minor ?? 0;
      const previousAmount = previousCategories.get(category)?.amount_minor ?? 0;
      return {
        category,
        current_amount_minor: currentAmount,
        previous_amount_minor: previousAmount,
        increase_minor: currentAmount - previousAmount,
      };
    })
    .filter((item) => item.increase_minor > 0)
    .sort((a, b) => b.increase_minor - a.increase_minor || a.category.localeCompare(b.category))
    .slice(0, 3);

  const expenses = expenseTransactions(current).sort(
    (a, b) => b.amountFen - a.amountFen || a.id.localeCompare(b.id)
  );
  const average = expenses.length === 0 ? 0 : Math.floor(currentTotal / expenses.length);
  const unusual = expenses
    .filter((transaction, index) => index === 0 || transaction.amountFen >= average * 2)
    .slice(0, 3)
    .map((transaction, index): UnusualTransaction => ({
      transaction_id: transaction.id,
      occurred_at: transaction.occurredAt,
      merchant: transaction.merchant,
      category: transaction.category,
      amount_minor: transaction.amountFen,
      currency: transaction.currency,
      reason: index === 0 ? "largest_expense" : "at_least_twice_period_average",
    }));

  return {
    action: "bill.analyze",
    period: { ...input.period },
    comparison_period: { month: previousMonth, timezone: input.period.timezone },
    account_id: accountId ?? null,
    currency: "CNY",
    current_month_expense_minor: currentTotal,
    previous_month_expense_minor: previousTotal,
    change_amount_minor: currentTotal - previousTotal,
    change_rate_bps:
      previousTotal === 0 ? null : Math.round(((currentTotal - previousTotal) * 10_000) / previousTotal),
    category_breakdown: categoryBreakdown,
    top_increased_categories: topIncreases,
    unusual_transactions: unusual,
    methodology: {
      expense_types: ["expense"],
      excluded_types: ["income", "transfer_out"],
      unusual_transaction_rule: "period largest expense plus up to two expenses at least twice the period average",
    },
    evidence: [{
      source: "financial_context.transactions",
      as_of: context.asOf,
      entity_ids: [...current, ...previous].map((transaction) => transaction.id),
    }],
  };
}

// 找出可能闲置的有效订阅
export function findPotentiallyUnusedSubscriptions(
  subscriptions: Subscription[]
): Subscription[] {
  return subscriptions.filter(
    (subscription) =>
      subscription.status === "active" &&
      subscription.isPotentiallyUnused
  );
}

// 统计每月有效订阅费用
export function calculateMonthlySubscriptionCost(
  subscriptions: Subscription[]
): number {
  return subscriptions
    .filter(
      (subscription) =>
        subscription.status === "active"
    )
    .reduce(
      (total, subscription) => {
        assertSafeNonNegativeFen(subscription.monthlyFeeFen, "subscription.monthlyFeeFen");
        return total + subscription.monthlyFeeFen;
      },
      0
    );
}

/** Executes subscription.list. No cancellation effect is implied or exposed. */
export function listSubscriptions(
  repository: FinancialContextRepository,
  input: SubscriptionListAction = { action: "subscription.list" }
): SubscriptionList {
  if (input.period) validatePeriod(input.period);
  const context = repository.getContextInfo();
  const subscriptions = repository.getSubscriptions().map((subscription): SubscriptionItem => {
    assertSafeNonNegativeFen(subscription.monthlyFeeFen, "subscription.monthlyFeeFen");
    return {
      subscription_id: subscription.id,
      name: subscription.name,
      monthly_fee_minor: subscription.monthlyFeeFen,
      currency: "CNY",
      status: subscription.status,
      last_used_date: subscription.lastUsedDate,
      potentially_unused: subscription.status === "active" && subscription.isPotentiallyUnused,
      mandate_id: subscription.mandateId,
    };
  });
  const active = subscriptions.filter((subscription) => subscription.status === "active");
  return {
    action: "subscription.list",
    period: input.period ? { ...input.period } : null,
    currency: "CNY",
    subscriptions,
    active_count: active.length,
    active_monthly_total_minor: active.reduce(
      (total, subscription) => total + subscription.monthly_fee_minor,
      0
    ),
    potentially_unused: active.filter((subscription) => subscription.potentially_unused),
    capabilities: {
      historical_subscription_state: false,
      cancel_merchant_membership: false,
      cancel_bank_debit: false,
    },
    evidence: [{
      source: "financial_context.subscriptions",
      as_of: context.asOf,
      entity_ids: subscriptions.map((subscription) => subscription.subscription_id),
    }],
  };
}

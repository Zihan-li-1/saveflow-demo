
import type {
  FinancialContextRepository,
  Transaction,
  Subscription,
} from "../../banking-core/contracts";
import type {
  BillAnalyzeAction,
  SubscriptionListAction,
} from "../schemas";
export { summarizeBills } from './bill-summary.mjs';

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
  comparison_period: BillAnalyzeAction["period"];
  account_id: string | null;
  currency: "CNY";
  current_month_expense_minor: number;
  previous_month_expense_minor: number;
  /** Preferred names for both calendar-month and custom-range queries. */
  period_expense_minor: number;
  comparison_period_expense_minor: number;
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
  if (!period || typeof period !== "object") throw new TypeError("period 必须是月份或日期区间");
  if (typeof period.timezone !== "string" || !period.timezone.trim()) {
    throw new TypeError("period.timezone 不能为空");
  }
  try { new Intl.DateTimeFormat("zh-CN", { timeZone: period.timezone }); }
  catch { throw new TypeError("period.timezone 必须是有效的 IANA 时区"); }
  if ("month" in period) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period.month)) throw new TypeError("period.month 必须是 YYYY-MM");
    if ("start_date" in period || "end_date" in period) throw new TypeError("period 不能同时包含 month 和日期区间");
    return;
  }
  if (!("start_date" in period) || !("end_date" in period) ||
      !isCalendarDate(period.start_date) || !isCalendarDate(period.end_date)) {
    throw new TypeError("period.start_date 和 period.end_date 必须是有效的 YYYY-MM-DD");
  }
  const days = daysBetween(period.start_date, period.end_date);
  if (days < 0) throw new TypeError("period.start_date 不能晚于 period.end_date");
  if (days >= 366) throw new TypeError("自定义账单区间最多为 366 天");
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function dateValue(value: string): number {
  return Date.parse(`${value}T00:00:00Z`);
}

function daysBetween(start: string, end: string): number {
  return (dateValue(end) - dateValue(start)) / 86_400_000;
}

function addDays(value: string, days: number): string {
  return new Date(dateValue(value) + days * 86_400_000).toISOString().slice(0, 10);
}

function previousCalendarMonth(month: string): string {
  const [year, oneBasedMonth] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, oneBasedMonth - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthBounds(month: string): { start: string; end: string } {
  const [year, oneBasedMonth] = month.split("-").map(Number);
  const start = `${year}-${String(oneBasedMonth).padStart(2, "0")}-01`;
  const end = new Date(Date.UTC(year, oneBasedMonth, 0)).toISOString().slice(0, 10);
  return { start, end };
}

function resolvePeriods(period: BillAnalyzeAction["period"]): {
  current: { start: string; end: string };
  comparison: { start: string; end: string };
  comparisonPeriod: BillAnalyzeAction["period"];
} {
  if ("month" in period) {
    const previousMonth = previousCalendarMonth(period.month);
    return {
      current: monthBounds(period.month),
      comparison: monthBounds(previousMonth),
      comparisonPeriod: { month: previousMonth, timezone: period.timezone },
    };
  }
  const lengthDays = daysBetween(period.start_date, period.end_date) + 1;
  const comparisonEnd = addDays(period.start_date, -1);
  const comparisonStart = addDays(comparisonEnd, -(lengthDays - 1));
  return {
    current: { start: period.start_date, end: period.end_date },
    comparison: { start: comparisonStart, end: comparisonEnd },
    comparisonPeriod: { start_date: comparisonStart, end_date: comparisonEnd, timezone: period.timezone },
  };
}

async function transactionsInRange(
  repository: FinancialContextRepository,
  accountId: string | undefined,
  range: { start: string; end: string }
): Promise<Transaction[]> {
  return (await repository.getTransactions({ accountId })).filter((transaction) => {
    const localDate = transaction.occurredAt.slice(0, 10);
    return localDate >= range.start && localDate <= range.end;
  });
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

/** Executes the read-only bill.analyze action against Financial Context. */
export async function analyzeBills(
  repository: FinancialContextRepository,
  input: BillAnalyzeAction
): Promise<BillAnalysis> {
  validatePeriod(input.period);
  const context = await repository.getContextInfo();
  const accountId = input.account_ref?.trim() || undefined;
  if (accountId && !await repository.getAccount(accountId)) {
    throw new TypeError("account_ref 未匹配到可访问账户");
  }

  const ranges = resolvePeriods(input.period);
  const [current, previous] = await Promise.all([
    transactionsInRange(repository, accountId, ranges.current),
    transactionsInRange(repository, accountId, ranges.comparison),
  ]);
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
    comparison_period: ranges.comparisonPeriod,
    account_id: accountId ?? null,
    currency: "CNY",
    current_month_expense_minor: currentTotal,
    previous_month_expense_minor: previousTotal,
    period_expense_minor: currentTotal,
    comparison_period_expense_minor: previousTotal,
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
export async function listSubscriptions(
  repository: FinancialContextRepository,
  input: SubscriptionListAction = { action: "subscription.list" }
): Promise<SubscriptionList> {
  if (input.period) validatePeriod(input.period);
  const [context, repositorySubscriptions] = await Promise.all([
    repository.getContextInfo(),
    repository.getSubscriptions(),
  ]);
  const subscriptions = repositorySubscriptions.map((subscription): SubscriptionItem => {
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

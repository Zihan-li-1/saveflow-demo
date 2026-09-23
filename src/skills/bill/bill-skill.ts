
import type {
  Transaction,
  Subscription,
} from "../../banking-core/contracts";

// 账单汇总结果
export type BillSummary = {
  totalIncomeFen: number;
  totalExpenseFen: number;
  transactionCount: number;
  categoryTotals: Record<string, number>;
};

// 统计收入、支出和消费类别
export function summarizeBills(
  transactions: Transaction[]
): BillSummary {
  let totalIncomeFen = 0;
  let totalExpenseFen = 0;

  const categoryTotals: Record<string, number> = {};

  for (const transaction of transactions) {
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
      (total, subscription) =>
        total + subscription.monthlyFeeFen,
      0
    );
}
  
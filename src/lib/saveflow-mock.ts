import rawData from "../data/saveflow_mock_data.json";

const currentMonth = rawData.analysisFixtures.currentMonth;
const previousMonth = rawData.analysisFixtures.previousMonth;
const currentSummary = rawData.monthlySummaries.find((item) => item.month === currentMonth);
const previousSummary = rawData.monthlySummaries.find((item) => item.month === previousMonth);
const goal = rawData.savingGoals[0];

if (!currentSummary || !previousSummary || !goal) {
  throw new Error("saveflow_mock_data.json is missing a required financial context fixture");
}

export const saveflowMock = {
  currentMonth,
  previousMonth,
  analysis: {
    totalExpense: currentSummary.expense,
    momIncrease: currentSummary.expense - previousSummary.expense,
    categories: [
      { name: "娱乐", changeAmount: rawData.analysisFixtures.entertainmentIncrease },
      { name: "购物", changeAmount: rawData.analysisFixtures.shoppingIncrease },
    ],
    subscriptionCount: rawData.subscriptions.length,
    subscriptions: rawData.subscriptions.map((item) => ({
      name: item.name,
      monthlyFee: item.monthlyFee,
      lastUsedDate: item.lastUsedDate,
      isPotentiallyUnused: item.isPotentiallyUnused,
    })),
  },
  goal: {
    targetAmount: goal.targetAmount,
    monthlySaving: goal.proposedMonthlySaving,
    estimatedCompletion: goal.targetDate.slice(0, 7).replace("-", "年") + "月",
    categoryBudgets: rawData.budgets
      .filter((item) => item.month === currentMonth)
      .map((item) => ({ name: item.category, amount: item.limit })),
  },
} as const;

export type SaveflowMock = typeof saveflowMock;

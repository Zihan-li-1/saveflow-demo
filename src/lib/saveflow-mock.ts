import rawData from "../data/saveflow_mock_data.json";

const currentMonth = rawData.analysisFixtures.currentMonth;
const previousMonth = rawData.analysisFixtures.previousMonth;
const currentSummary = rawData.monthlySummaries.find((item) => item.month === currentMonth);
const previousSummary = rawData.monthlySummaries.find((item) => item.month === previousMonth);
const goal = rawData.savingGoals[0];
const mainCard = rawData.cards.find((item) => item.id === "CARD-MAIN");
const entertainmentCard = rawData.cards.find((item) => item.id === "CARD-ENT");
const normalScenario = rawData.simulationScenarios.find((item) => item.id === "SCN-NORMAL");
const overLimitScenario = rawData.simulationScenarios.find((item) => item.id === "SCN-OVER-LIMIT");
const insufficientScenario = rawData.simulationScenarios.find((item) => item.id === "SCN-INSUFFICIENT");

if (!currentSummary || !previousSummary || !goal || !mainCard || !entertainmentCard || !normalScenario || !overLimitScenario || !insufficientScenario) {
  throw new Error("saveflow_mock_data.json is missing a required demo fixture");
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
  },
  goal: {
    targetAmount: goal.targetAmount,
    monthlySaving: goal.proposedMonthlySaving,
    estimatedCompletion: goal.targetDate.slice(0, 7).replace("-", "年") + "月",
    categoryBudgets: rawData.budgets
      .filter((item) => item.month === currentMonth)
      .map((item) => ({ name: item.category, amount: item.limit })),
  },
  scenarios: {
    normal: {
      cardName: mainCard.name,
      monthlyLimit: mainCard.monthlyLimit,
      usedThisMonth: mainCard.monthlySpent,
      currentConsumption: normalScenario.purchaseAmount,
      savingAmount: normalScenario.savingAmount,
      totalDebit: normalScenario.totalDebitIfApproved,
      resultDescription: "待确认：本次消费将自动储蓄 ¥5",
      status: "normal" as const,
      requiresConfirmation: normalScenario.requiresConfirmation,
    },
    overLimit: {
      cardName: entertainmentCard.name,
      monthlyLimit: entertainmentCard.monthlyLimit,
      usedThisMonth: overLimitScenario.spentBefore ?? entertainmentCard.monthlySpent,
      currentConsumption: overLimitScenario.purchaseAmount,
      savingAmount: overLimitScenario.savingAmount,
      totalDebit: overLimitScenario.totalDebitIfApproved,
      resultDescription: "本次消费将超出月度限额",
      status: "over-limit" as const,
      requiresConfirmation: overLimitScenario.requiresConfirmation,
    },
    insufficient: {
      cardName: mainCard.name,
      monthlyLimit: mainCard.monthlyLimit,
      usedThisMonth: mainCard.monthlySpent,
      currentConsumption: insufficientScenario.purchaseAmount,
      savingAmount: insufficientScenario.savingAmount,
      totalDebit: insufficientScenario.totalDebitIfApproved,
      resultDescription: "余额不足：无法完成本次消费与储蓄扣款",
      status: "insufficient-balance" as const,
      requiresConfirmation: insufficientScenario.requiresConfirmation,
    },
  },
} as const;

export type SaveflowMock = typeof saveflowMock;

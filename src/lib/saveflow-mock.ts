import { bankingCore } from "../banking-core/core.mjs";
import { getLegacyContext } from "../banking-core/legacy-adapter.mjs";
const context = getLegacyContext();
const goal = bankingCore.repository.getSavingGoal();
// Yuan fields are presentation-only compatibility fields, never Core write inputs.
export const saveflowMock = {
  currentMonth: context.currentMonth, previousMonth: context.previousMonth, asOf: context.asOf,
  analysis: {
    totalExpense: context.totalExpenseFen / 100, momIncrease: context.expenseIncreaseFen / 100,
    categories: context.categoryChanges.map(c => ({ name: c.name, changeAmount: c.changeAmountFen / 100 })),
    subscriptionCount: context.subscriptionCount, subscriptions: context.subscriptions,
  },
  goal: {
    targetAmount: goal.targetAmountFen / 100, currentAmount: goal.currentAmountFen / 100,
    monthlySaving: context.defaultMonthlySavingFen / 100,
    proposedMonthlySaving: goal.proposedMonthlySavingFen / 100,
    monthlySavingCap: context.monthlySavingCapFen / 100,
    estimatedCompletion: goal.targetDate.slice(0, 7).replace("-", "年") + "月",
  },
  monthlyIncome: context.monthlyIncomeFen / 100,
} as const;
export type SaveflowMock = typeof saveflowMock;

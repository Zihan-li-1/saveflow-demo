import type { Message } from "./use-saveflow";

export type ManagedCard = {
  id: string;
  name: string;
  status: string;
  monthlyBudgetFen: number;
  monthlySpentFen: number;
  onlinePaymentsEnabled: boolean;
  blockedCategories: readonly string[];
  alertThresholdFen: number | null;
  balanceReminderAmountFen: number | null;
  balanceReminderPercent: number | null;
  version: number;
};

/** Apply only verified card-result messages; previews must never change the displayed cards. */
export function synchronizeManagedCards(initialCards: readonly ManagedCard[], messages: readonly Message[]): ManagedCard[] {
  const cards = new Map<string, ManagedCard>(initialCards.map(card => [card.id, {
    ...card,
    blockedCategories: [...card.blockedCategories],
  }]));
  for (const message of messages) {
    if (message.kind !== "banking_card" || message.banking?.status !== "card_result") continue;
    const card = message.banking.data?.card as ManagedCard | undefined;
    if (card?.id && cards.has(card.id)) cards.set(card.id, { ...card, blockedCategories: [...(card.blockedCategories || [])] });
  }
  return [...cards.values()];
}

export function budgetBalanceAlert(card: Pick<ManagedCard, "monthlyBudgetFen" | "monthlySpentFen" | "balanceReminderAmountFen" | "balanceReminderPercent">): string | null {
  const remaining = Math.max(0, card.monthlyBudgetFen - card.monthlySpentFen);
  if (remaining === 0) return "预算余额已用完，请留意后续消费。";
  const threshold = card.balanceReminderAmountFen ?? (card.balanceReminderPercent == null ? null : Math.floor(card.monthlyBudgetFen * card.balanceReminderPercent / 100));
  if (threshold != null && remaining <= threshold) return `预算余额已到达提醒临界点，当前还剩 ¥${(remaining / 100).toFixed(2)}。`;
  return null;
}

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

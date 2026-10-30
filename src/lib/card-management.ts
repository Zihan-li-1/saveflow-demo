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

export type CardActivity = {
  id: string;
  cardName: string;
  label: string;
  detail: string;
  status: "待确认" | "处理中" | "已完成" | "已取消" | "操作失败" | "结果待核实";
};

const actionLabel: Record<string, string> = {
  "card.set_budget": "调整月预算",
  "card.set_controls": "调整交易权限",
  "card.freeze": "冻结卡片",
  "card.unfreeze": "解冻卡片",
};

type CardChangeEffect = {
  kind?: string;
  cardId?: string;
  cardName?: string;
  cardVersion?: number;
  after?: Partial<ManagedCard>;
};

const mergeVerifiedCard = (current: ManagedCard, update: Partial<ManagedCard>): ManagedCard => ({
  ...current,
  ...update,
  id: current.id,
  blockedCategories: Array.isArray(update.blockedCategories) ? [...update.blockedCategories] : [...current.blockedCategories],
});

/**
 * Follow verified card state from both fresh card.get results and completed write tasks.
 * A preview is applied only when its operation state is `success`; pending, failed and
 * unknown operations never change the displayed card.
 */
export function synchronizeManagedCards(
  initialCards: readonly ManagedCard[],
  messages: readonly Message[],
  operationStates: Readonly<Record<string, string>> = {},
): ManagedCard[] {
  const cards = new Map<string, ManagedCard>(initialCards.map(card => [card.id, {
    ...card,
    blockedCategories: [...card.blockedCategories],
  }]));
  for (const message of messages) {
    if (message.kind === "banking_card" && message.banking?.status === "card_result") {
      const card = message.banking.data?.card as ManagedCard | undefined;
      if (card?.id && cards.has(card.id)) cards.set(card.id, mergeVerifiedCard(cards.get(card.id)!, card));
      continue;
    }

    const data = message.banking;
    if (message.kind !== "banking_card_preview" || !data?.operationId || operationStates[data.operationId] !== "success") continue;
    const preview = data.preview as { exactEffects?: CardChangeEffect[] } | undefined;
    const effect = preview?.exactEffects?.find(item => item.kind === "card_change");
    if (!effect?.after) continue;
    const card = effect.cardId ? cards.get(effect.cardId) : [...cards.values()].find(item => item.name === effect.cardName);
    if (!card) continue;
    cards.set(card.id, mergeVerifiedCard(card, {
      ...effect.after,
      ...(Number.isSafeInteger(effect.cardVersion) ? { version: Math.max(card.version, Number(effect.cardVersion) + 1) } : {}),
    }));
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

/** Present card write requests from the conversation without treating previews as completed changes. */
export function cardActivities(messages: readonly Message[], operationStates: Readonly<Record<string, string>>): CardActivity[] {
  return messages.flatMap(message => {
    const data = message.banking;
    if (message.kind !== "banking_card_preview" || !data?.operationId || !data.action || !actionLabel[data.action]) return [];
    const preview = data.preview as { exactEffects?: Array<{ kind?: string; cardName?: string; after?: { monthlyBudgetFen?: number; onlinePaymentsEnabled?: boolean; blockedCategories?: string[] } }> } | undefined;
    const effect = preview?.exactEffects?.find(item => item.kind === "card_change");
    const state = operationStates[data.operationId];
    const status: CardActivity["status"] = state === "success" ? "已完成" : state === "cancelled" ? "已取消" : state === "error" ? "操作失败" : state === "executing" || state === "checking" ? "处理中" : state === "unknown" ? "结果待核实" : "待确认";
    const detail = data.action === "card.set_budget" && Number.isSafeInteger(effect?.after?.monthlyBudgetFen)
      ? `新预算 ¥${(Number(effect?.after?.monthlyBudgetFen) / 100).toFixed(2)}`
      : data.action === "card.set_controls"
        ? `线上支付${effect?.after?.onlinePaymentsEnabled ? "开启" : "关闭"}${effect?.after?.blockedCategories?.length ? ` · 禁用 ${effect.after.blockedCategories.join("、")}` : ""}`
        : status === "已完成" ? "操作结果已经重新查询核实" : "确认后才会改变卡片状态";
    return [{ id: data.operationId, cardName: effect?.cardName || "虚拟卡", label: actionLabel[data.action], detail, status }];
  }).reverse();
}

import type { Message } from "./use-saveflow";

export type OverviewSubscription = {
  id: string;
  name: string;
  monthlyFeeFen: number;
  status: "active" | "cancelled";
  isPotentiallyUnused: boolean;
};

/** The latest verified subscription result replaces the initial snapshot shown in the sidebar. */
export function currentSubscriptions(initial: readonly OverviewSubscription[], messages: readonly Message[]): OverviewSubscription[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.kind !== "banking_read" || message.banking?.status !== "subscription_result") continue;
    const value = message.banking.data?.subscriptions;
    if (!Array.isArray(value)) continue;
    return value.filter((item): item is OverviewSubscription => !!item && typeof item.id === "string" && typeof item.name === "string" && Number.isSafeInteger(item.monthlyFeeFen) && item.monthlyFeeFen >= 0 && ["active", "cancelled"].includes(item.status) && typeof item.isPotentiallyUnused === "boolean");
  }
  return initial.map(item => ({ ...item }));
}

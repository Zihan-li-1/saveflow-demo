import type { FinancialContextRepository, Subscription } from "../../banking-core/contracts";
import type { DispatchResult } from "../dispatch-result";
import type { SubscriptionListIntent } from "../dispatcher";

function calendarDays(from: string, to: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return undefined;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return Math.floor((end - start) / 86_400_000);
}

function explain(subscription: Subscription, inactivityDays: number | undefined): string {
  if (subscription.status === "cancelled") return "订阅已取消，不计入当前每月订阅支出。";
  if (subscription.isPotentiallyUnused) {
    const duration = inactivityDays === undefined ? "较长时间" : `连续 ${inactivityDays} 天`;
    return `数据标记为可能闲置：已${duration}未使用，但仍每月扣费；取消前请核实实际使用情况。`;
  }
  return inactivityDays === undefined
    ? "当前没有潜在闲置标记。"
    : `最近使用距统计日 ${inactivityDays} 天，当前没有潜在闲置标记。`;
}

export async function handleSubscriptionList(
  _intent: SubscriptionListIntent,
  repository: FinancialContextRepository,
): Promise<DispatchResult> {
  const [subscriptions, context] = await Promise.all([repository.getSubscriptions(), repository.getContextInfo()]);
  const asOfDate = context.asOf.slice(0, 10);
  const enriched = subscriptions.map(subscription => {
    const inactivityDays = calendarDays(subscription.lastUsedDate, asOfDate);
    const confidence = subscription.status !== "active" || !subscription.isPotentiallyUnused ? "not_flagged" : inactivityDays !== undefined && inactivityDays >= 90 ? "high" : "medium";
    const recognitionSignals = [
      subscription.isPotentiallyUnused ? "数据源标记为可能闲置" : "数据源未标记为闲置",
      inactivityDays === undefined ? "最近使用时间无法换算" : `距最近使用 ${inactivityDays} 天`,
      subscription.status === "active" ? "订阅仍在生效并按月计费" : "订阅已取消",
    ];
    return { ...subscription, ...(inactivityDays === undefined ? {} : { inactivityDays }), unusedReason: explain(subscription, inactivityDays), recognition: { confidence, signals: recognitionSignals } };
  });
  const active = subscriptions.filter(item => item.status === "active");
  const potentiallyUnused = active.filter(item => item.isPotentiallyUnused);
  const activeMonthlyFeeFen = active.reduce((sum, item) => sum + item.monthlyFeeFen, 0);
  const potentiallyUnusedMonthlyFeeFen = potentiallyUnused.reduce((sum, item) => sum + item.monthlyFeeFen, 0);
  return {
    ok: true,
    kind: "subscription_result",
    action: "subscription.list",
    data: {
      subscriptions: enriched,
      summary: {
        activeCount: active.length,
        activeMonthlyFeeFen,
        potentiallyUnusedCount: potentiallyUnused.length,
        potentiallyUnusedMonthlyFeeFen,
        potentialAnnualSavingsFen: potentiallyUnusedMonthlyFeeFen * 12,
      },
      methodology: { usesRepositoryFlag: true, usesLastUsedDate: true, highConfidenceInactivityDays: 90, historicalSubscriptionState: false, savingsEstimateMonths: 12, limitation: "闲置判断是规则提示，不等同于已核实的商户使用记录；取消前请由用户确认。" },
    },
    evidence: [{ source: context.dataSource, asOf: context.asOf, entityIds: subscriptions.map(item => item.id) }],
  };
}

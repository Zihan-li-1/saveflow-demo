import type { ActionRequest, Card, ContextInfo, Subscription } from "../banking-core/contracts";
import type { ResolvedTransferIntent } from "../skill/transfer/types";

export type DispatchEvidence = { source: string; asOf: string; entityIds: string[] };
export type BillTotals = { totalIncomeFen: number; totalExpenseFen: number; transactionCount: number; categoryTotals: Record<string, number> };
export type BillSummaryData = BillTotals & {
  month?: string;
  period?: { startDate: string; endDate: string; timezone: string; label?: string };
  monthlyBreakdown?: Array<BillTotals & { month: string; status: "unavailable" | "future" | "partial" | "complete" }>;
  insights?: Record<string, unknown>;
  coverage: { status: "unverified"; asOf: string; availableMonths: string[]; warning: string };
};
export type SubscriptionView = Subscription & { inactivityDays?: number; unusedReason: string; recognition: { confidence: "high" | "medium" | "not_flagged"; signals: string[] } };
export type SubscriptionListData = {
  subscriptions: SubscriptionView[];
  summary: { activeCount: number; activeMonthlyFeeFen: number; potentiallyUnusedCount: number; potentiallyUnusedMonthlyFeeFen: number; potentialAnnualSavingsFen: number };
  methodology: { usesRepositoryFlag: true; usesLastUsedDate: true; highConfidenceInactivityDays: 90; historicalSubscriptionState: false; savingsEstimateMonths: 12; limitation: string };
};
export type CardQueryData = { kind: "query"; card: Card; context: ContextInfo };
export type CardSecurityReviewData = { kind: "security_review"; card: Card; issue_type: string; severity: "high"; guidance: string[]; recommended_action: "card.freeze"; execution_allowed: false; requires_explicit_user_request_to_freeze: true; product_capability_notice: string };
export type CardActionRequestData = { kind: "action_request"; request: Extract<ActionRequest, { action: `card.${string}` }>; warnings?: string[]; requirements: { minimumRiskLevel: "L2" | "L3"; explicitUserConfirmation: true; executionOwner: "banking_core" }; evidence: DispatchEvidence[] };

export type BillDispatchResult = { ok: true; kind: "bill_result"; action: "bill.summary"; data: BillSummaryData; evidence: DispatchEvidence[] };
export type SubscriptionDispatchResult = { ok: true; kind: "subscription_result"; action: "subscription.list"; data: SubscriptionListData; evidence: DispatchEvidence[] };
export type TransferDispatchResult = { ok: true; kind: "transfer_resolution"; action: "transfer.create"; data: Extract<ResolvedTransferIntent, { state: "ready_for_planning" }> };
export type CardDispatchResult =
  | { ok: true; kind: "card_result"; action: "card.get" | "card.security_review"; data: CardQueryData | CardSecurityReviewData; evidence: DispatchEvidence[] }
  | { ok: true; kind: "card_action_request"; action: "card.set_budget" | "card.set_controls" | "card.freeze" | "card.unfreeze"; data: CardActionRequestData };

export type DispatchResult =
  | BillDispatchResult | SubscriptionDispatchResult | TransferDispatchResult | CardDispatchResult
  | { ok: true; kind: "wealth_result" | "wealth_action_request" | "wealth_recommendation" | "wealth_comparison" | "risk_assessment_required" | "scenario_rule_preview" | "scenario_rule" | "scenario_event_review" | "goal_plan" | "purchase_request"; action: string; data: Record<string, unknown>; evidence?: DispatchEvidence[] }
  | { ok: false; kind: "needs_clarification"; action: string; source: "parser" | "resolver"; missingSlots?: string[]; question?: string; slot?: string; reason?: string; candidates?: unknown[] }
  | { ok: false; kind: "unsupported" }
  | { ok: false; kind: "skill_error"; action: string; error: { code: "SKILL_ERROR"; message: string } }
  | { ok: false; kind: "card_error"; action: string; error: { code: string; message: string; uncertain?: boolean } }
  | { ok: false; kind: "wealth_error"; action: string; error: { code: string; message: string; uncertain?: boolean } };

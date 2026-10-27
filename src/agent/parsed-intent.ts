/** The only model-facing intent contract. It contains raw user entities, never resolved IDs. */
export const PARSED_INTENT_SCHEMA_VERSION = "1.0.0" as const;

export const PARSED_INTENT_ACTIONS = [
  "transfer.create",
  "bill.summary",
  "subscription.list",
  "card.get",
  "card.set_budget",
  "card.set_controls",
  "card.security_review",
  "card.freeze",
  "card.unfreeze",
  "wealth.recommend",
  "wealth.compare",
  "wealth.assess_risk",
  "wealth.subscribe",
  "wealth.redeem",
  "scenario.create_rule",
  "scenario.plan_purchase",
  "scenario.update_rule",
  "scenario.disable_rule",
  "scenario.review_event",
  "orchestrator.goal",
  "clarify",
  "unsupported",
] as const;

export type ParsedIntentAction = (typeof PARSED_INTENT_ACTIONS)[number];
export type ParsedIntentStatus =
  | "ready_for_resolution"
  | "needs_clarification"
  | "unsupported";

export type TransferSlotName = "payee_ref" | "amount" | "source_account_ref" | "target_account_ref";
/** The model-facing bill slot is the time filter; account IDs are resolver output. */
export type BillSlotName = "month";
export type CardSlotName = "card_ref" | "amount";
export type WealthSlotName = "goal" | "max_risk_level" | "horizon_days" | "liquidity_requirement" | "amount" | "product_refs" | "assessment_scope";
export type ScenarioSlotName = "trigger" | "conditions" | "proposed_steps" | "authorization_scope" | "rule_ref" | "changes" | "event_ref";

export interface ParsedAmount {
  /** Integer minor units (fen). No boundary may multiply or divide this value by 100. */
  amount_minor: number;
  currency: "CNY";
}

export interface TransferCreateSlots {
  /** Raw user wording, resolved later by Financial Context. */
  payee_ref?: string;
  amount?: ParsedAmount;
  /** Raw user wording, resolved later by Financial Context. */
  source_account_ref?: string;
  /** Raw user wording for the user's own receiving account (本人账户互转). Mutually exclusive with payee_ref. */
  target_account_ref?: string;
}

export interface BillSummarySlots {
  /** Calendar month in YYYY-MM form. */
  month?: string;
  /** Inclusive calendar-date range resolved from explicit or relative user wording. */
  period?: { start_date: string; end_date: string; timezone: "Asia/Shanghai"; label: string };
}

export interface CardReferenceSlots {
  /** Raw user wording; the resolver supplies card_id. */
  card_ref?: string;
}

export interface CardBudgetSlots extends CardReferenceSlots {
  amount?: ParsedAmount;
}
export interface CardControlSlots extends CardReferenceSlots {
  online_payments_enabled?: boolean;
  blocked_categories?: string[];
  alert_amount?: ParsedAmount | null;
  balance_reminder_amount?: ParsedAmount | null;
  balance_reminder_percentage?: number | null;
}
export interface CardSecurityReviewSlots extends CardReferenceSlots { issue_type?: "card_details_exposed" | "unauthorized_transaction" | "device_lost" }

export type WealthAction = "wealth.recommend" | "wealth.compare" | "wealth.assess_risk" | "wealth.subscribe" | "wealth.redeem";
export type WealthSlots = {
  goal?: { kind: "capital_preservation" | "steady_growth" | "short_term_purchase"; target_date?: string; max_risk_level?: "R1" | "R2" | "R3" };
  constraints?: { investable_amount?: ParsedAmount; max_settlement_days?: number };
  product_refs?: string[];
  assessment_scope?: "investment" | "portfolio";
  product_ref?: string;
  amount?: ParsedAmount;
  source_account_ref?: string;
  holding_ref?: string;
  quantity_or_amount?: { kind: "amount"; amount_minor: number; currency: "CNY" } | { kind: "units"; units_milli: number };
};

export type ParsedIntent = ParsedIntentBody & { choice?: { optionId: string } };

type ParsedIntentBody =
  | {
      schemaVersion: typeof PARSED_INTENT_SCHEMA_VERSION;
      action: "scenario.plan_purchase";
      slots: Record<string, unknown>;
      missingSlots: [];
      status: "ready_for_resolution";
    }
  | {
      schemaVersion: typeof PARSED_INTENT_SCHEMA_VERSION;
      action: "transfer.create";
      slots: TransferCreateSlots;
      missingSlots: TransferSlotName[];
      status: "ready_for_resolution" | "needs_clarification";
    }
  | {
      schemaVersion: typeof PARSED_INTENT_SCHEMA_VERSION;
      action: "bill.summary";
      slots: BillSummarySlots;
      missingSlots: BillSlotName[];
      status: "ready_for_resolution" | "needs_clarification";
    }
  | {
      schemaVersion: typeof PARSED_INTENT_SCHEMA_VERSION;
      action: "subscription.list";
      slots: Record<string, never>;
      missingSlots: [];
      status: "ready_for_resolution";
    }
  | {
      schemaVersion: typeof PARSED_INTENT_SCHEMA_VERSION;
      action: "card.get" | "card.freeze" | "card.unfreeze";
      slots: CardReferenceSlots;
      missingSlots: ["card_ref"] | [];
      status: "ready_for_resolution" | "needs_clarification";
    }
  | {
      schemaVersion: typeof PARSED_INTENT_SCHEMA_VERSION;
      action: "card.set_budget";
      slots: CardBudgetSlots;
      missingSlots: CardSlotName[];
      status: "ready_for_resolution" | "needs_clarification";
    }
  | {
      schemaVersion: typeof PARSED_INTENT_SCHEMA_VERSION;
      action: "card.set_controls";
      slots: CardControlSlots;
      missingSlots: string[];
      status: "ready_for_resolution" | "needs_clarification";
    }
  | {
      schemaVersion: typeof PARSED_INTENT_SCHEMA_VERSION;
      action: "card.security_review";
      slots: CardSecurityReviewSlots;
      missingSlots: string[];
      status: "ready_for_resolution" | "needs_clarification";
    }
  | {
      schemaVersion: typeof PARSED_INTENT_SCHEMA_VERSION;
      action: WealthAction;
      slots: Record<string, unknown>;
      missingSlots: string[];
      status: "ready_for_resolution" | "needs_clarification";
    }
  | {
      schemaVersion: typeof PARSED_INTENT_SCHEMA_VERSION;
      action: "scenario.create_rule" | "scenario.update_rule" | "scenario.disable_rule" | "scenario.review_event";
      slots: Record<string, unknown>;
      missingSlots: ScenarioSlotName[];
      status: "ready_for_resolution" | "needs_clarification";
    }
  | {
      schemaVersion: typeof PARSED_INTENT_SCHEMA_VERSION;
      action: "orchestrator.goal";
      slots: { goal_text?: string; horizon?: unknown; constraints?: unknown; amount?: { amount_minor: number; currency: "CNY" }; deadline?: string };
      missingSlots: Array<"goal_text" | "amount" | "deadline">;
      status: "ready_for_resolution" | "needs_clarification";
    }
  | {
      schemaVersion: typeof PARSED_INTENT_SCHEMA_VERSION;
      action: "clarify";
      slots: Record<string, never>;
      missingSlots: ["action"];
      status: "needs_clarification";
    }
  | {
      schemaVersion: typeof PARSED_INTENT_SCHEMA_VERSION;
      action: "unsupported";
      slots: Record<string, never>;
      missingSlots: [];
      status: "unsupported";
    };

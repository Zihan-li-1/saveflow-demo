/** The only model-facing intent contract. It contains raw user entities, never resolved IDs. */
export const PARSED_INTENT_SCHEMA_VERSION = "1.0.0" as const;

export const PARSED_INTENT_ACTIONS = [
  "transfer.create",
  "bill.summary",
  "card.get",
  "card.set_budget",
  "card.freeze",
  "card.unfreeze",
  "wealth.recommend",
  "wealth.compare",
  "wealth.assess_risk",
  "wealth.subscribe",
  "wealth.redeem",
  "clarify",
  "unsupported",
] as const;

export type ParsedIntentAction = (typeof PARSED_INTENT_ACTIONS)[number];
export type ParsedIntentStatus =
  | "ready_for_resolution"
  | "needs_clarification"
  | "unsupported";

export type TransferSlotName = "payee_ref" | "amount" | "source_account_ref";
/** The model-facing bill slot is the time filter; account IDs are resolver output. */
export type BillSlotName = "month";
export type CardSlotName = "card_ref" | "amount";

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
}

export interface BillSummarySlots {
  /** Calendar month in YYYY-MM form. */
  month?: string;
}

export interface CardReferenceSlots {
  /** Raw user wording; the resolver supplies card_id. */
  card_ref?: string;
}

export interface CardBudgetSlots extends CardReferenceSlots {
  amount?: ParsedAmount;
}

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

export type ParsedIntent =
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
      action: WealthAction;
      slots: WealthSlots;
      missingSlots: string[];
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

/** The only model-facing intent contract. It contains raw user entities, never resolved IDs. */
export const PARSED_INTENT_SCHEMA_VERSION = "1.0.0" as const;

export const PARSED_INTENT_ACTIONS = [
  "transfer.create",
  "bill.summary",
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

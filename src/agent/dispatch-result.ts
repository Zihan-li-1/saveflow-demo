export type DispatchEvidence = {
  source: string;
  asOf: string;
  entityIds: string[];
};

export type DispatchResult =
  | {
      ok: true;
      kind: "bill_result";
      action: "bill.summary";
      data: unknown;
      evidence: DispatchEvidence[];
    }
  | {
      ok: true;
      kind: "transfer_resolution";
      action: "transfer.create";
      data: unknown;
    }
  | {
      ok: true;
      kind: "card_result" | "card_action_request";
      action: "card.get" | "card.set_budget" | "card.freeze" | "card.unfreeze";
      data: unknown;
    }
  | {
      ok: false;
      kind: "needs_clarification";
      action: string;
      source: "parser" | "resolver";
      missingSlots?: string[];
      question?: string;
      slot?: string;
      reason?: string;
      candidates?: unknown[];
    }
  | {
      ok: false;
      kind: "unsupported";
    }
  | {
      ok: false;
      kind: "skill_error";
      action: string;
      error: {
        code: "SKILL_ERROR";
        message: string;
      };
    }
  | {
      ok: false;
      kind: "card_error";
      action: string;
      error: { code: string; message: string; uncertain?: boolean };
    };

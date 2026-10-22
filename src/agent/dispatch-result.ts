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
      kind: "subscription_result";
      action: "subscription.list";
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
      action: "card.get" | "card.set_budget" | "card.set_controls" | "card.security_review" | "card.freeze" | "card.unfreeze";
      data: unknown;
    }
  | {
      ok: true;
      kind: "wealth_result" | "wealth_action_request" | "wealth_recommendation" | "wealth_comparison" | "risk_assessment_required" | "scenario_rule_preview" | "scenario_rule" | "scenario_event_review" | "goal_plan";
      action: string;
      data: unknown;
      evidence?: DispatchEvidence[];
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
    }
  | {
      ok: false;
      kind: "wealth_error";
      action: string;
      error: { code: string; message: string; uncertain?: boolean };
    };

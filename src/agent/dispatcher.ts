import type { ParsedIntent } from "./parsed-intent";
import { validateParsedIntent } from "./validate-parsed-intent";
import type { DispatchResult } from "./dispatch-result";

export type BillSummaryIntent = Extract<ParsedIntent, { action: "bill.summary" }>;
export type TransferCreateIntent = Extract<ParsedIntent, { action: "transfer.create" }>;

export type DispatcherDependencies = {
  billHandler: (intent: BillSummaryIntent) => Promise<DispatchResult>;
  transferHandler: (intent: TransferCreateIntent) => Promise<DispatchResult>;
};

function clarificationResult(intent: ParsedIntent): DispatchResult {
  return {
    ok: false,
    kind: "needs_clarification",
    action: intent.action,
    source: "parser",
    ...(intent.missingSlots.length > 0 ? { missingSlots: [...intent.missingSlots] } : {}),
  };
}

function skillError(action: string, error: unknown): DispatchResult {
  const message = error instanceof Error && error.message.trim()
    ? error.message
    : "Skill 处理失败，请稍后重试。";
  return { ok: false, kind: "skill_error", action, error: { code: "SKILL_ERROR", message } };
}

/** Validate once more, gate non-ready states, then route through an explicit action switch. */
export async function dispatchParsedIntent(
  value: unknown,
  dependencies: DispatcherDependencies,
): Promise<DispatchResult> {
  const intent = validateParsedIntent(value);

  if (intent.status === "needs_clarification") return clarificationResult(intent);
  if (intent.status === "unsupported") return { ok: false, kind: "unsupported" };

  try {
    switch (intent.action) {
      case "transfer.create":
        return await dependencies.transferHandler(intent);
      case "bill.summary":
        return await dependencies.billHandler(intent);
    }
  } catch (error) {
    return skillError(intent.action, error);
  }
}

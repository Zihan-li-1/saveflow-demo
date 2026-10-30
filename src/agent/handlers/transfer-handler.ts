import { resolveTransferIntent } from "../../skill/transfer";
import type { TransferDependencies } from "../../skill/transfer/types";
import type { DispatchResult, TransferDispatchResult } from "../dispatch-result";
import type { TransferCreateIntent } from "../dispatcher";

export async function handleTransfer(
  intent: TransferCreateIntent,
  dependencies: TransferDependencies,
): Promise<TransferDispatchResult | Extract<DispatchResult, { ok: false; kind: "needs_clarification" }>> {
  const resolved = await resolveTransferIntent(dependencies, intent.slots);

  if (resolved.state === "needs_clarification") {
    return {
      ok: false,
      kind: "needs_clarification",
      action: "transfer.create",
      source: "resolver",
      question: resolved.clarification.question,
      slot: resolved.clarification.slot,
      reason: resolved.clarification.reason,
      ...(resolved.clarification.candidates
        ? { candidates: resolved.clarification.candidates }
        : {}),
    };
  }

  return {
    ok: true,
    kind: "transfer_resolution",
    action: "transfer.create",
    data: resolved,
  };
}

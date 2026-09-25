import { resolveTransferIntent } from "../../skill/transfer";
import type { TransferDependencies } from "../../skill/transfer/types";
import type { DispatchResult } from "../dispatch-result";
import type { TransferCreateIntent } from "../dispatcher";

export async function handleTransfer(
  intent: TransferCreateIntent,
  dependencies: TransferDependencies,
): Promise<DispatchResult> {
  const resolved = await resolveTransferIntent(dependencies, intent.slots);

  if (resolved.state === "needs_clarification") {
    return {
      ok: false,
      kind: "needs_clarification",
      action: "transfer.create",
      source: "resolver",
      question: resolved.clarification.question,
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

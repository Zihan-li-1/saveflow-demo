import type { FinancialContextRepository } from "../../banking-core/contracts";
import type { CardIntent } from "../dispatcher";
import type { DispatchResult } from "../dispatch-result";
import { handleCard as runtimeHandleCard } from "./card-handler.mjs";

/** Typed entry to the same Handler used by the Node HTTP runtime. */
export async function handleCard(
  intent: CardIntent,
  repository: FinancialContextRepository,
  selections: Record<string, { entityId: string; optionId: string }> = {},
): Promise<DispatchResult> {
  return runtimeHandleCard(intent, repository, selections) as Promise<DispatchResult>;
}

import { transferFromResolvedIntent } from "../banking-core/wire.mjs";
import type {
  ActionRequest,
  ActionResult,
  PreparedAction,
} from "../banking-core/contracts";
import { dispatchParsedIntent, type DispatcherDependencies } from "./dispatcher";
import type { DispatchResult } from "./dispatch-result";

type BankingCorePrepare = {
  prepare: (request: ActionRequest) => Promise<ActionResult<PreparedAction>>;
};

export type TransferPreviewResult =
  | {
      ok: true;
      kind: "transfer_preview";
      action: "transfer.create";
      data: PreparedAction;
    }
  | {
      ok: false;
      kind: "core_error";
      action: "transfer.create";
      error: NonNullable<Extract<ActionResult<PreparedAction>, { ok: false }>["error"]>;
      operationId?: string;
    };

function skillError(error: unknown): DispatchResult {
  const message = error instanceof Error && error.message.trim()
    ? error.message
    : "转账解析结果无效，请重新发起请求。";
  return {
    ok: false,
    kind: "skill_error",
    action: "transfer.create",
    error: { code: "SKILL_ERROR", message },
  };
}

/**
 * Handoff from Dispatcher to Banking Core. The D-generated preview is never
 * used as the user-confirmable preview; Core is the only source of that data.
 */
export async function prepareTransferPreview(
  dispatched: DispatchResult,
  core: BankingCorePrepare,
): Promise<DispatchResult | TransferPreviewResult> {
  if (
    !dispatched.ok ||
    dispatched.kind !== "transfer_resolution" ||
    dispatched.action !== "transfer.create"
  ) {
    return dispatched;
  }

  const resolved = dispatched.data;
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved) ||
      (resolved as { state?: unknown }).state !== "ready_for_planning") {
    return skillError(new Error("转账解析结果尚未达到 ready_for_planning。"));
  }

  let request: ActionRequest;
  try {
    request = transferFromResolvedIntent(resolved as Parameters<typeof transferFromResolvedIntent>[0]);
  } catch (error) {
    return skillError(error);
  }

  const prepared = await core.prepare(request);
  if (!prepared.ok) {
    return {
      ok: false,
      kind: "core_error",
      action: "transfer.create",
      error: prepared.error,
      ...(prepared.operationId ? { operationId: prepared.operationId } : {}),
    };
  }

  return {
    ok: true,
    kind: "transfer_preview",
    action: "transfer.create",
    data: prepared.data,
  };
}

/** Dispatches first, then performs the Core-only formal preview handoff. */
export async function orchestrateTransferPreview(
  intent: unknown,
  dependencies: DispatcherDependencies,
  core: BankingCorePrepare,
): Promise<DispatchResult | TransferPreviewResult> {
  const dispatched = await dispatchParsedIntent(intent, dependencies);
  return prepareTransferPreview(dispatched, core);
}

export type TransferOrchestrator = {
  prepare: (dispatched: DispatchResult) => Promise<DispatchResult | TransferPreviewResult>;
  dispatchAndPrepare: (
    intent: unknown,
    dependencies: DispatcherDependencies,
  ) => Promise<DispatchResult | TransferPreviewResult>;
};

export function createTransferOrchestrator(core: BankingCorePrepare): TransferOrchestrator {
  return {
    prepare: dispatched => prepareTransferPreview(dispatched, core),
    dispatchAndPrepare: (intent, dependencies) => orchestrateTransferPreview(intent, dependencies, core),
  };
}

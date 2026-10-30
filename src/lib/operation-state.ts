import type { ActionState } from "../banking-core/contracts";

/** The sole projection from Banking Core states to operation states rendered by the UI. */
export type CoreOperationStage = "plan" | "executing" | "checking" | "unknown" | "success" | "error" | "cancelled";

const coreToUiStage: Readonly<Record<ActionState, CoreOperationStage>> = {
  preparing: "plan",
  risk_check: "plan",
  awaiting_confirmation: "plan",
  confirmed: "executing",
  executing: "executing",
  checking: "checking",
  unknown: "unknown",
  succeeded: "success",
  failed: "error",
  cancelled: "cancelled",
};

const actionStates = new Set<ActionState>(Object.keys(coreToUiStage) as ActionState[]);

export function isActionState(value: unknown): value is ActionState {
  return typeof value === "string" && actionStates.has(value as ActionState);
}

export function projectCoreOperationState(state: ActionState): CoreOperationStage {
  return coreToUiStage[state];
}

export function isTerminalCoreOperationStage(stage: CoreOperationStage | undefined): boolean {
  return stage === "success" || stage === "error" || stage === "cancelled";
}

export function coreOperationBlocksInput(stage: CoreOperationStage): boolean {
  return stage === "executing" || stage === "checking" || stage === "unknown";
}

export type CardActivityStatus = "待确认" | "处理中" | "已完成" | "已取消" | "操作失败" | "结果待核实";

export function cardActivityStatus(stage: CoreOperationStage | undefined): CardActivityStatus {
  if (stage === "success") return "已完成";
  if (stage === "cancelled") return "已取消";
  if (stage === "error") return "操作失败";
  if (stage === "executing" || stage === "checking") return "处理中";
  if (stage === "unknown") return "结果待核实";
  return "待确认";
}

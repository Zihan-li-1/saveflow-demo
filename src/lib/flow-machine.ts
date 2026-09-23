import { writeOutcomeTransitions } from "../banking-core/action-machine.mjs";

export type Stage = "welcome" | "analyzing" | "plan" | "edit" | "executing" | "success" | "cancelled" | "error" | "unknown" | "checking" | "clarifying" | "answered";
export type FlowEvent = "START" | "ANALYZED" | "EDIT" | "SAVE" | "CONFIRM" | "SUCCEEDED" | "FAILED" | "UNCERTAIN" | "CHECK" | "CANCEL" | "RESET" | "CLARIFY" | "ANSWER";

// No write retry or reset is permitted while the outcome is unknown.
export const transitions: Partial<Record<Stage, Partial<Record<FlowEvent, Stage>>>> = {
  welcome: { START: "analyzing", RESET: "welcome" },
  analyzing: { ANALYZED: "plan", FAILED: "error", RESET: "welcome", CLARIFY: "clarifying", ANSWER: "answered" },
  clarifying: { START: "analyzing", RESET: "welcome" },
  answered: { START: "analyzing", RESET: "welcome" },
  plan: { EDIT: "edit", CONFIRM: "executing", CANCEL: "cancelled", RESET: "welcome" },
  edit: { SAVE: "plan", CANCEL: "cancelled", RESET: "welcome" },
  ...Object.fromEntries(Object.entries(writeOutcomeTransitions).map(([state, events]) => [state,
    Object.fromEntries(Object.entries(events).map(([event, next]) => [event, next === "succeeded" ? "success" : next === "failed" ? "error" : next])),
  ])),
  error: { START: "analyzing", EDIT: "edit", RESET: "welcome" },
  success: { START: "analyzing", RESET: "welcome" },
  cancelled: { START: "analyzing", RESET: "welcome" },
};
export function transition(stage: Stage, event: FlowEvent): Stage {
  return transitions[stage]?.[event] ?? stage;
}
export function canTransition(stage: Stage, event: FlowEvent) {
  return transitions[stage]?.[event] !== undefined;
}
export const stageCopy: Record<Stage, string> = {
  welcome: "等待目标", analyzing: "正在分析", plan: "等待确认", edit: "修改计划",
  executing: "执行中", success: "已完成", cancelled: "已取消", error: "需要处理",
  unknown: "结果待核实", checking: "正在查询结果",
  clarifying: "等待补充信息", answered: "已回答 · 可继续提问",
};

export type Scenario = "normal" | "insufficient" | "overLimit" | "timeout";
export type PlanInput = { monthlySavingFen: number; saveRateBps: number; confirmed: true; scenario?: Scenario; category?: string; targetAmountFen?: number | null };
export type Receipt = { operationId: string; status: "succeeded" | "failed" | "pending"; message: string };
export type Analysis = { totalExpenseFen: number; subscriptionCount: number };
export type RequestMap = {
  analyze: { goal: string; consent: true };
  "create-plan": PlanInput;
  "confirm-payment": { scenario: Exclude<Scenario, "timeout">; confirmed: true };
  "operation-status": { operationId: string };
};
export type ResultMap = { analyze: Analysis; "create-plan": Receipt; "confirm-payment": Receipt; "operation-status": Receipt };
export type Action = keyof RequestMap;
export type Envelope<T> = { code: string; message: string; requestId: string; data?: T };
export class ApiError extends Error {
  constructor(public code: string, message: string, public uncertain = false, public requestId?: string) {
    super(message);
    this.name = "ApiError";
  }
}
export function validatePlan(input: Pick<PlanInput, "monthlySavingFen" | "saveRateBps">): string | null {
  if (!Number.isSafeInteger(input.monthlySavingFen) || input.monthlySavingFen <= 0 || input.monthlySavingFen > 300000) return "每月储蓄须为 0.01–3,000 元，最多两位小数。";
  if (!Number.isInteger(input.saveRateBps) || input.saveRateBps < 0 || input.saveRateBps > 10000) return "储蓄比例须为 0–100%，最多两位小数。";
  return null;
}
export function isReceipt(value: unknown): value is Receipt {
  if (!value || typeof value !== "object") return false;
  const data = value as Receipt;
  return typeof data.operationId === "string" && ["succeeded", "failed", "pending"].includes(data.status) && typeof data.message === "string";
}

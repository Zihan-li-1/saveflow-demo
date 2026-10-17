export type PlanInput = { monthlySavingFen: number; confirmed: true; targetAmountFen?: number | null };
export type Receipt = { operationId: string; status: "succeeded" | "failed" | "pending"; message: string };
export type Analysis = {
  asOf?: string;
  currentMonth?: string;
  previousMonth?: string;
  dataSource?: string;
  totalExpenseFen: number;
  subscriptionCount: number;
  momIncreaseFen?: number;
  categories?: readonly { name: string; changeAmountFen: number }[];
};
export type RequestMap = {
  analyze: { goal: string; consent: true };
  "create-plan": PlanInput;
  "operation-status": { operationId: string };
};
export type ResultMap = { analyze: Analysis; "create-plan": Receipt; "operation-status": Receipt };
export type Action = keyof RequestMap;
export type Envelope<T> = { code: string; message: string; requestId: string; data?: T };
export class ApiError extends Error {
  constructor(public code: string, message: string, public uncertain = false, public requestId?: string) {
    super(message);
    this.name = "ApiError";
  }
}
export function validatePlan(input: Pick<PlanInput, "monthlySavingFen" | "targetAmountFen">): string | null {
  if (!Number.isSafeInteger(input.monthlySavingFen) || input.monthlySavingFen <= 0 || input.monthlySavingFen > 300000) return "每月储蓄须为 0.01–3,000 元，最多两位小数。";
  if (input.targetAmountFen != null && (!Number.isSafeInteger(input.targetAmountFen) || input.targetAmountFen <= 0)) return "目标金额须为正整数分。";
  return null;
}
export function isReceipt(value: unknown): value is Receipt {
  if (!value || typeof value !== "object") return false;
  const data = value as Receipt;
  return typeof data.operationId === "string" && ["succeeded", "failed", "pending"].includes(data.status) && typeof data.message === "string";
}

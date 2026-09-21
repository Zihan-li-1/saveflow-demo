import { saveflowMock } from "../saveflow-mock";
import { ApiError, validatePlan, type Action, type RequestMap, type ResultMap, type Receipt } from "./contracts";

// Synthetic, in-memory demonstration only. A real backend needs durable, user-scoped idempotency.
const operations = new Map<string, { fingerprint: string; receipt: Receipt }>();
export function mockRequest<A extends Action>(action: A, input: RequestMap[A], operationId: string): ResultMap[A] {
  const body = input as unknown as Record<string, unknown>;
  if (!body || typeof body !== "object") throw new ApiError("VALIDATION_ERROR", "请求参数无效");
  let result: ResultMap[Action];
  if (action === "analyze") {
    if (body.consent !== true || typeof body.goal !== "string" || !body.goal.trim() || body.goal.length > 500) throw new ApiError("VALIDATION_ERROR", "请授权模拟账单分析，并输入 1–500 字的目标");
    result = { totalExpenseFen: Math.round(saveflowMock.analysis.totalExpense * 100), subscriptionCount: saveflowMock.analysis.subscriptionCount };
  } else if (action === "operation-status") {
    if (typeof body.operationId !== "string") throw new ApiError("VALIDATION_ERROR", "缺少操作编号");
    result = operations.get(body.operationId)?.receipt ?? { operationId: body.operationId, status: "pending", message: "尚未取得最终结果，请稍后继续查询。" };
  } else if (action === "create-plan" || action === "confirm-payment") {
    if (body.confirmed !== true) throw new ApiError("CONFIRMATION_REQUIRED", "操作前需要明确确认");
    if (!operationId || operationId.length > 128) throw new ApiError("VALIDATION_ERROR", "缺少有效幂等键");
    if (body.scenario !== undefined && !["normal", "insufficient", "overLimit", "timeout"].includes(String(body.scenario))) throw new ApiError("VALIDATION_ERROR", "未知演示场景");
    if (action === "create-plan") {
      const error = validatePlan(input as RequestMap["create-plan"]);
      if (error) throw new ApiError("VALIDATION_ERROR", error);
    } else if (body.scenario === "timeout") throw new ApiError("VALIDATION_ERROR", "支付演示不支持此场景");
    const fingerprint = JSON.stringify({ action, input: Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b))) });
    const existing = operations.get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ApiError("IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同操作或参数", true);
      return existing.receipt as ResultMap[A];
    }
    const failed = body.scenario === "insufficient" || body.scenario === "overLimit";
    const receipt: Receipt = {
      operationId, status: failed ? "failed" : "succeeded",
      message: body.scenario === "insufficient" ? "余额不足，自动储蓄已暂停；本次操作未执行。" : body.scenario === "overLimit" ? "超出消费边界，本次操作被拒绝；请调整规则后重新确认。" : action === "create-plan" ? "模拟储蓄计划已生效；本次未发起支付。" : "模拟消费与储蓄已完成。",
    };
    operations.set(operationId, { fingerprint, receipt });
    if (body.scenario === "timeout") throw new ApiError("TIMEOUT", "请求超时，结果待核实，请查询原操作。", true);
    result = receipt;
  } else throw new ApiError("UNKNOWN_ACTION", "未知 action");
  return result as ResultMap[A];
}

import { apiConfig } from "./config";
import { ApiError, isReceipt, type Action, type Envelope, type RequestMap, type ResultMap } from "./contracts";

export async function request<A extends Action>(action: A, input: RequestMap[A], options: { operationId?: string; signal?: AbortSignal } = {}): Promise<ResultMap[A]> {
  const requestId = crypto.randomUUID();
  const operationId = options.operationId ?? requestId;
  if (apiConfig.mode === "mock") {
    const { mockRequest } = await import("./mock");
    if (options.signal?.aborted) throw new ApiError("ABORTED", "请求已取消");
    return mockRequest(action, input, operationId);
  }
  const write = action === "create-plan" || action === "confirm-payment";
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, apiConfig.timeoutMs);
  try {
    const response = await fetch(`${apiConfig.baseUrl}${apiConfig.endpoint}`, {
      method: "POST", credentials: "include", cache: "no-store", signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-Request-ID": requestId, ...(write ? { "Idempotency-Key": operationId } : {}) },
      body: JSON.stringify({ action, ...input }),
    });
    const payload = await response.json() as Envelope<ResultMap[A]>;
    if (!payload || typeof payload.code !== "string" || typeof payload.requestId !== "string") throw new ApiError("INVALID_RESPONSE", "接口返回格式异常", write, requestId);
    if (!response.ok || payload.code !== "OK") {
      // Only these explicit pre-execution rejections are safe to correct and resubmit.
      const rejected = ["VALIDATION_ERROR", "CONFIRMATION_REQUIRED", "UNAUTHORIZED", "FORBIDDEN", "LIMIT_EXCEEDED", "INSUFFICIENT_BALANCE"].includes(payload.code);
      const message = payload.code === "UNAUTHORIZED" ? "会话已过期，请重新登录。" : payload.message || "接口请求失败";
      throw new ApiError(payload.code, message, write && !rejected, payload.requestId);
    }
    const data = payload.data;
    if (action === "analyze") {
      const analysis = data as ResultMap["analyze"] | undefined;
      if (!analysis || !Number.isSafeInteger(analysis.totalExpenseFen) || analysis.totalExpenseFen < 0 || !Number.isInteger(analysis.subscriptionCount) || analysis.subscriptionCount < 0) throw new ApiError("INVALID_RESPONSE", "分析结果格式异常", false, requestId);
    } else if (!isReceipt(data) || data.operationId !== (action === "operation-status" ? (input as RequestMap["operation-status"]).operationId : operationId)) {
      throw new ApiError("INVALID_RESPONSE", "操作回执不匹配，需查询原操作", write, requestId);
    }
    return data as ResultMap[A];
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR", write ? "未取得可靠回执，请查询原操作结果，勿重复提交。" : "请求失败，请检查网络后重试。", write, requestId);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

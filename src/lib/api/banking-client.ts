import { apiConfig } from "./config";
import { ApiError } from "./contracts";
import type { BankingAction, BankingRequestMap, BankingResultMap } from "../../banking-core/api-contracts";
import { fromWire, toWire, WIRE_VERSION } from "../../banking-core/wire.mjs";

type Options = { mode?: "mock" | "http"; baseUrl?: string; timeoutMs?: number; accessCode?: () => string; fetchImpl?: typeof fetch };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const fen = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
function receipt(v: unknown, id: string): boolean {
  if (!object(v)) return false;
  return v.operationId === id && typeof v.receiptId === "string" && v.action === "transfer_money" && ["succeeded", "failed", "cancelled"].includes(String(v.status)) && typeof v.message === "string" && typeof v.planId === "string" && typeof v.stepId === "string" && typeof v.executedAt === "string" && Number.isFinite(Date.parse(v.executedAt)) && v.dataSource === "synthetic_demo_only" && Array.isArray(v.transactionIds) && v.transactionIds.every(t => typeof t === "string") && Array.isArray(v.effects) && (v.status !== "succeeded" || (v.transactionIds.length === 1 && v.effects.length === 1 && effect(v.effects[0])));
}
function effect(v: unknown): boolean {
  return object(v) && v.kind === "transfer_out" && v.currency === "CNY" && fen(v.amountFen) && Number(v.amountFen) > 0 && fen(v.feeFen) && fen(v.balanceBeforeFen) && fen(v.balanceAfterFen) && fen(v.availableBalanceAfterFen) && typeof v.fromAccountId === "string" && typeof v.payeeId === "string" && typeof v.payeeName === "string" && typeof v.accountNoMasked === "string" && v.balanceBeforeFen === Number(v.balanceAfterFen) + Number(v.amountFen) + Number(v.feeFen);
}
function valid<A extends BankingAction>(action: A, value: unknown, input: BankingRequestMap[A]): boolean {
  if (action === "transfer.prepare") {
    if (!object(value) || typeof value.operationId !== "string" || !value.operationId.startsWith("op_") || value.state !== "awaiting_confirmation" || !object(value.preview) || !object(value.risk)) return false;
    const p = value.preview, transfer = input as BankingRequestMap["transfer.prepare"];
    const e = Array.isArray(p.exactEffects) ? p.exactEffects[0] : null;
    return value.risk.allowed === true && value.risk.riskLevel === "L3" && p.riskLevel === "L3" && typeof p.planId === "string" && Array.isArray(p.stepIds) && p.stepIds.length === 1 && typeof p.stepIds[0] === "string" && typeof p.summary === "string" && typeof p.previewHash === "string" && /^[a-f0-9]{64}$/.test(p.previewHash) && typeof p.expiresAt === "string" && Number.isFinite(Date.parse(p.expiresAt)) && Array.isArray(p.exactEffects) && p.exactEffects.length === 1 && effect(e) && e.fromAccountId === transfer.fromAccountId && e.payeeId === transfer.payeeId && e.amountFen === transfer.amountFen && e.currency === transfer.currency && e.memo === (transfer.memo ?? "");
  }
  if (action === "action.execute") return receipt(value, (input as { operationId: string }).operationId);
  if (action === "action.status" || action === "action.decide") {
    if (!object(value) || value.operationId !== (input as { operationId: string }).operationId) return false;
    if (value.status === "pending") return ["preparing", "risk_check", "awaiting_confirmation", "confirmed", "executing", "unknown", "checking"].includes(String(value.state)) && value.receipt === undefined;
    return ["succeeded", "failed", "cancelled"].includes(String(value.status)) && value.state === value.status && receipt(value.receipt, String(value.operationId)) && object(value.receipt) && value.receipt.status === value.status;
  }
  if (action.endsWith(".list")) return Array.isArray(value) && value.every(v => object(v) && typeof v.id === "string");
  if (action === "context.get") return object(value) && value.dataSource === "synthetic_demo_only" && typeof value.asOf === "string" && typeof value.snapshotId === "string";
  return object(value) && value.id === (input as { id: string }).id && (action !== "account.get" || (fen(value.balanceFen) && fen(value.availableBalanceFen) && value.currency === "CNY"));
}

/** Shared typed adapter. Writes never retry; on uncertain execute retain operationId and query.
 * Access code remains in caller memory and is never persisted here. */
export function createBankingClient(options: Options = {}) {
  const mode = options.mode ?? apiConfig.mode;
  const baseUrl = options.baseUrl ?? apiConfig.baseUrl;
  const timeoutMs = options.timeoutMs ?? apiConfig.timeoutMs;
  return {
    async request<A extends BankingAction>(action: A, input: BankingRequestMap[A]): Promise<BankingResultMap[A]> {
      const write = action === "action.execute";
      if (mode === "mock") {
        const { dispatchBanking } = await import("../../banking-core/dispatch.mjs");
        const result = await dispatchBanking(action, input);
        if (!result.ok) throw new ApiError(result.error.code, result.error.message, result.error.uncertain);
        if (!valid(action, result.data, input)) throw new ApiError("INVALID_RESPONSE", "模拟接口结果不匹配", write);
        return result.data as BankingResultMap[A];
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await (options.fetchImpl ?? fetch)(`${baseUrl}/api/banking`, {
          method: "POST", credentials: "include", cache: "no-store", signal: controller.signal,
          headers: { "Content-Type": "application/json", "X-Saveflow-Access": options.accessCode?.() ?? "", ...(write ? { "Idempotency-Key": (input as { operationId: string }).operationId } : {}) },
          body: JSON.stringify({ schema_version: WIRE_VERSION, action, input: toWire(input) }),
        });
        const wire: unknown = await response.json();
        if (!object(wire) || wire.schema_version !== WIRE_VERSION || typeof wire.request_id !== "string" || typeof wire.code !== "string") throw new ApiError("INVALID_RESPONSE", "Banking Core 响应协议无效", write);
        const payload = fromWire(wire) as Record<string, unknown>;
        if (!response.ok || payload.code !== "OK") {
          const safeRejection = response.status < 500 && ["VALIDATION_ERROR", "CONFIRMATION_REQUIRED", "CONFIRMATION_INVALID", "UNAUTHORIZED", "FORBIDDEN", "PREVIEW_EXPIRED", "PREVIEW_STALE", "INSUFFICIENT_BALANCE", "LIMIT_EXCEEDED"].includes(String(payload.code));
          throw new ApiError(String(payload.code), typeof payload.message === "string" ? payload.message : "Banking Core 请求失败", write && !safeRejection, String(payload.requestId));
        }
        if (!valid(action, payload.data, input)) throw new ApiError("INVALID_RESPONSE", "回执或预览不匹配，请查询原操作", write, String(payload.requestId));
        return payload.data as BankingResultMap[A];
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR", write ? "未取得可靠回执，请保留原编号查询，勿重复提交。" : "请求未完成，请查询当前操作状态。", write);
      } finally { clearTimeout(timer); }
    },
  };
}

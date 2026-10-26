import { apiConfig } from "./config";
import { ApiError } from "./contracts";
import type { BankingAction, BankingRequestMap, BankingResultMap } from "../../banking-core/api-contracts";
import { fromWire, toWire, WIRE_VERSION } from "../../banking-core/wire.mjs";

type Options = { mode?: "mock" | "http"; baseUrl?: string; timeoutMs?: number; accessCode?: () => string; fetchImpl?: typeof fetch };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const fen = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
// Rule contracts retain snake_case domain fields, with previewGeneration in camelCase.
// The generic HTTP decoder otherwise changes nested rule fields as well as the envelope.
function restoreScenarioReceipt(value: Record<string, unknown>): Record<string, unknown> {
  if (!['scenario.create_rule', 'scenario.update_rule', 'scenario.disable_rule'].includes(String(value.action)) || !Array.isArray(value.effects)) return value;
  const rule = (input: unknown) => {
    if (!object(input)) return input;
    const restored = toWire(input) as Record<string, unknown>;
    restored.previewGeneration = restored.preview_generation; delete restored.preview_generation;
    return restored;
  };
  return { ...value, effects: value.effects.map(effect => object(effect) && effect.kind === 'scenario_rule_change' ? { ...effect, before: rule(effect.before), after: rule(effect.after) } : effect) };
}
function receipt(v: unknown, id: string): boolean {
  if (!object(v)) return false;
  const cardAction = ["card.set_budget", "card.set_controls", "card.freeze", "card.unfreeze"].includes(String(v.action));
  const scenarioAction = ["scenario.create_rule", "scenario.update_rule", "scenario.disable_rule"].includes(String(v.action));
  const wealthAction = ["wealth.subscribe", "wealth.redeem"].includes(String(v.action));
  return v.operationId === id && typeof v.receiptId === "string" && (v.action === "transfer_money" || cardAction || wealthAction || scenarioAction) && ["succeeded", "failed", "cancelled"].includes(String(v.status)) && typeof v.message === "string" && typeof v.planId === "string" && typeof v.stepId === "string" && typeof v.executedAt === "string" && Number.isFinite(Date.parse(v.executedAt)) && v.dataSource === "synthetic_demo_only" && Array.isArray(v.transactionIds) && v.transactionIds.every(t => typeof t === "string") && Array.isArray(v.effects) && (v.status !== "succeeded" || (cardAction ? v.transactionIds.length === 0 && v.effects.length === 1 && cardEffect(v.effects[0], String(v.action)) : wealthAction ? v.transactionIds.length === 0 && v.effects.length === 1 && wealthEffect(v.effects[0], String(v.action)) : scenarioAction ? v.transactionIds.length === 0 && v.effects.length === 1 && scenarioEffect(v.effects[0], String(v.action)) : v.transactionIds.length === 1 && v.effects.length === 1 && effect(v.effects[0])));
}
function scenarioEffect(v: unknown, action: string): boolean {
  if (!object(v) || v.kind !== 'scenario_rule_change' || v.action !== action || typeof v.ruleId !== 'string' || !Number.isSafeInteger(v.previewGeneration) ||
      !(v.ruleVersion === null || Number.isSafeInteger(v.ruleVersion)) || !object(v.after)) return false;
  const rule = v.after;
  return rule.id === v.ruleId && ['active', 'disabled'].includes(String(rule.status)) && rule.authorization_scope === 'suggest_only' &&
    Number.isSafeInteger(rule.version) && object(rule.trigger) && typeof rule.trigger.value === 'string' && Array.isArray(rule.proposed_steps) &&
    rule.proposed_steps.every(step => object(step) && ['bill.analyze', 'bill.report', 'subscription.list', 'wealth.recommend', 'wealth.compare', 'card.get'].includes(String(step.action)) && object(step.parameters));
}
function wealthEffect(v: unknown, action: string): boolean {
  if (!object(v) || v.kind !== "wealth_change" || v.action !== action || typeof v.productId !== "string" || typeof v.productName !== "string" || typeof v.holdingId !== "string" || !fen(v.amountFen) || Number(v.amountFen) <= 0 || !fen(v.unitsMilli) || Number(v.unitsMilli) <= 0 || !fen(v.holdingAmountBeforeFen) || !fen(v.holdingAmountAfterFen)) return false;
  return action === "wealth.subscribe" ? typeof v.fundingAccountId === "string" && Number.isSafeInteger(v.accountVersion) && fen(v.accountBalanceBeforeFen) && fen(v.accountBalanceAfterFen) && typeof v.disclosureVersion === "string" && typeof v.assessmentId === "string" : Number.isSafeInteger(v.holdingVersion) && typeof v.settlement === "string";
}
function cardEffect(v: unknown, action?: string): boolean {
  if (!object(v) || v.kind !== "card_change" || !["card.set_budget", "card.set_controls", "card.freeze", "card.unfreeze"].includes(String(v.action)) || (action && v.action !== action)) return false;
  const before = v.before, after = v.after;
  if (!(typeof v.cardId === "string" && typeof v.cardName === "string" && Number.isSafeInteger(v.cardVersion) && Number.isSafeInteger(v.previewGeneration) && fen(v.monthlySpentFen) && object(before) && object(after) && ["active", "frozen"].includes(String(before.status)) && ["active", "frozen"].includes(String(after.status)) && fen(before.monthlyBudgetFen) && fen(after.monthlyBudgetFen) && typeof before.onlinePaymentsEnabled === "boolean" && typeof after.onlinePaymentsEnabled === "boolean" && Array.isArray(before.blockedCategories) && Array.isArray(after.blockedCategories) && (before.alertThresholdFen === null || fen(before.alertThresholdFen)) && (after.alertThresholdFen === null || fen(after.alertThresholdFen)) && (before.balanceReminderAmountFen === null || fen(before.balanceReminderAmountFen)) && (after.balanceReminderAmountFen === null || fen(after.balanceReminderAmountFen)) && (before.balanceReminderPercent === null || Number.isSafeInteger(before.balanceReminderPercent) && Number(before.balanceReminderPercent) >= 1 && Number(before.balanceReminderPercent) <= 100) && (after.balanceReminderPercent === null || Number.isSafeInteger(after.balanceReminderPercent) && Number(after.balanceReminderPercent) >= 1 && Number(after.balanceReminderPercent) <= 100) && !(before.balanceReminderAmountFen !== null && before.balanceReminderPercent !== null) && !(after.balanceReminderAmountFen !== null && after.balanceReminderPercent !== null))) return false;
  if (v.action === "card.freeze") return before.status === "active" && after.status === "frozen" && before.monthlyBudgetFen === after.monthlyBudgetFen;
  if (v.action === "card.unfreeze") return before.status === "frozen" && after.status === "active" && before.monthlyBudgetFen === after.monthlyBudgetFen;
  if (v.action === "card.set_controls") return before.status === after.status && before.monthlyBudgetFen === after.monthlyBudgetFen && JSON.stringify(before) !== JSON.stringify(after);
  return before.status === after.status && before.monthlyBudgetFen !== after.monthlyBudgetFen;
}
function effect(v: unknown): boolean {
  return object(v) && v.kind === "transfer_out" && v.currency === "CNY" && fen(v.amountFen) && Number(v.amountFen) > 0 && fen(v.feeFen) && fen(v.balanceBeforeFen) && fen(v.balanceAfterFen) && fen(v.availableBalanceAfterFen) && typeof v.fromAccountId === "string" && typeof v.payeeId === "string" && typeof v.payeeName === "string" && typeof v.accountNoMasked === "string" && v.balanceBeforeFen === Number(v.balanceAfterFen) + Number(v.amountFen) + Number(v.feeFen);
}
function valid<A extends BankingAction>(action: A, value: unknown, input: BankingRequestMap[A]): boolean {
  if (["card.set_budget", "card.set_controls", "card.freeze", "card.unfreeze"].includes(action)) {
    if (!object(value) || typeof value.operationId !== "string" || value.state !== "awaiting_confirmation" || !object(value.preview) || !object(value.risk)) return false;
    const preview = value.preview, effects = preview.exactEffects;
    return value.risk.allowed === true && preview.riskLevel === (action === "card.unfreeze" ? "L3" : "L2") && typeof preview.previewHash === "string" && /^[a-f0-9]{64}$/.test(preview.previewHash) && typeof preview.expiresAt === "string" && Number.isFinite(Date.parse(preview.expiresAt)) && Array.isArray(preview.stepIds) && preview.stepIds.length === 1 && Array.isArray(effects) && effects.length === 1 && cardEffect(effects[0], action) && effects[0].cardId === (input as { cardId: string }).cardId;
  }
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
  if (action === "card.get") return object(value) && value.id === (input as { id: string }).id && typeof value.name === "string" && ["active", "frozen"].includes(String(value.status)) && fen(value.monthlyBudgetFen) && fen(value.monthlySpentFen) && typeof value.onlinePaymentsEnabled === "boolean" && Array.isArray(value.blockedCategories) && (value.alertThresholdFen === null || fen(value.alertThresholdFen)) && (value.balanceReminderAmountFen === null || fen(value.balanceReminderAmountFen)) && (value.balanceReminderPercent === null || Number.isSafeInteger(value.balanceReminderPercent) && Number(value.balanceReminderPercent) >= 1 && Number(value.balanceReminderPercent) <= 100) && !(value.balanceReminderAmountFen !== null && value.balanceReminderPercent !== null) && Number.isSafeInteger(value.version);
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
        if (object(payload.data)) {
          if (object(payload.data.receipt)) payload.data.receipt = restoreScenarioReceipt(payload.data.receipt);
          payload.data = restoreScenarioReceipt(payload.data);
        }
        if (!response.ok || payload.code !== "OK") {
          const safeRejection = response.status < 500 && ["VALIDATION_ERROR", "CONFIRMATION_REQUIRED", "CONFIRMATION_INVALID", "INVALID_STATE", "CARD_NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN", "PREVIEW_EXPIRED", "PREVIEW_STALE", "INSUFFICIENT_BALANCE", "LIMIT_EXCEEDED", "SUITABILITY_FAILED", "BELOW_MINIMUM_AMOUNT", "HOLDING_NOT_FOUND", "REDEMPTION_RESTRICTED", "INSUFFICIENT_HOLDING"].includes(String(payload.code));
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

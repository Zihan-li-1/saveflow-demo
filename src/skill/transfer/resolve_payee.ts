// skill/transfer/resolve_payee.ts
import type { FinancialContextRepository, PayeeResolution } from "./types";

/**
 * 解析收款人：输入 payee_ref 口语称呼，查询收款人列表并消歧。
 *
 * - 1 个匹配   → { status: "resolved", payee }，payee.id 即服务端 entity_id
 * - 0 个匹配   → { status: "needs_clarification" }（payee_not_found）
 * - 多个匹配   → { status: "needs_clarification" }（ambiguous_payee），附带全部候选，
 *                绝不私下挑选其中一个收款人
 * - 缺失称呼   → { status: "needs_clarification" }（missing_slot）
 *
 * 不抛异常：一切无法唯一定位的情形都返回 clarification，交由上层 Orchestrator 澄清。
 *
 * @param repository 金融上下文底座（只读），用于查询收款人
 * @param payeeRef   用户输入的收款人口语称呼（payee_ref）
 */
export async function resolvePayee(
  repository: FinancialContextRepository,
  payeeRef: string | null | undefined
): Promise<PayeeResolution> {
  const query = typeof payeeRef === "string" ? payeeRef.trim() : "";
  if (!query) {
    return {
      status: "needs_clarification",
      clarification: {
        reason: "missing_slot",
        slot: "payee_ref",
        question: "请告诉我要转给谁（收款人姓名）。",
      },
    };
  }

  const candidates = (await repository.queryPayeesByName(query)) ?? [];

  if (candidates.length === 0) {
    return {
      status: "needs_clarification",
      clarification: {
        reason: "payee_not_found",
        slot: "payee_ref",
        question: `没有找到收款人「${query}」，请确认姓名是否正确。`,
      },
    };
  }
  if (candidates.length === 1) {
    return { status: "resolved", payee: candidates[0] };
  }
  return {
    status: "needs_clarification",
    clarification: {
      reason: "ambiguous_payee",
      slot: "payee_ref",
      question: `「${query}」匹配到多位收款人，请确认是哪一位。`,
      candidates,
    },
  };
}

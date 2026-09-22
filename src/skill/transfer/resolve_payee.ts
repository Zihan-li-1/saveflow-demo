// skill/transfer/resolve_payee.ts
import {
  TransferSkillError,
  type FinancialContextRepository,
  type ResolvePayeeResult,
} from "./types";

/**
 * 解析收款人：输入收款人姓名字符串，查询收款人列表并消歧。
 *
 * - 0 个匹配   → 返回 { status: "not_found" }
 * - 1 个匹配   → 返回 { status: "resolved", payee }
 * - 多个匹配   → 返回 { status: "ambiguous", candidates }，附带全部候选，
 *                绝不私下挑选其中一个收款人。
 *
 * @param repository 金融上下文底座（B 同学提供），用于查询收款人
 * @param name       用户输入的收款人姓名
 */
export async function resolvePayee(
  repository: FinancialContextRepository,
  name: string
): Promise<ResolvePayeeResult> {
  const query = typeof name === "string" ? name.trim() : "";
  if (!query) {
    throw new TransferSkillError("INVALID_INPUT", "收款人姓名不能为空。");
  }

  const candidates = (await repository.queryPayeesByName(query)) ?? [];

  if (candidates.length === 0) {
    return { status: "not_found", query };
  }
  if (candidates.length === 1) {
    return { status: "resolved", payee: candidates[0] };
  }
  // 重名歧义：返回全部候选，由上层（Orchestrator / 用户）决定，不做任何自动挑选。
  return { status: "ambiguous", query, candidates };
}

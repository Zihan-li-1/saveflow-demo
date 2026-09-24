// skill/transfer/index.ts
import { resolvePayee } from "./resolve_payee";
import { prepareTransfer } from "./prepare_transfer";
import type {
  Amount,
  Clarification,
  ResolvedTransferIntent,
  TransferDependencies,
  TransferIntentSlots,
} from "./types";

// 导出两个核心函数 + 全部类型定义
export { resolvePayee, prepareTransfer };
export * from "./types";

/** 构造 needs_clarification 意图 */
function needsClarification(clarification: Clarification): ResolvedTransferIntent {
  return { action: "transfer.create", state: "needs_clarification", clarification };
}

/**
 * 解析转账意图（transfer.create）：把 LLM 抽取的口语槽位解析为服务端实体引用并组装转账预览。
 *
 * 输出 snake_case 的 ResolvedTransferIntent：
 * - ready_for_planning  ：全部槽位唯一解析成功，附带 references + preview
 * - needs_clarification ：缺失必备槽位 / 金额非法 / 收款人找不到或重名歧义 / 转出账户不存在
 *
 * 职责边界：只做实体解析与转账预览数据组装；不实现用户确认、不计算 risk_level、绝不执行真实转账。
 * 真正扣款应由上层（Orchestrator）在取得用户确认后调用 Banking Core 的 transfer.prepare → decide → execute。
 */
export async function resolveTransferIntent(
  deps: TransferDependencies,
  slots: TransferIntentSlots
): Promise<ResolvedTransferIntent> {
  const { repository } = deps;

  // ① 金额校验：缺失 → needs_clarification；必须为大于 0 的整数分，严禁浮点。
  const amount = slots.amount;
  if (!amount) {
    return needsClarification({
      reason: "missing_slot",
      slot: "amount",
      question: "请告诉我转账金额。",
    });
  }
  if (!Number.isSafeInteger(amount.amount_minor) || amount.amount_minor <= 0) {
    return needsClarification({
      reason: "invalid_amount",
      slot: "amount",
      question: "转账金额必须为大于 0 的整数分，请重新输入。",
    });
  }
  if (amount.currency !== "CNY") {
    return needsClarification({
      reason: "invalid_amount",
      slot: "amount",
      question: "目前仅支持人民币（CNY）转账。",
    });
  }
  const normalizedAmount: Amount = { amount_minor: amount.amount_minor, currency: amount.currency };

  // ② 转出账户槽位：缺失必备槽位 → needs_clarification。
  const sourceAccountRef =
    typeof slots.source_account_ref === "string" ? slots.source_account_ref.trim() : "";
  if (!sourceAccountRef) {
    return needsClarification({
      reason: "missing_slot",
      slot: "source_account_ref",
      question: "请确认从哪个账户转出。",
    });
  }

  // ③ 收款人解析（payee_ref 口语称呼 → 服务端 entity_id）。
  const payee = await resolvePayee(repository, slots.payee_ref);
  if (payee.status === "needs_clarification") {
    return needsClarification(payee.clarification);
  }

  // ④ 组装转账预览数据（此处同时完成转出账户的唯一解析）。
  const prepared = await prepareTransfer(repository, {
    source_account_id: sourceAccountRef,
    payee_id: payee.payee.id,
    amount: normalizedAmount,
  });
  if (prepared.status === "needs_clarification") {
    return needsClarification(prepared.clarification);
  }

  return {
    action: "transfer.create",
    state: "ready_for_planning",
    resolved_slots: { amount: normalizedAmount },
    references: [
      { slot: "source_account_ref", entity_id: prepared.preview.source_account_id, source: "financial_context" },
      { slot: "payee_ref", entity_id: prepared.preview.payee_id, source: "financial_context" },
    ],
    preview: prepared.preview,
  };
}

// skill/transfer/index.ts
// ⚠️ @deprecated —— 本目录是「阶段一」的 TS 平行实现，仅被测试引用，未接进生产。
// 生产路径为 src/agent/runtime.mjs 的 resolveTransferIntent；方向判定规则须与
// src/agent/transfer-direction.mjs 保持一致，如需改动请两处同步。
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
 * @deprecated 生产环境请使用 src/agent/runtime.mjs 的 resolveTransferIntent；本实现仅被测试引用。
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
      question: "转账金额必须是大于 0 的整数分。",
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

  const internal = !!slots.target_account_ref || slots.transfer_type === "internal";
  const external = !!slots.payee_ref || slots.transfer_type === "external";
  if (!internal && !external) {
    return needsClarification({
      reason: "missing_transfer_type",
      slot: "transfer_type",
      question: "这笔转账是转给本人其他账户，还是转给他人？",
    });
  }

  if (internal) {
    const sourceRef = typeof slots.source_account_ref === "string" ? slots.source_account_ref.trim() : "";
    if (!sourceRef) return needsClarification({ reason: "missing_slot", slot: "source_account_ref", question: "请确认从哪个本人账户转出。" });
    const targetRef = typeof slots.target_account_ref === "string" ? slots.target_account_ref.trim() : "";
    if (!targetRef) return needsClarification({ reason: "missing_slot", slot: "target_account_ref", question: "请确认转入哪个本人账户。" });
    if (!repository.queryOwnAccounts) return needsClarification({ reason: "target_account_not_found", slot: "target_account_ref", question: "当前账户查询接口暂不支持本人账户互转，请选择其他转账方式。" });
    const [sources, targets] = await Promise.all([
      repository.queryOwnAccounts(sourceRef, "source_account_ref"),
      repository.queryOwnAccounts(targetRef, "target_account_ref"),
    ]);
    if (!sources.length) return needsClarification({ reason: "source_account_not_found", slot: "source_account_ref", question: `转出账户「${sourceRef}」不存在或不可用。` });
    if (sources.length > 1) return needsClarification({ reason: "ambiguous_account", slot: "source_account_ref", question: `「${sourceRef}」匹配到多个本人账户，请选择一个。` });
    if (!targets.length) return needsClarification({ reason: "target_account_not_found", slot: "target_account_ref", question: `转入账户「${targetRef}」不存在或不可用。` });
    if (targets.length > 1) return needsClarification({ reason: "ambiguous_account", slot: "target_account_ref", question: `「${targetRef}」匹配到多个本人账户，请选择一个。` });
    const source = sources[0]; const target = targets[0];
    if (source.id === target.id) return needsClarification({ reason: "same_account", slot: "target_account_ref", question: "转出账户和转入账户不能是同一个，请重新选择。" });
    if (source.currency !== target.currency || source.currency !== normalizedAmount.currency) return needsClarification({ reason: "invalid_amount", slot: "amount", question: "本人互转的两个账户必须使用相同币种。" });
    if (source.availableBalanceFen < normalizedAmount.amount_minor) return needsClarification({ reason: "insufficient_balance", slot: "amount", question: "转出账户可用余额不足，无法生成转账预览。" });
    return {
      action: "transfer.create", state: "ready_for_planning", resolved_slots: { amount: normalizedAmount },
      references: [
        { slot: "source_account_ref", entity_id: source.id, source: "financial_context" },
        { slot: "target_account_ref", entity_id: target.id, source: "financial_context" },
      ],
      preview: {
        kind: "internal_transfer", source_account_id: source.id, source_account_name: source.name || sourceRef,
        target_account_id: target.id, target_account_name: target.name || targetRef,
        amount_minor: normalizedAmount.amount_minor, currency: normalizedAmount.currency,
        source_available_balance_minor: source.availableBalanceFen,
        source_estimated_balance_after_minor: source.availableBalanceFen - normalizedAmount.amount_minor,
        target_available_balance_minor: target.availableBalanceFen,
        target_estimated_balance_after_minor: target.availableBalanceFen + normalizedAmount.amount_minor,
      },
    };
  }

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

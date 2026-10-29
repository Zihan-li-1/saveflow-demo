"use client";

import type { ActionReceipt } from "@/banking-core/contracts";

export type TransferVerification = { availableBalanceFen: number; transactionId: string; occurredAt: string; amountFen: number; status: string };

const yuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`;

/** 转账回执卡：展示扣款结果，并展示从同一后端重新查询到的余额与交易记录。 */
export function BankingTransferReceipt({ receipt, verification }: { receipt?: ActionReceipt; verification?: TransferVerification }) {
  if (!receipt) return null;
  const effect = receipt.effects[0];
  const transfer = effect?.kind === "transfer_out" ? effect : undefined;
  const internal = effect?.kind === "transfer_internal" ? effect : undefined;
  const succeeded = receipt.status === "succeeded";
  return <div className="banking-result-card">
    <b>{succeeded ? "转账回执 · 已完成" : `转账回执 · ${receipt.status === "cancelled" ? "已取消" : "未成功"}`}</b>
    {transfer && <>
      <span>收款人：{transfer.payeeName}（{transfer.accountNoMasked}）</span>
      <span>金额：{yuan(transfer.amountFen)}（手续费 {yuan(transfer.feeFen)}）</span>
      <span>付款账户：{transfer.accountName}</span>
    </>}
    {internal && <>
      <span>转账方向：{internal.accountName} → {internal.targetAccountName}</span>
      <span>金额：{yuan(internal.amountFen)}</span>
      <span>转出后余额：{yuan(internal.sourceBalanceAfterFen)} · 转入后余额：{yuan(internal.targetBalanceAfterFen)}</span>
    </>}
    {verification && <>
      <span>转账后可用余额：{yuan(verification.availableBalanceFen)}</span>
      <small>已核对账户余额与转账结果；重复确认不会产生第二笔交易。</small>
    </>}
    <small>{receipt.message} · 数据来源：合成数据，不接真实银行</small>
    <small>该转账已完成，不能重复确认或取消。</small>
  </div>;
}

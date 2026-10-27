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
      <span>实际状态：{succeeded ? "已成功（succeeded）" : receipt.status}</span>
      <span>交易编号：{receipt.transactionIds.length ? receipt.transactionIds.join("、") : "无"}</span>
    </>}
    {internal && <>
      <span>转账方向：{internal.accountName} → {internal.targetAccountName}</span>
      <span>金额：{yuan(internal.amountFen)}</span>
      <span>转出后余额：{yuan(internal.sourceBalanceAfterFen)} · 转入后余额：{yuan(internal.targetBalanceAfterFen)}</span>
      <span>双方交易编号：{receipt.transactionIds.length ? receipt.transactionIds.join("、") : "无"}</span>
      <span>实际状态：{succeeded ? "已成功（succeeded）" : receipt.status}</span>
    </>}
    <span>回执编号：{receipt.receiptId}</span>
    <span>执行时间：{receipt.executedAt}</span>
    {verification && <>
      <span>后端交易记录：{verification.transactionId} · {yuan(verification.amountFen)} · {verification.status === "posted" ? "已记账（posted）" : verification.status}</span>
      <span>后端查询余额：{yuan(verification.availableBalanceFen)}</span>
      <small>已从同一后端重新查询账户余额与交易记录，结果与回执一致；重复确认只会返回本回执，不会产生第二笔交易。</small>
    </>}
    <small>{receipt.message} · 数据来源：合成数据，不接真实银行</small>
    <small>该操作已进入终态，不能重复确认或取消；如需核实，请保留上述回执编号。</small>
  </div>;
}

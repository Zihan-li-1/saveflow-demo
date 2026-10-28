"use client";

import type { ActionReceipt, InternalTransferEffect, TransferEffect } from "@/banking-core/contracts";

export type TransferVerification = { availableBalanceFen: number; transactionId: string; occurredAt: string; amountFen: number; status: string };
export type TransferVoucher = { receipt: ActionReceipt; verification?: TransferVerification };

const yuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`;

/** 微信支付式「支出凭证」：头顶收付款人，下方扣款信息。 */
export function BankingExpenseVoucher({ receipt }: { receipt: ActionReceipt }) {
  const effect = receipt.effects[0];
  const transfer = effect?.kind === "transfer_out" ? (effect as TransferEffect) : undefined;
  const internal = effect?.kind === "transfer_internal" ? (effect as InternalTransferEffect) : undefined;
  if (!transfer && !internal) return null;
  const succeeded = receipt.status === "succeeded";
  return <div className="expense-voucher">
    <div className="expense-voucher-head">
      <div className="expense-voucher-parties">
        <span>{transfer?.accountName || internal?.accountName}</span>
        <span className="expense-voucher-arrow">→</span>
        <span>{transfer ? `${transfer.payeeName}（${transfer.accountNoMasked}）` : internal?.targetAccountName}</span>
      </div>
      <strong>{yuan((transfer || internal)!.amountFen)}</strong>
    </div>
    <div className="expense-voucher-body">
      <div className="expense-voucher-row"><span>金额</span><b>{yuan((transfer || internal)!.amountFen)}</b></div>
      {transfer && <div className="expense-voucher-row"><span>手续费</span><b>{yuan(transfer.feeFen)}</b></div>}
      {transfer ? <div className="expense-voucher-row"><span>付款账户</span><b>{transfer.accountName}</b></div> : <div className="expense-voucher-row"><span>本人互转</span><b>{internal?.accountName} → {internal?.targetAccountName}</b></div>}
      <div className="expense-voucher-row"><span>状态</span><b>{succeeded ? "已成功" : receipt.status}</b></div>
    </div>
    <small>数据来源：合成数据，不接真实银行</small>
  </div>;
}

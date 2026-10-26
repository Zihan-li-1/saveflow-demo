"use client";

import type { ActionReceipt, TransferEffect } from "@/banking-core/contracts";
import type { Message } from "@/lib/use-saveflow";
import { BankingExpenseVoucher, type TransferVoucher } from "./BankingExpenseVoucher";

const DEFAULT_ACCOUNT = "模拟活期账户";
const DEFAULT_BALANCE_FEN = 500000; // 种子 ACC-CHECKING 可用余额 ¥5000
const yuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`;

/** 账户概览：账户头 + 支出凭证列表。数据从聊天里的 banking_receipt 消息读取，随会话持久化。 */
export function BankingAccountOverview({ messages }: { messages: Message[] }) {
  const vouchers: TransferVoucher[] = messages
    .filter(message => message.kind === "banking_receipt" && message.receipt)
    .map(message => ({ receipt: message.receipt as ActionReceipt, verification: message.verification }))
    .reverse();

  const latest = vouchers[0];
  const firstEffect = latest?.receipt.effects[0];
  const transfer = firstEffect?.kind === "transfer_out" ? (firstEffect as TransferEffect) : undefined;
  const accountName = transfer?.accountName || DEFAULT_ACCOUNT;
  // 可用余额以最新回执里的转账后余额为准（回执必含 availableBalanceAfterFen），
  // verification.availableBalanceFen 作为补充回退，最后才是种子默认值。
  const balanceFen = latest?.verification?.availableBalanceFen ?? transfer?.availableBalanceAfterFen ?? DEFAULT_BALANCE_FEN;

  return <section className="account-overview">
    <header className="account-overview-header">
      <div>
        <span className="eyebrow">ACCOUNT OVERVIEW</span>
        <h2>账户概览</h2>
      </div>
      <span className="account-chip">{accountName}</span>
    </header>
    <div className="account-balance-card">
      <span>可用余额</span>
      <strong>{yuan(balanceFen)}</strong>
      <small>合成数据 · <b className="account-name">{accountName}</b></small>
    </div>
    <div className="voucher-section">
      <div className="voucher-section-title">支出凭证</div>
      {vouchers.length
        ? vouchers.map(voucher => <BankingExpenseVoucher key={voucher.receipt.receiptId} receipt={voucher.receipt} />)
        : <p className="voucher-empty">暂无转账凭证</p>}
    </div>
  </section>;
}

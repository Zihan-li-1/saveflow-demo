"use client";
import { ShieldCheck } from "lucide-react";
import type { BankingAgentData } from "@/lib/banking-agent-client";

/** 本人账户互转的只读预览卡片：只展示方向与两侧余额变化，不提供确认/执行入口。 */
export function BankingInternalTransferPreview({ data }: { data?: BankingAgentData }) {
  const preview = data?.preview as Record<string, unknown> | undefined;
  const amountMinor = Number(preview?.amount_minor || 0);
  const sourceName = String(preview?.source_account_name || preview?.source_account_id || "付款账户");
  const targetName = String(preview?.target_account_name || preview?.target_account_id || "收款账户");
  const fmt = (n: unknown) => `¥${(Number(n || 0) / 100).toFixed(2)}`;
  return <div className="banking-preview-card">
    <div><b>本人账户互转预览</b><span>只读预览 · 不能执行</span></div>
    <strong>{fmt(amountMinor)}</strong>
    <p>{sourceName} → {targetName}</p>
    <p>转出账户可用余额 {fmt(preview?.source_available_balance_minor)} → {fmt(preview?.source_estimated_balance_after_minor)}（预计转出后）</p>
    <p>转入账户可用余额 {fmt(preview?.target_available_balance_minor)} → {fmt(preview?.target_estimated_balance_after_minor)}（预计转入后）</p>
    <div className="insight-line"><ShieldCheck size={14} /> 本人账户互转的正式执行能力尚未接入 Banking Core，此预览不会产生任何资金变动，无法执行。</div>
  </div>;
}

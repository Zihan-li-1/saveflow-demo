"use client";

import type { BankingAgentData } from "@/lib/banking-agent-client";

const yuan = (fen: unknown) => `¥${(Number(fen) / 100).toFixed(2)}`;
const cardStatus = (status: unknown) => status === "frozen" ? "已冻结" : "正常";

export function BankingCardResult({ data }: { data?: BankingAgentData }) {
  const card = data?.data?.card as { name: string; status: string; monthlyBudgetFen: number; monthlySpentFen: number; version: number } | undefined;
  if (!card) return null;
  return <div className="banking-result-card">
    <b>{card.name}</b>
    <span>状态：{cardStatus(card.status)}</span>
    <span>月消费预算：{yuan(card.monthlyBudgetFen)}</span>
    <span>本月已消费：{yuan(card.monthlySpentFen)}</span>
    <small>卡片版本 {card.version} · 数据来源：{String(data?.evidence?.[0]?.source || "未知")} · 截至 {String(data?.evidence?.[0]?.asOf || "未知")}</small>
  </div>;
}

type Effect = { kind: string; action: string; cardId: string; cardName: string; cardVersion: number; before: { status: string; monthlyBudgetFen: number }; after: { status: string; monthlyBudgetFen: number } };
export function BankingCardPreview({ data, active, busy, onConfirm, onReject, onCheck }: { data?: BankingAgentData; active: boolean; busy: boolean; onConfirm: (data: BankingAgentData) => void; onReject: (data: BankingAgentData) => void; onCheck: (data: BankingAgentData) => void }) {
  const preview = data?.preview;
  const effect = (preview?.exactEffects as Effect[] | undefined)?.[0];
  if (!data || !effect || !preview) return null;
  const operation = data.action === "card.set_budget" ? "设置月消费预算" : data.action === "card.freeze" ? "冻结卡片" : "解冻卡片";
  const change = data.action === "card.set_budget" ? `${yuan(effect.before.monthlyBudgetFen)} → ${yuan(effect.after.monthlyBudgetFen)}` : `${cardStatus(effect.before.status)} → ${cardStatus(effect.after.status)}`;
  return <div className="banking-preview-card card-action-preview">
    <div><b>卡片操作预览</b><span>{active ? "等待确认" : "已失效"}</span></div>
    <strong>{effect.cardName}</strong>
    <p>操作：{operation}</p>
    <p>变更前后：{change}</p>
    <small>卡片版本 {effect.cardVersion} · 风险等级 {String(data.risk?.riskLevel || "未知")} · 有效期至 {String(preview.expiresAt || "未知")}</small>
    {Array.isArray(preview.warnings) && preview.warnings.map((warning, index) => <small key={index}>{String(warning)}</small>)}
    <small>预览哈希：{String(preview.previewHash).slice(0, 16)}…</small>
    <button type="button" className="primary-button" onClick={() => onConfirm(data)} disabled={!active || busy}>{busy ? "处理中…" : "确认并执行"}</button>
    {active && <button type="button" className="secondary-button" onClick={() => onReject(data)} disabled={busy}>取消本次操作</button>}
    <button type="button" className="secondary-button" onClick={() => onCheck(data)} disabled={busy}>查询操作状态</button>
  </div>;
}

"use client";

import { stageCopy } from "@/lib/flow-machine";
import type { BankingAgentData } from "@/lib/banking-agent-client";
import { isTrialPreview } from "@/lib/trial-preview.mjs";

const yuan = (fen: unknown) => `¥${(Number(fen) / 100).toFixed(2)}`;
const cardStatus = (status: unknown) => status === "frozen" ? "已冻结" : "正常";

export function BankingCardResult({ data }: { data?: BankingAgentData }) {
  const card = data?.data?.card as { name: string; status: string; monthlyBudgetFen: number; monthlySpentFen: number; onlinePaymentsEnabled?: boolean; blockedCategories?: string[]; alertThresholdFen?: number | null; balanceReminderAmountFen?: number | null; balanceReminderPercent?: number | null; version: number } | undefined;
  if (!card) return null;
  const overBudgetFen = Math.max(0, card.monthlySpentFen - card.monthlyBudgetFen);
  const remainingFen = Math.max(0, card.monthlyBudgetFen - card.monthlySpentFen);
  const reminderThresholdFen = card.balanceReminderAmountFen ?? (card.balanceReminderPercent == null ? null : Math.floor(card.monthlyBudgetFen * card.balanceReminderPercent / 100));
  const balanceAlert = remainingFen === 0 ? "预算余额已用完，请留意后续消费。" : reminderThresholdFen != null && remainingFen <= reminderThresholdFen ? `预算余额已到达提醒临界点，当前还剩 ${yuan(remainingFen)}。` : null;
  return <div className="banking-result-card">
    <b>{card.name}</b>
    <span>状态：{cardStatus(card.status)}</span>
    <span>月消费预算：{yuan(card.monthlyBudgetFen)}</span>
    <span>本月已消费：{yuan(card.monthlySpentFen)}</span>
    <span>预算提醒：{overBudgetFen > 0 ? `已超出 ${yuan(overBudgetFen)}（预算不会自动拦截消费）` : `尚余 ${yuan(Math.max(0, card.monthlyBudgetFen - card.monthlySpentFen))}`}</span>
    <span>线上支付：{card.onlinePaymentsEnabled === false ? "已关闭" : "已开启"}</span>
    <span>已禁止的消费类别：{card.blockedCategories?.length ? card.blockedCategories.join("、") : "无"}</span>
    <span>单笔消费提醒：{card.alertThresholdFen == null ? "未设置" : `${yuan(card.alertThresholdFen)} 及以上提醒`}</span>
    <span>预算余额提醒：{card.balanceReminderAmountFen != null ? `剩余 ${yuan(card.balanceReminderAmountFen)} 时提醒` : card.balanceReminderPercent != null ? `剩余预算的 ${card.balanceReminderPercent}% 时提醒` : "未设置（余额用完仍会提醒）"}</span>
    {balanceAlert && <strong role="alert">{balanceAlert}</strong>}
    {data?.action === "card.security_review" && <div className="banking-notice">
      <b>安全事件处理建议（不会自动操作卡片）</b>
      {Array.isArray(data.data?.guidance) && data.data.guidance.map((item: unknown, index: number) => <span key={index}>{index + 1}. {String(item)}</span>)}
      <small>{String(data.data?.product_capability_notice || "注销或更换虚拟卡号取决于发卡银行及具体产品规则。")}</small>
    </div>}
    <small>卡片版本 {card.version} · 数据来源：{String(data?.evidence?.[0]?.source || "未知")} · 截至 {String(data?.evidence?.[0]?.asOf || "未知")}</small>
  </div>;
}

type Effect = { kind: string; action: string; cardId: string; cardName: string; cardVersion: number; before: { status: string; monthlyBudgetFen: number; onlinePaymentsEnabled?: boolean; blockedCategories?: string[]; alertThresholdFen?: number | null; balanceReminderAmountFen?: number | null; balanceReminderPercent?: number | null }; after: { status: string; monthlyBudgetFen: number; onlinePaymentsEnabled?: boolean; blockedCategories?: string[]; alertThresholdFen?: number | null; balanceReminderAmountFen?: number | null; balanceReminderPercent?: number | null } };
export function BankingCardPreview({ data, active, busy, onConfirm, onReject, onCheck }: { data?: BankingAgentData; active: boolean; busy: boolean; onConfirm: (data: BankingAgentData) => void; onReject: (data: BankingAgentData) => void; onCheck: (data: BankingAgentData) => void }) {
  const preview = data?.preview;
  const effect = (preview?.exactEffects as Effect[] | undefined)?.[0];
  if (!data || !effect || !preview) return null;
  const trial = isTrialPreview(data);
  const operation = data.action === "card.set_budget" ? "设置月消费预算" : data.action === "card.set_controls" ? "修改交易权限与消费提醒" : data.action === "card.freeze" ? "冻结卡片" : "解冻卡片";
  const change = data.action === "card.set_budget" ? `${yuan(effect.before.monthlyBudgetFen)} → ${yuan(effect.after.monthlyBudgetFen)}` : data.action === "card.set_controls" ? `线上支付：${effect.after.onlinePaymentsEnabled ? "开启" : "关闭"}；禁用类别：${effect.after.blockedCategories?.length ? effect.after.blockedCategories.join("、") : "无"}；单笔提醒：${effect.after.alertThresholdFen == null ? "关闭" : yuan(effect.after.alertThresholdFen)}；余额提醒：${effect.after.balanceReminderAmountFen != null ? `剩余 ${yuan(effect.after.balanceReminderAmountFen)}` : effect.after.balanceReminderPercent != null ? `剩余 ${effect.after.balanceReminderPercent}%` : "关闭"}` : `${cardStatus(effect.before.status)} → ${cardStatus(effect.after.status)}`;
  return <div className="banking-preview-card card-action-preview">
    <div><b>卡片操作预览</b><span>{trial ? data.previewCurrent === false ? "旧预览 · 已替换" : "仅供预览 · 尚未执行" : data.coreStage && data.coreStage !== "plan" ? stageCopy[data.coreStage] : active ? "等待确认" : "已失效"}</span></div>
    <strong>{effect.cardName}</strong>
    <p>操作：{operation}</p>
    <p>变更前后：{change}</p>
    <small>卡片版本 {effect.cardVersion} · 风险等级 {String(data.risk?.riskLevel || "未知")} · 有效期至 {String(preview.expiresAt || "未知")}</small>
    {Array.isArray(preview.warnings) && preview.warnings.map((warning, index) => <small key={index}>{String(warning)}</small>)}
    <small>预览哈希：{String(preview.previewHash).slice(0, 16)}…</small>
    {trial ? <small>仅供预览，不支持确认或执行。可在聊天中改金额、换卡或取消。</small> : <>
      <button type="button" className="primary-button" onClick={() => onConfirm(data)} disabled={!active || busy}>{busy ? "处理中…" : "确认并执行"}</button>
      {active && <button type="button" className="secondary-button" onClick={() => onReject(data)} disabled={busy}>取消本次操作</button>}
      <button type="button" className="secondary-button" onClick={() => onCheck(data)} disabled={busy}>查询操作状态</button>
    </>}
  </div>;
}

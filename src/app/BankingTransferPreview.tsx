"use client";
import { useState } from "react";
import type { BankingAgentData } from "@/lib/banking-agent-client";
import { isTrialPreview } from "@/lib/trial-preview.mjs";

export function BankingTransferPreview({ data, active, busy, onEdit, onConfirm, onReject, onCheck }: {
  data?: BankingAgentData;
  active: boolean;
  busy: boolean;
  onEdit: (data: BankingAgentData, message: string) => void;
  onConfirm: (data: BankingAgentData) => void;
  onReject: (data: BankingAgentData) => void;
  onCheck: (data: BankingAgentData) => void;
}) {
  const [editing, setEditing] = useState<"amount" | "payee" | null>(null);
  const [value, setValue] = useState("");
  const effect = (data?.preview?.exactEffects as Array<Record<string, unknown>> | undefined)?.[0] || {};
  const trial = isTrialPreview(data);
  const executed = data?.executed === true;
  const disabled = !active || busy;
  return <div className="banking-preview-card">
    <div><b>正式转账预览</b><span>{executed ? "已完成 · 已扣款" : active ? trial ? "试点预览 · 待确认执行" : "等待用户核对" : "历史预览 · 已不可操作"}</span></div>
    <strong>¥{(Number(effect.amountFen || 0) / 100).toFixed(2)}</strong>
    <p>{String(data?.preview?.summary || "")}</p>
    <p>{String(effect.accountName || effect.fromAccountId || "付款账户")} → {String(effect.payeeName || effect.payeeId || "收款人")}</p>
    <p>{executed ? "本笔转账已完成扣款，回执见下方消息；该预览已结束，不能再确认或取消。" : trial ? "试点转账预览：点击“确认转账”后经安全执行桥扣款（模拟）；也可修改金额/收款人或取消。" : "点击“确认转账”后才会执行扣款；也可取消本次转账或查询状态。"}</p>
    {Array.isArray(data?.preview?.warnings) && (data.preview.warnings as unknown[]).map((warning, index) => <small key={index}>{String(warning)}</small>)}
    <small>预览有效期 {String(data?.preview?.expiresAt || "未知")} · 风险等级 {String(data?.risk?.riskLevel || effect.riskLevel || "未知")} · 操作编号 {data?.operationId}</small>
    {executed ? null : trial ? <div className="transfer-preview-actions">
      <button type="button" className="secondary-button" disabled={disabled} onClick={() => { setEditing("amount"); setValue(""); }}>修改金额</button>
      <button type="button" className="secondary-button" disabled={disabled} onClick={() => { setEditing("payee"); setValue(""); }}>修改收款人</button>
      <button type="button" className="text-button" disabled={disabled} onClick={() => data && onEdit(data, "取消")}>取消</button>
      <button type="button" className="primary-button" disabled={disabled} onClick={() => data && onConfirm(data)}>{busy ? "执行中…" : "确认转账"}</button>
    </div> : <div className="transfer-preview-actions">
      <button type="button" className="primary-button" disabled={disabled} onClick={() => data && onConfirm(data)}>{busy ? "执行中…" : "确认转账"}</button>
      {active && <button type="button" className="secondary-button" disabled={busy} onClick={() => data && onReject(data)}>取消本次转账</button>}
      <button type="button" className="secondary-button" disabled={busy} onClick={() => data && onCheck(data)}>查询转账状态</button>
    </div>}
    {!executed && trial && editing && active && <form className="transfer-preview-edit" onSubmit={event => {
      event.preventDefault();
      if (disabled || !data || !value.trim()) return;
      onEdit(data, editing === "amount" ? `改成转账${value.trim()}元` : `收款人改成${value.trim()}`);
      setEditing(null);
    }}>
      <label>{editing === "amount" ? "新金额（元）" : "新收款人"}<input autoFocus aria-label={editing === "amount" ? "新金额（元）" : "新收款人"} inputMode={editing === "amount" ? "decimal" : "text"} pattern={editing === "amount" ? "[0-9]+(\\.[0-9]{1,2})?" : undefined} maxLength={editing === "amount" ? 16 : 128} required disabled={disabled} value={value} onChange={event => setValue(event.target.value)} /></label>
      <button type="submit" className="secondary-button" disabled={disabled}>生成新预览</button>
      <button type="button" className="text-button" onClick={() => setEditing(null)}>放弃修改</button>
    </form>}
  </div>;
}

"use client";
import { useState } from "react";
import type { BankingAgentData } from "@/lib/banking-agent-client";
import { isTrialPreview } from "@/lib/trial-preview.mjs";

export function BankingTransferPreview({ data, active, busy, onEdit, onConfirm, onReject, onCheck, verification, otpError, onVerify, onCancelVerification }: {
  data?: BankingAgentData;
  active: boolean;
  busy: boolean;
  onEdit: (data: BankingAgentData, message: string) => void;
  onConfirm: (data: BankingAgentData) => void;
  onReject: (data: BankingAgentData) => void;
  onCheck: (data: BankingAgentData) => void;
  verification?: { operationId: string; challengeId: string; expiresAt: string } | null;
  otpError?: string | null;
  onVerify?: (data: BankingAgentData, code: string) => void;
  onCancelVerification?: () => void;
}) {
  const [editing, setEditing] = useState<"amount" | "payee" | null>(null);
  const [value, setValue] = useState("");
  const [code, setCode] = useState("");
  const effect = (data?.preview?.exactEffects as Array<Record<string, unknown>> | undefined)?.[0] || {};
  const trial = isTrialPreview(data);
  const executed = data?.executed === true;
  const showOtp = !!data?.operationId && verification?.operationId === data.operationId && !executed;
  const disabled = !active || busy;
  const payee = String(effect.payeeName || effect.payeeId || "");
  const yuan = Number(effect.amountFen || 0) / 100;
  const buildEditMessage = (kind: "amount" | "payee") => {
    const v = value.trim();
    if (trial) return kind === "amount" ? `改成转账${v}元` : `收款人改成${v}`;
    return kind === "amount"
      ? payee ? `给${payee}转${v}元` : `转账${v}元`
      : `给${v}转${yuan}元`;
  };
  return <div className="banking-preview-card">
    <div><b>正式转账预览</b><span>{executed ? "已完成 · 已扣款" : active ? trial ? "试点预览 · 待确认执行" : "等待用户核对" : "历史预览 · 已不可操作"}</span></div>
    <strong>¥{(Number(effect.amountFen || 0) / 100).toFixed(2)}</strong>
    <p>{String(data?.preview?.summary || "")}</p>
    <p>{String(effect.accountName || effect.fromAccountId || "付款账户")} → {String(effect.payeeName || effect.payeeId || "收款人")}</p>
    <p>{executed ? "本笔转账已完成扣款；该预览已结束，不能再确认或取消。" : trial ? "试点转账预览：点击“确认转账”后经安全执行桥扣款（模拟）；也可修改金额/收款人或取消。" : "点击“确认转账”后才会执行扣款；也可修改金额/收款人、取消本次转账或查询状态。"}</p>
    {Array.isArray(data?.preview?.warnings) && (data.preview.warnings as unknown[]).map((warning, index) => <small key={index}>{String(warning)}</small>)}
    <small>预览有效期 {String(data?.preview?.expiresAt || "未知")} · 风险等级 {String(data?.risk?.riskLevel || effect.riskLevel || "未知")} · 操作编号 {data?.operationId}</small>
    {executed ? null : showOtp ? <div className="transfer-preview-otp">
      <p>这是一笔高风险转账，需输入一次性验证码才能执行。验证码已通过受控测试渠道发出，不显示在聊天记录中。</p>
      <form className="transfer-preview-edit" onSubmit={event => {
        event.preventDefault();
        if (disabled || !data || !/^\d{6}$/.test(code)) return;
        onVerify?.(data, code);
      }}>
        <label>一次性验证码<input autoFocus aria-label="一次性验证码" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required disabled={disabled} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} /></label>
        <button type="submit" className="primary-button" disabled={disabled || !/^\d{6}$/.test(code)}>{busy ? "验证中…" : "验证并转账"}</button>
        <button type="button" className="text-button" disabled={busy} onClick={() => { setCode(""); onCancelVerification?.(); }}>取消验证</button>
      </form>
      {otpError && <p className="otp-error" role="alert">{otpError}</p>}
    </div> : <div className="transfer-preview-actions">
      <button type="button" className="secondary-button" disabled={disabled} onClick={() => { setEditing("amount"); setValue(""); }}>修改金额</button>
      <button type="button" className="secondary-button" disabled={disabled} onClick={() => { setEditing("payee"); setValue(""); }}>修改收款人</button>
      {trial
        ? <button type="button" className="text-button" disabled={disabled} onClick={() => data && onEdit(data, "取消")}>取消</button>
        : <>{active && <button type="button" className="secondary-button" disabled={busy} onClick={() => data && onReject(data)}>取消本次转账</button>}
          <button type="button" className="secondary-button" disabled={busy} onClick={() => data && onCheck(data)}>查询转账状态</button></>}
      <button type="button" className="primary-button" disabled={disabled} onClick={() => data && onConfirm(data)}>{busy ? "执行中…" : "确认转账"}</button>
    </div>}
    {!executed && editing && active && <form className="transfer-preview-edit" onSubmit={event => {
      event.preventDefault();
      if (disabled || !data || !value.trim()) return;
      onEdit(data, buildEditMessage(editing === "amount" ? "amount" : "payee"));
      setEditing(null);
    }}>
      <label>{editing === "amount" ? "新金额（元）" : "新收款人"}<input autoFocus aria-label={editing === "amount" ? "新金额（元）" : "新收款人"} inputMode={editing === "amount" ? "decimal" : "text"} pattern={editing === "amount" ? "[0-9]+(\\.[0-9]{1,2})?" : undefined} maxLength={editing === "amount" ? 16 : 128} required disabled={disabled} value={value} onChange={event => setValue(event.target.value)} /></label>
      <button type="submit" className="secondary-button" disabled={disabled}>生成新预览</button>
      <button type="button" className="text-button" onClick={() => setEditing(null)}>放弃修改</button>
    </form>}
  </div>;
}

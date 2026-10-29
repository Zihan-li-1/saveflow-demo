"use client";
import { useState } from "react";
import { stageCopy } from "@/lib/flow-machine";
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
  const internal = effect.kind === "transfer_internal";
  const trial = isTrialPreview(data);
  const executed = data?.executed === true;
  const showOtp = !!data?.operationId && verification?.operationId === data.operationId && !executed;
  const pending = data?.outcomePending === true || ["executing", "checking", "unknown"].includes(data?.coreStage || "");
  const disabled = !active || busy || pending;
  const yuan = Number(effect.amountFen || 0) / 100;
  const buildEditMessage = (kind: "amount" | "payee") => {
    const v = value.trim();
    if (trial) return kind === "amount" ? `改成转账${v}元` : `收款人改成${v}`;
    return kind === "amount"
      ? `金额改成${v}元`
      : internal ? `从${String(effect.accountName || effect.fromAccountId)}转${yuan}元到${v}` : `给${v}转${yuan}元`;
  };
  return <div className="banking-preview-card">
    <div><b>{pending ? "正在核实转账结果" : "正式转账预览"}</b><span>{pending ? "请先查询结果" : executed ? "已完成 · 已扣款" : data?.coreStage && data.coreStage !== "plan" ? stageCopy[data.coreStage] : active ? trial ? "试点预览 · 待确认执行" : "等待用户核对" : "历史预览 · 已不可操作"}</span></div>
    <strong>¥{(Number(effect.amountFen || 0) / 100).toFixed(2)}</strong>
    <p>{String(data?.preview?.summary || "")}</p>
    <p>{String(effect.accountName || effect.fromAccountId || "付款账户")} → {String(internal ? effect.targetAccountName || effect.toAccountId || "本人账户" : effect.payeeName || effect.payeeId || "收款人")}</p>
    {internal && <><p>转出账户余额：¥{(Number(effect.sourceBalanceBeforeFen || 0) / 100).toFixed(2)} → ¥{(Number(effect.sourceBalanceAfterFen || 0) / 100).toFixed(2)}</p><p>转入账户余额：¥{(Number(effect.targetBalanceBeforeFen || 0) / 100).toFixed(2)} → ¥{(Number(effect.targetBalanceAfterFen || 0) / 100).toFixed(2)}</p></>}
    <p>{pending ? "您的转账请求已收到，但我们暂时无法确认最终结果。为避免重复扣款，请先不要再次发起相同转账。" : executed ? "本笔转账已完成；该预览已结束，不能再确认或取消。" : trial ? "试点转账预览：点击“确认转账”后经安全执行桥扣款（模拟）；也可修改金额/收款人或取消。" : internal ? "核对转出与转入账户及两侧余额后，点击页面按钮确认；聊天中的“确认”不会执行。" : "点击“确认转账”后才会执行扣款；也可修改金额/收款人、取消本次转账或查询状态。"}</p>
    {Array.isArray(data?.preview?.warnings) && (data.preview.warnings as unknown[]).map((warning, index) => <small key={index}>{String(warning)}</small>)}
    <small>风险等级 {String(data?.risk?.riskLevel || effect.riskLevel || "未知")}</small>
    {pending ? <div className="transfer-preview-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => data && onCheck(data)}>{data?.coreStage === "checking" || busy ? "查询中…" : "查询转账结果"}</button><small>我们会根据原交易记录核实状态，无需重新填写转账信息。</small></div> : executed ? null : showOtp ? <div className="transfer-preview-otp">
      <p>这是一笔高风险转账，需输入一次性验证码才能执行。</p>
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
      <button type="button" className="secondary-button" disabled={disabled} onClick={() => { setEditing("payee"); setValue(""); }}>{internal ? "修改转入账户" : "修改收款人"}</button>
      {trial
        ? <button type="button" className="text-button" disabled={disabled} onClick={() => data && onEdit(data, "取消")}>取消</button>
        : <>{active && <button type="button" className="secondary-button" disabled={busy} onClick={() => data && onReject(data)}>取消本次转账</button>}
          </>}
      <button type="button" className="secondary-button" disabled={busy} onClick={() => data && onCheck(data)}>查询转账状态</button>
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

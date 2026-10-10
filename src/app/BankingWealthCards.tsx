"use client";

import type { BankingAgentData } from "@/lib/banking-agent-client";

export function BankingWealthResult({ data }: { data?: BankingAgentData }) {
  const result = data?.data;
  if (!result) return null;
  const kind = String(result.kind);
  const products = (kind === "recommendation" ? result.matches : kind === "comparison" ? result.products : []) as Array<{ name: string; risk_level: string; liquidity: string; expected_yield_bps: number }>;
  return <div className="banking-result-card">
    <b>{kind === "recommendation" ? "模拟产品筛选" : kind === "comparison" ? "模拟产品对比" : kind === "risk_assessment" ? "模拟风险测评" : "风险测评入口"}</b>
    {products?.map((product, index) => <span key={index}>{product.name} · {product.risk_level} · {product.liquidity} · 展示年化 {(product.expected_yield_bps / 100).toFixed(2)}%</span>)}
    {kind === "risk_assessment" && <span>测评等级：{String((result.assessment as { risk_level?: string } | undefined)?.risk_level || "未知")}</span>}
    {kind === "questionnaire_required" && <span>需先通过可信页面完成风险测评。</span>}
    <small>合成数据演示 · 展示收益不保证 · 截至 {String(result.as_of || "未知")}</small>
  </div>;
}

export function BankingWealthPreview({ data, active, busy, onConfirm, onReject, onCheck }: { data?: BankingAgentData; active: boolean; busy: boolean; onConfirm: (data: BankingAgentData) => void; onReject: (data: BankingAgentData) => void; onCheck: (data: BankingAgentData) => void }) {
  const preview = data?.preview;
  if (!data || !preview) return null;
  return <div className="banking-preview-card card-action-preview">
    <div><b>模拟理财操作预览</b><span>{active ? "等待单独确认" : "已失效"}</span></div>
    <strong>{data.action === "wealth.subscribe" ? "申购" : "赎回"}</strong>
    <p>{String(preview.summary || "")}</p>
    {data.disclosure && <small>{String(data.disclosure.risk_disclosure || "")}</small>}
    {Array.isArray(preview.warnings) && preview.warnings.map((warning, index) => <small key={index}>{String(warning)}</small>)}
    <small>风险等级 {String(data.risk?.riskLevel || "未知")} · 有效期至 {String(preview.expiresAt || "未知")}</small>
    <button type="button" className="primary-button" onClick={() => onConfirm(data)} disabled={!active || busy}>{busy ? "处理中…" : "确认并执行模拟操作"}</button>
    {active && <button type="button" className="secondary-button" onClick={() => onReject(data)} disabled={busy}>取消本次操作</button>}
    <button type="button" className="secondary-button" onClick={() => onCheck(data)} disabled={busy}>查询操作状态</button>
  </div>;
}

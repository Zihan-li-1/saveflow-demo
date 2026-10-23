"use client";

import { stageCopy } from "@/lib/flow-machine";
import type { BankingAgentData } from "@/lib/banking-agent-client";

const riskText = (level: string) => level === "R1" ? "较低风险，短期可能约亏 0%–2%" : level === "R2" ? "中等风险，阶段亏损可能约 2%–10%" : level === "R3" ? "较高风险，亏损可能超过 10%" : "风险情况待确认";
const liquidityText = (value: string) => value === "T+0" ? "通常当天可取" : value === "T+1" ? "通常下一个工作日可取" : value === "AT_MATURITY" ? "一般需持有到计划结束" : "取用时间待确认";
const ProductTerms = () => <div className="financial-term-help"><details><summary>风险等级 <span>点此了解</span></summary><p>它表示价格波动和亏损可能性。百分比仅用于帮助理解，不是实际产品的最大亏损承诺。</p></details><details><summary>流动性 <span>点此了解</span></summary><p>它表示需要用钱时，多久能把资金取出来；越快可取，使用越灵活。</p></details></div>;

export function BankingWealthResult({ data }: { data?: BankingAgentData }) {
  const result = data?.data;
  if (!result) return null;
  const kind = String(result.kind);
  const screening = result.screening_context as { target_date: string; investable_amount_minor: number; max_risk_level: string; liquidity_requirement: string; source: string } | undefined;
  const products = (kind === "recommendation" ? result.matches : kind === "comparison" ? result.products : []) as Array<{ name: string; risk_level: string; liquidity: string; expected_yield_bps: number; duration_days?: number }>;
  return <div className="banking-result-card">
    <b>{kind === "recommendation" ? "模拟产品筛选" : kind === "comparison" ? "模拟产品对比" : kind === "risk_assessment" ? "模拟风险测评" : "风险测评入口"}</b>
    {screening?.source === "verified_savings_plan" && <p>按已核验储蓄目标筛选：目标日 {screening.target_date}，独立可投资金额 ¥{(screening.investable_amount_minor / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}，所选风险上限 {screening.max_risk_level}（仍受测评结果约束），资金{liquidityText(screening.liquidity_requirement)}。</p>}
    {products?.map((product, index) => <span key={index}>{product.name} · {riskText(product.risk_level)} · {liquidityText(product.liquidity)} · 示例年化 {(product.expected_yield_bps / 100).toFixed(2)}%{product.duration_days ? ` · 建议持有约 ${Math.max(1, Math.round(product.duration_days / 30))} 个月` : ""}</span>)}
    {kind === "risk_assessment" && <span>测评结果：{riskText(String((result.assessment as { risk_level?: string } | undefined)?.risk_level || ""))}</span>}
    {kind === "questionnaire_required" && <span>需先通过可信页面完成风险测评。</span>}
    {products?.length > 0 && <ProductTerms />}
    <small>合成数据演示 · 展示收益不保证 · 截至 {String(result.as_of || "未知")}</small>
  </div>;
}

export function BankingWealthPreview({ data, active, busy, onConfirm, onReject, onCheck }: { data?: BankingAgentData; active: boolean; busy: boolean; onConfirm: (data: BankingAgentData) => void; onReject: (data: BankingAgentData) => void; onCheck: (data: BankingAgentData) => void }) {
  const preview = data?.preview;
  if (!data || !preview) return null;
  return <div className="banking-preview-card card-action-preview">
    <div><b>模拟理财操作预览</b><span>{data.coreStage && data.coreStage !== "plan" ? stageCopy[data.coreStage] : active ? "等待单独确认" : "已失效"}</span></div>
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

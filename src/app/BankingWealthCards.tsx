"use client";

import type { BankingAgentData } from "@/lib/banking-agent-client";
import type { ActionReceipt, WealthEffect } from "@/banking-core/contracts";

const money = (fen: number) => `¥${(fen / 100).toFixed(2)}`;
const riskText = (level: string) => level === "R1" ? "较低风险，短期可能约亏 0%–2%" : level === "R2" ? "中等风险，阶段亏损可能约 2%–10%" : level === "R3" ? "较高风险，亏损可能超过 10%" : "风险情况待确认";
const liquidityText = (value: string) => value === "T+0" ? "通常当天可取" : value === "T+1" ? "通常下一个工作日可取" : value === "AT_MATURITY" ? "一般需持有到计划结束" : "取用时间待确认";
const durationText = (days: number) => days === 0 ? "没有固定持有期" : days % 30 === 0 ? `约 ${days / 30} 个月` : `${days} 天`;
const reasonText: Record<string, string> = {
  RISK_TOO_HIGH: "风险等级高于当前测评或用户上限",
  LIQUIDITY_TOO_SLOW: "资金取用速度不满足要求",
  TERM_TOO_LONG: "产品期限超过计划持有时间",
  BELOW_MINIMUM_AMOUNT: "可投入金额低于最低金额",
  DISCLOSURE_UNAVAILABLE: "产品披露缺失或已过期",
  CAPITAL_NOT_GUARANTEED: "无法验证本金保障",
};
const ProductTerms = () => <div className="financial-term-help"><details><summary>风险等级 <span>点此了解</span></summary><p>它表示价格波动和亏损可能性。百分比仅用于帮助理解，不是实际产品的最大亏损承诺。</p></details><details><summary>流动性 <span>点此了解</span></summary><p>它表示需要用钱时，多久能把资金取出来；越快可取，使用越灵活。</p></details></div>;

export function BankingWealthResult({ data }: { data?: BankingAgentData }) {
  const result = data?.data;
  if (!result) return null;
  const kind = String(result.kind);
  const products = (kind === "recommendation" ? result.matches : kind === "comparison" ? result.products : []) as Array<{ product_id?: string; name: string; risk_level: string; liquidity: string; expected_yield_bps: number; minimum_amount?: { amount_minor?: number }; duration_days?: number }>;
  const excluded = (Array.isArray(result.excluded) ? result.excluded : []) as Array<{ product_id: string; product_name?: string; reason_codes?: string[] }>;
  const questionnaire = result.questionnaire as { route?: string; source?: string } | undefined;
  return <div className="banking-result-card">
    <b>{kind === "recommendation" ? "模拟产品筛选" : kind === "comparison" ? "模拟产品对比" : kind === "risk_assessment" ? "模拟风险测评" : "风险测评入口"}</b>
    {products?.map((product, index) => <article key={product.product_id || index}>
      <h3>{product.name}</h3>
      <div className="financial-data-grid">
        <p><span>可能的波动</span><strong>{riskText(product.risk_level)}</strong></p>
        <p><span>示例年化收益率</span><strong>{(product.expected_yield_bps / 100).toFixed(2)}%</strong></p>
        <p><span>最低金额</span><strong>{money(product.minimum_amount?.amount_minor ?? 0)}</strong></p>
        <p><span>最快何时可取</span><strong>{liquidityText(product.liquidity)}</strong></p>
        <p><span>建议持有时间</span><strong>{durationText(product.duration_days ?? 0)}</strong></p>
      </div>
    </article>)}
    {kind === "recommendation" && excluded.length > 0 && <details><summary>查看未入选产品及原因（{excluded.length}）</summary>{excluded.map(item => <p key={item.product_id}><strong>{item.product_name || item.product_id}</strong>：{(item.reason_codes || []).map(code => reasonText[code] || code).join("；")}</p>)}</details>}
    {kind === "risk_assessment" && <span>测评结果：{riskText(String((result.assessment as { risk_level?: string } | undefined)?.risk_level || ""))}</span>}
    {kind === "questionnaire_required" && <><span>需由用户本人在可信页面完成风险测评，模型不能代答。</span>{questionnaire?.route && <a className="primary-button" href={questionnaire.route}>打开风险测评</a>}</>}
    {products?.length > 0 && <ProductTerms />}
    {typeof result.disclaimer === "string" && <small>{result.disclaimer}</small>}
    <small>合成数据演示 · 展示收益不保证 · 截至 {String(result.as_of || "未知")}</small>
  </div>;
}

export function BankingWealthPreview({ data, active, busy, onConfirm, onReject, onCheck }: { data?: BankingAgentData; active: boolean; busy: boolean; onConfirm: (data: BankingAgentData) => void; onReject: (data: BankingAgentData) => void; onCheck: (data: BankingAgentData) => void }) {
  const preview = data?.preview;
  if (!data || !preview) return null;
  const effect = (preview.exactEffects as WealthEffect[] | undefined)?.[0];
  return <div className="banking-preview-card card-action-preview">
    <div><b>模拟理财操作预览</b><span>{active ? "等待单独确认" : "已失效"}</span></div>
    <strong>{data.action === "wealth.subscribe" ? "申购" : "赎回"}</strong>
    <p>{String(preview.summary || "")}</p>
    {effect && <div className="financial-data-grid">
      <p><span>产品</span><strong>{effect.productName}</strong></p>
      <p><span>本次金额</span><strong>{money(effect.amountFen)}</strong></p>
      <p><span>持仓变化</span><strong>{money(effect.holdingAmountBeforeFen)} → {money(effect.holdingAmountAfterFen)}</strong></p>
      {effect.action === "wealth.subscribe" && <p><span>可用余额变化</span><strong>{money(effect.accountBalanceBeforeFen ?? 0)} → {money(effect.accountBalanceAfterFen ?? 0)}</strong></p>}
      {effect.action === "wealth.redeem" && <p><span>预计到账</span><strong>{liquidityText(effect.settlement || "")}</strong></p>}
    </div>}
    {data.disclosure && <small><strong>产品风险披露：</strong>{String(data.disclosure.risk_disclosure || "")}</small>}
    {Array.isArray(preview.warnings) && preview.warnings.map((warning, index) => <small key={index}>{String(warning)}</small>)}
    <small>操作风险等级 {String(data.risk?.riskLevel || "未知")} · 一次确认仅授权本次操作 · 有效期至 {String(preview.expiresAt || "未知")}</small>
    <button type="button" className="primary-button" onClick={() => onConfirm(data)} disabled={!active || busy}>{busy ? "处理中…" : "确认并执行模拟操作"}</button>
    {active && <button type="button" className="secondary-button" onClick={() => onReject(data)} disabled={busy}>取消本次操作</button>}
    <button type="button" className="secondary-button" onClick={() => onCheck(data)} disabled={busy}>查询操作状态</button>
  </div>;
}

export function BankingWealthReceipt({ receipt }: { receipt?: ActionReceipt }) {
  const effect = receipt?.effects?.[0] as WealthEffect | undefined;
  if (!receipt || !effect || effect.kind !== "wealth_change") return null;
  return <section className="financial-read-card" aria-label="模拟理财操作结果">
    <header><b>{effect.action === "wealth.subscribe" ? "模拟申购完成" : "模拟赎回完成"}</b><span>回执已核验</span></header>
    <p className="financial-source">操作编号 {receipt.operationId} · {receipt.executedAt}</p>
    <article><h3>{effect.productName}</h3><div className="financial-data-grid">
      <p><span>本次金额</span><strong>{money(effect.amountFen)}</strong></p>
      <p><span>持仓变化</span><strong>{money(effect.holdingAmountBeforeFen)} → {money(effect.holdingAmountAfterFen)}</strong></p>
      {effect.action === "wealth.subscribe" && <p><span>可用余额变化</span><strong>{money(effect.accountBalanceBeforeFen ?? 0)} → {money(effect.accountBalanceAfterFen ?? 0)}</strong></p>}
      {effect.action === "wealth.redeem" && <p><span>到账安排</span><strong>{liquidityText(effect.settlement || "")}</strong></p>}
    </div></article>
    <footer>合成数据演示；本回执只证明本次模拟操作结果，不代表真实投资交易。</footer>
  </section>;
}

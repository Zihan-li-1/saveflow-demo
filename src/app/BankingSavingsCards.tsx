"use client";

import { useState, type FormEvent } from "react";
import type { BankingAgentData, SavingsPlanInputs, WealthScreeningInputs } from "@/lib/banking-agent-client";
import "./banking-trial-cards.css";

const amount = (minor: number) => `¥${(minor / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const evidenceLabel = (ref: string, month: string, recentSource: string) => ref.startsWith("recent:") ? `${recentSource === "repository" ? "演示账单" : "你填写的"} ${month}` : `历史演示数据 ${ref.split(":")[1]}`;
function toMinor(value: string) {
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [yuan, cents = ""] = value.trim().split(".");
  return Number(yuan) * 100 + Number(cents.padEnd(2, "0"));
}

export function BankingSavingsInputsCard({ data, active = true, onSubmit }: { data?: BankingAgentData; active?: boolean; onSubmit: (data: BankingAgentData, inputs: SavingsPlanInputs) => void }) {
  const [saved, setSaved] = useState("");
  const [income, setIncome] = useState("");
  const [expenses, setExpenses] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  if (data?.status !== "needs_plan_inputs" || !data.continuationToken || !data.requiredMonth || !data.categories?.length) return null;
  const repositoryRecent = data.recentSource === "repository" ? data.recent : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const savedMinor = toMinor(saved);
    if (savedMinor === null) { setError("请填写本目标已存金额，金额最多两位小数。"); return; }
    if (repositoryRecent) {
      setError("");
      onSubmit(data, { saved_amount_minor: savedMinor });
      return;
    }
    const incomeMinor = toMinor(income);
    const categoryExpenses: Record<string, number> = {};
    for (const category of data.categories!) {
      const value = toMinor(expenses[category] ?? "");
      if (value === null) { setError(`请填写${category}的金额，未支出请填 0。`); return; }
      categoryExpenses[category] = value;
    }
    if (incomeMinor === null) { setError("请填写最近月收入，金额最多两位小数。"); return; }
    setError("");
    onSubmit(data, { month: data.requiredMonth!, saved_amount_minor: savedMinor, income_minor: incomeMinor, category_expenses_minor: categoryExpenses });
  };
  return <form className="financial-read-card savings-input-card" onSubmit={submit} aria-label="补充储蓄计划数据">
    <header><b>{repositoryRecent ? "确认目标进度" : "补充近期收支"}</b><span>确认后才生成计划</span></header>
    <p>目标 {data.goal ? amount(data.goal.target_amount_minor) : "待确认"}，截止 {data.goal?.deadline || "待确认"}。本目标已存金额与账户总余额可能不同，需要由你填写。</p>
    {repositoryRecent ? <article><h3>演示账单已覆盖最近完整月 {repositoryRecent.month}</h3><p>月收入 {amount(repositoryRecent.income_minor)}。分类支出来自同一演示数据快照，不与手工输入混用。</p><div className="savings-category-list">{data.categories.map(category => <div key={category}><b>{category}</b><span>{amount(repositoryRecent.category_expenses_minor[category] ?? 0)}</span></div>)}</div></article> : <p>请按最近完整月 <strong>{data.requiredMonth}</strong> 填写。以下数字来自你填写，系统只能核对计算，无法证明账单真实。</p>}
    <div className="savings-input-grid"><label>本目标已存金额（元）<input required inputMode="decimal" value={saved} onChange={event => setSaved(event.target.value)} placeholder="未存请填 0" /></label>{!repositoryRecent && <label>月收入（元）<input required inputMode="decimal" value={income} onChange={event => setIncome(event.target.value)} /></label>}</div>
    {!repositoryRecent && <fieldset><legend>按消费类别填写 {data.requiredMonth} 支出（元）</legend><div className="savings-input-grid">{data.categories.map(category => <label key={category}>{category}<input required inputMode="decimal" value={expenses[category] ?? ""} onChange={event => setExpenses(current => ({ ...current, [category]: event.target.value }))} placeholder="未支出请填 0" /></label>)}</div></fieldset>}
    {error && <p role="alert">{error}</p>}
    <button type="submit" className="primary-button" disabled={!active}>核算并生成储蓄计划</button>
    {!active && <p>这份补充请求已失效，请重新描述储蓄目标。</p>}
  </form>;
}

function WealthScreeningForm({ data, deadline, onWealth }: { data: BankingAgentData; deadline: string; onWealth: (data: BankingAgentData, inputs: WealthScreeningInputs) => void }) {
  const [investable, setInvestable] = useState("");
  const [risk, setRisk] = useState("");
  const [liquidity, setLiquidity] = useState("");
  const [wealthError, setWealthError] = useState("");
  const submitWealth = (event: FormEvent) => {
    event.preventDefault();
    const amountMinor = toMinor(investable);
    if (amountMinor === null || amountMinor < 1 || amountMinor > 1_000_000_000) { setWealthError("请填写独立可投资金额，最多 1,000 万元。"); return; }
    if (!["R1", "R2", "R3"].includes(risk) || !["T+0", "T+1", "AT_MATURITY"].includes(liquidity)) { setWealthError("请选择风险上限和资金取用要求。"); return; }
    setWealthError("");
    onWealth(data, { investable_amount_minor: amountMinor, max_risk_level: risk as WealthScreeningInputs["max_risk_level"], liquidity_requirement: liquidity as WealthScreeningInputs["liquidity_requirement"] });
  };
  return <form onSubmit={submitWealth} aria-label="储蓄目标理财筛选条件"><p>目标日 {deadline} 已从这份计划带入。请填写与目标储蓄、应急资金分开的可投资金额；不会自动申购。</p><div className="savings-input-grid"><label>独立可投资金额（元）<input required name="investable_amount" inputMode="decimal" value={investable} onChange={event => setInvestable(event.target.value)} placeholder="不要填必须存下的钱" /></label><label>风险上限<select required value={risk} onChange={event => setRisk(event.target.value)}><option value="">请选择</option><option value="R1">R1 · 较低风险</option><option value="R2">R2 · 中等风险</option><option value="R3">R3 · 较高风险</option></select></label><label>资金取用要求<select required value={liquidity} onChange={event => setLiquidity(event.target.value)}><option value="">请选择</option><option value="T+0">当天可取</option><option value="T+1">下一个工作日可取</option><option value="AT_MATURITY">可持有到目标日</option></select></label></div><small>最终风险上限还会受到可信风险测评结果约束；展示收益不保证。</small>{wealthError && <p role="alert">{wealthError}</p>}<button type="submit" className="secondary-button">只读筛选产品</button></form>;
}

export function BankingWealthInputsCard({ data, onWealth }: { data?: BankingAgentData; onWealth?: (data: BankingAgentData, inputs: WealthScreeningInputs) => void }) {
  if (data?.status !== 'needs_wealth_inputs' || typeof data.data?.target_date !== 'string' || !onWealth) return null;
  return <section className="financial-read-card savings-input-card"><header><b>继续理财条件筛选</b><span>只读 · 不申购</span></header><WealthScreeningForm data={data} deadline={data.data.target_date} onWealth={onWealth} /></section>;
}

export function BankingSavingsPlanCard({ data, onWealth }: { data?: BankingAgentData; onWealth?: (data: BankingAgentData, inputs: WealthScreeningInputs) => void }) {
  if (data?.status !== "goal_plan" || data.data?.verification_status !== "verified") return null;
  const details = data.data;
  const calc = details.calculation as { target_amount_minor: number; saved_amount_minor: number; remaining_minor: number; deadline: string; opportunity_dates: string[]; required_monthly_minor: number; observed_income_minor: number; observed_expense_minor: number; observed_surplus_minor: number; monthly_gap_minor: number };
  const advice = details.advice as { feasible: boolean; proposed_expense_minor: number; remaining_gap_minor: number; observations: Array<{ category: string; trend: "up" | "down" | "flat"; reason: string; evidence_refs: string[]; uncertain: boolean }>; category_budgets: Array<{ category: string; suggested_minor: number; reason: string; evidence_refs: string[] }> ; caveats: string[] };
  const recent = details.recent as { month: string; category_expenses_minor: Record<string, number> } | undefined;
  if (!calc || !advice || !recent) return null;
  return <section className="financial-read-card savings-plan-card" aria-label="储蓄计划卡片">
    <header><b>储蓄计划草案</b><span>已完成算术与证据复核 · 只读</span></header>
    <p className="financial-source">按{details.recent_source === "repository" ? "演示账单" : "用户填写的"} {recent.month} 收支测算；更早的历史 Mock 仅作对比。目标已存金额由你提供，未与真实账户核对。</p>
    <div className="savings-metrics"><p><span>目标金额</span><strong>{amount(calc.target_amount_minor)}</strong></p><p><span>本目标已存</span><strong>{amount(calc.saved_amount_minor)}</strong></p><p><span>还差</span><strong>{amount(calc.remaining_minor)}</strong></p><p><span>截止日期</span><strong>{calc.deadline}</strong></p></div>
    <article><h3>{calc.remaining_minor === 0 ? "目标已达成" : "每月需要存多少"}</h3><p>{calc.remaining_minor === 0 ? "按你填写的本目标已存金额，目前无需继续为此目标存款。" : `从下一个完整月起，共 ${calc.opportunity_dates.length} 次月初机会（${calc.opportunity_dates[0]} 至 ${calc.opportunity_dates.at(-1)}）。每次至少存 ${amount(calc.required_monthly_minor)}。`}</p><div className="savings-metrics"><p><span>最近月收入</span><strong>{amount(calc.observed_income_minor)}</strong></p><p><span>最近月支出</span><strong>{amount(calc.observed_expense_minor)}</strong></p><p><span>最近月结余</span><strong>{amount(calc.observed_surplus_minor)}</strong></p><p><span>按原消费水平的月缺口</span><strong>{amount(calc.monthly_gap_minor)}</strong></p></div></article>
    {advice.observations.length > 0 && <article><h3>消费习惯观察</h3><div className="savings-category-list">{advice.observations.map(item => <div key={item.category}><b>{item.category}：{item.trend === "up" ? "高于历史" : item.trend === "down" ? "低于历史" : "与历史接近"}</b><span>{item.reason}</span><small>依据：{item.evidence_refs.map(ref => evidenceLabel(ref, recent.month, String(details.recent_source))).join("、")}；样本有限</small></div>)}</div></article>}
    <article><h3>分类消费建议</h3><div className="savings-category-list">{advice.category_budgets.map(item => <div key={item.category}><b>{item.category}</b><span>最近月 {amount(recent.category_expenses_minor[item.category] ?? 0)} → 建议上限 {amount(item.suggested_minor)}</span><small>{item.reason}</small><small>类别依据：{item.evidence_refs.map(ref => evidenceLabel(ref, recent.month, String(details.recent_source))).join("、")}；建议能否执行需你确认。</small></div>)}</div></article>
    <article><h3>{advice.feasible ? "按建议金额可覆盖目标" : "建议后仍有资金缺口"}</h3><div className="savings-metrics"><p><span>分类建议支出合计</span><strong>{amount(advice.proposed_expense_minor)}</strong></p><p><span>最近月收入</span><strong>{amount(calc.observed_income_minor)}</strong></p><p><span>每月目标储蓄</span><strong>{amount(calc.required_monthly_minor)}</strong></p><p><span>建议后月缺口</span><strong>{amount(advice.remaining_gap_minor)}</strong></p></div><p>{advice.feasible ? "分类建议与最近月收入在算术上匹配；未来收入和支出仍可能变化。" : `按分类建议，仍差 ${amount(advice.remaining_gap_minor)}/月。可延长期限、增加收入或调整可变消费；不要假设已自动取消订阅。`}</p>{advice.caveats.map((item, index) => <small key={index}>{item}</small>)}</article>
    <footer>仅作模拟规划，未创建储蓄任务、转账或理财申购。{onWealth && data.wealthHandoffToken && <details><summary>单独查看只读理财筛选</summary><WealthScreeningForm data={data} deadline={calc.deadline} onWealth={onWealth} /></details>}</footer>
  </section>;
}


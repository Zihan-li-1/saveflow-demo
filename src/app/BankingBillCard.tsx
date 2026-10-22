import { ArrowDownLeft, ArrowUpRight, CalendarDays, ReceiptText, ShieldCheck } from "lucide-react";
import type { BankingAgentData } from "@/lib/banking-agent-client";
import { billCategories, billFen, billMonthLabel, billMonthlyBreakdown, formatBillAsOf, formatBillDateRange, formatBillMoney, formatBillPeriod, formatCompactBillMoney, shouldShowMonthlyBillChart } from "@/lib/bill-display";
import "./banking-bill-card.css";

export function BankingBillCard({ data }: { data?: BankingAgentData }) {
  const summary = data?.data ?? {};
  const income = billFen(summary.totalIncomeFen);
  const expense = billFen(summary.totalExpenseFen);
  const balance = income !== undefined && expense !== undefined ? income - expense : undefined;
  const count = billFen(summary.transactionCount);
  const categories = billCategories(summary.categoryTotals, expense);
  const monthly = billMonthlyBreakdown(summary.monthlyBreakdown);
  const showMonthlyChart = shouldShowMonthlyBillChart(summary.period, monthly.length);
  const visibleMonths = monthly.filter(item => item.status !== "future");
  const completedMonths = monthly.filter(item => item.status === "complete");
  const maximumMonthlyExpense = Math.max(1, ...visibleMonths.map(item => item.totalExpenseFen));
  const periodLabel = formatBillPeriod(summary.month, summary.period);
  const exactPeriod = formatBillDateRange(summary.period);
  const isRange = !!summary.period;
  const spansYears = new Set(monthly.map(item => item.month.slice(0, 4))).size > 1;
  const highestMonth = completedMonths.reduce<(typeof completedMonths)[number] | undefined>((highest, item) => !highest || item.totalExpenseFen > highest.totalExpenseFen ? item : highest, undefined);
  const averageExpense = completedMonths.length ? Math.round(completedMonths.reduce((total, item) => total + item.totalExpenseFen, 0) / completedMonths.length) : undefined;
  const latest = completedMonths.at(-1); const previous = completedMonths.at(-2);
  const change = latest && previous ? latest.totalExpenseFen - previous.totalExpenseFen : undefined;
  const trend = change === undefined ? undefined : change === 0 ? "与上月持平" : `较上月${change > 0 ? "增加" : "减少"}${formatBillMoney(Math.abs(change))}${previous && previous.totalExpenseFen > 0 ? `（${Math.round((Math.abs(change) / previous.totalExpenseFen) * 100)}%）` : ""}`;
  const categoryChanges = latest && previous ? [...new Set([...Object.keys(latest.categoryTotals), ...Object.keys(previous.categoryTotals)])]
    .map(name => ({ name, changeFen: (latest.categoryTotals[name] ?? 0) - (previous.categoryTotals[name] ?? 0) }))
    .filter(item => item.changeFen !== 0)
    .sort((a, b) => Math.abs(b.changeFen) - Math.abs(a.changeFen)).slice(0, 3) : [];
  const evidence = data?.evidence?.[0];
  const coverage = summary.coverage as { warning?: string } | undefined;
  const source = evidence?.source === "synthetic_demo_only" ? "模拟演示数据" : typeof evidence?.source === "string" && evidence.source ? evidence.source : "来源未知";
  const balanceTone = balance === undefined || balance === 0 ? "neutral" : balance > 0 ? "positive" : "negative";

  return <section className="banking-result-card bill-report" aria-label={`${periodLabel}收支概览`}>
    <header className="bill-report-header">
      <div className="bill-report-heading"><span className="bill-report-icon"><CalendarDays size={19} aria-hidden="true" /></span><div><span className="bill-report-month">{periodLabel}</span><h3>{isRange ? "期间收支概览" : "月度收支概览"}</h3>{exactPeriod && <p className="bill-report-period-exact">{exactPeriod}</p>}</div></div>
      <span className="bill-report-badge">账单报告</span>
    </header>
    {coverage?.warning && <p className="bill-report-empty">{coverage.warning}</p>}
    <div className="bill-report-hero"><span>{isRange ? "期间总支出" : "本月总支出"}</span><strong>{formatBillMoney(expense)}</strong></div>
    <dl className="bill-report-metrics">
      <div className="bill-report-metric income"><dt><ArrowDownLeft size={17} aria-hidden="true" /> {isRange ? "期间收入" : "本月收入"}</dt><dd>{formatBillMoney(income)}</dd></div>
      <div className="bill-report-metric expense"><dt><ArrowUpRight size={17} aria-hidden="true" /> {isRange ? "期间支出" : "本月支出"}</dt><dd>{formatBillMoney(expense)}</dd></div>
    </dl>
    <div className="bill-report-summary">
      <div className="bill-report-balance"><span>收支结余</span><strong className={balanceTone}>{formatBillMoney(balance, true)}</strong><p>收入 − 支出 · 不是账户可用余额</p></div>
      <div className="bill-report-count"><span><ReceiptText size={15} aria-hidden="true" /> 总交易笔数</span><strong>{count === undefined ? "—" : new Intl.NumberFormat("zh-CN").format(count)}{count !== undefined && <span> 笔</span>}</strong></div>
    </div>
    {count === 0 && <p className="bill-report-empty">{monthly.length > 0 && visibleMonths.length === 0 ? "所选时间尚未到来" : isRange ? "所选期间暂无交易记录" : "本月暂无交易记录"}</p>}
    {showMonthlyChart && <div className="bill-report-chart"><h4>每月支出对比<span>柱形高度以支出最高月份为基准</span></h4>{highestMonth && averageExpense !== undefined && <p className="bill-report-chart-summary">最高：{billMonthLabel(highestMonth.month, spansYears)} {formatBillMoney(highestMonth.totalExpenseFen)} · 月均：{formatBillMoney(averageExpense)}{trend ? ` · ${trend}` : ""}</p>}<ul aria-label="每月支出条形图">{monthly.map(item => {
      const height = item.totalExpenseFen === 0 ? 3 : Math.max(8, Math.round((item.totalExpenseFen / maximumMonthlyExpense) * 100));
      const monthLabel = billMonthLabel(item.month, spansYears);
      const unavailable = item.status === "unavailable";
      const amountLabel = unavailable ? "缺数据" : item.status === "future" ? "未到" : formatCompactBillMoney(item.totalExpenseFen);
      return <li key={item.month} className={item.status} aria-label={`${monthLabel}${unavailable ? "数据覆盖不足" : item.status === "future" ? "尚未到来" : `支出${formatBillMoney(item.totalExpenseFen)}${item.status === "partial" ? "，数据未完结" : ""}`}`}><strong title={unavailable || item.status === "future" ? undefined : formatBillMoney(item.totalExpenseFen)}>{amountLabel}</strong><div className="bill-report-bar-track"><span style={{ height: unavailable || item.status === "future" ? "0" : `${height}%` }} /></div><span>{monthLabel}{item.status === "partial" && <small>截至目前</small>}</span></li>;
    })}</ul></div>}
    {latest && previous && categoryChanges.length > 0 && <div className="bill-report-drivers"><h4>主要变化<span>{billMonthLabel(latest.month, spansYears)}较{billMonthLabel(previous.month, spansYears)}</span></h4><ul>{categoryChanges.map(item => <li key={item.name}><span>{item.name}</span><strong className={item.changeFen > 0 ? "up" : "down"}>{item.changeFen > 0 ? "增加" : "减少"} {formatBillMoney(Math.abs(item.changeFen))}</strong></li>)}</ul><p>仅比较最近两个完整月份；不包含未完结或未来月份。</p></div>}
    {categories.length > 0 && expense !== undefined && <div className="bill-report-categories"><h4>消费分类<span>按支出金额排序</span></h4><ul>{categories.map(category => { const percentage = expense > 0 ? (category.amountFen / expense) * 100 : 0; return <li key={category.name}><div><span>{category.name}</span><span>{percentage.toFixed(1)}%</span></div><strong>{formatBillMoney(category.amountFen)}</strong><div className="bill-report-category-track" aria-hidden="true"><span style={{ width: `${percentage}%` }} /></div></li>; })}</ul></div>}
    <footer className="bill-report-footer"><div><ShieldCheck size={14} aria-hidden="true" /><span>数据来源：{source}</span></div><span>统计截至：{formatBillAsOf(evidence?.asOf)}</span></footer>
  </section>;
}

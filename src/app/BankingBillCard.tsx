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
  const insights = summary.insights && typeof summary.insights === "object" && !Array.isArray(summary.insights) ? summary.insights as Record<string, unknown> : undefined;
  const insightChange = typeof insights?.changeFen === "number" && Number.isSafeInteger(insights.changeFen) ? insights.changeFen : undefined;
  const insightRate = typeof insights?.changeRateBps === "number" && Number.isSafeInteger(insights.changeRateBps) ? insights.changeRateBps : undefined;
  const comparisonAvailable = insights?.comparisonAvailable === true;
  const comparisonPeriod = insights?.comparisonPeriod && typeof insights.comparisonPeriod === "object" && !Array.isArray(insights.comparisonPeriod) ? insights.comparisonPeriod as Record<string, unknown> : undefined;
  const comparisonMonth = typeof comparisonPeriod?.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(comparisonPeriod.month) ? comparisonPeriod.month : undefined;
  const insightCategories = Array.isArray(insights?.categoryChanges) ? insights.categoryChanges.filter(item => item && typeof item === "object" && !Array.isArray(item)).slice(0, 3) as Array<Record<string, unknown>> : [];
  const monthly = billMonthlyBreakdown(summary.monthlyBreakdown);
  const showMonthlyChart = shouldShowMonthlyBillChart(summary.period, monthly.length);
  const visibleMonths = monthly.filter(item => item.status !== "future" && item.status !== "unavailable");
  const completedMonths = monthly.filter(item => item.status === "complete");
  const maximumMonthlyExpense = Math.max(1, ...visibleMonths.map(item => item.totalExpenseFen));
  const periodLabel = formatBillPeriod(summary.month, summary.period);
  const exactPeriod = formatBillDateRange(summary.period);
  const isRange = !!summary.period;
  const spansYears = new Set(monthly.map(item => item.month.slice(0, 4))).size > 1;
  const insightScope = comparisonMonth ? `${isRange ? "最近完整月份" : periodLabel}与${formatBillPeriod(comparisonMonth, undefined)}比较` : "与紧邻的上一时间段比较";
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
  const coverage = summary.coverage as { warning?: string; availableMonths?: string[] } | undefined;
  const missingMonths = monthly.filter(item => item.status === "unavailable");
  const missingSingleMonth = typeof summary.month === "string" && Array.isArray(coverage?.availableMonths) && !coverage.availableMonths.includes(summary.month);
  const noAvailableData = count === 0 && (missingSingleMonth || (monthly.length > 0 && missingMonths.length === monthly.length));
  const source = evidence?.source === "synthetic_demo_only" ? "模拟演示数据" : typeof evidence?.source === "string" && evidence.source ? evidence.source : "来源未知";
  const balanceTone = balance === undefined || balance === 0 ? "neutral" : balance > 0 ? "positive" : "negative";

  return <section className="banking-result-card bill-report" aria-label={`${periodLabel}收支概览`}>
    <header className="bill-report-header">
      <div className="bill-report-heading"><span className="bill-report-icon"><CalendarDays size={19} aria-hidden="true" /></span><div><span className="bill-report-month">{periodLabel}</span><h3>{isRange ? "期间收支概览" : "月度收支概览"}</h3>{exactPeriod && <p className="bill-report-period-exact">{exactPeriod}</p>}</div></div>
      <span className="bill-report-badge">账单报告</span>
    </header>
    {coverage?.warning && <p className="bill-report-empty">{coverage.warning}</p>}
    {noAvailableData && <p className="bill-report-empty">所选时间没有可用账单数据，不能视为零消费。</p>}
    {!showMonthlyChart && missingMonths.length > 0 && <p className="bill-report-empty">缺数据：{missingMonths.map(item => billMonthLabel(item.month, spansYears)).join("、")}</p>}
    {missingSingleMonth && <p className="bill-report-empty">本月缺数据</p>}
    <div className="bill-report-hero"><span>{isRange ? "期间总支出" : "本月总支出"}</span><strong>{formatBillMoney(noAvailableData ? undefined : expense)}</strong></div>
    <dl className="bill-report-metrics">
      <div className="bill-report-metric income"><dt><ArrowDownLeft size={17} aria-hidden="true" /> {isRange ? "期间收入" : "本月收入"}</dt><dd>{formatBillMoney(noAvailableData ? undefined : income)}</dd></div>
      <div className="bill-report-metric expense"><dt><ArrowUpRight size={17} aria-hidden="true" /> {isRange ? "期间支出" : "本月支出"}</dt><dd>{formatBillMoney(noAvailableData ? undefined : expense)}</dd></div>
    </dl>
    <div className="bill-report-summary">
      <div className="bill-report-balance"><span>收支结余</span><strong className={balanceTone}>{formatBillMoney(noAvailableData ? undefined : balance, true)}</strong><p>收入 − 支出 · 不是账户可用余额</p></div>
      <div className="bill-report-count"><span><ReceiptText size={15} aria-hidden="true" /> 总交易笔数</span><strong>{noAvailableData || count === undefined ? "—" : new Intl.NumberFormat("zh-CN").format(count)}{!noAvailableData && count !== undefined && <span> 笔</span>}</strong></div>
    </div>
    {count === 0 && !noAvailableData && <p className="bill-report-empty">{monthly.length > 0 && monthly.every(item => item.status === "future") ? "所选时间尚未到来" : isRange ? "所选期间暂无交易记录" : "本月暂无交易记录"}</p>}
    {insights && <div className="bill-report-insights"><h4>支出变化解读<span>{insightScope}</span></h4>{comparisonAvailable && insightChange !== undefined ? <><p className={insightChange > 0 ? "up" : insightChange < 0 ? "down" : "neutral"}>支出{insightChange > 0 ? "增加" : insightChange < 0 ? "减少" : "持平"} {formatBillMoney(Math.abs(insightChange))}{insightRate !== undefined ? `（${insightRate > 0 ? "+" : ""}${(insightRate / 100).toFixed(1)}%）` : ""}</p>{insightCategories.length > 0 && <ul>{insightCategories.map(item => <li key={String(item.category)}><span>{String(item.category)}</span><strong className={Number(item.changeFen) > 0 ? "up" : "down"}>{Number(item.changeFen) > 0 ? "+" : "−"}{formatBillMoney(Math.abs(Number(item.changeFen)))}</strong></li>)}</ul>}</> : <p className="neutral">{comparisonMonth ? `${formatBillPeriod(comparisonMonth, undefined)}暂无可用记录，暂不判断涨跌。` : "上一时间段暂无可用记录，暂不判断涨跌。"}</p>}<small>{typeof insights.note === "string" ? insights.note : "仅统计支出交易。"}</small></div>}
    {showMonthlyChart && <div className="bill-report-chart"><h4>每月支出对比<span>柱形高度以支出最高月份为基准</span></h4>{highestMonth && averageExpense !== undefined && <p className="bill-report-chart-summary">最高：{billMonthLabel(highestMonth.month, spansYears)} {formatBillMoney(highestMonth.totalExpenseFen)} · 月均：{formatBillMoney(averageExpense)}{trend ? ` · ${trend}` : ""}</p>}<ul aria-label="每月支出条形图">{monthly.map(item => {
      const height = item.totalExpenseFen === 0 ? 3 : Math.max(8, Math.round((item.totalExpenseFen / maximumMonthlyExpense) * 100));
      const monthLabel = billMonthLabel(item.month, spansYears);
      const unavailable = item.status === "unavailable";
      const amountLabel = unavailable ? "缺数据" : item.status === "future" ? "未到" : formatCompactBillMoney(item.totalExpenseFen);
      return <li key={item.month} className={item.status} aria-label={`${monthLabel}${unavailable ? "数据覆盖不足" : item.status === "future" ? "尚未到来" : `支出${formatBillMoney(item.totalExpenseFen)}${item.status === "partial" ? "，数据未完结" : ""}`}`}><strong title={unavailable || item.status === "future" ? undefined : formatBillMoney(item.totalExpenseFen)}>{amountLabel}</strong><div className="bill-report-bar-track"><span style={{ height: unavailable || item.status === "future" ? "0" : `${height}%` }} /></div><span>{monthLabel}{item.status === "partial" && <small>截至目前</small>}</span></li>;
    })}</ul></div>}
    {latest && previous && categoryChanges.length > 0 && <div className="bill-report-drivers"><h4>最近两月分类变化<span>{billMonthLabel(latest.month, spansYears)}较{billMonthLabel(previous.month, spansYears)}</span></h4><ul>{categoryChanges.map(item => <li key={item.name}><span>{item.name}</span><strong className={item.changeFen > 0 ? "up" : "down"}>{item.changeFen > 0 ? "增加" : "减少"} {formatBillMoney(Math.abs(item.changeFen))}</strong></li>)}</ul><p>只比较最近两个完整月份；不包含未完结或未来月份。</p></div>}
    {categories.length > 0 && expense !== undefined && <div className="bill-report-categories"><h4>消费分类<span>按支出金额排序</span></h4><ul>{categories.map(category => { const percentage = expense > 0 ? (category.amountFen / expense) * 100 : 0; return <li key={category.name}><div><span>{category.name}</span><span>{percentage.toFixed(1)}%</span></div><strong>{formatBillMoney(category.amountFen)}</strong><div className="bill-report-category-track" aria-hidden="true"><span style={{ width: `${percentage}%` }} /></div></li>; })}</ul></div>}
    <footer className="bill-report-footer"><div><ShieldCheck size={14} aria-hidden="true" /><span>数据来源：{source}</span></div><span>统计截至：{formatBillAsOf(evidence?.asOf)}</span></footer>
  </section>;
}

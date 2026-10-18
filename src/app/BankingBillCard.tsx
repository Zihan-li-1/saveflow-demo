import { ArrowDownLeft, ArrowUpRight, CalendarDays, ReceiptText, ShieldCheck } from "lucide-react";
import type { BankingAgentData } from "@/lib/banking-agent-client";
import { billCategories, billFen, formatBillAsOf, formatBillMoney, formatBillMonth } from "@/lib/bill-display";
import "./banking-bill-card.css";

export function BankingBillCard({ data }: { data?: BankingAgentData }) {
  const summary = data?.data ?? {};
  const income = billFen(summary.totalIncomeFen);
  const expense = billFen(summary.totalExpenseFen);
  const balance = income !== undefined && expense !== undefined ? income - expense : undefined;
  const count = billFen(summary.transactionCount);
  const categories = billCategories(summary.categoryTotals, expense);
  const evidence = data?.evidence?.[0];
  const source = evidence?.source === "synthetic_demo_only" ? "模拟演示数据" : typeof evidence?.source === "string" && evidence.source ? evidence.source : "来源未知";
  const balanceTone = balance === undefined || balance === 0 ? "neutral" : balance > 0 ? "positive" : "negative";

  return <section className="banking-result-card bill-report" aria-label={`${formatBillMonth(summary.month)}月度收支概览`}>
    <header className="bill-report-header">
      <div className="bill-report-heading"><span className="bill-report-icon"><CalendarDays size={19} aria-hidden="true" /></span><div><span className="bill-report-month">{formatBillMonth(summary.month)}</span><h3>月度收支概览</h3></div></div>
      <span className="bill-report-badge">账单报告</span>
    </header>
    <div className="bill-report-hero"><span>本月总支出</span><strong>{formatBillMoney(expense)}</strong></div>
    <dl className="bill-report-metrics">
      <div className="bill-report-metric income"><dt><ArrowDownLeft size={17} aria-hidden="true" /> 本月收入</dt><dd>{formatBillMoney(income)}</dd></div>
      <div className="bill-report-metric expense"><dt><ArrowUpRight size={17} aria-hidden="true" /> 本月支出</dt><dd>{formatBillMoney(expense)}</dd></div>
    </dl>
    <div className="bill-report-summary">
      <div className="bill-report-balance"><span>收支结余</span><strong className={balanceTone}>{formatBillMoney(balance, true)}</strong><p>收入 − 支出 · 不是账户可用余额</p></div>
      <div className="bill-report-count"><span><ReceiptText size={15} aria-hidden="true" /> 总交易笔数</span><strong>{count === undefined ? "—" : new Intl.NumberFormat("zh-CN").format(count)}{count !== undefined && <span> 笔</span>}</strong></div>
    </div>
    {count === 0 && <p className="bill-report-empty">本月暂无交易记录</p>}
    {categories.length > 0 && <div className="bill-report-categories"><h4>消费分类<span>按支出金额排序</span></h4><ul>{categories.map(category => <li key={category.name}><span>{category.name}</span><strong>{formatBillMoney(category.amountFen)}</strong></li>)}</ul></div>}
    <footer className="bill-report-footer"><div><ShieldCheck size={14} aria-hidden="true" /><span>数据来源：{source}</span></div><span>统计截至：{formatBillAsOf(evidence?.asOf)}</span></footer>
  </section>;
}

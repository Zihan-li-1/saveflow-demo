import type { BankingAgentData } from "@/lib/banking-agent-client";
import type { Subscription, InvestmentProduct } from "@/banking-core/contracts";
import "./banking-trial-cards.css";

const money = (fen: number) => `¥${(fen / 100).toFixed(2)}`;
export function BankingReadCard({ data }: { data?: BankingAgentData }) {
  const subscriptions = data?.data?.subscriptions as Subscription[] | undefined;
  const products = data?.data?.products as InvestmentProduct[] | undefined;
  const evidence = data?.evidence?.[0];
  return <section className="financial-read-card" aria-label={subscriptions ? "订阅查询结果" : "理财产品查询结果"}>
    <header><b>{subscriptions ? "订阅项目" : "理财产品"}</b><span>模拟数据 · 只读查询</span></header>
    <p className="financial-source">来源 {String(evidence?.source)} · 截至 {String(evidence?.asOf)}</p>
    {subscriptions?.map(s => <article key={s.id}>
      <h3>{s.name}</h3><div className="financial-data-grid">
        <p><span>每月费用</span><strong>{money(s.monthlyFeeFen)}</strong></p>
        <p><span>状态</span><strong>{s.status === "active" ? "使用中" : "已取消"}</strong></p>
        <p><span>最近使用</span><strong>{s.lastUsedDate}</strong></p>
        <p><span>闲置提示</span><strong>{s.isPotentiallyUnused ? "可能闲置，待核实" : "暂无闲置标记"}</strong></p>
      </div>
    </article>)}
    {products?.map(p => <article key={p.id}>
      <h3>{p.name}</h3><div className="financial-data-grid">
        <p><span>风险等级</span><strong>{p.riskLevel}</strong></p>
        <p><span>示例年化收益率</span><strong>{(p.expectedYield / 100).toFixed(2)}%</strong></p>
        <p><span>最低金额</span><strong>{money(p.minimumAmountFen)}</strong></p>
        <p><span>流动性</span><strong>{p.liquidity === "AT_MATURITY" ? "到期可用" : p.liquidity}</strong></p>
        <p><span>期限</span><strong>{p.durationDays} 天</strong></p>
      </div>
    </article>)}
    {(subscriptions?.length === 0 || products?.length === 0) && <p>当前没有项目。</p>}
    <footer>{products ? "合成产品数据，示例收益率不构成收益保证。" : "仅展示已有订阅记录，没有取消订阅操作。"}</footer>
  </section>;
}

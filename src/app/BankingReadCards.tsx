import type { BankingAgentData } from "@/lib/banking-agent-client";
import type { Subscription, InvestmentProduct } from "@/banking-core/contracts";
import "./banking-trial-cards.css";

const money = (fen: number) => `¥${(fen / 100).toFixed(2)}`;
export function BankingReadCard({ data }: { data?: BankingAgentData }) {
  const subscriptions = data?.data?.subscriptions as Subscription[] | undefined;
  const products = data?.data?.products as InvestmentProduct[] | undefined;
  const wealthProducts = data?.data?.products as Array<{ product_ref: string; name: string; risk_level: string; expected_yield_bps: number; minimum_amount_minor: number; liquidity: string; duration_days: number }> | undefined;
  const steps = data?.data?.steps as Array<{ action: string; reason: string }> | undefined;
  const rule = data?.data?.rule as { id?: string; status?: string; trigger?: { type?: string; value?: string }; proposed_steps?: Array<{ action: string }> } | undefined;
  const evidence = data?.evidence?.[0];
  const isWealth = ["wealth_recommendation", "wealth_comparison"].includes(data?.status || "");
  const title = data?.status === "goal_plan" ? "综合财务规划" : data?.status === "risk_assessment_required" ? "风险测评要求" : data?.status?.startsWith("scenario_") ? "跨场景规则" : subscriptions ? "订阅项目" : isWealth ? data?.status === "wealth_comparison" ? "理财产品对比" : "理财条件筛选" : "理财产品";
  return <section className="financial-read-card" aria-label={title}>
    <header><b>{title}</b><span>{data?.status === "scenario_rule" ? "模拟规则 · 已保存" : "模拟数据 · 只读或建议"}</span></header>
    <p className="financial-source">来源 {String(evidence?.source || "synthetic_demo_only")} · 截至 {String(evidence?.asOf || evidence?.as_of || "未知")}</p>
    {subscriptions?.map(s => <article key={s.id}>
      <h3>{s.name}</h3><div className="financial-data-grid">
        <p><span>每月费用</span><strong>{money(s.monthlyFeeFen)}</strong></p>
        <p><span>状态</span><strong>{s.status === "active" ? "使用中" : "已取消"}</strong></p>
        <p><span>最近使用</span><strong>{s.lastUsedDate}</strong></p>
        <p><span>闲置提示</span><strong>{s.isPotentiallyUnused ? "可能闲置，待核实" : "暂无闲置标记"}</strong></p>
      </div>
    </article>)}
    {!isWealth && products?.map(p => <article key={p.id}>
      <h3>{p.name}</h3><div className="financial-data-grid">
        <p><span>风险等级</span><strong>{p.riskLevel}</strong></p>
        <p><span>示例年化收益率</span><strong>{(p.expectedYield / 100).toFixed(2)}%</strong></p>
        <p><span>最低金额</span><strong>{money(p.minimumAmountFen)}</strong></p>
        <p><span>流动性</span><strong>{p.liquidity === "AT_MATURITY" ? "到期可用" : p.liquidity}</strong></p>
        <p><span>期限</span><strong>{p.durationDays} 天</strong></p>
      </div>
    </article>)}
    {isWealth && wealthProducts?.map(p => <article key={p.product_ref}>
      <h3>{p.name}</h3><div className="financial-data-grid">
        <p><span>风险等级</span><strong>{p.risk_level}</strong></p><p><span>示例年化收益率</span><strong>{(p.expected_yield_bps / 100).toFixed(2)}%</strong></p>
        <p><span>最低金额</span><strong>{money(p.minimum_amount_minor)}</strong></p><p><span>流动性</span><strong>{p.liquidity === "AT_MATURITY" ? "到期可用" : p.liquidity}</strong></p><p><span>期限</span><strong>{p.duration_days} 天</strong></p>
      </div>
    </article>)}
    {data?.status === "risk_assessment_required" && <article><h3>需要用户本人完成正式问卷</h3><p>模型不能代答；完成适当性评估前不提供申购入口。</p></article>}
    {steps?.map((step, index) => <article key={`${step.action}-${index}`}><h3>{index + 1}. {step.action}</h3><p>{step.reason}</p></article>)}
    {rule && <article><h3>{rule.id ? `规则 ${rule.id}` : "规则变更预览"}</h3><div className="financial-data-grid"><p><span>状态</span><strong>{rule.status || "待确认"}</strong></p><p><span>触发</span><strong>{rule.trigger?.value || "—"}</strong></p><p><span>建议步骤</span><strong>{rule.proposed_steps?.map(step => step.action).join("、") || "—"}</strong></p></div></article>}
    {(subscriptions?.length === 0 || products?.length === 0 || (isWealth && wealthProducts?.length === 0)) && <p>当前没有符合条件的项目。</p>}
    <footer>{isWealth ? "仅按用户声明条件筛选；未完成正式风险测评，不构成个性化投资建议。" : data?.status?.startsWith("scenario_") ? "规则只生成建议；资金或控制变更仍需重新预览并确认。" : products ? "合成产品数据，示例收益率不构成收益保证。" : subscriptions ? "仅展示已有订阅记录，没有取消订阅操作。" : "本结果不会自动执行任何资金或控制变更。"}</footer>
  </section>;
}

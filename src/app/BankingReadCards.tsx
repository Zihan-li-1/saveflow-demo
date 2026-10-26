import type { BankingAgentData } from "@/lib/banking-agent-client";
import type { InvestmentProduct } from "@/banking-core/contracts";
import "./banking-trial-cards.css";

const money = (fen: number) => `¥${(fen / 100).toFixed(2)}`;
const riskText = (level: string) => level === "R1" ? "较低风险（示例：短期可能约亏 0%–2%）" : level === "R2" ? "中等风险（示例：阶段亏损可能约 2%–10%）" : level === "R3" ? "较高风险（示例：亏损可能超过 10%）" : "风险情况待确认";
const liquidityText = (value: string) => value === "T+0" ? "通常当天可取" : value === "T+1" ? "通常下一个工作日可取" : value === "AT_MATURITY" ? "一般需持有到计划结束" : "取用时间待确认";
const durationText = (days: number) => days === 0 ? "没有固定持有期" : days % 30 === 0 ? `约 ${days / 30} 个月` : days >= 30 ? `约 ${Math.round(days / 30)} 个月（${days} 天）` : `${days} 天`;
const ProductTerms = () => <div className="financial-term-help">
  <details><summary>风险等级 <span>点此了解</span></summary><p>风险等级用来表示价格波动和发生亏损的可能性。这里的百分比只是帮助理解差异的演示尺度，不代表实际产品最多只会亏这么多；购买前仍需查看产品说明和正式风险测评。</p></details>
  <details><summary>流动性 <span>点此了解</span></summary><p>流动性就是需要用钱时，多久能把理财资金取出来。当天可取最灵活；下一个工作日可取需要等待；持有到计划结束通常不能提前使用这笔钱。</p></details>
</div>;
type SubscriptionView = { id: string; name: string; monthlyFeeFen: number; status: "active" | "cancelled"; lastUsedDate: string; isPotentiallyUnused: boolean; inactivityDays?: number; unusedReason?: string };
export function BankingReadCard({ data, active = false, busy = false, onConfirm, onReject, onCheck }: { data?: BankingAgentData; active?: boolean; busy?: boolean; onConfirm?: (data: BankingAgentData) => void; onReject?: (data: BankingAgentData) => void; onCheck?: (data: BankingAgentData) => void }) {
  const subscriptions = data?.data?.subscriptions as SubscriptionView[] | undefined;
  const subscriptionSummary = data?.data?.summary as { activeCount?: number; activeMonthlyFeeFen?: number; potentiallyUnusedCount?: number; potentiallyUnusedMonthlyFeeFen?: number; potentialAnnualSavingsFen?: number } | undefined;
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
    {subscriptions && subscriptionSummary && <div className="subscription-summary" aria-label="订阅费用汇总"><p><span>每月订阅总额</span><strong>{money(subscriptionSummary.activeMonthlyFeeFen ?? 0)}</strong></p><p><span>可能闲置月费</span><strong>{money(subscriptionSummary.potentiallyUnusedMonthlyFeeFen ?? 0)}</strong></p><p><span>预计每年可节省</span><strong>{money(subscriptionSummary.potentialAnnualSavingsFen ?? 0)}</strong></p></div>}
    {subscriptions?.map(s => <article key={s.id}>
      <h3>{s.name}</h3><div className="financial-data-grid">
        <p><span>每月费用</span><strong>{money(s.monthlyFeeFen)}</strong></p>
        <p><span>状态</span><strong>{s.status === "active" ? "使用中" : "已取消"}</strong></p>
        <p><span>最近使用</span><strong>{s.lastUsedDate}</strong></p>
        <p><span>闲置提示</span><strong>{s.isPotentiallyUnused ? "可能闲置，待核实" : "暂无闲置标记"}</strong></p>
      </div>
      {s.unusedReason && <p className="subscription-reason">{s.unusedReason}</p>}
    </article>)}
    {!isWealth && products?.map(p => <article key={p.id}>
      <h3>{p.name}</h3><div className="financial-data-grid">
        <p><span>可能的波动</span><strong>{riskText(p.riskLevel)}</strong></p>
        <p><span>示例年化收益率</span><strong>{(p.expectedYield / 100).toFixed(2)}%</strong></p>
        <p><span>最低金额</span><strong>{money(p.minimumAmountFen)}</strong></p>
        <p><span>最快何时可取</span><strong>{liquidityText(p.liquidity)}</strong></p>
        <p><span>建议持有时间</span><strong>{durationText(p.durationDays)}</strong></p>
      </div>
      <ProductTerms />
    </article>)}
    {isWealth && wealthProducts?.map(p => <article key={p.product_ref}>
      <h3>{p.name}</h3><div className="financial-data-grid">
        <p><span>可能的波动</span><strong>{riskText(p.risk_level)}</strong></p><p><span>示例年化收益率</span><strong>{(p.expected_yield_bps / 100).toFixed(2)}%</strong></p>
        <p><span>最低金额</span><strong>{money(p.minimum_amount_minor)}</strong></p><p><span>最快何时可取</span><strong>{liquidityText(p.liquidity)}</strong></p><p><span>建议持有时间</span><strong>{durationText(p.duration_days)}</strong></p>
      </div>
      <ProductTerms />
    </article>)}
    {data?.status === "risk_assessment_required" && <article><h3>需要用户本人完成正式问卷</h3><p>模型不能代答；完成适当性评估前不提供申购入口。</p></article>}
    {steps?.map((step, index) => <article key={`${step.action}-${index}`}><h3>{index + 1}. {step.action}</h3><p>{step.reason}</p></article>)}
    {rule && <article><h3>{rule.id ? `规则 ${rule.id}` : "规则变更预览"}</h3><div className="financial-data-grid"><p><span>状态</span><strong>{rule.status || "待确认"}</strong></p><p><span>触发</span><strong>{rule.trigger?.value || "—"}</strong></p><p><span>建议步骤</span><strong>{rule.proposed_steps?.map(step => step.action).join("、") || "—"}</strong></p></div></article>}
    {data?.status === 'scenario_rule_preview' && onConfirm && onReject && onCheck && <div className="error-actions">
      {data.outcomePending && <p>结果待核实，请先查询原操作。</p>}
      <button type="button" className="primary-button" disabled={!active || busy || data.outcomePending} onClick={() => onConfirm(data)}>确认并保存规则</button>
      <button type="button" className="secondary-button" disabled={!active || busy || data.outcomePending} onClick={() => onReject(data)}>取消本次操作</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => onCheck(data)}>查询操作状态</button>
    </div>}
    {(subscriptions?.length === 0 || products?.length === 0 || (isWealth && wealthProducts?.length === 0)) && <p>当前没有符合条件的项目。</p>}
    <footer>{isWealth ? "仅按用户声明条件筛选；未完成正式风险测评，不构成个性化投资建议。" : data?.status?.startsWith("scenario_") ? "规则只生成建议；资金或控制变更仍需重新预览并确认。" : products ? "合成产品数据，示例收益率不构成收益保证。" : subscriptions ? "节省金额按可能闲置订阅月费 × 12 估算；请核实后自行决定，本结果不会取消订阅。" : "本结果不会自动执行任何资金或控制变更。"}</footer>
  </section>;
}

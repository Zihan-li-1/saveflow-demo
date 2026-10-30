import type { BankingAgentData } from '@/lib/banking-agent-client';
import { BankingBillCard } from './BankingBillCard';
import { BankingReadCard } from './BankingReadCards';
import { BankingCardResult } from './BankingCardCards';

const labels: Record<string, string> = {
  'bill.summary': '账单概览', 'subscription.list': '订阅项目', 'card.get': '卡片信息',
  'product.list': '理财产品', 'wealth.recommend': '理财条件筛选', 'wealth.compare': '产品比较',
};

export function BankingPlanCard({ data }: { data?: BankingAgentData }) {
  const plan = data?.plan;
  if (!plan) return null;
  if (data?.historySnapshot) return <section className="financial-read-card" aria-label="历史规划快照"><header><b>历史规划快照</b></header><p>请重新查询以取得当前可核验的数据。</p></section>;
  return <section className="financial-read-card" aria-label="只读规划结果">
    <header><b>只读分析</b><span>{({ completed: '已完成', partial: '部分完成', needs_clarification: '需要补充', unsupported: '暂不支持', cancelled: '已取消', business_intent: '单项业务' } as Record<string, string>)[plan.status] ?? '部分结果'}</span></header>
    {plan.reason && <p>{plan.reason}</p>}
    {plan.question && <p>{plan.question}</p>}
    {plan.steps.map(step => {
      const result = step.result?.result;
      const verified = step.status === 'completed' && result?.ok === true;
      const cardData = verified ? { status: result.kind, action: result.action, data: result.data, evidence: result.evidence } as BankingAgentData : undefined;
      return <article key={step.stepId}>
        <h3>{labels[step.tool] ?? step.tool} · {verified ? '已核验' : '未完成'}</h3>
        {verified && step.tool === 'bill.summary' && <BankingBillCard data={cardData} />}
        {verified && step.tool === 'card.get' && (Array.isArray(result.data.cards) ? result.data.cards : []).map((card, index) => <BankingCardResult key={index} data={{ ...cardData!, data: { card } }} />)}
        {verified && ['subscription.list', 'product.list', 'wealth.recommend', 'wealth.compare'].includes(step.tool) && <BankingReadCard data={cardData} />}
        {verified && <small>来源：{result.evidence[0]?.source === 'synthetic_demo_only' ? '模拟演示数据' : result.evidence[0]?.source} · 截至 {result.evidence[0]?.asOf}</small>}
      </article>;
    })}
    <footer>分析说明由模型生成；金额与项目以已核验的业务卡片为准。本次没有执行修改。</footer>
  </section>;
}

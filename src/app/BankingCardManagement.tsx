"use client";

import type { Message } from "@/lib/use-saveflow";
import { saveflowMock } from "@/lib/saveflow-mock";
import { budgetBalanceAlert, cardActivities, synchronizeManagedCards } from "@/lib/card-management";

const yuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`;

/** Two initialized virtual cards, overlaid with verified card.get results after operations. */
export function BankingCardManagement({ messages, operationStates = {} }: { messages: Message[]; operationStates?: Readonly<Record<string, string>> }) {
  const cards = synchronizeManagedCards(saveflowMock.cards, messages, operationStates);
  const activities = cardActivities(messages, operationStates);
  return <section className="card-management" aria-labelledby="card-management-title">
    <header className="card-management-header">
      <div><span className="eyebrow">CARD MANAGEMENT</span><h2 id="card-management-title">卡片管理</h2></div>
      <span className="account-chip">{cards.length} 张虚拟卡</span>
    </header>
    <p className="card-management-note">这里固定展示两张初始化卡。卡片操作成功后，以重新查询并核实过的结果同步更新对应卡片，不会用操作预览提前改变状态。</p>
    <div className="managed-card-grid">
      {cards.map(card => {
        const remaining = card.monthlyBudgetFen - card.monthlySpentFen;
        const balanceAlert = budgetBalanceAlert(card);
        return <article className={`managed-card ${card.status === "frozen" ? "is-frozen" : ""}`} key={card.id}>
          <div className="managed-card-title"><div><small>虚拟卡</small><h3>{card.name}</h3></div><span>{card.status === "frozen" ? "已冻结" : "正常使用"}</span></div>
          <div className="managed-card-budget"><span>本月已消费</span><strong>{yuan(card.monthlySpentFen)}</strong><small>月预算 {yuan(card.monthlyBudgetFen)}</small></div>
          <div className="managed-card-progress"><span style={{ width: `${Math.min(100, card.monthlyBudgetFen ? card.monthlySpentFen * 100 / card.monthlyBudgetFen : 100)}%` }} /></div>
          <p className={remaining < 0 ? "over-budget" : ""}>{remaining < 0 ? `已超预算 ${yuan(-remaining)}` : `预算尚余 ${yuan(remaining)}`}</p>
          {balanceAlert && <p className="over-budget" role="alert">{balanceAlert}</p>}
          <dl>
            <div><dt>线上支付</dt><dd>{card.onlinePaymentsEnabled ? "已开启" : "已关闭"}</dd></div>
            <div><dt>禁用类别</dt><dd>{card.blockedCategories.length ? card.blockedCategories.join("、") : "无"}</dd></div>
            <div><dt>单笔提醒</dt><dd>{card.alertThresholdFen == null ? "未设置" : `${yuan(card.alertThresholdFen)} 及以上`}</dd></div>
            <div><dt>余额提醒</dt><dd>{card.balanceReminderAmountFen != null ? `剩余 ${yuan(card.balanceReminderAmountFen)} 时` : card.balanceReminderPercent != null ? `剩余预算的 ${card.balanceReminderPercent}% 时` : "未设置"}</dd></div>
          </dl>
        </article>;
      })}
    </div>
    <section className="card-activity" aria-labelledby="card-activity-title">
      <div className="card-activity-heading"><h3 id="card-activity-title">卡片操作记录</h3><span>{activities.length ? `${activities.length} 项` : "暂无操作"}</span></div>
      {activities.length ? <ul>{activities.map(activity => <li key={activity.id}><div><strong>{activity.label}</strong><span>{activity.cardName} · {activity.detail}</span></div><span className={`card-activity-status status-${activity.status}`}>{activity.status}</span></li>)}</ul> : <p>还没有卡片操作。上方仍会持续显示已有的虚拟卡及当前状态。</p>}
    </section>
  </section>;
}

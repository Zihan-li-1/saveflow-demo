"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Message } from "@/lib/use-saveflow";
import { saveflowMock } from "@/lib/saveflow-mock";
import { currentSubscriptions } from "@/lib/subscription-overview";

const money = (fen: number) => `¥${(fen / 100).toFixed(2)}`;

export function BankingSubscriptionOverview({ messages }: { messages: Message[] }) {
  const [expanded, setExpanded] = useState(false);
  const subscriptions = currentSubscriptions(saveflowMock.subscriptions, messages);
  const active = subscriptions.filter(item => item.status === "active");
  const unused = active.filter(item => item.isPotentiallyUnused);
  return <div className="activity-card subscription-overview">
    <div className="section-title"><span>订阅概览</span><span>{active.length} 项生效中</span></div>
    <button type="button" className="subscription-overview-toggle" aria-expanded={expanded} aria-controls="subscription-overview-details" onClick={() => setExpanded(value => !value)}>
      <span className="rule-icon purple">订</span><b>订阅服务</b><span>{unused.length ? `${unused.length} 项可能闲置` : "状态正常"}</span><ChevronDown size={14} className={expanded ? "expanded" : ""} />
    </button>
    {expanded && <div id="subscription-overview-details" className="subscription-overview-details">
      {subscriptions.length ? subscriptions.map(item => <div className="subscription-overview-item" key={item.id}><div><b>{item.name}</b><span>{money(item.monthlyFeeFen)}/月</span></div><span className={item.status === "cancelled" ? "cancelled" : item.isPotentiallyUnused ? "attention" : "active"}>{item.status === "cancelled" ? "已取消" : item.isPotentiallyUnused ? "可能闲置" : "正常扣费"}</span></div>) : <p>当前没有订阅服务。</p>}
      <small>内容会在 Agent 返回最新订阅查询结果后自动更新。</small>
    </div>}
  </div>;
}

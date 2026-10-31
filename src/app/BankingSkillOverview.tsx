"use client";

import { useState } from "react";
import { ArrowLeftRight, BarChart3, ChevronDown, CreditCard, Landmark, Layers3, Repeat2 } from "lucide-react";
import type { SkillGroupId, SkillOverview } from "@/lib/banking-agent-client";
import styles from "./BankingSkillOverview.module.css";

const icons = { transfer: ArrowLeftRight, bills: BarChart3, wealth: Landmark, cards: CreditCard, subscriptions: Repeat2, cross_scenario: Layers3 } satisfies Record<SkillGroupId, typeof ArrowLeftRight>;
const statusText = { available_demo: "可体验", planning_only: "只读规划", conditional: "条件可用", unavailable: "暂不可用" } as const;

export function BankingSkillOverview({ overview, interactive = true, onSelectExample }: { overview: SkillOverview; interactive?: boolean; onSelectExample: (prompt: string) => void }) {
  const [expanded, setExpanded] = useState<SkillGroupId | null>(null);
  return <section className={styles.overview} aria-label="SaveFlow Agent 能力总览">
    <div className={styles.heading}><div><strong>选择一项金融服务</strong><span>所有能力均基于模拟数据，写操作仍需预览和页面确认。</span></div></div>
    <div className={styles.grid}>{overview.groups.map(group => {
      const Icon = icons[group.id]; const open = expanded === group.id;
      return <article className={`${styles.skill} ${open ? styles.open : ""}`} key={group.id}>
        <button type="button" className={styles.skillButton} aria-expanded={open} onClick={() => setExpanded(open ? null : group.id)}>
          <span className={styles.icon}><Icon size={20} /></span><span className={styles.summary}><strong>{group.title}</strong><small>{group.description}</small></span>
          <span className={`${styles.status} ${styles[group.status]}`}>{statusText[group.status]}</span><ChevronDown className={styles.chevron} size={17} />
        </button>
        <ul className={styles.capabilities}>{group.capabilities.slice(0, 4).map(item => <li key={item.action}>{item.label}</li>)}</ul>
        {open && <div className={styles.examples}>{group.examples.length ? <><span>试试这样问</span>{group.examples.map(example => <button type="button" key={example.prompt} disabled={!interactive} onClick={() => onSelectExample(example.prompt)}>{example.label}<small>{example.prompt}</small></button>)}</> : <p>当前运行环境尚未核验该类任务，暂不提供体验入口。</p>}</div>}
      </article>;
    })}</div>
    {!interactive && <p className={styles.snapshot}>这是历史能力快照。请重新询问“你可以帮我做什么”以获取当前可用入口。</p>}
  </section>;
}

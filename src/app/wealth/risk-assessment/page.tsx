"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

const questions = [
  { text: "如果理财短期下跌 5%，你更可能怎么做？", choices: [{ label: "立即退出，避免继续亏损", score: 0 }, { label: "先观察并重新核对资金用途", score: 1 }, { label: "能够接受波动并按原计划持有", score: 2 }] },
  { text: "这笔资金最早什么时候可能要用？", choices: [{ label: "随时可能使用", score: 0 }, { label: "一年内可能使用", score: 1 }, { label: "一年以上暂时不用", score: 2 }] },
  { text: "你更看重哪一项？", choices: [{ label: "尽量少波动", score: 0 }, { label: "风险和收益相对均衡", score: 1 }, { label: "愿意承受较大波动争取更高收益", score: 2 }] },
] as const;

export default function RiskAssessmentPage() {
  const [answers, setAnswers] = useState<number[]>([]);
  const complete = questions.every((_, index) => Number.isInteger(answers[index]));
  const level = useMemo(() => {
    const score = answers.reduce((sum, value) => sum + value, 0);
    return score <= 1 ? "R1" : score <= 4 ? "R2" : "R3";
  }, [answers]);
  return <main style={{ maxWidth: 720, margin: "40px auto", padding: 24, fontFamily: "system-ui", color: "#172033" }}>
    <Link href="/" style={{ color: "#315efb" }}>← 返回 SaveFlow</Link>
    <h1>模拟风险测评</h1>
    <p>请由用户本人作答。模型不能代答。本页面只用于合成数据演示，不构成真实投资适当性评估。</p>
    {questions.map((question, index) => <fieldset key={question.text} style={{ margin: "24px 0", padding: 20, border: "1px solid #dbe2ef", borderRadius: 12 }}>
      <legend><strong>{index + 1}. {question.text}</strong></legend>
      {question.choices.map(choice => <label key={choice.label} style={{ display: "block", margin: "12px 0" }}><input type="radio" name={`question-${index}`} checked={answers[index] === choice.score} onChange={() => setAnswers(current => { const next = [...current]; next[index] = choice.score; return next; })} /> {choice.label}</label>)}
    </fieldset>)}
    {complete ? <section role="status" style={{ padding: 20, borderRadius: 12, background: "#eef3ff" }}><h2>演示结果：{level}</h2><p>{level === "R1" ? "更重视本金波动和随时取用。" : level === "R2" ? "能够承受一定波动，但仍需保留必要流动资金。" : "能够承受较高波动，但仍不代表任何产品必然适合。"}</p><p>返回助手后仍需重新核对产品风险、流动性、期限与风险披露，并对每笔资金操作单独确认。</p></section> : <p>请完成全部题目后查看演示结果。</p>}
  </main>;
}

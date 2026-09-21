"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import BillAnalysisCard from "@/components/BillAnalysisCard";
import CardExecuteCard from "@/components/CardExecuteCard";
import SavingPlanCard from "@/components/SavingPlanCard";
import type { SaveflowMock } from "@/lib/saveflow-mock";

export default function CardDebugPage() {
  const [lastEvent, setLastEvent] = useState("等待卡片操作");
  const [saveflowMock, setSaveflowMock] = useState<SaveflowMock | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const record = (event: string) => setLastEvent(event);

  useEffect(() => {
    fetch("/api/saveflow")
      .then(async (response) => {
        const payload = (await response.json()) as { success: boolean; data?: SaveflowMock; error?: string };
        if (!response.ok || !payload.success || !payload.data) throw new Error(payload.error ?? "接口返回数据为空");
        setSaveflowMock(payload.data);
      })
      .catch((error: Error) => setLoadError(error.message));
  }, []);

  return (
    <main className="min-h-screen bg-[#0a0806] px-6 py-8 text-[#e7c686]">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#a99b80]">SaveFlow / Card QA</p>
            <h1 className="mt-2 text-2xl font-bold">统一数据卡片调试页</h1>
            <p className="mt-2 max-w-2xl text-sm text-[#a99b80]">
              数据来自统一 mock JSON，目标、分析、消费即储蓄与异常场景使用同一份 fixture。
            </p>
          </div>
          <Link href="/" className="rounded-lg border border-[#d4af37]/30 px-3 py-2 text-sm text-[#d9b878] hover:bg-[#d4af37]/10">
            返回 IM 演示
          </Link>
        </div>

        <div className="mb-7 rounded-xl border border-[#d4af37]/20 bg-[#16110c]/70 px-4 py-3 text-sm text-[#cbb27f]">
          最近事件：<b className="text-[#f0d9a6]">{lastEvent}</b>
        </div>

        {loadError && <div className="mb-7 rounded-xl border border-red-400/40 bg-red-950/30 px-4 py-3 text-sm text-red-200">接口加载失败：{loadError}</div>}

        {!saveflowMock && !loadError && <div className="rounded-xl border border-[#d4af37]/20 bg-[#16110c]/70 px-4 py-8 text-center text-sm text-[#cbb27f]">正在从 /api/saveflow 加载演示数据...</div>}

        {saveflowMock && <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <BillAnalysisCard {...saveflowMock.analysis} />

          <SavingPlanCard
            savingGoal={saveflowMock.goal.targetAmount}
            monthlySaving={saveflowMock.goal.monthlySaving}
            categoryBudgets={saveflowMock.goal.categoryBudgets}
            estimatedCompletion={saveflowMock.goal.estimatedCompletion}
            onConfirmCreate={() => record("储蓄计划：确认创建")}
            onModifyPlan={() => record("储蓄计划：修改方案")}
            onCancelPlan={() => record("储蓄计划：取消")}
          />

          <CardExecuteCard
            {...saveflowMock.scenarios.normal}
            onConfirmPay={() => record("正常消费：确认支付")}
            onCancelPay={() => record("正常消费：取消")}
          />

          <CardExecuteCard
            {...saveflowMock.scenarios.overLimit}
            onConfirmPay={() => record("超限消费：确认支付")}
            onCancelPay={() => record("超限消费：取消")}
          />

          <CardExecuteCard
            {...saveflowMock.scenarios.insufficient}
            onConfirmPay={() => record("余额不足：不应触发支付")}
            onCancelPay={() => record("余额不足：关闭提示")}
          />
        </div>}
      </div>
    </main>
  );
}

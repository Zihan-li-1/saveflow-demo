"use client";
// components/SavingPlanCard.tsx
import type { SavingPlanCardProps } from '@/types/card';
import { formatAmount } from '@/lib/format';

/**
 * 储蓄计划卡片
 */
export default function SavingPlanCard({
  savingGoal,
  monthlySaving,
  categoryBudgets,
  estimatedCompletion,
  onConfirmCreate,
  onModifyPlan,
  onCancelPlan,
}: SavingPlanCardProps) {
  return (
    <div className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-[#d4af37]/15 border-t-[#d4af37]/40 bg-[#16110c]/55 p-6 shadow-xl shadow-black/60 backdrop-blur-xl transition-all hover:border-[#d4af37]/35 hover:bg-[#1a1410]/60 hover:shadow-2xl hover:shadow-black/70 animate-[fade-up_0.6s_ease-out_both]">
      {/* 暗金装饰光斑 */}
      <div className="pointer-events-none absolute -left-12 -top-12 h-40 w-40 rounded-full bg-[#d4af37]/10 blur-2xl animate-[drift_34s_ease-in-out_infinite]" />
      <div className="pointer-events-none absolute -bottom-14 -right-12 h-44 w-44 rounded-full bg-[#c9a86a]/10 blur-2xl animate-[drift_42s_ease-in-out_infinite_reverse]" />

      <div className="relative z-10">
        {/* 标题 */}
        <p className="text-sm font-bold tracking-tight text-[#e7c686] [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">
          储蓄计划
        </p>

        {/* 储蓄目标 */}
        <div className="mt-4 rounded-2xl border border-[#d4af37]/10 bg-[#14100b]/50 p-4 transition-colors hover:border-[#d4af37]/25">
          <p className="text-xs font-semibold text-[#a99b80]">储蓄目标</p>
          <p className="mt-1 text-xl font-extrabold tracking-tight text-[#e7c686] [text-shadow:0_1px_3px_rgba(0,0,0,0.6)] transition-all hover:font-black hover:[text-shadow:0_0_18px_rgba(212,175,55,0.4)]">
            ¥{formatAmount(savingGoal)}
          </p>
        </div>

        {/* 每月建议储蓄 / 预计完成时间 */}
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-[#d4af37]/10 bg-[#14100b]/50 p-4 transition-colors hover:border-[#d4af37]/25">
            <p className="text-xs font-semibold text-[#a99b80]">每月建议储蓄</p>
            <p className="mt-1 text-base font-extrabold tracking-tight text-[#d9b878] [text-shadow:0_1px_2px_rgba(0,0,0,0.6)] transition-all hover:[text-shadow:0_0_14px_rgba(212,175,55,0.35)]">
              ¥{formatAmount(monthlySaving)}
            </p>
          </div>
          <div className="rounded-2xl border border-[#d4af37]/10 bg-[#14100b]/50 p-4 transition-colors hover:border-[#d4af37]/25">
            <p className="text-xs font-semibold text-[#a99b80]">预计完成时间</p>
            <p className="mt-1 text-base font-semibold tracking-tight text-[#d9b878] [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">
              {estimatedCompletion}
            </p>
          </div>
        </div>

        {/* 分类预算 */}
        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold text-[#a99b80]">分类预算</p>
          <div className="space-y-1">
            {categoryBudgets.map((item) => (
              <div
                key={item.name}
                className="flex items-center justify-between -mx-2 rounded-md px-2 py-1 transition-all hover:bg-[#d4af37]/10 hover:shadow-[inset_2px_0_0_0_rgba(212,175,55,0.5)]"
              >
                <span className="text-sm font-normal text-[#e3d9c4]">{item.name}</span>
                <span className="text-sm font-extrabold tracking-tight text-[#d9b878] [text-shadow:0_1px_2px_rgba(0,0,0,0.6)] transition-all hover:[text-shadow:0_0_14px_rgba(212,175,55,0.35)]">
                  ¥{formatAmount(item.amount)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* 按钮组 */}
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onConfirmCreate}
            className="flex-1 rounded-xl border border-[#d4af37]/50 bg-[#2b2013]/80 px-4 py-2 text-sm font-semibold text-[#f0d9a6] backdrop-blur transition hover:border-[#d4af37]/80 hover:bg-[#3a2c14]/90 hover:text-[#f7e7bd] hover:shadow-[inset_0_0_12px_rgba(212,175,55,0.15),0_0_16px_rgba(212,175,55,0.28)]"
          >
            确认创建
          </button>
          <button
            type="button"
            onClick={onModifyPlan}
            className="flex-1 rounded-xl border border-[#d4af37]/25 bg-[#16110c]/70 px-4 py-2 text-sm font-semibold text-[#cbb27f] backdrop-blur transition hover:border-[#d4af37]/50 hover:bg-[#1d1610]/85 hover:text-[#e7c686] hover:shadow-[inset_0_0_10px_rgba(212,175,55,0.12),0_0_10px_rgba(212,175,55,0.18)]"
          >
            修改方案
          </button>
          <button
            type="button"
            onClick={onCancelPlan}
            className="rounded-xl border border-[#d4af37]/20 bg-[#16110c]/60 px-4 py-2 text-sm font-normal text-[#a99b80] backdrop-blur transition hover:border-[#d4af37]/45 hover:bg-[#1d1610]/80 hover:text-[#cbb27f] hover:shadow-[inset_0_0_10px_rgba(212,175,55,0.12),0_0_10px_rgba(212,175,55,0.15)]"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

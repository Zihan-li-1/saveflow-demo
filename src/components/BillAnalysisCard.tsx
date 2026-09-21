"use client";
// components/BillAnalysisCard.tsx
import type { BillAnalysisCardProps } from '@/types/card';
import { formatAmount, formatSigned } from '@/lib/format';

/**
 * 账单分析卡片（纯展示，无按钮）
 */
export default function BillAnalysisCard({
  totalExpense,
  momIncrease,
  categories,
  subscriptionCount,
}: BillAnalysisCardProps) {
  return (
    <div className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-[#d4af37]/15 border-t-[#d4af37]/40 bg-[#16110c]/55 p-6 shadow-xl shadow-black/60 backdrop-blur-xl transition-all hover:border-[#d4af37]/35 hover:bg-[#1a1410]/60 hover:shadow-2xl hover:shadow-black/70 animate-[fade-up_0.6s_ease-out_both]">
      {/* 暗金装饰光斑 */}
      <div className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-[#d4af37]/10 blur-2xl animate-[drift_32s_ease-in-out_infinite]" />
      <div className="pointer-events-none absolute -bottom-14 -left-12 h-44 w-44 rounded-full bg-[#c9a86a]/10 blur-2xl animate-[drift_40s_ease-in-out_infinite_reverse]" />

      <div className="relative z-10">
        {/* 头部：本月支出总额与环比 */}
        <div className="mb-4">
          <p className="text-xs font-semibold text-[#a99b80]">本月支出</p>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-extrabold tracking-tight text-[#e7c686] [text-shadow:0_1px_3px_rgba(0,0,0,0.6)] transition-all hover:font-black hover:[text-shadow:0_0_18px_rgba(212,175,55,0.4)]">
              ¥{formatAmount(totalExpense)}
            </span>
            <span className="text-xs font-semibold text-[#a99b80]">环比</span>
            <span
              className={`text-xs font-extrabold tracking-tight ${
                momIncrease >= 0 ? 'text-[#e0a26b]' : 'text-[#a9cfa0]'
              }`}
            >
              {formatSigned(momIncrease)}
            </span>
          </div>
        </div>

        {/* 分类变化明细 */}
        <div className="space-y-1 border-t border-[#d4af37]/10 pt-4">
          {categories.map((item) => (
            <div
              key={item.name}
              className="flex items-center justify-between -mx-2 rounded-md px-2 py-1 transition-all hover:bg-[#d4af37]/10 hover:shadow-[inset_2px_0_0_0_rgba(212,175,55,0.5)]"
            >
              <span className="text-sm font-normal text-[#e3d9c4]">{item.name}</span>
              <span
                className={`text-sm font-extrabold tracking-tight ${
                  item.changeAmount >= 0 ? 'text-[#e0a26b]' : 'text-[#a9cfa0]'
                }`}
              >
                {formatSigned(item.changeAmount)}
              </span>
            </div>
          ))}

          {/* 新增订阅项数 */}
          <div className="flex items-center justify-between -mx-2 rounded-md px-2 py-1 transition-all hover:bg-[#d4af37]/10 hover:shadow-[inset_2px_0_0_0_rgba(212,175,55,0.5)]">
            <span className="text-sm font-semibold text-[#a99b80]">当前订阅</span>
            <span className="text-sm font-extrabold tracking-tight text-[#d9b878] [text-shadow:0_1px_2px_rgba(0,0,0,0.6)] transition-all hover:[text-shadow:0_0_14px_rgba(212,175,55,0.35)]">
              {subscriptionCount} 项
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

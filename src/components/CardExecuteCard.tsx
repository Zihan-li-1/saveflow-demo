"use client";
// components/CardExecuteCard.tsx
import type { CardExecuteCardProps } from '@/types/card';
import { formatAmount } from '@/lib/format';

/**
 * 卡片执行消费结果卡片
 */
export default function CardExecuteCard({
  cardName,
  monthlyLimit,
  usedThisMonth,
  currentConsumption,
  savingAmount,
  totalDebit,
  resultDescription,
  status,
  requiresConfirmation = true,
  onConfirmPay,
  onCancelPay,
}: CardExecuteCardProps) {
  const isOverLimit = status === 'over-limit';
  const isInsufficient = status === 'insufficient-balance';
  const isError = isOverLimit || isInsufficient;

  return (
    <div className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-[#d4af37]/15 border-t-[#d4af37]/40 bg-[#16110c]/55 p-6 shadow-xl shadow-black/60 backdrop-blur-xl transition-all hover:border-[#d4af37]/35 hover:bg-[#1a1410]/60 hover:shadow-2xl hover:shadow-black/70 animate-[fade-up_0.6s_ease-out_both]">
      {/* 暗金装饰光斑 */}
      <div className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-[#d4af37]/10 blur-2xl animate-[drift_32s_ease-in-out_infinite]" />
      <div className="pointer-events-none absolute -bottom-14 -left-12 h-44 w-44 rounded-full bg-[#c9a86a]/10 blur-2xl animate-[drift_40s_ease-in-out_infinite_reverse]" />

      <div className="relative z-10">
        {/* 处理结果状态横幅（局部冒出动画） */}
        <div
          className={`mb-4 flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold animate-[result-pop_0.4s_ease-out_0.15s_both] ${
            isError
              ? 'border-[#c24a3a]/60 bg-[#2a1410]/70 text-[#e8876f] shadow-[0_0_16px_rgba(194,74,58,0.25)]'
              : 'border-[#3f8a5f]/60 bg-[#0f2317]/70 text-[#7fd3a4] shadow-[0_0_16px_rgba(63,138,95,0.25)]'
          }`}
        >
          <span
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
              isError ? 'bg-[#d9684f]' : 'bg-[#57b986]'
            }`}
          />
          <span>{resultDescription}</span>
        </div>

        {/* 卡片名称 */}
        <p className="text-sm font-bold tracking-tight text-[#e7c686] [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">
          {cardName}
        </p>

        {/* 金额明细 */}
        <div className="mt-3 space-y-1">
          <Row label="月度限额" value={`¥${formatAmount(monthlyLimit)}`} />
          <Row label="本月已使用" value={`¥${formatAmount(usedThisMonth)}`} />
          <Row
            label="本次消费"
            value={`¥${formatAmount(currentConsumption)}`}
            highlight={isError}
          />
          <Row label="自动储蓄" value={`¥${formatAmount(savingAmount)}`} />
          <Row label="预计总扣款" value={`¥${formatAmount(totalDebit)}`} highlight={isError} />
        </div>

        {/* 按钮组 */}
        <div className="mt-5 flex gap-2">
          {requiresConfirmation && <button
              type="button"
              onClick={onConfirmPay}
              className={`flex-1 rounded-xl border px-4 py-2 text-sm font-semibold backdrop-blur transition ${
                isError
                  ? 'border-[#c24a3a]/60 bg-[#2a1410]/70 text-[#f0b3a3] hover:border-[#c24a3a]/85 hover:bg-[#331812]/85 hover:text-[#fbd0c4] hover:shadow-[inset_0_0_12px_rgba(194,74,58,0.15),0_0_16px_rgba(194,74,58,0.3)]'
                  : 'border-[#3f8a5f]/60 bg-[#0f2317]/70 text-[#a8e6c0] hover:border-[#3f8a5f]/85 hover:bg-[#122a1b]/85 hover:text-[#c4f0d6] hover:shadow-[inset_0_0_12px_rgba(63,138,95,0.15),0_0_16px_rgba(63,138,95,0.3)]'
              }`}
            >
              确认支付
            </button>}
          <button
            type="button"
            onClick={onCancelPay}
            className="flex-1 rounded-xl border border-[#d4af37]/20 bg-[#16110c]/60 px-4 py-2 text-sm font-normal text-[#a99b80] backdrop-blur transition hover:border-[#d4af37]/45 hover:bg-[#1d1610]/80 hover:text-[#cbb27f] hover:shadow-[inset_0_0_10px_rgba(212,175,55,0.12),0_0_10px_rgba(212,175,55,0.15)]"
          >
            {requiresConfirmation ? '取消' : '关闭'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 金额明细行（局部子组件，仅本文件使用） */
function Row({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-center justify-between -mx-2 rounded-md px-2 py-1 transition-all hover:bg-[#d4af37]/10 hover:shadow-[inset_2px_0_0_0_rgba(212,175,55,0.5)]">
      <span className="text-sm font-semibold text-[#a99b80]">{label}</span>
      <span
        className={`text-sm font-extrabold tracking-tight [text-shadow:0_1px_2px_rgba(0,0,0,0.6)] transition-all ${
          highlight
            ? 'text-[#e8876f] hover:[text-shadow:0_0_14px_rgba(194,74,58,0.4)]'
            : 'text-[#d9b878] hover:[text-shadow:0_0_14px_rgba(212,175,55,0.35)]'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

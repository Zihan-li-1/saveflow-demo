// lib/format.ts
/**
 * 数字格式化工具（卡片组件共用）
 */

/**
 * 千分位格式化：8460 -> "8,460"，-1280 -> "-1,280"
 * 不包含货币符号，由组件按需拼接「¥」等前缀。
 */
export function formatAmount(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

/**
 * 带正负号格式化：620 -> "+620"，-430 -> "-430"，0 -> "0"
 * 用于展示环比、分类变化等有方向性的金额。
 */
export function formatSigned(value: number): string {
  if (value > 0) return `+${formatAmount(value)}`;
  return formatAmount(value);
}

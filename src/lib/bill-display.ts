/** Presentation only. All monetary inputs remain integer fen. */
export function billFen(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function formatBillMoney(value: number | undefined, signed = false): string {
  if (value === undefined || !Number.isSafeInteger(value)) return "—";
  const fen = BigInt(value);
  const zero = BigInt(0);
  const hundred = BigInt(100);
  const absolute = fen < zero ? -fen : fen;
  const yuan = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(Number(absolute / hundred));
  const decimals = String(absolute % hundred).padStart(2, "0");
  const sign = fen < zero ? "−" : signed && fen > zero ? "+" : "";
  return `${sign}¥${yuan}.${decimals}`;
}

export function formatBillMonth(value: unknown): string {
  if (typeof value !== "string" || !/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value)) return "月份未知";
  return `${value.slice(0, 4)} 年 ${Number(value.slice(5))} 月`;
}

export function formatBillAsOf(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return "日期未知";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "日期未知";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value;
  return `${part("year")}年${part("month")}月${part("day")}日 ${part("hour")}:${part("minute")}（北京时间）`;
}

export function billCategories(value: unknown, expenseFen: number | undefined): Array<{ name: string; amountFen: number }> {
  if (!value || typeof value !== "object" || Array.isArray(value) || expenseFen === undefined || expenseFen === 0) return [];
  const entries = Object.entries(value);
  if (!entries.length || entries.some(([name, amount]) => !name.trim() || billFen(amount) === undefined)) return [];
  const categories = entries.map(([name, amount]) => ({ name, amountFen: amount as number }));
  // Only display a complete, consistent breakdown. Never invent a missing category.
  if (categories.reduce((total, item) => total + BigInt(item.amountFen), BigInt(0)) !== BigInt(expenseFen)) return [];
  return categories.sort((a, b) => b.amountFen - a.amountFen);
}

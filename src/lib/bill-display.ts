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

export function formatBillPeriod(month: unknown, period: unknown): string {
  if (typeof month === "string") return formatBillMonth(month);
  if (!period || typeof period !== "object" || Array.isArray(period)) return "时间范围未知";
  const value = period as Record<string, unknown>;
  if (typeof value.label === "string" && value.label.trim()) return value.label;
  if (typeof value.startDate === "string" && typeof value.endDate === "string") return `${value.startDate} 至 ${value.endDate}`;
  return "时间范围未知";
}

export function formatBillDateRange(period: unknown): string | undefined {
  if (!period || typeof period !== "object" || Array.isArray(period)) return undefined;
  const value = period as Record<string, unknown>;
  if (typeof value.startDate !== "string" || typeof value.endDate !== "string") return undefined;
  const format = (date: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    return match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : undefined;
  };
  const start = format(value.startDate); const end = format(value.endDate);
  return start && end ? `${start}—${end}` : undefined;
}

export function formatCompactBillMoney(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return "—";
  if (value >= 1_000_000) return `¥${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}万`;
  return formatBillMoney(value);
}

export function shouldShowMonthlyBillChart(period: unknown, monthCount: number): boolean {
  if (monthCount <= 2 || !period || typeof period !== "object" || Array.isArray(period)) return false;
  const value = period as Record<string, unknown>;
  if (typeof value.startDate !== "string" || typeof value.endDate !== "string") return false;
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(value.startDate) || !datePattern.test(value.endDate)) return false;
  const start = new Date(`${value.startDate}T00:00:00Z`);
  const end = new Date(`${value.endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  const targetMonth = start.getUTCMonth() + 2;
  const targetYear = start.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastTargetDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const twoMonthsLater = new Date(Date.UTC(targetYear, normalizedMonth, Math.min(start.getUTCDate(), lastTargetDay)));
  return end.getTime() > twoMonthsLater.getTime();
}

export type BillMonthRow = { month: string; status: "complete" | "partial" | "future" | "unavailable"; totalIncomeFen: number; totalExpenseFen: number; transactionCount: number };

export function billMonthlyBreakdown(value: unknown): BillMonthRow[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 13) return [];
  const rows = value.filter(row => row && typeof row === "object" && !Array.isArray(row)).map(row => row as Record<string, unknown>);
  if (rows.length !== value.length || rows.some(row => typeof row.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month) || !["complete", "partial", "future", "unavailable"].includes(String(row.status)) || billFen(row.totalIncomeFen) === undefined || billFen(row.totalExpenseFen) === undefined || billFen(row.transactionCount) === undefined)) return [];
  return rows.map(row => ({ month: row.month as string, status: row.status as BillMonthRow["status"], totalIncomeFen: row.totalIncomeFen as number, totalExpenseFen: row.totalExpenseFen as number, transactionCount: row.transactionCount as number }));
}

export function billMonthLabel(month: string, showYear: boolean): string {
  return showYear ? `${month.slice(0, 4)}/${month.slice(5)}` : `${Number(month.slice(5))}月`;
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

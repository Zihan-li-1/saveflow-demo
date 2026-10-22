import { validCalendarDate, validTimezone } from './calendar.mjs';

export type ResponseFailure = { reason: 'INVALID_HTTP_RESPONSE' | 'INVALID_REPLY_ENVELOPE' | 'INVALID_BILL_PERIOD' | 'INVALID_MONTHLY_STATUS' | 'INVALID_BILL_TOTALS' | 'INVALID_EVIDENCE'; path: string };
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: RecordValue, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const month = (value: unknown): value is string => typeof value === 'string' && validCalendarDate(`${value}-01`);
const timestamp = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && validCalendarDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
const totals = (value: RecordValue) => {
  if (!nonnegative(value.totalIncomeFen) || !nonnegative(value.totalExpenseFen) || !nonnegative(value.transactionCount) || !record(value.categoryTotals)) return false;
  const entries = Object.entries(value.categoryTotals);
  return entries.every(([name, amount]) => !!name.trim() && nonnegative(amount)) &&
    entries.reduce((sum, [, amount]) => sum + BigInt(amount as number), BigInt(0)) === BigInt(value.totalExpenseFen);
};
const totalKeys = ['totalIncomeFen', 'totalExpenseFen', 'transactionCount', 'categoryTotals'];

/** Validate untrusted bill data before presentation. Diagnostics contain fixed schema paths only. */
export function billResponseFailure(data: RecordValue): ResponseFailure | undefined {
  const fail = (reason: ResponseFailure['reason'], path: string): ResponseFailure => ({ reason, path });
  if (data.action !== 'bill.summary' || !keys(data, ['status', 'action', 'data', 'evidence']) || !record(data.data)) return fail('INVALID_REPLY_ENVELOPE', 'data');
  const bill = data.data;
  if (!keys(bill, [...totalKeys, 'month', 'period', 'monthlyBreakdown', 'coverage'])) return fail('INVALID_BILL_TOTALS', 'data.data');
  if (('month' in bill) === ('period' in bill)) return fail('INVALID_BILL_PERIOD', 'data.data.period');
  let startMonth: string, endMonth: string;
  if ('month' in bill) {
    if (!month(bill.month)) return fail('INVALID_BILL_PERIOD', 'data.data.month');
    startMonth = endMonth = bill.month;
  } else {
    const p = bill.period;
    if (!record(p) || !keys(p, ['startDate', 'endDate', 'timezone', 'label']) ||
        !validCalendarDate(p.startDate) || !validCalendarDate(p.endDate) || !validTimezone(p.timezone) ||
        typeof p.startDate !== 'string' || typeof p.endDate !== 'string' || p.startDate > p.endDate ||
        Date.parse(`${p.endDate}T00:00:00Z`) - Date.parse(`${p.startDate}T00:00:00Z`) >= 366 * 86400000 ||
        typeof p.label !== 'string' || !p.label.trim() || p.label.length > 80) return fail('INVALID_BILL_PERIOD', 'data.data.period');
    startMonth = p.startDate.slice(0, 7); endMonth = p.endDate.slice(0, 7);
  }
  if (!totals(bill)) return fail('INVALID_BILL_TOTALS', 'data.data.categoryTotals');
  if ('period' in bill || 'monthlyBreakdown' in bill) {
    const rows = bill.monthlyBreakdown;
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 13) return fail('INVALID_BILL_TOTALS', 'data.data.monthlyBreakdown');
    let expected = startMonth;
    const categorySums = new Map<string, bigint>();
    for (const [index, row] of rows.entries()) {
      const path = `data.data.monthlyBreakdown[${index}]`;
      if (!record(row) || !keys(row, [...totalKeys, 'month', 'status'])) return fail('INVALID_BILL_TOTALS', path);
      if (typeof row.status !== 'string' || !['complete', 'partial', 'future', 'unavailable'].includes(row.status)) return fail('INVALID_MONTHLY_STATUS', `${path}.status`);
      if (!month(row.month) || row.month !== expected || row.month > endMonth) return fail('INVALID_BILL_PERIOD', `${path}.month`);
      if (!totals(row)) return fail('INVALID_BILL_TOTALS', path);
      for (const [name, amount] of Object.entries(row.categoryTotals as RecordValue)) categorySums.set(name, (categorySums.get(name) ?? BigInt(0)) + BigInt(amount as number));
      const next = new Date(`${row.month}-01T00:00:00Z`);
      next.setUTCMonth(next.getUTCMonth() + 1);
      expected = next.toISOString().slice(0, 7);
    }
    if (rows.at(-1).month !== endMonth) return fail('INVALID_BILL_PERIOD', 'data.data.monthlyBreakdown');
    for (const field of totalKeys.slice(0, 3)) {
      if (rows.reduce((sum, row) => sum + BigInt(row[field]), BigInt(0)) !== BigInt(bill[field] as number)) return fail('INVALID_BILL_TOTALS', `data.data.${field}`);
    }
    const categories = bill.categoryTotals as RecordValue;
    if ([...new Set([...categorySums.keys(), ...Object.keys(categories)])].some(name => (categorySums.get(name) ?? BigInt(0)) !== BigInt((categories[name] ?? 0) as number))) return fail('INVALID_BILL_TOTALS', 'data.data.categoryTotals');
  }
  if ('coverage' in bill) {
    const c = bill.coverage;
    if (!record(c) || !keys(c, ['status', 'asOf', 'availableMonths', 'warning']) || c.status !== 'unverified' || !timestamp(c.asOf) ||
        !Array.isArray(c.availableMonths) || !c.availableMonths.every(month) || new Set(c.availableMonths).size !== c.availableMonths.length ||
        typeof c.warning !== 'string' || !c.warning.trim()) return fail('INVALID_EVIDENCE', 'data.data.coverage');
  }
  if (!Array.isArray(data.evidence) || data.evidence.length !== 1) return fail('INVALID_EVIDENCE', 'data.evidence');
  const e = data.evidence[0];
  if (!record(e) || !keys(e, ['source', 'asOf', 'entityIds']) || e.source !== 'synthetic_demo_only' || !timestamp(e.asOf) ||
      !Array.isArray(e.entityIds) || e.entityIds.length !== bill.transactionCount || e.entityIds.some(id => typeof id !== 'string' || !id.trim()) ||
      new Set(e.entityIds).size !== e.entityIds.length || (record(bill.coverage) && bill.coverage.asOf !== e.asOf)) return fail('INVALID_EVIDENCE', 'data.evidence[0]');
}

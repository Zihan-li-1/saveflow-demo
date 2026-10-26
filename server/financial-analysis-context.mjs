import { localDate, validCalendarDate, validTimezone } from '../src/lib/calendar.mjs';
import { summarizeBills } from '../src/skills/bill/bill-summary.mjs';

const validMonth = value => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && validCalendarDate(`${value}-01`);
const monthEnd = month => {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
};
function monthsBetween(start, end) {
  const months = [];
  let cursor = new Date(`${start.slice(0, 7)}-01T00:00:00Z`);
  while (cursor.toISOString().slice(0, 7) <= end.slice(0, 7)) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}
const summarize = rows => {
  if (!rows.length) return null;
  const summary = summarizeBills(rows);
  return { ...summary, netCashFlowFen: summary.totalIncomeFen - summary.totalExpenseFen };
};

/**
 * Read-only, on-demand server aggregates. No model, writes, raw-detail output or cache.
 * `month`/`period` reuse the existing bill intent's time slots; do not pass model results as facts.
 * @param {Pick<import('../src/banking-core/contracts').FinancialContextRepository, 'getContextInfo'|'getTransactions'>} repository
 * @param {{month?: string, period?: {start_date: string, end_date: string, timezone?: string}, timezone?: string, now?: ()=>number}} [options]
 */
export async function buildFinancialAnalysisContext(repository, options = {}) {
  const { month, period, now = Date.now } = options;
  const timezone = period?.timezone ?? options.timezone ?? 'Asia/Shanghai';
  if (!validTimezone(timezone) || (month !== undefined && !validMonth(month)) || (month !== undefined && period !== undefined)) {
    throw new TypeError('Invalid financial analysis period');
  }
  if (period && (!validCalendarDate(period.start_date) || !validCalendarDate(period.end_date) || period.start_date > period.end_date ||
      (Date.parse(period.end_date) - Date.parse(period.start_date)) / 86400000 >= 366)) {
    throw new TypeError('Financial analysis range must contain 1–366 calendar days');
  }
  const explicit = month !== undefined || period !== undefined;
  const startDate = month ? `${month}-01` : period?.start_date;
  const endDate = month ? monthEnd(month) : period?.end_date;
  const [context, transactions] = await Promise.all([
    repository.getContextInfo(),
    repository.getTransactions(explicit ? { startDate, endDate, timezone } : {}),
  ]);
  if (context.currency !== 'CNY' || !Number.isFinite(Date.parse(context.asOf))) throw new TypeError('Invalid financial source metadata');
  const currentDate = localDate(now(), timezone);
  const asOfDate = localDate(context.asOf, timezone);
  const cutoff = currentDate < asOfDate ? currentDate : asOfDate;
  const declared = context.availableMonths;
  if (declared !== undefined && (!Array.isArray(declared) || declared.some(value => !validMonth(value)))) throw new TypeError('Invalid available months');
  // Repository is the only fact source. Fail closed on data outside its money contract.
  const records = transactions.map(transaction => {
    if (transaction.status !== 'posted' || transaction.currency !== 'CNY' ||
        !['income', 'expense', 'transfer_out'].includes(transaction.type) ||
        !Number.isSafeInteger(transaction.amountFen) || transaction.amountFen < 0 ||
        typeof transaction.category !== 'string' || !transaction.category.trim() || !Number.isFinite(Date.parse(transaction.occurredAt))) {
      throw new TypeError('Invalid repository transaction');
    }
    return { transaction, date: localDate(transaction.occurredAt, timezone) };
  });
  const observedMonths = [...new Set(records.map(row => row.date.slice(0, 7)))].sort();
  const availableMonths = (declared ?? observedMonths).filter(value => observedMonths.includes(value));
  const completeMonths = [...new Set(availableMonths)].filter(value => monthEnd(value) < cutoff).sort();
  // If no complete month exists, expose available partial records honestly.
  const defaultMonths = completeMonths.length ? completeMonths : [...new Set(availableMonths)].filter(value => `${value}-01` <= cutoff).sort();
  const selectedMonths = explicit ? monthsBetween(startDate, endDate) : defaultMonths.slice(-3);
  const selected = records.filter(row => selectedMonths.includes(row.date.slice(0, 7)) && row.date <= currentDate &&
    (!explicit || (row.date >= startDate && row.date <= endDate)));
  const monthly = selectedMonths.map(value => {
    const rows = selected.filter(row => row.date.startsWith(value));
    const fullCalendarMonth = monthEnd(value) < cutoff;
    const fullSelection = !explicit || (startDate <= `${value}-01` && endDate >= monthEnd(value));
    return { month: value, status: !rows.length ? 'unavailable' : fullCalendarMonth && fullSelection && availableMonths.includes(value) ? 'available' : 'partial',
      summary: summarize(rows.map(row => row.transaction)),
      observedStartDate: rows.length ? rows.map(row => row.date).sort()[0] : null,
      observedEndDate: rows.length ? rows.map(row => row.date).sort().at(-1) : null };
  });
  const dates = selected.map(row => row.date).sort();
  const spanMonths = selectedMonths.length ? monthsBetween(`${selectedMonths[0]}-01`, monthEnd(selectedMonths.at(-1))) : [];
  const missingMonths = spanMonths.filter(value => !selected.some(row => row.date.startsWith(value)));
  const summary = summarize(selected.map(row => row.transaction));
  const insufficient = !explicit && selectedMonths.filter(value => completeMonths.includes(value)).length < 3;
  return {
    schemaVersion: '1.0.0', status: !summary ? 'unavailable' : insufficient || missingMonths.length || monthly.some(row => row.status !== 'available') ? 'partial' : 'available',
    currency: 'CNY',
    range: { selection: explicit ? 'explicit' : 'latest_available_complete_months', timezone,
      startDate: startDate ?? (selectedMonths.length ? `${selectedMonths[0]}-01` : null),
      endDate: endDate ?? (selectedMonths.length ? monthEnd(selectedMonths.at(-1)) : null), months: selectedMonths, targetMonthCount: explicit ? null : 3 },
    summary, monthly,
    coverage: { currentDate, asOfDate, completeMonths, missingMonths, insufficientMonths: insufficient,
      observedStartDate: dates[0] ?? null, observedEndDate: dates.at(-1) ?? null,
      completeness: 'unverified', warning: '仅统计实际可用的已入账记录；完整自然月不等于流水已完整核验。缺月和无记录不代表零支出。' },
    source: { repository: 'financial_context.transactions', datasetId: context.datasetId, snapshotId: context.snapshotId,
      dataSource: context.dataSource, asOf: context.asOf, transactionSources: [...new Set(selected.map(row => row.transaction.source))].sort() },
    methodology: { incomeTypes: ['income'], expenseTypes: ['expense'], excludedTypes: ['transfer_out'],
      netCashFlow: 'totalIncomeFen - totalExpenseFen; excludes transfers', amountUnit: 'integer_fen' },
  };
}

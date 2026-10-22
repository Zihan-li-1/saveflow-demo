import { localDate, validTimezone } from '../src/lib/calendar.mjs';

/** Server-owned clock; financial snapshots must never supply the calendar. */
export function understandingContext({ now = Date.now, timezone = 'Asia/Shanghai', financialContext } = {}) {
  if (!validTimezone(timezone)) throw new Error('Invalid user timezone');
  const instant = new Date(now());
  return {
    currentTime: instant.toISOString(), currentDate: localDate(instant, timezone), timezone,
    dateRangeConvention: 'inclusive local calendar dates: start_date <= transaction local date <= end_date',
    ...(financialContext ? { financialData: financialContext } : {}),
  };
}

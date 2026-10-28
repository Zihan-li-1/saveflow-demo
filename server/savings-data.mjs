import { summarizeBills } from '../src/skills/bill/bill-summary.mjs';

const postedSummary = transactions => summarizeBills(transactions.filter(item => item.status === 'posted'));

export async function collectSavingsData(repository, currentDate) {
  const requiredMonth = new Date(Date.UTC(Number(currentDate.slice(0, 4)), Number(currentDate.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
  const context = await repository.getContextInfo();
  const asOfMonth = /^\d{4}-(0[1-9]|1[0-2])/.test(context.asOf || '') ? context.asOf.slice(0, 7) : '';
  const available = [...new Set((context.availableMonths || []).filter(month => /^\d{4}-(0[1-9]|1[0-2])$/.test(month)))].sort();
  const history = [];
  for (const month of available.filter(month => month < requiredMonth && month < asOfMonth)) {
    history.push({ month, category_expenses_minor: postedSummary(await repository.getTransactions({ month })).categoryTotals });
  }
  let recent = null;
  // availableMonths only means records exist; it does not certify complete coverage.
  if (available.includes(requiredMonth) && (context.completeMonths || []).includes(requiredMonth) && requiredMonth < asOfMonth) {
    const summary = postedSummary(await repository.getTransactions({ month: requiredMonth }));
    recent = { month: requiredMonth, income_minor: summary.totalIncomeFen, category_expenses_minor: summary.categoryTotals };
  }
  const categories = [...new Set([...history.flatMap(item => Object.keys(item.category_expenses_minor)), ...Object.keys(recent?.category_expenses_minor || {})])].sort();
  if (recent) for (const category of categories) recent.category_expenses_minor[category] ??= 0;
  const recentSource = recent ? 'repository' : 'user_provided';
  return { requiredMonth, context, history, recent, categories, recentSource,
    sources: { recent: recentSource, recent_as_of: recent ? context.asOf : currentDate, history: context.dataSource || 'synthetic_demo_only', history_as_of: context.asOf } };
}


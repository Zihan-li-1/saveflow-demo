function expenseTotals(transactions) {
  const totals = {};
  for (const item of transactions) {
    if (item.status !== 'posted' || item.type !== 'expense' || typeof item.category !== 'string' || !item.category ||
      !Number.isSafeInteger(item.amountFen) || item.amountFen < 0) continue;
    totals[item.category] = (totals[item.category] || 0) + item.amountFen;
  }
  return totals;
}

export async function collectSavingsData(repository, currentDate) {
  const requiredMonth = new Date(Date.UTC(Number(currentDate.slice(0, 4)), Number(currentDate.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
  const context = await repository.getContextInfo();
  const asOfMonth = /^\d{4}-(0[1-9]|1[0-2])/.test(context.asOf || '') ? context.asOf.slice(0, 7) : '';
  const available = [...new Set((context.availableMonths || []).filter(month => /^\d{4}-(0[1-9]|1[0-2])$/.test(month)))].sort();
  const history = [];
  for (const month of available.filter(month => month < requiredMonth && month < asOfMonth)) {
    history.push({ month, category_expenses_minor: expenseTotals(await repository.getTransactions({ month })) });
  }
  let recent = null;
  // availableMonths only means records exist; it does not certify complete coverage.
  if (available.includes(requiredMonth) && (context.completeMonths || []).includes(requiredMonth) && requiredMonth < asOfMonth) {
    const transactions = await repository.getTransactions({ month: requiredMonth });
    const income_minor = transactions.filter(item => item.status === 'posted' && item.type === 'income' && Number.isSafeInteger(item.amountFen) && item.amountFen >= 0)
      .reduce((sum, item) => sum + item.amountFen, 0);
    recent = { month: requiredMonth, income_minor, category_expenses_minor: expenseTotals(transactions) };
  }
  const categories = [...new Set([...history.flatMap(item => Object.keys(item.category_expenses_minor)), ...Object.keys(recent?.category_expenses_minor || {})])].sort();
  if (recent) for (const category of categories) recent.category_expenses_minor[category] ??= 0;
  const recentSource = recent ? 'repository' : 'user_provided';
  return { requiredMonth, context, history, recent, categories, recentSource,
    sources: { recent: recentSource, recent_as_of: recent ? context.asOf : currentDate, history: context.dataSource || 'synthetic_demo_only', history_as_of: context.asOf } };
}


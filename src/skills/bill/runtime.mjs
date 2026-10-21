function assertFen(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} 必须是非负整数分`);
}

export function summarizeTransactions(transactions) {
  const result = { totalIncomeFen: 0, totalExpenseFen: 0, transactionCount: transactions.length, categoryTotals: {} };
  for (const transaction of transactions) {
    assertFen(transaction.amountFen, 'transaction.amountFen');
    if (transaction.type === 'income') result.totalIncomeFen += transaction.amountFen;
    if (transaction.type === 'expense') {
      result.totalExpenseFen += transaction.amountFen;
      result.categoryTotals[transaction.category] = (result.categoryTotals[transaction.category] ?? 0) + transaction.amountFen;
    }
  }
  return result;
}

function previousMonth(month) {
  const [year, value] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, value - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function categoryCounts(transactions) {
  const counts = {};
  for (const transaction of transactions) {
    if (transaction.type !== 'expense') continue;
    const item = counts[transaction.category] ?? { amountFen: 0, transactionCount: 0 };
    item.amountFen += transaction.amountFen;
    item.transactionCount++;
    counts[transaction.category] = item;
  }
  return counts;
}

export async function analyzeMonth(repository, month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new TypeError('month 必须是 YYYY-MM');
  const comparisonMonth = previousMonth(month);
  const [current, comparison, context] = await Promise.all([
    repository.getTransactions({ month }),
    repository.getTransactions({ month: comparisonMonth }),
    repository.getContextInfo(),
  ]);
  const summary = summarizeTransactions(current);
  const comparisonSummary = summarizeTransactions(comparison);
  const currentCategories = categoryCounts(current);
  const comparisonCategories = categoryCounts(comparison);
  const categories = Object.entries(currentCategories)
    .map(([category, value]) => ({ category, amountFen: value.amountFen, transactionCount: value.transactionCount }))
    .sort((a, b) => b.amountFen - a.amountFen || a.category.localeCompare(b.category));
  const topIncreasedCategories = [...new Set([...Object.keys(currentCategories), ...Object.keys(comparisonCategories)])]
    .map(category => ({
      category,
      currentAmountFen: currentCategories[category]?.amountFen ?? 0,
      previousAmountFen: comparisonCategories[category]?.amountFen ?? 0,
      increaseFen: (currentCategories[category]?.amountFen ?? 0) - (comparisonCategories[category]?.amountFen ?? 0),
    }))
    .filter(item => item.increaseFen > 0)
    .sort((a, b) => b.increaseFen - a.increaseFen || a.category.localeCompare(b.category))
    .slice(0, 3);
  const expenses = current.filter(transaction => transaction.type === 'expense')
    .sort((a, b) => b.amountFen - a.amountFen || a.id.localeCompare(b.id));
  const average = expenses.length ? Math.floor(summary.totalExpenseFen / expenses.length) : 0;
  const unusualTransactions = expenses
    .filter((transaction, index) => index === 0 || transaction.amountFen >= average * 2)
    .slice(0, 3)
    .map((transaction, index) => ({
      transactionId: transaction.id,
      occurredAt: transaction.occurredAt,
      merchant: transaction.merchant,
      category: transaction.category,
      amountFen: transaction.amountFen,
      reason: index === 0 ? 'largest_expense' : 'at_least_twice_period_average',
    }));
  return {
    ...summary,
    month,
    comparisonMonth,
    previousExpenseFen: comparisonSummary.totalExpenseFen,
    changeAmountFen: summary.totalExpenseFen - comparisonSummary.totalExpenseFen,
    changeRateBps: comparisonSummary.totalExpenseFen === 0 ? null : Math.round(((summary.totalExpenseFen - comparisonSummary.totalExpenseFen) * 10_000) / comparisonSummary.totalExpenseFen),
    categories,
    topIncreasedCategories,
    unusualTransactions,
    methodology: { version: 'bill-analysis-v1', expenseTypes: ['expense'], excludedTypes: ['income', 'transfer_out'], comparison: 'previous_calendar_month' },
    evidence: [{ source: context.dataSource, asOf: context.asOf, entityIds: [...current, ...comparison].map(transaction => transaction.id) }],
  };
}

export async function querySubscriptions(repository) {
  const [subscriptions, context] = await Promise.all([repository.getSubscriptions(), repository.getContextInfo()]);
  for (const subscription of subscriptions) assertFen(subscription.monthlyFeeFen, 'subscription.monthlyFeeFen');
  const active = subscriptions.filter(subscription => subscription.status === 'active');
  return {
    subscriptions,
    activeCount: active.length,
    activeMonthlyTotalFen: active.reduce((sum, subscription) => sum + subscription.monthlyFeeFen, 0),
    potentiallyUnused: active.filter(subscription => subscription.isPotentiallyUnused),
    capabilities: { historicalSubscriptionState: false, cancelMerchantMembership: false, cancelBankDebit: false },
    evidence: [{ source: context.dataSource, asOf: context.asOf, entityIds: subscriptions.map(subscription => subscription.id) }],
  };
}

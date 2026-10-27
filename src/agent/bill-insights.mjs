const expense = transaction => transaction.type === 'expense';

function categoryTotals(transactions) {
  return transactions.filter(expense).reduce((totals, transaction) => {
    totals[transaction.category] = (totals[transaction.category] ?? 0) + transaction.amountFen;
    return totals;
  }, {});
}

export function previousMonth(month) {
  const [year, oneBasedMonth] = month.split('-').map(Number);
  const value = new Date(Date.UTC(year, oneBasedMonth - 2, 1));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function buildBillInsights(current, comparison, comparisonPeriod) {
  const currentExpenseFen = current.filter(expense).reduce((sum, item) => sum + item.amountFen, 0);
  const comparisonExpenseFen = comparison.filter(expense).reduce((sum, item) => sum + item.amountFen, 0);
  const currentCategories = categoryTotals(current);
  const comparisonCategories = categoryTotals(comparison);
  const categoryChanges = [...new Set([...Object.keys(currentCategories), ...Object.keys(comparisonCategories)])]
    .map(category => ({ category, currentAmountFen: currentCategories[category] ?? 0, comparisonAmountFen: comparisonCategories[category] ?? 0, changeFen: (currentCategories[category] ?? 0) - (comparisonCategories[category] ?? 0) }))
    .filter(item => item.changeFen !== 0)
    .sort((a, b) => Math.abs(b.changeFen) - Math.abs(a.changeFen) || a.category.localeCompare(b.category))
    .slice(0, 3);
  const largestExpenses = current.filter(expense)
    .sort((a, b) => b.amountFen - a.amountFen || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map(item => ({ transactionId: item.id, merchant: item.merchant, category: item.category, amountFen: item.amountFen, occurredAt: item.occurredAt }));
  return {
    comparisonPeriod,
    currentExpenseFen,
    comparisonExpenseFen,
    changeFen: currentExpenseFen - comparisonExpenseFen,
    changeRateBps: comparisonExpenseFen === 0 ? null : Math.round(((currentExpenseFen - comparisonExpenseFen) * 10_000) / comparisonExpenseFen),
    categoryChanges,
    largestExpenses,
    comparisonAvailable: comparison.length > 0,
    note: comparison.length > 0 ? '与紧邻的等长上一时间段比较；仅统计支出交易。' : '上一时间段没有可用交易记录，无法计算可靠涨跌比例。',
  };
}

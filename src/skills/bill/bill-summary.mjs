// Shared by the existing bill Skill/runtime and server financial context.
// @ts-check
/** @param {import('../../banking-core/contracts').Transaction[]} transactions */
export function summarizeBills(transactions) {
  let totalIncomeFen = 0;
  let totalExpenseFen = 0;
  /** @type {Record<string, number>} */
  const categoryTotals = {};
  for (const transaction of transactions) {
    if (!Number.isSafeInteger(transaction.amountFen) || transaction.amountFen < 0) {
      throw new TypeError('transaction.amountFen 必须是非负整数分');
    }
    if (transaction.type === 'income') totalIncomeFen += transaction.amountFen;
    if (transaction.type === 'expense') {
      totalExpenseFen += transaction.amountFen;
      // Define own properties so even a category named __proto__ is ordinary data.
      Object.defineProperty(categoryTotals, transaction.category, { enumerable: true, configurable: true, writable: true,
        value: (Object.hasOwn(categoryTotals, transaction.category) ? categoryTotals[transaction.category] : 0) + transaction.amountFen });
    }
  }
  if (![totalIncomeFen, totalExpenseFen, ...Object.values(categoryTotals)].every(Number.isSafeInteger)) {
    throw new TypeError('账单汇总超过安全整数分');
  }
  return { totalIncomeFen, totalExpenseFen, transactionCount: transactions.length, categoryTotals };
}

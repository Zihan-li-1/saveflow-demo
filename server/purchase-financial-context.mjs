import { handleBillSummary } from '../src/agent/runtime.mjs';

/** Reuse B's read repository and existing Bill query; never touch its write port.
 * Historical expense is not proof of future obligations or today's balance.
 */
export async function purchaseFinancialContext(repository, rawAccount) {
  const context = await repository.getContextInfo();
  const normalize = s => s.replace(/^我的?/, '').replace(/账户$/, '').trim();
  const query = normalize(rawAccount ?? '');
  const accounts = (await repository.getAccounts()).filter(a => a.status === 'active' &&
    (normalize(a.name) === query || (query === '活期' && a.type === 'checking')));
  const account = accounts.length === 1 ? accounts[0] : undefined;
  const bill = await handleBillSummary({ action: 'bill.summary', slots: { month: context.currentMonth } }, repository);
  return { ...(account ? { account_ref: account.id, available_minor: account.availableBalanceFen } : {}),
    source: context.dataSource, as_of: context.asOf, bill_summary: bill.data,
    evidence: [{ source: 'financial_context.accounts', as_of: context.asOf }, { source: 'bill.summary', as_of: context.asOf, coverage: bill.data.coverage }] };
}

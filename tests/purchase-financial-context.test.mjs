import test from 'node:test';
import assert from 'node:assert/strict';
import { createFinancialContext } from '../src/banking-core/repository.mjs';
import { purchaseFinancialContext } from '../server/purchase-financial-context.mjs';
test('purchase consults existing account and Bill APIs without treating old history as upcoming obligations', async () => {
  const { repository } = createFinancialContext();
  const account = (await repository.getAccounts()).find(a => a.type === 'checking');
  const result = await purchaseFinancialContext(repository, account.name);
  assert.equal(result.account_ref, account.id); assert.equal(result.available_minor, account.availableBalanceFen);
  assert.equal(result.obligations_minor, undefined);
  assert.equal(result.as_of, (await repository.getContextInfo()).asOf);
  assert.ok(result.evidence.some(e => e.source === 'bill.summary'));
  assert.ok(result.bill_summary.coverage.warning);
  const unknown = await purchaseFinancialContext(repository, '不存在的账户'); assert.equal(unknown.account_ref, undefined);
});

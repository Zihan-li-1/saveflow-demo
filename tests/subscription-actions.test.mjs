import test from 'node:test';
import assert from 'node:assert/strict';
import { createBankingCore } from '../src/banking-core/core.mjs';

const unwrap = result => { assert.equal(result.ok, true, result.error?.message); return result.data; };
async function confirmAndExecute(core, prepared) {
  unwrap(await core.decide(prepared.operationId, { previewHash: prepared.preview.previewHash, decision: 'confirm', confirmedStepIds: prepared.preview.stepIds }));
  return unwrap(await core.execute(prepared.operationId, prepared.preview.previewHash));
}

test('停止自动续费仅更新订阅状态，不退款也不写流水', async () => {
  const core = createBankingCore();
  const subscription = core.repository.getSubscriptions().find(item => item.status === 'active');
  const accountsBefore = core.repository.getAccounts();
  const transactionsBefore = core.repository.getTransactions();
  const prepared = unwrap(await core.prepare({ action: 'subscription.cancel_renewal', input: { subscriptionId: subscription.id } }));
  assert.match(prepared.preview.summary, /不产生退款|停止/);
  assert.deepEqual(core.repository.getSubscriptions().find(item => item.id === subscription.id), subscription);
  const receipt = await confirmAndExecute(core, prepared);
  assert.equal(receipt.transactionIds.length, 0);
  assert.equal(core.repository.getSubscriptions().find(item => item.id === subscription.id).status, 'cancelled');
  assert.deepEqual(core.repository.getAccounts(), accountsBefore);
  assert.deepEqual(core.repository.getTransactions(), transactionsBefore);
});

test('续订必须选账户，确认后只扣一期并写入娱乐流水，重复执行不重复扣款', async () => {
  const core = createBankingCore();
  const active = core.repository.getSubscriptions().find(item => item.status === 'active');
  const cancel = unwrap(await core.prepare({ action: 'subscription.cancel_renewal', input: { subscriptionId: active.id } }));
  await confirmAndExecute(core, cancel);
  const missing = await core.prepare({ action: 'subscription.renew', input: { subscriptionId: active.id } });
  assert.equal(missing.ok, false);
  const account = core.repository.getAccounts()[0];
  const beforeCount = core.repository.getTransactions().length;
  const prepared = unwrap(await core.prepare({ action: 'subscription.renew', input: { subscriptionId: active.id, sourceAccountId: account.id } }));
  assert.equal(prepared.preview.exactEffects[0].category, '娱乐');
  assert.equal(core.repository.getAccount(account.id).balanceFen, account.balanceFen);
  const first = await confirmAndExecute(core, prepared);
  const second = unwrap(await core.execute(prepared.operationId, prepared.preview.previewHash));
  assert.deepEqual(second, first);
  const transaction = core.repository.getTransactions().find(item => item.operationId === prepared.operationId);
  assert.equal(transaction.accountId, account.id);
  assert.equal(transaction.type, 'expense');
  assert.equal(transaction.category, '娱乐');
  assert.equal(transaction.merchant, active.name);
  assert.equal(core.repository.getTransactions().length, beforeCount + 1);
  assert.equal(core.repository.getAccount(account.id).balanceFen, account.balanceFen - active.monthlyFeeFen);
  assert.equal(core.repository.getSubscriptions().find(item => item.id === active.id).status, 'active');
});

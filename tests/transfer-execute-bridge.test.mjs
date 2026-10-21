import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { executeTrialTransfer, handleExecuteTrial } from '../server/transfer-execute-bridge.mjs';

// 验证「执行桥」：TrueForge 试点预览（tfpreview:）→ 授权确认 → 执行 → 回执 → 扣款。
// 安全性质：篡改哈希拒绝、非试点编号拒绝、幂等只扣一次。

const unwrap = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
const balance = core => core.repository.getAccount('ACC-CHECKING').availableBalanceFen;

async function preview(core, amountFen = 50000) {
  return unwrap(await core.prepare({ action: 'transfer_money', input: { fromAccountId: 'ACC-CHECKING', payeeId: 'payee_001', amountFen, currency: 'CNY' }, origin: 'agent_suggested' }));
}

test('执行桥：tfpreview 预览 → 授权确认 → 执行 → 回执 → 扣款', async () => {
  const core = createBankingCore();
  const prepared = await preview(core, 50000);
  assert.equal(balance(core), 500000); // 预览未扣款

  const result = await executeTrialTransfer(core, { trialOperationId: `tfpreview:${prepared.operationId}`, previewHash: prepared.preview.previewHash });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.status, 'succeeded');
  assert.equal(result.data.effects[0].amountFen, 50000);
  assert.equal(balance(core), 450000); // 执行后扣款
});

test('执行桥：篡改预览哈希被拒绝，不扣款', async () => {
  const core = createBankingCore();
  const prepared = await preview(core, 50000);
  const result = await executeTrialTransfer(core, { trialOperationId: `tfpreview:${prepared.operationId}`, previewHash: 'f'.repeat(64) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONFIRMATION_INVALID');
  assert.equal(balance(core), 500000); // 未扣款
});

test('执行桥：拒绝非试点编号', async () => {
  const core = createBankingCore();
  const result = await executeTrialTransfer(core, { trialOperationId: 'op_not_a_trial', previewHash: 'a'.repeat(64) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'VALIDATION_ERROR');
});

test('执行桥：幂等——重复执行返回同一回执，只扣一次款', async () => {
  const core = createBankingCore();
  const prepared = await preview(core, 50000);
  const first = await executeTrialTransfer(core, { trialOperationId: `tfpreview:${prepared.operationId}`, previewHash: prepared.preview.previewHash });
  const second = await executeTrialTransfer(core, { trialOperationId: `tfpreview:${prepared.operationId}`, previewHash: prepared.preview.previewHash });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.data.receiptId, second.data.receiptId);
  assert.equal(balance(core), 450000); // 只扣一次
  const transactions = await core.repository.getTransactions({ accountId: 'ACC-CHECKING' });
  assert.equal(transactions.filter(transaction => transaction.operationId === prepared.operationId).length, 1); // 只记一笔账
});

function httpRequest(trialOperationId, previewHash, accessCode = 'x'.repeat(16)) {
  return new Request('http://localhost/api/execute-trial', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Saveflow-Access': accessCode },
    body: JSON.stringify({ trialOperationId, previewHash }),
  });
}

test('执行桥 HTTP：授权后执行试点转账并返回回执，扣款一次', async () => {
  const core = createBankingCore();
  const prepared = await preview(core, 50000);
  const response = await handleExecuteTrial(httpRequest(`tfpreview:${prepared.operationId}`, prepared.preview.previewHash), { env: { SAVEFLOW_ACCESS_CODE: 'x'.repeat(16) }, core });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.code, 'OK');
  assert.equal(payload.data.status, 'succeeded');
  assert.equal(payload.data.effects[0].amountFen, 50000);
  assert.equal(balance(core), 450000);
});

test('执行桥 HTTP：访问码错误拒绝，不扣款', async () => {
  const core = createBankingCore();
  const prepared = await preview(core, 50000);
  const response = await handleExecuteTrial(httpRequest(`tfpreview:${prepared.operationId}`, prepared.preview.previewHash, 'wrong'), { env: { SAVEFLOW_ACCESS_CODE: 'x'.repeat(16) }, core });
  assert.equal(response.status, 401);
  assert.equal(balance(core), 500000);
});

test('执行桥 HTTP：篡改哈希被拒绝，不扣款', async () => {
  const core = createBankingCore();
  const prepared = await preview(core, 50000);
  const response = await handleExecuteTrial(httpRequest(`tfpreview:${prepared.operationId}`, 'f'.repeat(64)), { env: { SAVEFLOW_ACCESS_CODE: 'x'.repeat(16) }, core });
  assert.equal(response.status, 409);
  assert.equal(balance(core), 500000);
});

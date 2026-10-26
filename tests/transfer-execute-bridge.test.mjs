import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { executeTrialTransfer, startTrialVerification, verifyTrialVerification, handleExecuteTrial } from '../server/transfer-execute-bridge.mjs';

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

// —— 高风险试点转账（>¥1000）需先 OTP 验证 ——

test('执行桥：高风险试点转账未验证时执行被拒且不扣款，操作保持未确认', async () => {
  const core = createBankingCore({ demoOtpCode: '123456' });
  const prepared = await preview(core, 200000);
  assert.equal(prepared.risk.requiredVerification, 'otp');
  const result = await executeTrialTransfer(core, { trialOperationId: `tfpreview:${prepared.operationId}`, previewHash: prepared.preview.previewHash });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'VERIFICATION_REQUIRED');
  assert.equal(balance(core), 500000); // 未扣款
  assert.equal(unwrap(await core.getOperation(prepared.operationId)).state, 'awaiting_confirmation'); // 未自动确认
});

test('执行桥：高风险试点转账 发起→校验→执行 全链路成功，只扣一次款', async () => {
  const core = createBankingCore({ demoOtpCode: '123456' });
  const prepared = await preview(core, 200000);
  const trialId = `tfpreview:${prepared.operationId}`;
  const hash = prepared.preview.previewHash;

  const started = await startTrialVerification(core, { trialOperationId: trialId, previewHash: hash });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.match(started.data.challengeId, /^otp_/);
  assert.equal(started.data.deliveryHint.includes('不返回验证码'), true);

  const verified = await verifyTrialVerification(core, { trialOperationId: trialId, previewHash: hash, challengeId: started.data.challengeId, code: '123456' });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.data.verified, true);

  const result = await executeTrialTransfer(core, { trialOperationId: trialId, previewHash: hash });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.status, 'succeeded');
  assert.equal(result.data.effects[0].amountFen, 200000);
  assert.equal(balance(core), 300000);
});

test('执行桥：高风险试点转账验证码错误被拒，不扣款', async () => {
  const core = createBankingCore({ demoOtpCode: '123456' });
  const prepared = await preview(core, 200000);
  const trialId = `tfpreview:${prepared.operationId}`;
  const hash = prepared.preview.previewHash;
  const started = await startTrialVerification(core, { trialOperationId: trialId, previewHash: hash });
  const bad = await verifyTrialVerification(core, { trialOperationId: trialId, previewHash: hash, challengeId: started.data.challengeId, code: '000000' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'VERIFICATION_INVALID');
  assert.equal(balance(core), 500000);
});

test('执行桥：试点验证入口拒绝非试点编号', async () => {
  const core = createBankingCore();
  const result = await startTrialVerification(core, { trialOperationId: 'op_not_trial', previewHash: 'a'.repeat(64) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'VALIDATION_ERROR');
});

function trialHttpRequest(body) {
  return new Request('http://localhost/api/execute-trial', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Saveflow-Access': 'x'.repeat(16) },
    body: JSON.stringify(body),
  });
}

test('执行桥 HTTP：高风险试点转账经 verification.start/verify 后执行成功', async () => {
  const core = createBankingCore({ demoOtpCode: '123456' });
  const prepared = await preview(core, 200000);
  const trialId = `tfpreview:${prepared.operationId}`;
  const hash = prepared.preview.previewHash;
  const options = { env: { SAVEFLOW_ACCESS_CODE: 'x'.repeat(16) }, core };

  const startRes = await handleExecuteTrial(trialHttpRequest({ action: 'verification.start', trialOperationId: trialId, previewHash: hash }), options);
  assert.equal(startRes.status, 200);
  const challengeId = (await startRes.json()).data.challengeId;
  assert.match(challengeId, /^otp_/);

  const verifyRes = await handleExecuteTrial(trialHttpRequest({ action: 'verification.verify', trialOperationId: trialId, previewHash: hash, challengeId, code: '123456' }), options);
  assert.equal(verifyRes.status, 200);
  assert.equal((await verifyRes.json()).code, 'OK');

  const execRes = await handleExecuteTrial(trialHttpRequest({ action: 'execute', trialOperationId: trialId, previewHash: hash }), options);
  assert.equal(execRes.status, 200);
  assert.equal((await execRes.json()).data.status, 'succeeded');
  assert.equal(balance(core), 300000);
});

test('执行桥 HTTP：高风险试点转账未验证即执行被拒（409）且不扣款', async () => {
  const core = createBankingCore({ demoOtpCode: '123456' });
  const prepared = await preview(core, 200000);
  const options = { env: { SAVEFLOW_ACCESS_CODE: 'x'.repeat(16) }, core };
  const res = await handleExecuteTrial(trialHttpRequest({ action: 'execute', trialOperationId: `tfpreview:${prepared.operationId}`, previewHash: prepared.preview.previewHash }), options);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'VERIFICATION_REQUIRED');
  assert.equal(balance(core), 500000);
});

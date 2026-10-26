import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLowBalanceCore as createBankingCore } from './fixtures/low-balance-core.mjs';
import { handleTransfer, transferRepository, prepareTransferPreview } from '../src/agent/runtime.mjs';

// 端到端可行性验证：转账 agent 层（runtime.mjs）→ core.prepare → core.decide → core.execute。
// 证明「确认执行闭环」的后端发动机已经具备，只是前端 React 按钮尚未接线（D 范围之外）。

const unwrap = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };

async function previewTransfer(core, slots) {
  const repo = transferRepository(core.repository);
  const resolution = await handleTransfer({ action: 'transfer.create', slots }, repo);
  assert.equal(resolution.ok, true, JSON.stringify(resolution));
  assert.equal(resolution.kind, 'transfer_resolution');
  const prepared = await prepareTransferPreview(resolution, { prepare: core.prepare.bind(core) });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(prepared.kind, 'transfer_preview');
  return prepared.data;
}

test('transfer confirm-execute 后端闭环：预览不扣款，确认后执行产生回执并扣款', async () => {
  const core = createBankingCore();
  const data = await previewTransfer(core, {
    payee_ref: '张三',
    amount: { amount_minor: 50000, currency: 'CNY' },
    source_account_ref: '活期账户',
  });
  assert.match(data.operationId, /^op_/);
  assert.match(data.preview.previewHash, /^[a-f0-9]{64}$/);
  assert.equal(core.repository.getAccount('ACC-CHECKING').availableBalanceFen, 500000); // 预览未扣款

  const decided = unwrap(await core.decide(data.operationId, {
    previewHash: data.preview.previewHash,
    decision: 'confirm',
    confirmedStepIds: data.preview.stepIds,
  }));
  assert.equal(decided.state, 'confirmed');
  assert.equal(core.repository.getAccount('ACC-CHECKING').availableBalanceFen, 500000); // 确认仍未扣款

  const receipt = unwrap(await core.execute(data.operationId, data.preview.previewHash));
  assert.equal(receipt.status, 'succeeded');
  assert.equal(receipt.effects[0].amountFen, 50000);
  assert.equal(core.repository.getAccount('ACC-CHECKING').availableBalanceFen, 450000); // 执行后扣款
});

test('权限分级：≤1000元 只需确认；>1000元 需一次性验证码（OTP）', async () => {
  const core = createBankingCore();
  const small = unwrap(await core.prepare({ action: 'transfer_money', input: { fromAccountId: 'ACC-CHECKING', payeeId: 'payee_001', amountFen: 50000, currency: 'CNY' } }));
  assert.equal(small.risk.requiredVerification, 'none');
  assert.equal(small.risk.verificationCode, undefined);
  const large = unwrap(await core.prepare({ action: 'transfer_money', input: { fromAccountId: 'ACC-CHECKING', payeeId: 'payee_001', amountFen: 200000, currency: 'CNY' } }));
  assert.equal(large.risk.requiredVerification, 'otp');
  assert.equal(large.risk.verificationCode, undefined); // 验证码不再写进风险结果
});

test('改金额 = 新预览（新 operationId + 新 hash），旧 hash 无法确认新操作', async () => {
  const core = createBankingCore();
  const a = await previewTransfer(core, { payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' }, source_account_ref: '活期账户' });
  const b = await previewTransfer(core, { payee_ref: '张三', amount: { amount_minor: 60000, currency: 'CNY' }, source_account_ref: '活期账户' });
  assert.notEqual(a.operationId, b.operationId);
  assert.notEqual(a.preview.previewHash, b.preview.previewHash);
  // 用旧预览的 hash 去确认新操作 → 被拒，证明预览哈希唯一绑定内容
  const wrong = await core.decide(b.operationId, {
    previewHash: a.preview.previewHash,
    decision: 'confirm',
    confirmedStepIds: b.preview.stepIds,
  });
  assert.equal(wrong.error.code, 'CONFIRMATION_INVALID');
});

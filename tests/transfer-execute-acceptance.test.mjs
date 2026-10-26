import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import seed from '../src/data/saveflow_mock_data.json' with { type: 'json' };
import { createBankingCore } from '../src/banking-core/core.mjs';
import { createLowBalanceCore } from './fixtures/low-balance-core.mjs';
import { createPostgresBankingCore } from '../src/banking-core/postgres-store.mjs';
import { VERIFICATION_TTL_MS, VERIFICATION_ISSUE_COOLDOWN_MS } from '../src/banking-core/verification.mjs';
import { executeTrialTransfer, startTrialVerification, verifyTrialVerification } from '../server/transfer-execute-bridge.mjs';

// 高风险转账验收清单（队长《高风险操作》12 项）——逐条对照、逐条可执行。
// 1~9、11、12 走内存 Core；第 10 项需要 PostgreSQL（BANKING_TEST_DATABASE_URL），未配置时跳过。

const connectionString = process.env.BANKING_TEST_DATABASE_URL;
const unwrap = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
const balance = core => core.repository.getAccount('ACC-CHECKING').availableBalanceFen;
const transferInput = amountFen => ({ fromAccountId: 'ACC-CHECKING', payeeId: 'payee_001', amountFen, currency: 'CNY' });
const transferRequest = amountFen => ({ action: 'transfer_money', input: transferInput(amountFen) });

function coreWithCodes() {
  const codes = [];
  const core = createBankingCore({ deliverVerificationCode: ({ code }) => codes.push(code) });
  return { core, codes };
}
async function prepare(core, amountFen) { return unwrap(await core.prepare(transferRequest(amountFen))); }
async function confirm(core, p) { return unwrap(await core.decide(p.operationId, { previewHash: p.preview.previewHash, decision: 'confirm', confirmedStepIds: p.preview.stepIds })); }
async function verify(core, p, codes) {
  const started = unwrap(await core.startVerification(p.operationId, p.preview.previewHash));
  return { started, result: await core.verifyVerification(p.operationId, p.preview.previewHash, { challengeId: started.challengeId, code: codes[codes.length - 1] }) };
}
const booked = async (core, operationId) => (await core.repository.getTransactions({ accountId: 'ACC-CHECKING' })).filter(tx => tx.operationId === operationId).length;

test('[验收 1/12] 500 元普通转账：明确确认后成功，只扣款一次', async () => {
  const { core } = coreWithCodes();
  const p = await prepare(core, 50000);
  assert.equal(p.risk.requiredVerification, 'none');
  await confirm(core, p);
  const first = unwrap(await core.execute(p.operationId, p.preview.previewHash));
  assert.equal(first.status, 'succeeded');
  // 重复执行返回同一回执，资金只扣一次、只记一笔账。
  assert.deepEqual(unwrap(await core.execute(p.operationId, p.preview.previewHash)), first);
  assert.equal(balance(core), 2950000);
  assert.equal(await booked(core, p.operationId), 1);
});

test('[验收 2/12] 2000 元未验证：直接调用执行接口应被拒绝', async () => {
  const { core } = coreWithCodes();
  const p = await prepare(core, 200000);
  assert.equal(p.risk.requiredVerification, 'otp');
  await confirm(core, p);
  const result = await core.execute(p.operationId, p.preview.previewHash);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'VERIFICATION_REQUIRED');
  assert.equal(balance(core), 3000000); // 未扣款
});

test('[验收 3/12] 2000 元验证成功：得到正确回执，余额减 2000 元', async () => {
  const { core, codes } = coreWithCodes();
  const p = await prepare(core, 200000);
  await confirm(core, p);
  const { result } = await verify(core, p, codes);
  assert.equal(result.ok, true);
  const receipt = unwrap(await core.execute(p.operationId, p.preview.previewHash));
  assert.equal(receipt.status, 'succeeded');
  assert.equal(receipt.effects[0].amountFen, 200000);
  assert.equal(balance(core), 2800000);
});

test('[验收 4/12] 连续三次输错验证码：挑战锁定，余额不变', async () => {
  const { core, codes } = coreWithCodes();
  const p = await prepare(core, 200000);
  await confirm(core, p);
  const started = unwrap(await core.startVerification(p.operationId, p.preview.previewHash));
  for (let i = 0; i < 3; i++) {
    const r = await core.verifyVerification(p.operationId, p.preview.previewHash, { challengeId: started.challengeId, code: '000000' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, i === 2 ? 'VERIFICATION_LOCKED' : 'VERIFICATION_INVALID');
  }
  // 锁定后即便给出正确码也拒绝，且无法执行。
  assert.equal((await core.verifyVerification(p.operationId, p.preview.previewHash, { challengeId: started.challengeId, code: codes[0] })).error.code, 'VERIFICATION_LOCKED');
  assert.equal((await core.execute(p.operationId, p.preview.previewHash)).error.code, 'VERIFICATION_REQUIRED');
  assert.equal(balance(core), 3000000);
});

test('[验收 5/12] 修改金额或收款人：旧授权失效，需新预览、新验证', async () => {
  const { core, codes } = coreWithCodes();
  const a = await prepare(core, 200000); // ¥2000
  await confirm(core, a);
  const { result } = await verify(core, a, codes);
  assert.equal(result.ok, true); // 旧金额已通过验证
  // 改金额 → 全新预览（新 operationId + 新 hash），旧验证对新操作无效。
  const b = await prepare(core, 250000); // 改成 ¥2500
  assert.notEqual(a.operationId, b.operationId);
  assert.notEqual(a.preview.previewHash, b.preview.previewHash);
  await confirm(core, b);
  assert.equal((await core.execute(b.operationId, b.preview.previewHash)).error.code, 'VERIFICATION_REQUIRED');
  assert.equal(balance(core), 3000000);
  // 新操作走自己的验证后才可执行。
  const started = unwrap(await core.startVerification(b.operationId, b.preview.previewHash));
  assert.equal((await core.verifyVerification(b.operationId, b.preview.previewHash, { challengeId: started.challengeId, code: codes[codes.length - 1] })).ok, true);
  const receipt = unwrap(await core.execute(b.operationId, b.preview.previewHash));
  assert.equal(receipt.effects[0].amountFen, 250000);
  assert.equal(balance(core), 2750000);
});

test('[验收 6/12] 旧验证码或过期验证码：拒绝，不允许重放', async () => {
  const { core, codes } = coreWithCodes();
  const p = await prepare(core, 200000);
  await confirm(core, p);
  const started = unwrap(await core.startVerification(p.operationId, p.preview.previewHash));
  // 已消费的验证码不得重放（单次有效）。
  assert.equal((await core.verifyVerification(p.operationId, p.preview.previewHash, { challengeId: started.challengeId, code: codes[0] })).ok, true);
  assert.equal((await core.verifyVerification(p.operationId, p.preview.previewHash, { challengeId: started.challengeId, code: codes[0] })).error.code, 'VERIFICATION_ALREADY_USED');

  // 过期验证码拒绝。
  let time = Date.parse('2026-09-22T00:00:00Z');
  const codes2 = [];
  const core2 = createBankingCore({ now: () => time, deliverVerificationCode: ({ code }) => codes2.push(code) });
  const p2 = await prepare(core2, 200000);
  await confirm(core2, p2);
  const s2 = unwrap(await core2.startVerification(p2.operationId, p2.preview.previewHash));
  time += VERIFICATION_TTL_MS + 1000;
  assert.equal((await core2.verifyVerification(p2.operationId, p2.preview.previewHash, { challengeId: s2.challengeId, code: codes2[0] })).error.code, 'VERIFICATION_EXPIRED');
  assert.equal(balance(core2), 3000000);
});

test('[验收 7/12] 余额不足，即使验证正确：仍拒绝交易', async () => {
  const codes = [];
  const core = createLowBalanceCore({ deliverVerificationCode: ({ code }) => codes.push(code) });
  const p1 = await prepare(core, 300000); // 两笔 ¥3000，可用余额只有 ¥5000
  const p2 = await prepare(core, 300000);
  await confirm(core, p1); await confirm(core, p2);
  for (const p of [p1, p2]) assert.equal((await verify(core, p, codes)).result.ok, true);
  unwrap(await core.execute(p1.operationId, p1.preview.previewHash)); // 余额 → ¥2000
  const second = await core.execute(p2.operationId, p2.preview.previewHash);
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'INSUFFICIENT_BALANCE');
  assert.equal(balance(core), 200000);
});

test('[验收 8/12] 通过 TrueForge 执行桥直接提交：不能绕过验证与独立确认', async () => {
  const core = createBankingCore({ demoOtpCode: '123456' });
  const p = unwrap(await core.prepare({ action: 'transfer_money', input: transferInput(200000), origin: 'agent_suggested' }));
  assert.equal(p.risk.requiredVerification, 'otp');
  const trialId = `tfpreview:${p.operationId}`;
  const hash = p.preview.previewHash;
  // 未验证直接经执行桥提交 → 拒绝，不扣款，操作保持未确认（不自动确认/执行）。
  const direct = await executeTrialTransfer(core, { trialOperationId: trialId, previewHash: hash });
  assert.equal(direct.ok, false);
  assert.equal(direct.error.code, 'VERIFICATION_REQUIRED');
  assert.equal(balance(core), 3000000);
  assert.equal(unwrap(await core.getOperation(p.operationId)).state, 'awaiting_confirmation');
  // 正常流程：发起 → 校验 → 执行。
  const started = unwrap(await startTrialVerification(core, { trialOperationId: trialId, previewHash: hash }));
  assert.equal((unwrap(await verifyTrialVerification(core, { trialOperationId: trialId, previewHash: hash, challengeId: started.challengeId, code: '123456' }))).verified, true);
  const receipt = unwrap(await executeTrialTransfer(core, { trialOperationId: trialId, previewHash: hash }));
  assert.equal(receipt.status, 'succeeded');
  assert.equal(balance(core), 2800000);
});

test('[验收 9/12] 同一交易重复执行：最多一次资金效果，返回可信回执', async () => {
  const { core, codes } = coreWithCodes();
  const p = await prepare(core, 200000);
  await confirm(core, p);
  assert.equal((await verify(core, p, codes)).result.ok, true);
  const first = unwrap(await core.execute(p.operationId, p.preview.previewHash));
  const second = unwrap(await core.execute(p.operationId, p.preview.previewHash));
  assert.equal(first.status, 'succeeded');
  assert.deepEqual(second, first); // 同一可信回执
  assert.equal(first.receiptId, second.receiptId);
  assert.equal(balance(core), 2800000); // 只扣一次
  assert.equal(await booked(core, p.operationId), 1); // 只记一笔账
});

test('[验收 10/12] PostgreSQL 跨实例/服务重启：挑战状态不丢失，不误认已验证', { skip: !connectionString }, async t => {
  const source = structuredClone(seed);
  source.user.id = `test_${randomUUID()}`;
  const open = () => createPostgresBankingCore({ connectionString, source, demoOtpCode: '123456' });
  const first = await open();
  const second = await open();
  let restarted;
  const input = transferInput(200000);
  try {
    const p = unwrap(await first.prepare({ action: 'transfer_money', input }));
    assert.equal(p.risk.requiredVerification, 'otp');
    unwrap(await first.decide(p.operationId, { previewHash: p.preview.previewHash, decision: 'confirm', confirmedStepIds: p.preview.stepIds }));
    const started = unwrap(await first.startVerification(p.operationId, p.preview.previewHash));
    // 第二实例（模拟重启）读取同一操作：未验证状态不丢失，也不误认已验证。
    assert.equal((await second.execute(p.operationId, p.preview.previewHash)).error.code, 'VERIFICATION_REQUIRED');
    // 用第二实例校验固定码成功，证明挑战哈希/状态跨实例持久化。
    assert.equal((unwrap(await second.verifyVerification(p.operationId, p.preview.previewHash, { challengeId: started.challengeId, code: '123456' }))).verified, true);
    // 第三次实例（再次重启）执行成功且幂等，只扣一次。
    restarted = await open();
    const receipt = unwrap(await restarted.execute(p.operationId, p.preview.previewHash));
    assert.equal(receipt.status, 'succeeded');
    assert.deepEqual(unwrap(await restarted.execute(p.operationId, p.preview.previewHash)), receipt);
    assert.equal((await restarted.repository.getAccount('ACC-CHECKING')).availableBalanceFen, 2800000);
  } finally {
    for (const core of [first, second, restarted]) if (core) await core.close();
    const { default: postgres } = await import('postgres');
    const sql = postgres(connectionString, { max: 1 });
    await sql.begin(async tx => {
      for (const table of ['banking_transactions', 'banking_operations', 'banking_cards', 'banking_accounts', 'banking_wealth_holdings']) {
        await tx.unsafe(`DELETE FROM ${table} WHERE owner_id = $1`, [source.user.id]);
      }
    });
    await sql.end({ timeout: 5 });
  }
});

test('[验收 11/12] 用户在聊天中要求跳过验证：Agent 不得改变 Core 风险策略', async () => {
  const { core } = coreWithCodes();
  // 任何试图在输入里夹带「跳过验证 / 下调风险」字段的请求都被 schema 拒绝；风险只由金额决定。
  for (const extra of [{ skipVerification: true }, { requiredVerification: 'none' }, { skip_verification: true }]) {
    const result = await core.prepare({ action: 'transfer_money', input: { ...transferInput(200000), ...extra } });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error.code, 'VALIDATION_ERROR');
  }
  // 正常输入下，>1000 元转账的风险等级恒为 L3 + otp，无任何字段可下调。
  const p = await prepare(core, 200000);
  assert.equal(p.risk.riskLevel, 'L3');
  assert.equal(p.risk.requiredVerification, 'otp');
});

test('[验收 12/12] 网络中断导致结果不明确：按原操作编号查询，不自动再扣款', async () => {
  const { core, codes } = coreWithCodes();
  const p = await prepare(core, 200000);
  await confirm(core, p);
  assert.equal((await verify(core, p, codes)).result.ok, true);
  const receipt = unwrap(await core.execute(p.operationId, p.preview.previewHash));
  assert.equal(receipt.status, 'succeeded');
  // “结果不明确”后按原编号查询：拿到同一回执，且不会自动再扣款。
  const lookedUp = unwrap(await core.getOperation(p.operationId));
  assert.equal(lookedUp.state, 'succeeded');
  assert.deepEqual(lookedUp.receipt, receipt);
  assert.deepEqual(unwrap(await core.execute(p.operationId, p.preview.previewHash)), receipt);
  assert.equal(balance(core), 2800000);
  assert.equal(await booked(core, p.operationId), 1);
});

test('[P1 步骤6] 重复确认：同一预览重复确认幂等，执行仍只扣一次', async () => {
  const { core } = coreWithCodes();
  const p = await prepare(core, 50000);
  const first = await confirm(core, p);
  // 对同一预览再次确认：幂等返回同一 confirmed 状态，不报错、不重复计账。
  const second = unwrap(await core.decide(p.operationId, { previewHash: p.preview.previewHash, decision: 'confirm', confirmedStepIds: p.preview.stepIds }));
  assert.equal(first.state, 'confirmed');
  assert.equal(second.state, 'confirmed');
  unwrap(await core.execute(p.operationId, p.preview.previewHash));
  assert.equal(balance(core), 2950000);
  assert.equal(await booked(core, p.operationId), 1);
});

test('[P1 步骤6] 并发确认：两个并发确认不产生双重效果，最终只扣一次', async () => {
  const { core } = coreWithCodes();
  const p = await prepare(core, 50000);
  const decision = { previewHash: p.preview.previewHash, decision: 'confirm', confirmedStepIds: p.preview.stepIds };
  const results = await Promise.all([core.decide(p.operationId, decision), core.decide(p.operationId, decision)]);
  // 至少一次确认成功；即便并发下另一路被安全拒绝，最终状态与资金也必须唯一。
  assert.ok(results.some(r => r.ok), JSON.stringify(results));
  assert.equal(unwrap(await core.getOperation(p.operationId)).state, 'confirmed');
  unwrap(await core.execute(p.operationId, p.preview.previewHash));
  assert.equal(balance(core), 2950000);
  assert.equal(await booked(core, p.operationId), 1);
});

test('[P1 步骤5] 速率限制：同一操作短时间重复发码被拒，冷却后重发成功', async () => {
  let time = Date.parse('2026-09-22T00:00:00Z');
  const codes = [];
  const core = createBankingCore({ now: () => time, deliverVerificationCode: ({ code }) => codes.push(code) });
  const p = await prepare(core, 200000);
  await confirm(core, p);
  unwrap(await core.startVerification(p.operationId, p.preview.previewHash));
  // 冷却期内重发 → 被拒（防止暴力枚举）。
  time += VERIFICATION_ISSUE_COOLDOWN_MS - 1000;
  const tooSoon = await core.startVerification(p.operationId, p.preview.previewHash);
  assert.equal(tooSoon.ok, false, JSON.stringify(tooSoon));
  assert.equal(tooSoon.error.code, 'VERIFICATION_RATE_LIMITED');
  // 超过冷却期后重发 → 成功，新码有效。
  time += 2000;
  const second = unwrap(await core.startVerification(p.operationId, p.preview.previewHash));
  assert.match(second.challengeId, /^otp_/);
  assert.equal((await core.verifyVerification(p.operationId, p.preview.previewHash, { challengeId: second.challengeId, code: codes[codes.length - 1] })).ok, true);
});

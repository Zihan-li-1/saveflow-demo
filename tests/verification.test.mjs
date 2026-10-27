import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { createLowBalanceCore } from './fixtures/low-balance-core.mjs';
import { generateCode, hashCode, createChallenge, verifyChallenge, VERIFICATION_MAX_ATTEMPTS, VERIFICATION_TTL_MS, VERIFICATION_ISSUE_COOLDOWN_MS } from '../src/banking-core/verification.mjs';

const unwrap = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
const balance = core => core.repository.getAccount('ACC-CHECKING').availableBalanceFen;
const input = amountFen => ({ action: 'transfer_money', input: { fromAccountId: 'ACC-CHECKING', payeeId: 'payee_001', amountFen, currency: 'CNY' } });
async function prepare(core, amountFen) { return unwrap(await core.prepare(input(amountFen))); }
async function confirm(core, p) { return unwrap(await core.decide(p.operationId, { previewHash: p.preview.previewHash, decision: 'confirm', confirmedStepIds: p.preview.stepIds })); }

// 受控测试渠道：把投递的验证码捕获到数组，模拟「服务端控制台/独立测试渠道」。
function coreWithCapturedCodes() {
  const codes = [];
  const core = createBankingCore({ deliverVerificationCode: ({ code }) => codes.push(code) });
  return { core, codes };
}

async function verify(core, p, codes) {
  const started = unwrap(await core.startVerification(p.operationId, p.preview.previewHash));
  return { started, result: await core.verifyVerification(p.operationId, p.preview.previewHash, { challengeId: started.challengeId, code: codes[codes.length - 1] }) };
}

test('普通转账（≤1000元）无需验证：确认后直接执行', async () => {
  const { core } = coreWithCapturedCodes();
  const p = await prepare(core, 50000);
  assert.equal(p.risk.requiredVerification, 'none');
  await confirm(core, p);
  const receipt = unwrap(await core.execute(p.operationId, p.preview.previewHash));
  assert.equal(receipt.status, 'succeeded');
  assert.equal(balance(core), 2950000);
});

test('高风险转账未验证时，执行被拒绝且不扣款', async () => {
  const { core } = coreWithCapturedCodes();
  const p = await prepare(core, 200000);
  assert.equal(p.risk.requiredVerification, 'otp');
  await confirm(core, p);
  const result = await core.execute(p.operationId, p.preview.previewHash);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'VERIFICATION_REQUIRED');
  assert.equal(balance(core), 3000000); // 未扣款
});

test('高风险转账验证成功后执行：得到回执并扣款一次', async () => {
  const { core, codes } = coreWithCapturedCodes();
  const p = await prepare(core, 200000);
  await confirm(core, p);
  const { result } = await verify(core, p, codes);
  assert.equal(result.ok, true);
  const receipt = unwrap(await core.execute(p.operationId, p.preview.previewHash));
  assert.equal(receipt.status, 'succeeded');
  assert.equal(receipt.effects[0].amountFen, 200000);
  assert.equal(balance(core), 2800000);
});

test('连续输错 3 次锁定，余额不变，正确码也无法再授权', async () => {
  const { core, codes } = coreWithCapturedCodes();
  const p = await prepare(core, 200000);
  await confirm(core, p);
  const started = unwrap(await core.startVerification(p.operationId, p.preview.previewHash));
  for (let i = 0; i < 3; i++) {
    const r = await core.verifyVerification(p.operationId, p.preview.previewHash, { challengeId: started.challengeId, code: '000000' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, i === 2 ? 'VERIFICATION_LOCKED' : 'VERIFICATION_INVALID');
  }
  // 锁定后即使给出正确码也拒绝
  const correct = await core.verifyVerification(p.operationId, p.preview.previewHash, { challengeId: started.challengeId, code: codes[0] });
  assert.equal(correct.error.code, 'VERIFICATION_LOCKED');
  const exec = await core.execute(p.operationId, p.preview.previewHash);
  assert.equal(exec.error.code, 'VERIFICATION_REQUIRED');
  assert.equal(balance(core), 3000000);
});

test('验证码过期：超过 2 分钟或预览有效期后拒绝', async () => {
  let time = Date.parse('2026-09-22T00:00:00Z');
  const codes = [];
  const core = createBankingCore({ now: () => time, deliverVerificationCode: ({ code }) => codes.push(code) });
  const p = await prepare(core, 200000);
  await confirm(core, p);
  const started = unwrap(await core.startVerification(p.operationId, p.preview.previewHash));
  time += VERIFICATION_TTL_MS + 1000;
  const r = await core.verifyVerification(p.operationId, p.preview.previewHash, { challengeId: started.challengeId, code: codes[0] });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'VERIFICATION_EXPIRED');
  assert.equal(balance(core), 3000000);
});

test('已消费的验证码不得重放（单次有效）', async () => {
  const { core, codes } = coreWithCapturedCodes();
  const p = await prepare(core, 200000);
  await confirm(core, p);
  const started = unwrap(await core.startVerification(p.operationId, p.preview.previewHash));
  const first = await core.verifyVerification(p.operationId, p.preview.previewHash, { challengeId: started.challengeId, code: codes[0] });
  assert.equal(first.ok, true);
  const replay = await core.verifyVerification(p.operationId, p.preview.previewHash, { challengeId: started.challengeId, code: codes[0] });
  assert.equal(replay.error.code, 'VERIFICATION_ALREADY_USED');
});

test('重新发起验证会作废旧验证码', async () => {
  let time = Date.parse('2026-09-22T00:00:00Z');
  const codes = [];
  const core = createBankingCore({ now: () => time, deliverVerificationCode: ({ code }) => codes.push(code) });
  const p = await prepare(core, 200000);
  await confirm(core, p);
  unwrap(await core.startVerification(p.operationId, p.preview.previewHash));
  const oldCode = codes[0];
  // 冷却期内重发被拒；超过冷却期后重发作废旧码。
  time += VERIFICATION_ISSUE_COOLDOWN_MS;
  const started2 = unwrap(await core.startVerification(p.operationId, p.preview.previewHash));
  const newCode = codes[1];
  // 旧码作废
  const old = await core.verifyVerification(p.operationId, p.preview.previewHash, { challengeId: started2.challengeId, code: oldCode });
  assert.equal(old.error.code, 'VERIFICATION_INVALID');
  // 新码有效
  const fresh = await core.verifyVerification(p.operationId, p.preview.previewHash, { challengeId: started2.challengeId, code: newCode });
  assert.equal(fresh.ok, true);
});

test('验证码绑定当前预览：错误 previewHash 被拒绝', async () => {
  const { core } = coreWithCapturedCodes();
  const p = await prepare(core, 200000);
  await confirm(core, p);
  const other = await prepare(core, 200000);
  const started = unwrap(await core.startVerification(p.operationId, p.preview.previewHash));
  const r = await core.verifyVerification(p.operationId, other.preview.previewHash, { challengeId: started.challengeId, code: '000000' });
  assert.equal(r.error.code, 'CONFIRMATION_INVALID');
});

test('demoOtpCode 固定验证码：仍走 hash/TTL/单次校验，投递的就是固定码', async () => {
  const codes = [];
  const core = createBankingCore({ demoOtpCode: '123456', deliverVerificationCode: ({ code }) => codes.push(code) });
  const p = await prepare(core, 200000);
  await confirm(core, p);
  const started = unwrap(await core.startVerification(p.operationId, p.preview.previewHash));
  assert.equal(codes[0], '123456'); // 受控渠道投递的即固定码
  const ok = await core.verifyVerification(p.operationId, p.preview.previewHash, { challengeId: started.challengeId, code: '123456' });
  assert.equal(ok.ok, true);
  const receipt = unwrap(await core.execute(p.operationId, p.preview.previewHash));
  assert.equal(receipt.status, 'succeeded');
  assert.equal(balance(core), 2800000);
});

test('余额不足时，即使验证正确也拒绝执行', async () => {
  const codes = [];
  const core = createLowBalanceCore({ deliverVerificationCode: ({ code }) => codes.push(code) });
  // 两笔 ¥3000 都通过 prepare/confirm/verify，但可用余额只有 ¥5000，后执行的那笔被最终余额重查拦下。
  const p1 = await prepare(core, 300000);
  const p2 = await prepare(core, 300000);
  await confirm(core, p1); await confirm(core, p2);
  for (const p of [p1, p2]) {
    const { result } = await verify(core, p, codes);
    assert.equal(result.ok, true);
  }
  unwrap(await core.execute(p1.operationId, p1.preview.previewHash)); // 余额 → ¥2000
  const second = await core.execute(p2.operationId, p2.preview.previewHash);
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'INSUFFICIENT_BALANCE');
  assert.equal(balance(core), 200000);
});

// —— 纯函数单元测试：verification.mjs ——

test('generateCode 生成 6 位数字；hashCode 稳定且绑定 challengeId', () => {
  for (let i = 0; i < 20; i++) assert.match(generateCode(), /^\d{6}$/);
  assert.notEqual(hashCode('a', '123456'), hashCode('b', '123456'));
  assert.equal(hashCode('a', '123456'), hashCode('a', '123456'));
});

test('verifyChallenge 状态机：成功/错误/锁定/过期/重放', () => {
  const t0 = Date.parse('2026-09-22T00:00:00Z');
  const { state, code } = createChallenge({ challengeId: 'otp_x', code: '123456', nowMs: t0 });
  assert.equal(state.maxAttempts, VERIFICATION_MAX_ATTEMPTS);
  assert.equal(state.codeHash, hashCode('otp_x', '123456'));
  // 错一次
  const wrong = verifyChallenge(state, '000000', t0 + 1000);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error.code, 'VERIFICATION_INVALID');
  assert.equal(wrong.state.attempts, 1);
  // 正确
  const ok = verifyChallenge(wrong.state, '123456', t0 + 2000);
  assert.equal(ok.ok, true);
  assert.equal(ok.state.status, 'verified');
  // 重放
  const replay = verifyChallenge(ok.state, '123456', t0 + 3000);
  assert.equal(replay.error.code, 'VERIFICATION_ALREADY_USED');
  // 过期
  const expired = verifyChallenge({ ...state }, '123456', t0 + VERIFICATION_TTL_MS + 1);
  assert.equal(expired.error.code, 'VERIFICATION_EXPIRED');
});

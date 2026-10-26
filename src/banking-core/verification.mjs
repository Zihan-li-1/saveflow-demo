// @ts-check
// 逐笔 OTP（One-Time Password）验证码：纯函数 + 参数化时钟，便于单元测试。
// 只做「生成 / 校验 / 过期 / 限次」，不做持久化、不做渠道投递、不参与账务。
// 明文验证码只通过受控测试渠道交付（默认打印到服务端控制台），绝不写入风险响应或操作记录。
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/** 验证码有效期：2 分钟，且不能超过原预览有效期（由调用方在 start 时取较小值）。 */
export const VERIFICATION_TTL_MS = 2 * 60 * 1000;
/** 每笔挑战最多尝试次数，超过即锁定。 */
export const VERIFICATION_MAX_ATTEMPTS = 3;
/** 同一操作相邻两次发码的最小间隔（速率限制），防止「重发→试 3 次→重发」暴力枚举。 */
export const VERIFICATION_ISSUE_COOLDOWN_MS = 30 * 1000;

/** 6 位数字验证码，使用密码学安全的均匀随机数（拒绝采样避免偏置）。 @returns {string} */
export function generateCode() {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** 仅存验证码的 per-challenge 哈希，绑定 challengeId 防跨操作重放。
 * @param {string} challengeId @param {string} code @returns {string} */
export function hashCode(challengeId, code) {
  return createHash('sha256').update(`saveflow-otp-v1:${challengeId}:${code}`).digest('hex');
}

/** 生成一条挑战。返回 `state`（仅含哈希，用于持久化）与明文 `code`（仅交给投递渠道）。
 * @param {{ challengeId: string, code: string, nowMs: number, maxAttempts?: number, ttlMs?: number }} input
 * @returns {{ state: import('./contracts').VerificationState, code: string, expiresAt: string }} */
export function createChallenge({ challengeId, code, nowMs, maxAttempts = VERIFICATION_MAX_ATTEMPTS, ttlMs = VERIFICATION_TTL_MS }) {
  const expiresAt = new Date(nowMs + ttlMs).toISOString();
  return {
    state: { challengeId, codeHash: hashCode(challengeId, code), issuedAt: new Date(nowMs).toISOString(), expiresAt, attempts: 0, maxAttempts, status: /** @type {const} */ ('pending') },
    code,
    expiresAt,
  };
}

/** @param {string} a @param {string} b @returns {boolean} */
function safeEqual(a, b) {
  const aBuf = Buffer.from(a, 'hex');
  const bBuf = Buffer.from(b, 'hex');
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

/** 校验一次验证码。返回新 state（成功置 verified / 失败累加 attempts 或锁定）与结果。
 *  始终返回 state，由调用方持久化，保证「错误次数 / 已消费」不被客户端绕过。
 * @param {import('./contracts').VerificationState} state @param {string} code @param {number} nowMs
 * @returns {{ ok: true, state: import('./contracts').VerificationState } | { ok: false, state: import('./contracts').VerificationState, error: { code: import('./contracts').ErrorCode, message: string } }} */
export function verifyChallenge(state, code, nowMs) {
  if (state.status === 'verified') return { ok: false, state, error: { code: /** @type {const} */ ('VERIFICATION_ALREADY_USED'), message: '验证码已使用，请重新发起验证。' } };
  if (state.status === 'locked') return { ok: false, state, error: { code: /** @type {const} */ ('VERIFICATION_LOCKED'), message: '验证次数已超限，请重新发起验证。' } };
  if (nowMs >= Date.parse(state.expiresAt)) return { ok: false, state: { ...state, status: /** @type {const} */ ('locked') }, error: { code: /** @type {const} */ ('VERIFICATION_EXPIRED'), message: '验证码已过期，请重新发起验证。' } };
  if (state.attempts >= state.maxAttempts) return { ok: false, state: { ...state, status: /** @type {const} */ ('locked') }, error: { code: /** @type {const} */ ('VERIFICATION_LOCKED'), message: '验证次数已超限，请重新发起验证。' } };
  if (!safeEqual(hashCode(state.challengeId, code), state.codeHash)) {
    const attempts = state.attempts + 1;
    const status = attempts >= state.maxAttempts ? /** @type {const} */ ('locked') : /** @type {const} */ ('pending');
    return {
      ok: false,
      state: { ...state, attempts, status },
      error: { code: status === 'locked' ? /** @type {const} */ ('VERIFICATION_LOCKED') : /** @type {const} */ ('VERIFICATION_INVALID'), message: status === 'locked' ? '验证次数已超限，请重新发起验证。' : `验证码错误，还可尝试 ${state.maxAttempts - attempts} 次。` },
    };
  }
  return { ok: true, state: { ...state, status: /** @type {const} */ ('verified'), verifiedAt: new Date(nowMs).toISOString() } };
}

// 转账「执行桥」：把 TrueForge 试点预览（tfpreview:op_xxx）安全地接到 Core 的 decide→execute→回执。
//
// 这是「服务端授权通道」——不通过 MCP 暴露给模型，只接受明确确认 + 预览哈希，聊天/模型无法直接动钱。
// 与 banking.mjs 的拦截互补：那边拦「通用 API 误收试点单」，这边开「授权桥」；
// 两者都要求预览哈希精确匹配，执行只走 Core 已存储的 confirmed 参数，绝不接受模型改金额。
import { timingSafeEqual } from 'node:crypto';
import { getConfiguredBankingCore } from '../src/banking-core/postgres-store.mjs';
import { BankingError } from '../src/banking-core/errors.mjs';
import { isTrialOperationId } from '../src/lib/trial-preview.mjs';

const fail = (code, message, uncertain = false) => ({ ok: false, error: { code, message, uncertain } });

function realOperationId(trialOperationId) {
  if (!isTrialOperationId(trialOperationId)) {
    return fail('VALIDATION_ERROR', '执行桥只接受 TrueForge 试点预览编号（tfpreview: 前缀）');
  }
  const opId = trialOperationId.slice('tfpreview:'.length);
  if (!/^op_[a-zA-Z0-9_-]+$/.test(opId)) return fail('VALIDATION_ERROR', '试点编号内不是有效的操作编号');
  return { ok: true, data: opId };
}

/**
 * 授权执行一座 TrueForge 试点转账预览：剥前缀 → 精确确认（previewHash）→ 执行 → 回执。
 * 幂等：同一预览重复执行返回同一回执，只扣一次款。
 * @param {ReturnType<import('../src/banking-core/core.mjs').createBankingCore>} core 与预览同源的 Core（生产为共享 PostgreSQL）
 * @param {{ trialOperationId: string; previewHash: string }} input
 */
export async function executeTrialTransfer(core, { trialOperationId, previewHash }) {
  if (typeof previewHash !== 'string' || !/^[a-f0-9]{64}$/.test(previewHash)) return fail('VALIDATION_ERROR', '预览哈希无效');

  const resolved = realOperationId(trialOperationId);
  if (!resolved.ok) return resolved;
  const opId = resolved.data;

  const result = await core.executeTrial(opId, previewHash);
  if (!result.ok) return { ok: false, error: result.error, operationId: opId };
  return { ok: true, data: result.data, operationId: opId };
}

/**
 * 发起试点转账 OTP 挑战：剥前缀 → 精确确认（previewHash）→ 发起验证码（响应不含验证码）。
 * @param {ReturnType<import('../src/banking-core/core.mjs').createBankingCore>} core
 * @param {{ trialOperationId: string; previewHash: string }} input
 */
export async function startTrialVerification(core, { trialOperationId, previewHash }) {
  if (typeof previewHash !== 'string' || !/^[a-f0-9]{64}$/.test(previewHash)) return fail('VALIDATION_ERROR', '预览哈希无效');

  const resolved = realOperationId(trialOperationId);
  if (!resolved.ok) return resolved;
  const opId = resolved.data;

  const result = await core.startTrialVerification(opId, previewHash);
  if (!result.ok) return { ok: false, error: result.error, operationId: opId };
  return { ok: true, data: result.data, operationId: opId };
}

/**
 * 校验试点转账 OTP：剥前缀 → 校验挑战编号 + 验证码，成功后回传已验证状态。
 * @param {ReturnType<import('../src/banking-core/core.mjs').createBankingCore>} core
 * @param {{ trialOperationId: string; previewHash: string; challengeId: string; code: string }} input
 */
export async function verifyTrialVerification(core, { trialOperationId, previewHash, challengeId, code }) {
  if (typeof previewHash !== 'string' || !/^[a-f0-9]{64}$/.test(previewHash)) return fail('VALIDATION_ERROR', '预览哈希无效');

  const resolved = realOperationId(trialOperationId);
  if (!resolved.ok) return resolved;
  const opId = resolved.data;

  const result = await core.verifyTrialVerification(opId, previewHash, { challengeId, code });
  if (!result.ok) return { ok: false, error: result.error, operationId: opId };
  return { ok: true, data: result.data, operationId: opId };
}

async function readBody(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new BankingError('VALIDATION_ERROR', '需要 application/json');
  const reader = request.body?.getReader();
  if (!reader) throw new BankingError('VALIDATION_ERROR', '请求体不能为空');
  let bytes = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > 16384) { await reader.cancel(); throw new BankingError('VALIDATION_ERROR', '请求体超过 16KB'); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new BankingError('VALIDATION_ERROR', 'JSON 格式无效'); }
  } finally { reader.releaseLock(); }
}

function statusCode(code) {
  if (code === 'UNAUTHORIZED') return 401;
  if (code === 'FORBIDDEN') return 403;
  if (code === 'DATABASE_NOT_CONFIGURED') return 503;
  if (['IDEMPOTENCY_CONFLICT', 'PREVIEW_STALE', 'PREVIEW_EXPIRED', 'INVALID_STATE', 'CONFIRMATION_INVALID', 'CONFIRMATION_REQUIRED', 'VERIFICATION_REQUIRED'].includes(code)) return 409;
  return 400;
}

/** HTTP 入口（/api/execute-trial）：试点转账授权桥，按 action 分发 execute / verification.start / verification.verify。 */
export async function handleExecuteTrial(request, { env = process.env, core: providedCore } = {}) {
  const requestId = crypto.randomUUID();
  const reply = (status, code, message, data) => Response.json({ code, message, requestId, ...(data !== undefined ? { data } : {}) }, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  try {
    if (request.method !== 'POST') return reply(405, 'METHOD_NOT_ALLOWED', '仅支持 POST');
    const expected = env.SAVEFLOW_ACCESS_CODE;
    if (!expected || expected.length < 16) return reply(503, 'ACCESS_NOT_CONFIGURED', '请配置服务端演示访问码');
    const access = request.headers.get('X-Saveflow-Access') ?? '';
    if (Buffer.byteLength(access) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(access), Buffer.from(expected))) return reply(401, 'UNAUTHORIZED', '演示访问码无效');
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) return reply(403, 'FORBIDDEN', '不允许跨来源请求');
    const body = await readBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, 'VALIDATION_ERROR', '请求体必须为对象');
    const { action = 'execute', trialOperationId, previewHash, challengeId, code } = body;
    const core = providedCore ?? await getConfiguredBankingCore(env);
    let result;
    if (action === 'verification.start') result = await startTrialVerification(core, { trialOperationId, previewHash });
    else if (action === 'verification.verify') result = await verifyTrialVerification(core, { trialOperationId, previewHash, challengeId, code });
    else if (action === 'execute') result = await executeTrialTransfer(core, { trialOperationId, previewHash });
    else return reply(400, 'VALIDATION_ERROR', '未知的执行桥动作');
    if (!result.ok) return reply(statusCode(result.error.code), result.error.code, result.error.message);
    const message = action === 'execute' ? '试点转账已执行' : action === 'verification.start' ? '验证码已发起' : '验证通过';
    return reply(200, 'OK', message, result.data);
  } catch (error) {
    const safe = error instanceof BankingError ? error : new BankingError('INTERNAL_ERROR', '执行桥未取得可靠结果，请查询原操作', true);
    return reply(statusCode(safe.code), safe.code, safe.message);
  }
}

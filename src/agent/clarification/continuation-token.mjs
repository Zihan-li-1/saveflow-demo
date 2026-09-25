import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

const VERSION = 2;
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const AAD = Buffer.from('saveflow-continuation-v2', 'utf8');

function keyFor(secret) {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function encode(value, secret) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFor(secret), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function issueContinuationToken(input, secret, now = Date.now(), ttlMs = 5 * 60_000) {
  if (typeof secret !== 'string' || secret.length < 16) throw Object.assign(new Error('续接令牌密钥未配置'), { code: 'CONTINUATION_CONFIG_ERROR', status: 503 });
  const payload = {
    v: VERSION,
    tokenId: `ct_${randomUUID()}`,
    action: input.action,
    slots: input.slots ?? {},
    pendingSlot: input.pendingSlot,
    choices: input.choices ?? [],
    selections: input.selections ?? {},
    expiresAt: now + ttlMs,
  };
  return encode(payload, secret);
}

export function verifyContinuationToken(token, secret, now = Date.now()) {
  if (typeof secret !== 'string' || secret.length < 16) throw Object.assign(new Error('续接令牌密钥未配置'), { code: 'CONTINUATION_CONFIG_ERROR', status: 503 });
  if (typeof token !== 'string') throw new Error('续接凭据无效');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !part || !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error('续接凭据无效');
  const [ivEncoded, tagEncoded, ciphertextEncoded] = parts;
  let payload;
  try {
    const iv = Buffer.from(ivEncoded, 'base64url');
    const tag = Buffer.from(tagEncoded, 'base64url');
    const ciphertext = Buffer.from(ciphertextEncoded, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES || ciphertext.length === 0) throw new Error('invalid token');
    const decipher = createDecipheriv(ALGORITHM, keyFor(secret), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    payload = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  } catch { throw new Error('续接凭据无效'); }
  if (!payload || payload.v !== VERSION || !['transfer.create', 'bill.summary'].includes(payload.action) || !payload.slots || !Array.isArray(payload.choices) || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= now) throw new Error('续接凭据已过期或无效');
  return payload;
}

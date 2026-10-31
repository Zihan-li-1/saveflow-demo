import { createHash } from 'node:crypto';
import { canonical } from '../../src/banking-core/errors.mjs';

export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const secretKey = /password|passwd|token|secret|api.?key|^authorization$|account.?no|card.?number|identity|身份证|银行卡号/i;
export function redact(value) {
  if (typeof value === 'string') return value.replace(/\b\d{12,19}[Xx]?\b/g, '[REDACTED]').replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? '[REDACTED]' : redact(item)]));
  return value;
}
// Credentials and raw account numbers are never accepted as workflow arguments.
export function containsSecrets(value) {
  if (typeof value === 'string') return /\b\d{12,19}[Xx]?\b|\bBearer\s+/i.test(value);
  if (Array.isArray(value)) return value.some(containsSecrets);
  return !!value && typeof value === 'object' && Object.entries(value).some(([key, item]) => secretKey.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || containsSecrets(item));
}

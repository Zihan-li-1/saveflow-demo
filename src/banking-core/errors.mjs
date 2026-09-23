// @ts-check
export class BankingError extends Error {
  /** @param {import('./contracts').ErrorCode} code @param {string} message @param {boolean} [uncertain] */
  constructor(code, message, uncertain = false) {
    super(message); this.name = 'BankingError'; this.code = code; this.uncertain = uncertain;
  }
  toJSON() { return { code: this.code, message: this.message, uncertain: this.uncertain }; }
}
/** @param {unknown} value @param {string} [label] @returns {asserts value is string} */
export function assertId(value, label = '编号') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new BankingError('VALIDATION_ERROR', `${label}格式无效`);
}
/** @param {unknown} value @param {boolean} [positive] @returns {asserts value is number} */
export function assertFen(value, positive = true) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new BankingError('VALIDATION_ERROR', '金额必须为安全整数分');
}
/** Only the original yuan seed uses this conversion. Never round user/tool input. @param {number} yuan */
export function seedYuanToFen(yuan) {
  const fen = Math.round(yuan * 100);
  if (Math.abs(yuan * 100 - fen) > 0.000001) throw new BankingError('VALIDATION_ERROR', '种子金额精度超过分');
  assertFen(fen, false); return fen;
}
/** Canonical JSON is used for idempotency, not as a cryptographic hash. @param {unknown} value @returns {string} */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(/** @type {Record<string, unknown>} */(value)[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

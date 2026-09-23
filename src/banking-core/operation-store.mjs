// @ts-check
import { BankingError, assertId, canonical } from './errors.mjs';
/** Process-local Mock store. A production adapter must atomically persist ledger + receipt.
 * Keys are user + operation, deliberately stronger than user + action + operation. */
export class OperationStore {
  /** @type {Map<string, import('./contracts').OperationRecord>} */
  #records = new Map();
  /** @param {string} owner @param {string} operationId */
  get(owner, operationId) {
    assertId(owner); assertId(operationId);
    const record = this.#records.get(`${owner}\0${operationId}`);
    return record ? structuredClone(record) : undefined;
  }
  /** @param {string} owner @param {import('./contracts').OperationRecord} record */
  put(owner, record) {
    assertId(owner); assertId(record.operationId);
    const existing = this.get(owner, record.operationId);
    if (existing && (existing.action !== record.action || existing.fingerprint !== record.fingerprint)) throw new BankingError('IDEMPOTENCY_CONFLICT', '同一操作编号不能更改动作或参数，请先查询原操作', true);
    this.#records.set(`${owner}\0${record.operationId}`, structuredClone(record));
  }
  /** @param {string} action @param {unknown} input */
  fingerprint(action, input) { return canonical({ action, input }); }
}

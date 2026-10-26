// @ts-check
import { BankingError, assertId, canonical } from './errors.mjs';
/** Process-local Mock store. A production adapter must atomically persist ledger + receipt.
 * Keys are user + operation, deliberately stronger than user + action + operation. */
export class OperationStore {
  /** @type {Map<string, import('./contracts').OperationRecord>} */
  #records = new Map();
  /** @type {Map<string, import('./contracts').ScenarioRule>} */
  #scenarioRules = new Map();
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
  /** 原子地消费一次验证码尝试（单进程内无真正并行，`get` 已返回克隆，`put` 后写回）。
   * @param {string} owner @param {string} operationId @param {(record: import('./contracts').OperationRecord) => { error?: { code: import('./contracts').ErrorCode, message: string } }} apply */
  mutateVerification(owner, operationId, apply) {
    assertId(owner); assertId(operationId);
    const existing = this.get(owner, operationId);
    if (!existing) throw new BankingError('OPERATION_NOT_FOUND', '未取得此操作的记录，请保留原编号继续核实', true);
    const { error } = apply(existing);
    this.put(owner, existing);
    return { error };
  }
  /** @param {string} action @param {unknown} input */
  fingerprint(action, input) { return canonical({ action, input }); }
  /** @param {string} owner @param {string} ruleId */
  getScenarioRule(owner, ruleId) {
    assertId(owner); assertId(ruleId);
    const rule = this.#scenarioRules.get(`${owner}\0${ruleId}`);
    return rule ? structuredClone(rule) : undefined;
  }
  /** @param {string} owner @param {string} ruleId */
  reserveScenarioPreview(owner, ruleId) {
    const rule = this.getScenarioRule(owner, ruleId);
    if (!rule) throw new BankingError('OPERATION_NOT_FOUND', '找不到可访问的场景规则');
    rule.previewGeneration += 1;
    this.#scenarioRules.set(`${owner}\0${ruleId}`, structuredClone(rule));
    return rule.previewGeneration;
  }
  /** @param {string} owner @param {import('./contracts').OperationRecord} record @param {import('./contracts').ScenarioEffect} effect @param {()=>import('./contracts').ActionReceipt} makeReceipt */
  commitScenario(owner, record, effect, makeReceipt) {
    const persisted = this.get(owner, record.operationId);
    if (!persisted) throw new BankingError('OPERATION_NOT_FOUND', '未取得此操作的记录', true);
    if (persisted.receipt) return persisted.receipt;
    const current = this.getScenarioRule(owner, effect.ruleId);
    if (effect.action === 'scenario.create_rule') {
      if (current) throw new BankingError('PREVIEW_STALE', '规则编号已存在，请重新预览');
    } else if (!current || current.version !== effect.ruleVersion || current.previewGeneration !== effect.previewGeneration) {
      throw new BankingError('PREVIEW_STALE', '规则已变化，请重新预览并确认');
    }
    this.#scenarioRules.set(`${owner}\0${effect.ruleId}`, structuredClone(effect.after));
    const receipt = makeReceipt();
    persisted.receipt = receipt; persisted.state = 'succeeded';
    this.put(owner, persisted);
    return structuredClone(receipt);
  }
}

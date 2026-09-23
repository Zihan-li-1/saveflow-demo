// @ts-check
import { BankingError, assertFen, assertId } from './errors.mjs';

export const WIRE_VERSION = '1.1.0';
/** Internal B contracts follow 建骨架.md camelCase/Fen; network follows intent-contracts.md.
 * Currency is always explicit beside amount_minor. No numeric scaling at this boundary. */
const special = { fromAccountId: 'source_account_id', expectedYield: 'expected_yield_bps' };
/** @param {string} key */
const snake = key => /** @type {Record<string,string>} */(special)[key] ?? key.replace(/Fen$/, 'Minor').replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
const inverse = Object.fromEntries(Object.entries(special).map(([a, b]) => [b, a]));
/** @param {string} key */
const camel = key => inverse[key] ?? key.replace(/_minor$/, '_fen').replace(/_([a-z])/g, (_, c) => c.toUpperCase());
/** @param {unknown} value @param {(key: string) => string} rename @returns {unknown} */
function map(value, rename) {
  if (Array.isArray(value)) return value.map(v => map(v, rename));
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]) => [rename(k), map(v, rename)]);
    if (new Set(entries.map(e => e[0])).size !== entries.length) throw new BankingError('VALIDATION_ERROR', '字段映射冲突');
    return Object.fromEntries(entries);
  }
  return value;
}
/** @param {unknown} value */
export const toWire = value => map(value, snake);
/** @param {unknown} value */
export const fromWire = value => map(value, camel);

/** A/D handoff: accepts ONLY resolved server entity references, never raw LLM payee names.
 * @param {{action: string, state: string, resolved_slots: Record<string, unknown>, references: {slot: string, entity_id: string, source: string}[]}} resolved
 * @returns {import('./contracts').ActionRequest} */
export function transferFromResolvedIntent(resolved) {
  if (resolved.action !== 'transfer.create' || resolved.state !== 'ready_for_planning') throw new BankingError('UNKNOWN_ACTION', '只接受已解析的 transfer.create');
  const slots = resolved.resolved_slots;
  const amount = /** @type {{amount_minor?: unknown, currency?: unknown} | undefined} */(slots.amount);
  assertFen(amount?.amount_minor);
  if (amount?.currency !== 'CNY') throw new BankingError('VALIDATION_ERROR', '金额必须包含 CNY 币种');
  /** @param {string} slot */
  function entity(slot) {
    const matches = resolved.references.filter(r => r.slot === slot && ['financial_context', 'user_selection'].includes(r.source));
    if (matches.length !== 1) throw new BankingError('VALIDATION_ERROR', '账户和收款人必须先唯一解析');
    assertId(matches[0].entity_id);
    return matches[0].entity_id;
  }
  return { action: 'transfer_money', input: { fromAccountId: entity('source_account_ref'), payeeId: entity('payee_ref'), amountFen: amount.amount_minor, currency: 'CNY' } };
}

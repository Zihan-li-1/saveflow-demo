// @ts-check
/** 转账方向判定 —— 唯一权威定义。以下四处必须与此保持一致：
 *  1. src/agent/validate-parsed-intent.mjs —— 契约校验的 directionKey
 *  2. src/agent/clarification/merge-intent.mjs —— 续接的必需槽位
 *  3. src/agent/runtime.mjs —— 生产 resolver 的路由
 *  4. src/skill/transfer/index.ts —— @deprecated 的 TS 平行实现（未接进生产）
 *
 * 判定规则：
 *  - 'internal'：本人互转 —— 槽位含 target_account_ref，或 transfer_type === 'internal'
 *  - 'external'：对外转账 —— 槽位含 payee_ref，或 transfer_type === 'external'
 *  - 'unclear' ：两者皆无 —— 需先澄清 transfer_type
 *
 * 注意：validate-parsed-intent.mjs 中「payee_ref 与 target_account_ref 互斥、且 transfer_type
 * 须与之匹配」的合法性校验，仍用严格的 `'xxx_ref' in slots`（不含 transfer_type）来判断，
 * 与本函数「判定方向」是两个不同职责，请勿混用。
 * @param {Record<string, unknown>} slots
 * @returns {'internal' | 'external' | 'unclear'}
 */
export function transferDirection(slots) {
  if ('target_account_ref' in slots || slots.transfer_type === 'internal') return 'internal';
  if ('payee_ref' in slots || slots.transfer_type === 'external') return 'external';
  return 'unclear';
}

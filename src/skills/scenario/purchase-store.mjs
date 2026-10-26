import { emptyPurchaseState } from './purchase-budget.mjs';

/** PostgreSQL-only production store. Do not call external services in callback.
 * ponytail: serializes all an owner's workflows; split account locks if volume
 * warrants it. One transaction preserves budget and operation invariants.
 */
export function createPurchaseStore(sql) {
  if (!sql?.begin || !sql?.unsafe) throw Object.assign(new Error('购物持久化数据库未配置'), { code: 'PERSISTENCE_UNAVAILABLE' });
  return {
    async transaction(owner, callback) {
      if (typeof owner !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(owner)) throw Object.assign(new Error('用户会话无效'), { code: 'UNAUTHORIZED' });
      return sql.begin(async tx => {
        await tx`INSERT INTO purchase_owners (owner_ref, record) VALUES (${owner}, ${tx.json(emptyPurchaseState())}) ON CONFLICT DO NOTHING`;
        const [row] = await tx`SELECT record FROM purchase_owners WHERE owner_ref = ${owner} FOR UPDATE`;
        const state = structuredClone(row.record);
        if (!state || !['workflows', 'reservations', 'operations', 'jobs', 'events'].every(key => state[key] && typeof state[key] === 'object' && !Array.isArray(state[key]))) throw new Error('Invalid purchase state');
        const result = await callback(state);
        await tx`UPDATE purchase_owners SET record = ${tx.json(state)}, revision = revision + 1, updated_at = now() WHERE owner_ref = ${owner}`;
        return structuredClone(result);
      });
    },
    async owners() { return (await sql`SELECT owner_ref FROM purchase_owners`).map(row => row.owner_ref); },
  };
}

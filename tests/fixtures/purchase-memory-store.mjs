import { emptyPurchaseState } from '../../src/skills/scenario/purchase-budget.mjs';

// Tests only. Production must fail closed when PostgreSQL is unavailable.
export function createPurchaseTestStore() {
  const records = new Map(), queues = new Map();
  return {
    async transaction(owner, callback) {
      const previous = queues.get(owner) ?? Promise.resolve();
      let release;
      const next = new Promise(resolve => { release = resolve; });
      queues.set(owner, previous.then(() => next));
      await previous;
      try {
        const state = structuredClone(records.get(owner) ?? emptyPurchaseState());
        const result = await callback(state);
        records.set(owner, structuredClone(state));
        return structuredClone(result);
      } finally { release(); }
    },
    async owners() { return [...records.keys()]; },
  };
}

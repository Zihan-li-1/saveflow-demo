import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createPurchaseStore } from '../src/skills/scenario/purchase-store.mjs';
import { createPurchaseTestStore } from './fixtures/purchase-memory-store.mjs';
import { reserveBudget } from '../src/skills/scenario/purchase-budget.mjs';

async function check(store, owner) {
  const results = await Promise.allSettled(['first', 'second'].map(workflow_ref => store.transaction(owner, state =>
    reserveBudget(state, { workflow_ref, account_ref: 'acc', amount_minor: 70000, available_minor: 100000, obligations_minor: 0 }))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'INSUFFICIENT_PLANNING_BALANCE');
  await assert.rejects(store.transaction(owner, state => { state.events.invalid = {}; throw new Error('rollback'); }));
  assert.equal(await store.transaction(owner, state => Object.hasOwn(state.events, 'invalid')), false);
  assert.equal(await store.transaction(owner + '_other', state => Object.keys(state.reservations).length), 0);
}
test('isolated test store serializes concurrent reservations and rolls back errors', async () => check(createPurchaseTestStore(), 'test_owner'));
test('production store requires an explicit database client', () => {
  assert.throws(() => createPurchaseStore(), { code: 'PERSISTENCE_UNAVAILABLE' });
});
test('PostgreSQL owner transactions survive reconnect and prevent double allocation', { skip: !process.env.PURCHASE_TEST_DATABASE_URL }, async () => {
  const { default: postgres } = await import('postgres');
  const sql = postgres(process.env.PURCHASE_TEST_DATABASE_URL, { max: 4, connect_timeout: 5 });
  const owner = 'test_' + randomUUID();
  try {
    await sql.unsafe(await readFile(new URL('../migrations/006_purchase_workflows.sql', import.meta.url), 'utf8'));
    await check(createPurchaseStore(sql), owner);
    const other = postgres(process.env.PURCHASE_TEST_DATABASE_URL, { max: 1, connect_timeout: 5 });
    try { assert.equal(await createPurchaseStore(other).transaction(owner, s => Object.keys(s.reservations).length), 1); }
    finally { await other.end(); }
  } finally {
    await sql`DELETE FROM purchase_owners WHERE owner_ref IN (${owner}, ${owner + '_other'})`;
    await sql.end();
  }
});

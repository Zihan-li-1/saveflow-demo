import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import seed from '../src/data/saveflow_mock_data.json' with { type: 'json' };
import { createPostgresBankingCore } from '../src/banking-core/postgres-store.mjs';

const connectionString = process.env.BANKING_TEST_DATABASE_URL;
const input = { fromAccountId: 'ACC-CHECKING', payeeId: 'payee_001', amountFen: 100, currency: 'CNY' };
const value = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };

async function fixture(t) {
  const source = structuredClone(seed);
  source.user.id = `test_${randomUUID()}`;
  const { default: postgres } = await import('postgres');
  const sql = postgres(connectionString, { max: 1 });
  const cores = [];
  t.after(async () => {
    for (const core of cores) await core.close();
    for (const table of ['banking_transactions', 'banking_operations', 'banking_cards', 'banking_accounts']) {
      await sql.unsafe(`DELETE FROM ${table} WHERE owner_id = $1`, [source.user.id]);
    }
    await sql.end({ timeout: 5 });
  });
  const open = async () => { const core = await createPostgresBankingCore({ connectionString, source }); cores.push(core); return core; };
  return { sql, owner: source.user.id, open, core: await open() };
}

test('Postgres JSONB: driver serializes once; operation fields and seeded/executed transactions are objects', { skip: !connectionString }, async t => {
  const { sql, owner, core } = await fixture(t);
  const [driver] = await sql.unsafe('SELECT jsonb_typeof($1::jsonb) AS kind, $1::jsonb AS record', [sql.json({ nested: { amountFen: 100 } })]);
  assert.equal(driver.kind, 'object');
  assert.deepEqual(driver.record, { nested: { amountFen: 100 } });
  const prepared = value(await core.prepare({ action: 'transfer_money', input }));
  const [row] = await sql.unsafe('SELECT *, jsonb_typeof(record) AS kind FROM banking_operations WHERE owner_id = $1 AND operation_id = $2', [owner, prepared.operationId]);
  assert.equal(row.kind, 'object');
  assert.equal(row.record.action, row.action);
  assert.equal(row.record.fingerprint, row.fingerprint);
  assert.deepEqual(row.record.request.input, { ...input, memo: '' });
  value(await core.decide(prepared.operationId, { previewHash: prepared.preview.previewHash, decision: 'confirm', confirmedStepIds: prepared.preview.stepIds }));
  const receipt = value(await core.execute(prepared.operationId, prepared.preview.previewHash));
  assert.equal(receipt.dataSource, 'synthetic_demo_only');
  const rows = await sql.unsafe('SELECT jsonb_typeof(record) AS kind FROM banking_transactions WHERE owner_id = $1', [owner]);
  assert.ok(rows.length > 1);
  assert.ok(rows.every(r => r.kind === 'object'));
  assert.equal((await core.repository.getTransactions()).filter(r => r.operationId === prepared.operationId).length, 1);
});

test('Postgres legacy JSONB: transfer/card previews and receipts survive cross-instance reads and execution', { skip: !connectionString }, async t => {
  const { sql, owner, core, open } = await fixture(t);
  const second = await open();
  for (const request of [{ action: 'transfer_money', input }, { action: 'card.set_budget', input: { cardId: 'CARD-ENT', monthlyBudgetFen: 10000 } }]) {
    const p = value(await core.prepare(request));
    const wrap = () => sql.unsafe('UPDATE banking_operations SET record = to_jsonb(record::text) WHERE owner_id = $1 AND operation_id = $2', [owner, p.operationId]);
    await wrap();
    assert.deepEqual(value(await second.getOperation(p.operationId)).preview, p.preview);
    value(await second.decide(p.operationId, { previewHash: p.preview.previewHash, decision: 'confirm', confirmedStepIds: p.preview.stepIds }));
    const receipt = value(await core.execute(p.operationId, p.preview.previewHash));
    const [updated] = await sql.unsafe('SELECT jsonb_typeof(record) AS kind FROM banking_operations WHERE owner_id = $1 AND operation_id = $2', [owner, p.operationId]);
    assert.equal(updated.kind, 'object');
    await wrap();
    assert.deepEqual(value(await second.execute(p.operationId, p.preview.previewHash)), receipt);
    const [row] = await sql.unsafe('SELECT record FROM banking_operations WHERE owner_id = $1 AND operation_id = $2', [owner, p.operationId]);
    assert.equal(typeof row.record, 'string');
    assert.deepEqual(value(await second.getOperation(p.operationId)).receipt, receipt);
  }
});

test('Postgres legacy transactions: month/account filters return decoded records without losing bills', { skip: !connectionString }, async t => {
  const { sql, owner, core, open } = await fixture(t);
  const before = await core.repository.getTransactions({ month: '2026-08' });
  assert.equal(before.length, 12);
  await sql.unsafe('UPDATE banking_transactions SET record = to_jsonb(record::text) WHERE owner_id = $1', [owner]);
  const second = await open();
  assert.deepEqual(await second.repository.getTransactions({ month: '2026-08' }), before);
  assert.deepEqual(await second.repository.getTransactions({ month: '2026-08', accountId: input.fromAccountId }), before.filter(r => r.accountId === input.fromAccountId));
  assert.deepEqual(await second.repository.getTransactions({ month: '2025-01' }), []);
});

test('Postgres legacy idempotency: same request replays; changed fingerprint/action and decisions still conflict', { skip: !connectionString }, async t => {
  const { sql, owner, core, open } = await fixture(t);
  const second = await open(), id = `op_${randomUUID()}`;
  const request = { confirmed: true, monthlySavingFen: 100 };
  const receipt = await core.createLegacyPlan(id, request);
  await sql.unsafe('UPDATE banking_operations SET record = to_jsonb(record::text) WHERE owner_id = $1 AND operation_id = $2', [owner, id]);
  assert.deepEqual(await second.createLegacyPlan(id, request), receipt);
  await assert.rejects(second.createLegacyPlan(id, { ...request, monthlySavingFen: 200 }), { code: 'IDEMPOTENCY_CONFLICT' });
  const p = value(await core.prepare({ action: 'transfer_money', input }));
  await assert.rejects(second.createLegacyPlan(p.operationId, request), { code: 'IDEMPOTENCY_CONFLICT' });
  value(await core.decide(p.operationId, { previewHash: p.preview.previewHash, decision: 'confirm', confirmedStepIds: p.preview.stepIds }));
  const conflict = await second.decide(p.operationId, { previewHash: p.preview.previewHash, decision: 'reject', confirmedStepIds: [] });
  assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(value(await core.getOperation(p.operationId)).state, 'confirmed');
});

test('Postgres malformed legacy records fail closed without changing balances', { skip: !connectionString }, async t => {
  const { sql, owner, core } = await fixture(t);
  const p = value(await core.prepare({ action: 'transfer_money', input }));
  const before = await core.repository.getAccount(input.fromAccountId);
  for (const invalid of ['not JSON', '[]', 'null', JSON.stringify(JSON.stringify({ action: 'transfer_money' }))]) {
    await sql.unsafe('UPDATE banking_operations SET record = $3::jsonb WHERE owner_id = $1 AND operation_id = $2', [owner, p.operationId, sql.json(invalid)]);
    assert.equal((await core.getOperation(p.operationId)).error.code, 'VALIDATION_ERROR');
    assert.equal((await core.execute(p.operationId, p.preview.previewHash)).error.code, 'VALIDATION_ERROR');
  }
  assert.deepEqual(await core.repository.getAccount(input.fromAccountId), before);
});

test('Postgres B: independent Core instances share preview, confirmation, receipt and ledger', { skip: !connectionString }, async () => {
  const source = structuredClone(seed);
  source.user.id = `test_${randomUUID()}`;
  const first = await createPostgresBankingCore({ connectionString, source });
  const second = await createPostgresBankingCore({ connectionString, source });
  const before = (await first.repository.getAccount(input.fromAccountId)).availableBalanceFen;
  let restarted;
  try {
    const prepared = value(await first.prepare({ action: 'transfer_money', input }));
    assert.equal((await second.repository.getAccount(input.fromAccountId)).availableBalanceFen, before);
    value(await second.decide(prepared.operationId, {
      previewHash: prepared.preview.previewHash,
      decision: 'confirm',
      confirmedStepIds: prepared.preview.stepIds,
    }));
    const [firstExecution, secondExecution] = await Promise.all([
      second.execute(prepared.operationId, prepared.preview.previewHash),
      first.execute(prepared.operationId, prepared.preview.previewHash),
    ]);
    const receipt = value(firstExecution);
    assert.deepEqual(value(secondExecution), receipt);
    assert.equal(receipt.status, 'succeeded');
    assert.deepEqual(value(await first.getOperation(prepared.operationId)).receipt, receipt);
    restarted = await createPostgresBankingCore({ connectionString, source });
    assert.deepEqual(value(await restarted.getOperation(prepared.operationId)).receipt, receipt);
    assert.equal((await first.repository.getAccount(input.fromAccountId)).availableBalanceFen, before - input.amountFen);
    assert.equal((await first.repository.getTransactions()).filter(row => row.operationId === prepared.operationId).length, 1);
  } finally {
    await restarted?.close();
    const postgres = await import('postgres');
    const sql = postgres.default(connectionString, { max: 1 });
    await sql.begin(async tx => {
      await tx.unsafe('DELETE FROM banking_transactions WHERE owner_id = $1', [source.user.id]);
      await tx.unsafe('DELETE FROM banking_operations WHERE owner_id = $1', [source.user.id]);
      await tx.unsafe('DELETE FROM banking_cards WHERE owner_id = $1', [source.user.id]);
      await tx.unsafe('DELETE FROM banking_accounts WHERE owner_id = $1', [source.user.id]);
    });
    await sql.end({ timeout: 5 });
    await first.close();
    await second.close();
  }
});

test('Postgres cards: a second instance and restart see the committed budget and state', { skip: !connectionString }, async () => {
  const source = structuredClone(seed);
  source.user.id = `test_${randomUUID()}`;
  const first = await createPostgresBankingCore({ connectionString, source });
  const second = await createPostgresBankingCore({ connectionString, source });
  let restarted;
  let firstClosed = false;
  try {
    const before = await first.repository.getCard('CARD-ENT');
    const prepared = value(await first.prepare({ action: 'card.set_budget', input: { cardId: 'CARD-ENT', monthlyBudgetFen: 10000 } }));
    assert.equal((await second.repository.getCard('CARD-ENT')).monthlyBudgetFen, before.monthlyBudgetFen);
    value(await second.decide(prepared.operationId, { previewHash: prepared.preview.previewHash, decision: 'confirm', confirmedStepIds: prepared.preview.stepIds }));
    const receipt = value(await second.execute(prepared.operationId, prepared.preview.previewHash));
    assert.deepEqual(value(await first.execute(prepared.operationId, prepared.preview.previewHash)), receipt);
    assert.equal((await first.repository.getCard('CARD-ENT')).monthlyBudgetFen, 10000);
    assert.equal((await first.repository.getCard('CARD-ENT')).version, before.version + 1);
    const freeze = value(await first.prepare({ action: 'card.freeze', input: { cardId: 'CARD-ENT' } }));
    value(await second.decide(freeze.operationId, { previewHash: freeze.preview.previewHash, decision: 'confirm', confirmedStepIds: freeze.preview.stepIds }));
    value(await second.execute(freeze.operationId, freeze.preview.previewHash));
    assert.equal((await first.repository.getCard('CARD-ENT')).status, 'frozen');
    const thaw = value(await second.prepare({ action: 'card.unfreeze', input: { cardId: 'CARD-ENT' } }));
    value(await first.decide(thaw.operationId, { previewHash: thaw.preview.previewHash, decision: 'confirm', confirmedStepIds: thaw.preview.stepIds }));
    value(await first.execute(thaw.operationId, thaw.preview.previewHash));
    assert.equal((await second.repository.getCard('CARD-ENT')).status, 'active');
    await first.close();
    firstClosed = true;
    restarted = await createPostgresBankingCore({ connectionString, source });
    assert.equal((await restarted.repository.getCard('CARD-ENT')).monthlyBudgetFen, 10000);
    assert.equal((await restarted.repository.getCard('CARD-ENT')).version, before.version + 3);
    assert.equal((await restarted.repository.getCard('CARD-ENT')).status, 'active');
  } finally {
    await restarted?.close();
    const postgres = await import('postgres');
    const sql = postgres.default(connectionString, { max: 1 });
    await sql.begin(async tx => {
      await tx.unsafe('DELETE FROM banking_transactions WHERE owner_id = $1', [source.user.id]);
      await tx.unsafe('DELETE FROM banking_operations WHERE owner_id = $1', [source.user.id]);
      await tx.unsafe('DELETE FROM banking_cards WHERE owner_id = $1', [source.user.id]);
      await tx.unsafe('DELETE FROM banking_accounts WHERE owner_id = $1', [source.user.id]);
    });
    await sql.end({ timeout: 5 });
    if (!firstClosed) await first.close();
    await second.close();
  }
});

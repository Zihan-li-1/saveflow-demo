import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import seed from '../src/data/saveflow_mock_data.json' with { type: 'json' };
import { createPostgresBankingCore } from '../src/banking-core/postgres-store.mjs';

const connectionString = process.env.BANKING_TEST_DATABASE_URL;
const input = { fromAccountId: 'ACC-CHECKING', payeeId: 'payee_001', amountFen: 100, currency: 'CNY' };
const value = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };

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
      await tx.unsafe('DELETE FROM banking_accounts WHERE owner_id = $1', [source.user.id]);
    });
    await sql.end({ timeout: 5 });
    await first.close();
    await second.close();
  }
});
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { PostgresAgentRunRepository } from '../server/agent-framework/repository.mjs';

test('PostgreSQL run persistence: unique keys, CAS, ownership and cancellation', { skip: !process.env.BANKING_TEST_DATABASE_URL }, async () => {
  // A temporary table shadows the production table in this dedicated connection.
  const sql = postgres(process.env.BANKING_TEST_DATABASE_URL, { max: 1, connect_timeout: 5 });
  try {
    const migration = await readFile(new URL('../migrations/008_agent_runs.sql', import.meta.url), 'utf8');
    await sql.unsafe(migration.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMPORARY TABLE'));
    const first = new PostgresAgentRunRepository(sql); const second = new PostgresAgentRunRepository(sql);
    const run = { run_id: 'test_run', user_id: 'test_owner', version: 0, state: 'CREATED' };
    assert.equal((await first.create(run, 'key', 'digest')).created, true);
    assert.equal((await second.create({ ...run, run_id: 'other' }, 'key', 'digest')).created, false);
    await assert.rejects(first.create(run, 'key', 'different'), { code: 'DUPLICATE_REQUEST' });
    const a = await first.get('test_owner', 'test_run'); const b = await second.get('test_owner', 'test_run');
    await first.save(a, 0); await assert.rejects(second.save(b, 0), { code: 'DUPLICATE_REQUEST' });
    await assert.rejects(second.get('another_owner', 'test_run'), { code: 'RUN_NOT_FOUND' });
    await second.requestCancel('test_owner', 'test_run'); assert.equal(await first.cancellationRequested('test_owner', 'test_run'), true);
  } finally { await sql.end({ timeout: 5 }); }
});

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before running database migrations.');
const { default: postgres } = await import('postgres');
const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 });
try {
  const migration = await readFile(new URL('../migrations/001_banking_persistence.sql', import.meta.url), 'utf8');
  await sql.begin(async tx => {
    for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) await tx.unsafe(statement);
  });
  console.log('Banking persistence schema is up to date.');
} finally {
  await sql.end({ timeout: 5 });
}
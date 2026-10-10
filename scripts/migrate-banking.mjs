import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before running database migrations.');
const { default: postgres } = await import('postgres');
const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 });
try {
  for (const name of ['001_banking_persistence.sql', '002_cards.sql', '003_wealth_holdings.sql']) {
    const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    await sql.begin(async tx => {
      for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) await tx.unsafe(statement);
    });
  }
  console.log('Banking persistence schema is up to date.');
} finally {
  await sql.end({ timeout: 5 });
}

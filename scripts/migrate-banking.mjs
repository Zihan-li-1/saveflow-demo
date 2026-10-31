import { readFile } from 'node:fs/promises';

/** Split SQL only at statement terminators outside strings, identifiers, comments, and dollar quotes. */
export function splitSqlStatements(sql) {
  const statements = [];
  let start = 0;
  let quote = null;
  let dollarTag = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i], next = sql[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (dollarTag) { if (sql.startsWith(dollarTag, i)) { i += dollarTag.length - 1; dollarTag = null; } continue; }
    if (quote) {
      if (ch === quote) {
        if (sql[i + 1] === quote) { i += 1; continue; }
        quote = null;
      }
      continue;
    }
    if (ch === '-' && next === '-') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '$') {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) { dollarTag = match[0]; i += dollarTag.length - 1; continue; }
    }
    if (ch === ';') {
      const statement = sql.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before running database migrations.');
const { default: postgres } = await import('postgres');
const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 });
try {
  for (const name of ['001_banking_persistence.sql', '002_cards.sql', '003_wealth_holdings.sql', '003_scenario_rules.sql', '004_card_security_controls.sql', '005_card_balance_reminders.sql', '006_purchase_workflows.sql', '007_internal_transfer_entries.sql', '008_agent_runs.sql']) {
    const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    await sql.begin(async tx => {
      for (const statement of splitSqlStatements(migration)) await tx.unsafe(statement);
    });
  }
  console.log('Banking persistence schema is up to date.');
} finally {
  await sql.end({ timeout: 5 });
}

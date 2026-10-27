import postgres from 'postgres';
import { createPurchaseStore } from '../src/skills/scenario/purchase-store.mjs';
import { runDuePurchases } from '../src/skills/scenario/purchase-skill.mjs';
import { setTimeout } from 'node:timers/promises';
if (!process.env.DATABASE_URL || process.env.PURCHASE_WORKER_ENABLED !== 'true') throw new Error('Configure DATABASE_URL and PURCHASE_WORKER_ENABLED=true');
const sql = postgres(process.env.DATABASE_URL, { max: 2, connect_timeout: 5, idle_timeout: 20 });
const store = createPurchaseStore(sql);
const stopping = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stopping.abort());
try {
  while (!stopping.signal.aborted) {
    await store.transaction('purchase_worker_system', s => { s.events.heartbeat = { at: Date.now() }; });
    await runDuePurchases({ store });
    if (process.argv.includes('--once')) break;
    // A server process independent of the browser; no order API is called here.
    try { await setTimeout(30000, undefined, { signal: stopping.signal }); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  }
} finally { await sql.end({ timeout: 5 }); }

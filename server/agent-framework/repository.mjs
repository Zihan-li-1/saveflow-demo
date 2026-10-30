import { fail } from './models.mjs';

// Repository boundary: implementations must atomically claim create keys and CAS versions.
export class AgentRunRepository {
  async create() { throw new Error('not implemented'); }
  async get() { throw new Error('not implemented'); }
  async save() { throw new Error('not implemented'); }
  async health() { throw new Error('not implemented'); }
  async requestCancel() { throw new Error('not implemented'); }
  async cancellationRequested() { throw new Error('not implemented'); }
}
// Local demonstration only. Not shared between processes and not durable.
export class InMemoryAgentRunRepository extends AgentRunRepository {
  #runs = new Map();
  #keys = new Map();
  #cancelled = new Set();
  async create(run, key, fingerprint) {
    const scoped = `${run.user_id}:${key}`;
    const previous = this.#keys.get(scoped);
    if (previous) { if (previous.fingerprint !== fingerprint) fail('DUPLICATE_REQUEST'); return { run: await this.get(run.user_id, previous.run_id), created: false }; }
    this.#keys.set(scoped, { fingerprint, run_id: run.run_id }); this.#runs.set(run.run_id, structuredClone(run)); return { run: structuredClone(run), created: true };
  }
  async get(owner, id) { const run = this.#runs.get(id); if (!run || run.user_id !== owner) fail('RUN_NOT_FOUND'); return structuredClone(run); }
  async save(run, expectedVersion) {
    const current = await this.get(run.user_id, run.run_id);
    // No await between comparison and mutation.
    if (this.#runs.get(run.run_id).version !== expectedVersion || current.version !== expectedVersion) fail('DUPLICATE_REQUEST');
    run.version = expectedVersion + 1; run.updated_at = new Date().toISOString(); this.#runs.set(run.run_id, structuredClone(run));
  }
  async health() { return { persistence: 'in_memory_demo_only' }; }
  async requestCancel(owner, id) { await this.get(owner, id); this.#cancelled.add(id); }
  async cancellationRequested(owner, id) { await this.get(owner, id); return this.#cancelled.has(id); }
}
export class PostgresAgentRunRepository extends AgentRunRepository {
  constructor(sql) { super(); this.sql = sql; }
  async create(run, key, fingerprint) {
    const rows = await this.sql`INSERT INTO agent_runs (run_id, user_id, idempotency_key, fingerprint, version, body) VALUES (${run.run_id}, ${run.user_id}, ${key}, ${fingerprint}, ${run.version}, ${this.sql.json(run)}) ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING run_id`;
    if (rows.length) return { run, created: true };
    const [old] = await this.sql`SELECT body, fingerprint FROM agent_runs WHERE user_id = ${run.user_id} AND idempotency_key = ${key}`;
    if (old.fingerprint !== fingerprint) fail('DUPLICATE_REQUEST');
    return { run: old.body, created: false };
  }
  async get(owner, id) { const [row] = await this.sql`SELECT body FROM agent_runs WHERE run_id = ${id} AND user_id = ${owner}`; if (!row) fail('RUN_NOT_FOUND'); return row.body; }
  async save(run, expectedVersion) {
    const next = { ...run, version: expectedVersion + 1, updated_at: new Date().toISOString() };
    const rows = await this.sql`UPDATE agent_runs SET body = ${this.sql.json(next)}, version = ${next.version} WHERE run_id = ${run.run_id} AND user_id = ${run.user_id} AND version = ${expectedVersion} RETURNING run_id`;
    if (!rows.length) fail('DUPLICATE_REQUEST'); Object.assign(run, next);
  }
  async health() { await this.sql`SELECT run_id FROM agent_runs LIMIT 1`; return { persistence: 'postgres' }; }
  async requestCancel(owner, id) { await this.sql`UPDATE agent_runs SET cancel_requested = true WHERE run_id = ${id} AND user_id = ${owner}`; }
  async cancellationRequested(owner, id) { const [row] = await this.sql`SELECT cancel_requested FROM agent_runs WHERE run_id = ${id} AND user_id = ${owner}`; if (!row) fail('RUN_NOT_FOUND'); return row.cancel_requested; }
}

// Local HTTP smoke test through the real Next route handlers. Synthetic data only.
import next from 'next';
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBankingCore } from '../src/banking-core/core.mjs';

process.env.SAVEFLOW_ACCESS_CODE = randomUUID();
delete process.env.DATABASE_URL;
process.env.ALLOW_EPHEMERAL_BANKING = 'true';
process.env.SAVEFLOW_STATIC_EXPORT = 'false';
const app = next({ dev: true, hostname: '127.0.0.1', port: 0 });
await app.prepare();
const server = http.createServer(app.getRequestHandler());
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const checks = [];
let exitCode = 0;
async function call(path, body, key = randomUUID()) {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Saveflow-Access': process.env.SAVEFLOW_ACCESS_CODE, 'Idempotency-Key': key, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
  const envelope = await response.json();
  assert.equal(response.status, 200, JSON.stringify(envelope));
  assert.deepEqual(Object.keys(envelope).sort(), ['data', 'error', 'request_id', 'run_id', 'state']);
  return envelope;
}
try {
  const repository = createBankingCore().repository;
  const month = (await repository.getContextInfo()).currentMonth;
  await call('/health'); await call('/ready'); checks.push('health_ready');
  assert.equal((await call('/api/v1/skills')).data.length, 5); await call('/api/v1/skills/bill/schema'); checks.push('five_skills_schema');
  const key = randomUUID(); const input = { session_id: 'http_smoke', query: '账单测试', skill_name: 'bill', arguments: { action: 'bill.summary', month } };
  const single = await call('/api/v1/agent/runs', input, key); assert.equal(single.state, 'SUCCEEDED'); checks.push('single_read');
  const duplicate = await call('/api/v1/agent/runs', input, key); assert.equal(duplicate.run_id, single.run_id); checks.push('duplicate');
  await call(`/api/v1/agent/runs/${single.run_id}`);
  const missing = await call('/api/v1/agent/runs', { ...input, arguments: { action: 'bill.summary' } }); assert.equal(missing.state, 'COLLECTING_INPUT');
  assert.equal((await call(`/api/v1/agent/runs/${missing.run_id}/input`, { arguments: { month } })).state, 'SUCCEEDED'); checks.push('input_resume');
  const write = await call('/api/v1/agent/runs', { session_id: 'http_smoke', query: '生成规则提案测试', skill_name: 'scenario', arguments: { action: 'scenario.create_rule', trigger: { type: 'manual', value: 'HTTP smoke test' }, conditions: {}, proposed_steps: [{ action: 'card.get', parameters: {} }], authorization_scope: 'suggest_only' } });
  assert.equal(write.state, 'WAITING_CONFIRMATION');
  const confirmed = await call(`/api/v1/agent/runs/${write.run_id}/confirm`, { ...write.data.confirmations[0], confirmed: true }); assert.equal(confirmed.state, 'SUCCEEDED'); assert.equal(confirmed.data.result.financial_execution, false); checks.push('confirmed_proposal_only');
  const cancel = await call('/api/v1/agent/runs', { ...input, arguments: { action: 'bill.summary' } });
  assert.equal((await call(`/api/v1/agent/runs/${cancel.run_id}/cancel`, {})).state, 'CANCELLED'); checks.push('cancel');
  const sequence = await call('/api/v1/agent/runs', { session_id: 'http_smoke', query: '顺序查询测试', steps: [
    { step_id: 'bill_step', skill_name: 'bill', arguments: { action: 'bill.summary', month } },
    { step_id: 'card_step', skill_name: 'card', arguments: { action: 'card.get', card_ref: (await repository.getCards())[0].name }, dependencies: ['bill_step'] },
  ] }); assert.equal(sequence.state, 'SUCCEEDED'); checks.push('two_skill_sequence');
  console.log(JSON.stringify({ mock: true, checks, passed: checks.length, failed: 0 }));
} catch (error) {
  exitCode = 1;
  throw error;
} finally {
  // Next dev workers can retain handles after app.close on Windows.
  const deadline = setTimeout(() => process.exit(exitCode), 5000);
  deadline.unref();
  await new Promise(resolve => server.close(resolve)); await app.close();
  clearTimeout(deadline);
  process.exit(exitCode);
}

// Real Docker/MCP/PostgreSQL acceptance. All mutations use synthetic data only.
// Deliberately report known volatile continuation layers as merge blockers.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import nextEnv from '@next/env';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { createTrueforgeClient } from '../server/trueforge-client.mjs';

nextEnv.loadEnvConfig(process.cwd(), true);
const dir = 'docs/verification/postgres-fix';
await mkdir(dir, { recursive: true });
const report = { at: new Date().toISOString(), syntheticOnly: true, checks: [], mergeBlockers: [] };
const compose = ['compose', '--env-file', '.env.local', '-f', 'compose.yaml', '-f', 'compose.postgres.yaml'];
const runFile = promisify(execFile);
async function docker(...args) { return (await runFile('docker', [...compose, ...args], { timeout: 90000, maxBuffer: 2 * 1024 * 1024 })).stdout; }
async function coreEval(code) { return JSON.parse(await docker('exec', '-T', 'mcp', 'node', '--input-type=module', '-e', code)); }
const coreImports = `import seed from './src/data/saveflow_mock_data.json' with { type: 'json' }; import { createPostgresBankingCore } from './src/banking-core/postgres-store.mjs'; import postgres from 'postgres'; const connectionString = process.env.SAVEFLOW_TRIAL_DATABASE_URL; const value = r => { if (!r.ok) throw new Error(r.error.code); return r.data; };`;
async function call(port, name, args = {}) {
  const client = new Client({ name: 'docker-persistence-acceptance', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    return name === 'tools/list' ? await client.listTools() : (await client.callTool({ name, arguments: args })).structuredContent;
  } finally { await client.close(); }
}
async function post(path, body, extraHeaders = {}) {
  const response = await fetch(`http://127.0.0.1:4300${path}`, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Saveflow-Access': process.env.SAVEFLOW_ACCESS_CODE, ...extraHeaders,
  }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() };
}
async function ready() {
  for (let n = 0; n < 40; n++) {
    try { if ((await fetch('http://127.0.0.1:4300/healthz')).ok && (await fetch('http://127.0.0.1:4333/mcp')).status === 405 && (await fetch('http://127.0.0.1:4334/mcp')).status === 405) return; } catch { /* Wait for the actual services. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Docker services did not become ready');
}
try {
  await ready();
  const tools = (await call(4333, 'tools/list')).tools.map(t => t.name);
  assert.ok(tools.every(name => !/execute|confirm|decide/.test(name)));
  report.checks.push({ name: 'MCP exposes queries/previews only', tools });
  const bill = await call(4333, 'bill_summary', { month: '2026-08' });
  assert.equal(bill.data.transactionCount, 12); assert.equal(bill.data.totalExpenseFen, 846000);
  const preview = await call(4333, 'transfer_preview', { source_account_ref: '活期账户', payee_ref: '张三', amount: { amount_minor: 100, currency: 'CNY' } });
  assert.equal(preview.status, 'awaiting_confirmation');
  const snapshot = () => coreEval(`${coreImports}
    const core = await createPostgresBankingCore({ connectionString }); const sql = postgres(connectionString, { max: 1 });
    try { const [record] = await sql.unsafe(${JSON.stringify("SELECT operation_id, action, state, jsonb_typeof(record) AS kind, record->>'action' AS record_action, record->>'fingerprint' = fingerprint AS fingerprint_matches FROM banking_operations WHERE owner_id = $1 AND operation_id = $2")}, ['USR-DEMO-001', ${JSON.stringify(preview.operationId)}]);
    console.log(JSON.stringify({ record, operation: value(await core.getOperation(${JSON.stringify(preview.operationId)})), accounts: await core.repository.getAccounts(), cards: await core.repository.getCards(), transactions: (await core.repository.getTransactions()).length })); } finally { await core.close(); await sql.end(); }`);
  const before = await snapshot();
  assert.equal(before.record.kind, 'object'); assert.equal(before.record.fingerprint_matches, true); assert.equal(before.record.action, before.record.record_action);
  const raw = preview.operationId, hash = preview.preview.previewHash;
  for (const id of [`tfpreview:${raw}`, raw]) {
    const r = await post('/api/banking', { schema_version: '1.1.0', action: 'action.execute', input: { operation_id: id, preview_hash: hash } }, { 'Idempotency-Key': id });
    assert.equal(r.status, id.startsWith('tfpreview:') ? 403 : 400);
    assert.equal(r.json.code, id.startsWith('tfpreview:') ? 'FORBIDDEN' : 'OPERATION_NOT_FOUND');
  }
  report.checks.push({ name: 'JSONB object/action/fingerprint and prefix-stripping execution boundary', record: before.record });
  const clarifying = await call(4333, 'transfer_preview', { payee_ref: '张三', amount: { amount_minor: 100, currency: 'CNY' } });
  const bridged = await call(4334, 'transfer_preview', { payee_ref: '张三', amount: { amount_minor: 100, currency: 'CNY' } });
  assert.equal(clarifying.status, 'needs_clarification'); assert.equal(bridged.status, 'needs_clarification');
  const web = await post('/api/banking-agent', { message: '给张三转100元' });
  assert.equal(web.status, 200); assert.equal(web.json.data.status, 'needs_clarification');
  const webBill = await post('/api/banking-agent', { message: '查账单' });
  assert.equal(webBill.status, 200); assert.equal(webBill.json.data.status, 'needs_clarification');
  const bridgeAnswer = { continuationToken: bridged.continuationToken, choice: { optionId: bridged.choices[0].optionId } };
  const bridgeOnce = await call(4334, 'transfer_preview', bridgeAnswer);
  assert.equal(bridgeOnce.status, 'awaiting_confirmation');
  assert.deepEqual(await call(4334, 'transfer_preview', bridgeAnswer), bridgeOnce);
  const webAnswer = { continuationToken: web.json.data.continuationToken, choice: { optionId: web.json.data.choices[0].optionId } };
  const webOnce = await post('/api/banking-agent', webAnswer), webTwice = await post('/api/banking-agent', webAnswer);
  assert.equal(webOnce.status, 200); assert.equal(webTwice.status, 200);
  assert.equal(webOnce.json.data.status, 'awaiting_confirmation');
  assert.deepEqual(webTwice.json.data, webOnce.json.data);
  report.checks.push({ name: 'real web and bridge duplicate continuation requests replay the same preview', webOperationId: webOnce.json.data.operationId, bridgeOperationId: bridgeOnce.operationId });

  // A separate synthetic owner exercises a real mock debit; never the trial
  // user, an external bank, a model-issued confirmation, or an exposed MCP tool.
  const owner = `test_docker_${randomUUID()}`;
  const committed = await coreEval(`${coreImports}
    const source = structuredClone(seed); source.user.id = ${JSON.stringify(owner)};
    const a = await createPostgresBankingCore({ connectionString, source }); const b = await createPostgresBankingCore({ connectionString, source });
    try { const before = await a.repository.getAccount('ACC-CHECKING'); const p = value(await a.prepare({ action: 'transfer_money', input: { fromAccountId: 'ACC-CHECKING', payeeId: 'payee_001', amountFen: 100, currency: 'CNY' } }));
    value(await b.decide(p.operationId, { previewHash: p.preview.previewHash, decision: 'confirm', confirmedStepIds: p.preview.stepIds }));
    const receipt = value(await b.execute(p.operationId, p.preview.previewHash)); const duplicate = value(await a.execute(p.operationId, p.preview.previewHash));
    console.log(JSON.stringify({ owner: source.user.id, operationId: p.operationId, hash: p.preview.previewHash, beforeFen: before.availableBalanceFen, receipt, duplicate })); } finally { await a.close(); await b.close(); }`);
  assert.equal(committed.receipt.dataSource, 'synthetic_demo_only'); assert.deepEqual(committed.duplicate, committed.receipt);

  // Agent sessions live in the separate TrueForge service, not the web Core DB.
  const tfEnv = { ...process.env, TRUEFORGE_BASE_URL: 'http://127.0.0.1:8790', TRUEFORGE_MCP_SERVER: 'saveflow-docker-mcp', TRUEFORGE_SKILL_MCP_SERVER: 'saveflow-docker-bridge' };
  const sessionId = await createTrueforgeClient({ env: tfEnv, tool: 'transfer_preview' }).createSession();
  await docker('up', '-d', '--force-recreate', '--no-deps', 'pilot-db');
  await docker('up', '-d', '--wait', 'pilot-db');
  await docker('restart', 'mcp');
  await ready();
  const after = await snapshot();
  assert.deepEqual(after, before);
  const resumed = await call(4333, 'transfer_preview', { continuationToken: clarifying.continuationToken, choice: { optionId: clarifying.choices[0].optionId } });
  assert.equal(resumed.status, 'awaiting_confirmation');
  const recovery = await coreEval(`${coreImports}
    const source = structuredClone(seed); source.user.id = ${JSON.stringify(owner)}; const core = await createPostgresBankingCore({ connectionString, source });
    try { console.log(JSON.stringify({ operation: value(await core.getOperation(${JSON.stringify(committed.operationId)})), account: await core.repository.getAccount('ACC-CHECKING'), ledgerCount: (await core.repository.getTransactions()).filter(r => r.operationId === ${JSON.stringify(committed.operationId)}).length })); } finally { await core.close(); }`);
  assert.deepEqual(recovery.operation.receipt, committed.receipt); assert.equal(recovery.ledgerCount, 1); assert.equal(recovery.account.availableBalanceFen, committed.beforeFen - 100);
  report.checks.push({ name: 'database container recreation + independent Core/MCP restart restore preview, receipt, balance and exactly one ledger entry', record: after.record, simulatedReceipt: recovery.operation.receipt, ledgerCount: recovery.ledgerCount, balanceFen: recovery.account.availableBalanceFen });
  report.checks.push({ name: 'encrypted MCP clarification token resumes after process restart', status: resumed.status });
  await docker('restart', 'bridge', 'web'); await ready();
  const lostBridge = await call(4334, 'transfer_preview', { continuationToken: bridged.continuationToken, choice: { optionId: bridged.choices[0].optionId } });
  assert.equal(lostBridge.error.code, 'CONTINUATION_INVALID');
  const lostWeb = await post('/api/banking-agent', { continuationToken: web.json.data.continuationToken, choice: { optionId: web.json.data.choices[0].optionId } });
  assert.equal(lostWeb.status, 400); assert.equal(lostWeb.json.code, 'CONTINUATION_INVALID');
  const lostBill = await post('/api/banking-agent', { continuationToken: webBill.json.data.continuationToken, message: '2026年8月' });
  assert.equal(lostBill.status, 400); assert.equal(lostBill.json.code, 'CONTINUATION_INVALID');
  const sdk = new TrueForge({ baseUrl: tfEnv.TRUEFORGE_BASE_URL, token: tfEnv.TRUEFORGE_TOKEN || undefined, maxRetries: 0 });
  const { data: session } = await sdk.sessions.get(sessionId);
  assert.equal(session.id, sessionId); assert.equal(session.shared, false);
  report.checks.push({ name: 'TrueForge Session survives web/MCP/bridge restarts (TrueForge service itself was not restarted)', shared: session.shared });
  report.mergeBlockers.push({ layer: 'web TrueForge adapter', observed: lostWeb.json.code, reason: 'tfm1 state/revision/cancellation/replay cache is process-local Map' });
  report.mergeBlockers.push({ layer: 'web TrueForge bill adapter', observed: lostBill.json.code, reason: 'tfb1 session/scope/replay cache is process-local Map' });
  report.mergeBlockers.push({ layer: 'MCP credential bridge', observed: lostBridge.error.code, reason: 'tfg1 alias/replay cache is process-local Map' });
  const final = await snapshot();
  assert.deepEqual(final.accounts, before.accounts); assert.deepEqual(final.cards, before.cards); assert.equal(final.transactions, before.transactions);
  report.checks.push({ name: 'trial account balances/cards/ledger unchanged throughout real chain', transactions: final.transactions });
  report.corePersistencePassed = true;
  report.endToEndContinuationPersistencePassed = false;
  report.safeToMerge = false;
  report.acceptanceChecksPassed = true;
} catch (error) {
  // Never print SDK/child-process error objects: they may contain credentials.
  if (error.stderr) await writeFile('.next/persistence-private-error.log', error.stderr);
  report.acceptanceChecksPassed = false;
  report.failure = { name: error.name, code: error.code ?? 'ASSERTION_OR_SERVICE_FAILURE', message: error instanceof assert.AssertionError ? error.message : 'Acceptance stopped; inspect local service diagnostics privately.' };
  process.exitCode = 1;
}
await writeFile(`${dir}/persistence-report.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

/* eslint-disable @typescript-eslint/no-require-imports -- Exercise ESM HTTP entry and transpiled browser client. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { handleBankingAgent, bankingAuthConfigStatus } = require('../server/banking-agent.mjs');
const env = { SAVEFLOW_BANKING_RUNTIME: 'legacy-qwen', SAVEFLOW_ACCESS_CODE: 'auth-test-access-1234', CONTINUATION_TOKEN_SECRET: 'auth-test-secret-1234' };
let sequence = 0;
const request = access => new Request('http://localhost/api/banking-agent', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `auth-test-${++sequence}`, ...(access === undefined ? {} : { 'x-saveflow-access': access }) },
  body: JSON.stringify({ message: '查询2026-08账单', history: [], consent: true }),
});

test('missing and incorrect test access codes stop before Harness and TrueForge with safe diagnostics', async () => {
  for (const enabled of [false, true]) for (const access of [undefined, 'wrong', 'auth-test-access-5678']) {
    const logs = [];
    const fail = () => { assert.fail('Unauthenticated request reached downstream'); };
    const response = await handleBankingAgent(request(access), {
      env: { ...env, SAVEFLOW_TRUEFORGE_BILL_ENABLED: String(enabled) },
      parseIntent: fail, trueforgeBillAdapter: { handle: fail }, onAuthDiagnostic: entry => logs.push(entry),
    });
    const body = await response.json();
    assert.equal(response.status, 401); assert.equal(body.code, 'UNAUTHORIZED');
    assert.deepEqual(logs, [{ event: 'banking_auth_failure', category: access === undefined ? 'ACCESS_HEADER_MISSING' : 'ACCESS_MISMATCH', requestId: body.requestId }]);
    for (const value of [env.SAVEFLOW_ACCESS_CODE, env.CONTINUATION_TOKEN_SECRET, 'SAVEFLOW_ACCESS_CODE', 'CONTINUATION_TOKEN_SECRET']) {
      assert.equal(JSON.stringify({ body, logs }).includes(value), false);
    }
  }
});

test('missing/invalid server configuration exposes no internal reason; wrong access cannot inspect continuation config', async () => {
  for (const access of [undefined, 'short']) {
    const logs = [];
    const response = await handleBankingAgent(request(), { env: { SAVEFLOW_ACCESS_CODE: access }, onAuthDiagnostic: e => logs.push(e) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'SERVICE_UNAVAILABLE');
    assert.equal(logs[0].category, access === undefined ? 'ACCESS_CONFIG_MISSING' : 'ACCESS_CONFIG_INVALID');
  }
  const missingSecret = { SAVEFLOW_ACCESS_CODE: env.SAVEFLOW_ACCESS_CODE };
  const wrong = await handleBankingAgent(request('wrong'), { env: missingSecret, onAuthDiagnostic() {} });
  assert.equal(wrong.status, 401); assert.equal((await wrong.json()).code, 'UNAUTHORIZED');
  const correct = await handleBankingAgent(request(env.SAVEFLOW_ACCESS_CODE), { env: missingSecret, onAuthDiagnostic() {} });
  assert.equal(correct.status, 503); assert.equal((await correct.json()).code, 'CONTINUATION_CONFIG_ERROR');
});

test('correct access code permits either explicitly configured whole runtime', async () => {
  const harness = await handleBankingAgent(request(env.SAVEFLOW_ACCESS_CODE), { env,
    parseIntent: async () => ({ schemaVersion: '1.0.0', action: 'bill.summary', slots: { month: '2026-08' }, missingSlots: [], status: 'ready_for_resolution' }),
  });
  const result = await harness.json();
  assert.equal(harness.status, 200); assert.equal(result.data.data.transactionCount, 12);
  let called = 0;
  const trueforge = await handleBankingAgent(request(env.SAVEFLOW_ACCESS_CODE), {
    env: { ...env, SAVEFLOW_BANKING_RUNTIME: 'trueforge' },
    trueforgeRuntimeClient: { createSession: async () => 'runtime-session', cancel: async () => {}, runTurn: async () => { called++; return JSON.stringify({ schemaVersion: '1.0.0', action: 'bill.summary', slots: { month: '2026-08' }, missingSlots: [], status: 'ready_for_resolution' }); } },
  });
  assert.equal(trueforge.status, 200); assert.equal(called, 1);
  assert.deepEqual((await trueforge.json()).data, result.data);
});

test('Netlify wrapper reads runtime environment and keeps access verification', async () => {
  const bankingAgent = (await import('../netlify/functions/banking-agent.mjs')).default;
  const keys = ['SAVEFLOW_ACCESS_CODE', 'CONTINUATION_TOKEN_SECRET'];
  const original = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = env[key];
    const denied = await bankingAgent(request('wrong'));
    assert.equal(denied.status, 401);
    // Auth succeeds, then existing request validation rejects consent without invoking providers.
    const accepted = new Request('http://localhost/api/banking-agent', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'x-forwarded-for': 'auth-netlify',
    }, body: JSON.stringify({ message: 'bill', consent: false }) });
    assert.equal((await (await bankingAgent(accepted)).json()).code, 'INVALID_REQUEST');
  } finally { keys.forEach((key, i) => { if (original[i] === undefined) delete process.env[key]; else process.env[key] = original[i]; }); }
});

test('Next development env loader loads local file, gives inherited environment priority, and reports only states', () => {
  const directory = mkdtempSync(join(tmpdir(), 'saveflow-auth-test-'));
  try {
    writeFileSync(join(directory, '.env.local'), `SAVEFLOW_ACCESS_CODE=${env.SAVEFLOW_ACCESS_CODE}\nCONTINUATION_TOKEN_SECRET=${env.CONTINUATION_TOKEN_SECRET}\n`);
    const code = `const loader=require(${JSON.stringify(require.resolve('@next/env'))}); loader.loadEnvConfig(${JSON.stringify(directory)},true,{info(){},error(){}}); console.log(JSON.stringify({fileMatches:process.env.SAVEFLOW_ACCESS_CODE==='auth-test-access-1234',inheritedMatches:process.env.SAVEFLOW_ACCESS_CODE==='inherited-test-access-1234',secretConfigured:process.env.CONTINUATION_TOKEN_SECRET.length>=16}));`;
    for (const inherited of [false, true]) {
      const child = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: {
        SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
        ...(inherited ? { SAVEFLOW_ACCESS_CODE: 'inherited-test-access-1234' } : {}),
      } });
      assert.equal(child.status, 0);
      assert.deepEqual(JSON.parse(child.stdout), { fileMatches: !inherited, inheritedMatches: inherited, secretConfigured: true });
    }
    assert.deepEqual(bankingAuthConfigStatus(env), { accessCode: 'configured', continuationSecret: 'configured' });
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.startsWith(join(tmpdir(), 'saveflow-auth-test-')));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('browser sends the access Header and masks legacy and new authentication error details', async () => {
  const ts = require('typescript');
  require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, filename);
  const { askBankingAgent } = require('../src/lib/banking-agent-client.ts');
  const original = global.fetch;
  try {
    for (const code of ['UNAUTHORIZED', 'ACCESS_NOT_CONFIGURED', 'CONTINUATION_CONFIG_ERROR', 'SERVICE_UNAVAILABLE']) {
      global.fetch = async (url, init) => {
        assert.equal(url, '/api/banking-agent'); assert.equal(init.headers['X-Saveflow-Access'], env.SAVEFLOW_ACCESS_CODE);
        return Response.json({ code, message: 'private server detail' }, { status: code === 'UNAUTHORIZED' ? 401 : 503 });
      };
      await assert.rejects(askBankingAgent({ message: 'bill' }, env.SAVEFLOW_ACCESS_CODE, new AbortController().signal), error => {
        assert.equal(error.code, code === 'UNAUTHORIZED' ? 'UNAUTHORIZED' : 'SERVICE_UNAVAILABLE');
        assert.equal(error.message.includes('private server detail'), false); return true;
      });
    }
  } finally { global.fetch = original; }
});

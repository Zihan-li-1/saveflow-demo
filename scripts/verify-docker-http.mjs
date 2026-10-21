import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd(), true);
const base = 'http://127.0.0.1:4300';
const report = { at: new Date().toISOString(), url: base, checks: [] };
const headers = { 'Content-Type': 'application/json', 'X-Saveflow-Access': process.env.SAVEFLOW_ACCESS_CODE };
async function check(name, path, init, status) {
  const response = await fetch(base + path, init), text = await response.text();
  assert.equal(response.status, status, name);
  assert.ok(!text.includes(process.env.SAVEFLOW_ACCESS_CODE));
  report.checks.push({ name, status: response.status });
}
try {
  await check('health', '/healthz', {}, 200);
  await check('static home', '/', {}, 200);
  await check('environment file not served', '/.env.local', {}, 404);
  await check('encoded path traversal refused', '/%2e%2e%2fpackage.json', {}, 400);
  const path = '/api/banking-agent';
  await check('POST method required', path, {}, 405);
  await check('missing access code', path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 401);
  await check('incorrect access code', path, { method: 'POST', headers: { ...headers, 'X-Saveflow-Access': 'incorrect-test-access-code' }, body: '{}' }, 401);
  await check('cross origin refused', path, { method: 'POST', headers: { ...headers, Origin: 'https://invalid.example' }, body: '{}' }, 403);
  await check('JSON content type required', path, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' }, 415);
  await check('16KiB body limit', path, { method: 'POST', headers, body: JSON.stringify({ message: 'x'.repeat(17000) }) }, 413);
  await check('invalid JSON refused', path, { method: 'POST', headers, body: '{' }, 400);
  await check('execution field rejected', path, { method: 'POST', headers, body: JSON.stringify({ message: '查询2026年8月账单', execute: true }) }, 400);
  for (let i = 0; i < 2; i++) await check('forged continuation refused', path, { method: 'POST', headers, body: JSON.stringify({ message: '查看我的卡', continuationToken: 'tfm1.invalid.invalid' }) }, 400);
  await check('10/minute limit preserved', path, { method: 'POST', headers, body: '{}' }, 429);
  await check('trial execute permanently forbidden', '/api/banking', { method: 'POST', headers, body: JSON.stringify({ schema_version: '1.1.0', action: 'action.execute', input: { operation_id: 'tfpreview:docker-test', preview_hash: 'a'.repeat(64) } }) }, 403);
  report.success = true;
} catch (error) { report.success = false; report.error = error.message; process.exitCode = 1; }
await mkdir('.next/docker-check', { recursive: true });
await writeFile('.next/docker-check/http-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

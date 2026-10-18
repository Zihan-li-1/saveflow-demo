// Real SDK + native HTTP fault injection; deliberately NOT a model/MCP E2E result.
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import nextEnv from '@next/env';
import { createTrueforgeClient } from '../server/trueforge-client.mjs';
import { createTrueforgeSkillAdapter } from '../server/trueforge-skill-adapter.mjs';
nextEnv.loadEnvConfig(process.cwd(), true);
let stalled = 0, cancelRequests = 0;
const proxy = http.createServer(async (req, res) => {
  if (req.url.endsWith('/turns') && req.method === 'POST') { stalled++; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': deliberately stalled SSE\n\n'); return; }
  if (req.url.endsWith('/cancel')) cancelRequests++;
  let body = ''; for await (const chunk of req) body += chunk;
  try {
    const response = await fetch(new URL(req.url, process.env.TRUEFORGE_BASE_URL), { method: req.method,
      headers: { 'Content-Type': 'application/json', ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}) }, ...(body ? { body } : {}) });
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text());
  } catch { res.writeHead(502).end('{}'); }
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
try {
  const env = { ...process.env, TRUEFORGE_BASE_URL: `http://127.0.0.1:${proxy.address().port}`, SAVEFLOW_TRUEFORGE_READ_ENABLED: 'true' };
  const adapter = createTrueforgeSkillAdapter({ env, clientFactory: tool => createTrueforgeClient({ env, tool }) });
  const start = Date.now(); const reply = await adapter.handle({ message: '查看娱乐虚拟卡', consent: true, history: [] }, { scope: 'native-http-timeout-fault' });
  const report = { realSdkAndHttp: true, modelOrMcpEndToEnd: false, fault: 'stalled SSE before tool execution', elapsedMs: Date.now() - start, stalled, cancelRequests, code: reply.code, httpStatus: reply.httpStatus };
  assert.equal(reply.httpStatus, 504); assert.equal(reply.code, 'TRUEFORGE_TIMEOUT'); assert.ok(report.elapsedMs < 30000); assert.equal(stalled, 1); assert.equal(cancelRequests, 1);
  await mkdir('.next', { recursive: true }); await writeFile('.next/trueforge-multi-timeout.json', JSON.stringify(report, null, 2)); console.log(report);
} finally { proxy.closeAllConnections(); proxy.close(); }

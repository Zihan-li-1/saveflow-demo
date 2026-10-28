import { handlePurchaseRequest } from '../server/purchase-api.mjs';
// Serve the existing static export and original API handlers in one container.
import http from 'node:http';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { handleAgent } from '../server/qwen.mjs';
import { handleBanking } from '../server/banking.mjs';
import { handleBankingAgent, bankingAuthConfigStatus } from '../server/banking-agent.mjs';
import { handleExecuteTrial } from '../server/transfer-execute-bridge.mjs';

const root = resolve('out');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const visits = [];
const server = http.createServer(async (req, res) => {
  const pathname = req.url?.split('?')[0];
  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ok: true, service: 'saveflow', gitSha: process.env.SAVEFLOW_GIT_SHA || 'unknown', gitDirty: process.env.SAVEFLOW_GIT_DIRTY || 'unknown' })); return; }
  if (pathname === '/version') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ service: 'saveflow', gitSha: process.env.SAVEFLOW_GIT_SHA || 'unknown', gitDirty: process.env.SAVEFLOW_GIT_DIRTY || 'unknown', nodeEnv: process.env.NODE_ENV || 'unknown' })); return; }
  const banking = pathname === '/api/banking' || (pathname === '/api/saveflow' && req.method === 'POST');
  const agent = pathname === '/api/banking-agent';
  const executeTrial = pathname === '/api/execute-trial';
  const purchase = pathname === '/api/purchase';
  try {
    if (banking || agent || executeTrial || purchase || pathname === '/api/agent') {
      const now = Date.now();
      while (visits.length && visits[0] < now - 60000) visits.shift();
      if (!banking && !executeTrial && !purchase && visits.length >= 10) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'RATE_LIMIT', message: '每分钟最多10次请求，请稍后再试。' })); return; }
      if (!banking && !executeTrial && !purchase) visits.push(now);
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: new Headers(Object.entries(req.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(', ') : value]])), signal: controller.signal,
        ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Readable.toWeb(req), duplex: 'half' }) });
      const response = await (purchase ? handlePurchaseRequest(request) : banking ? handleBanking(request) : agent ? handleBankingAgent(request) : executeTrial ? handleExecuteTrial(request) : handleAgent(request));
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return;
    }
    if (pathname?.startsWith('/api/')) { res.writeHead(404).end(); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    let decoded;
    try { decoded = decodeURIComponent(pathname || '/'); } catch { res.writeHead(400).end(); return; }
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').includes('..')) { res.writeHead(400).end(); return; }
    const file = resolve(root, `.${decoded.endsWith('/') ? `${decoded}index.html` : decoded}`);
    if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    let body, status = 200;
    try { body = await readFile(file); }
    catch { status = 404; body = await readFile(resolve(root, '404.html')).catch(() => Buffer.from('Not found')); }
    res.writeHead(status, { 'Content-Type': status === 404 ? types['.html'] : types[extname(file)] || 'application/octet-stream', 'Cache-Control': pathname?.startsWith('/_next/static/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"code":"INTERNAL_ERROR","message":"Service unavailable"}'); }
});
console.info(JSON.stringify({ event: 'banking_auth_config', ...bankingAuthConfigStatus() }));
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('SaveFlow container HTTP ready'));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.close(() => process.exit(0)); setTimeout(() => server.closeAllConnections(), 5000).unref(); });

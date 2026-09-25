import http from 'node:http';
import { Readable } from 'node:stream';
import next from 'next';
import { handleAgent } from '../server/qwen.mjs';
import { handleBanking } from '../server/banking.mjs';
import { handleBankingAgent } from '../server/banking-agent.mjs';

const port = Number(process.env.PORT || 3000);
const app = next({ dev: true, hostname: '127.0.0.1', port });
await app.prepare(); // Next loads .env.local into server environment.
const nextHandler = app.getRequestHandler();
const visits = [];
const server = http.createServer(async (req, res) => {
  const path = req.url?.split('?')[0];
  const banking = path === '/api/banking' || (path === '/api/saveflow' && req.method === 'POST');
  const bankingAgent = path === '/api/banking-agent';
  if (path !== '/api/agent' && !banking && !bankingAgent) return nextHandler(req, res);
  const now = Date.now();
  while (visits.length && visits[0] < now - 60000) visits.shift();
  if (!banking && visits.length >= 10) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'RATE_LIMIT', message: '每分钟最多10次请求，请稍后再试。' })); return; }
  if (!banking) visits.push(now);
  try {
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: new Headers(Object.entries(req.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(', ') : value]])), signal: controller.signal, ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Readable.toWeb(req), duplex: 'half' }) });
    const response = await (banking ? handleBanking(request) : bankingAgent ? handleBankingAgent(request) : handleAgent(request));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch { res.writeHead(500); res.end('Agent service unavailable'); }
});
server.listen(port, '127.0.0.1', () => console.log(`SaveFlow + Qwen: http://127.0.0.1:${port} (provider calls require server credentials)`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); app.close().finally(() => process.exit(0)); });

// Isolated browser-test host. Understanding below is an offline fixture, not a
// production phrase parser or evidence of real-model semantics. No .env is loaded.
import http from 'node:http';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { handleBankingAgent } from '../../server/banking-agent.mjs';
import { handleBanking } from '../../server/banking.mjs';
import { createBankingCore } from '../../src/banking-core/core.mjs';
import { buildParsedIntent } from '../../src/agent/clarification/merge-intent.mjs';
import { continuationModel } from './continuation-model.mjs';

const env = { SAVEFLOW_ACCESS_CODE: 'conversation-ui-access-1234', CONTINUATION_TOKEN_SECRET: 'conversation-ui-token-secret-1234' };
let clock = Date.now();
const core = createBankingCore({ now: () => clock });
const counts = { prepare: 0, decide: 0, execute: 0, sync: 0, model: 0 };
const wrapped = { ...core, prepare: async request => { counts.prepare++; return core.prepare(request); } };
let sequence = 0;
const requests = [];
const parseIntent = async (message, options) => {
  counts.model++;
  if (message.includes('账单')) return buildParsedIntent('bill.summary', { month: '2026-08' });
  if (message.includes('查看') && message.includes('卡')) return buildParsedIntent('card.get', { card_ref: message.includes('娱乐') ? '娱乐虚拟卡' : '我的卡' });
  if (options.context?.action === 'transfer.create' && message === '给张三转600元') return buildParsedIntent('transfer.create', {
    ...options.context.slots, amount: { amount_minor: 60000, currency: 'CNY' },
  });
  if (options.context) return continuationModel(message, options);
  return buildParsedIntent('transfer.create', { payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' },
    ...(message.includes('活期') ? { source_account_ref: '活期账户' } : {}) });
};
const root = path.resolve('out');
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/test-state') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ counts, transactions: core.repository.getTransactions().length, requests })); return;
  }
  if (pathname === '/test-control' && req.method === 'POST') {
    const buffers = []; for await (const chunk of req) buffers.push(chunk);
    const body = JSON.parse(Buffer.concat(buffers).toString());
    if (body.command === 'advance') clock += body.ms;
    res.end('{}'); return;
  }
  if (pathname === '/api/banking-agent' || pathname === '/api/banking') {
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: Readable.toWeb(req), duplex: 'half' });
    request.headers.set('x-forwarded-for', `conversation-ui-${++sequence}`);
    const body = await request.clone().json();
    if (pathname === '/api/banking-agent') {
      if (body.taskMode === 'sync') counts.sync++;
      requests.push({ taskMode: body.taskMode ?? 'auto', hasSession: typeof body.conversationToken === 'string',
        hasContinuation: typeof body.continuationToken === 'string', hasTaskId: typeof body.taskId === 'string' });
    }
    if (body.action === 'action.decide') counts.decide++;
    if (body.action === 'action.execute') counts.execute++;
    const response = pathname === '/api/banking-agent'
      ? await handleBankingAgent(request, { env, core: wrapped, now: () => clock, parseIntent }) : await handleBanking(request, { env, core });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return;
  }
  const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!target.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
  try {
    const content = await readFile(target);
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' })[path.extname(target)] ?? 'application/octet-stream');
    res.end(content);
  } catch { res.writeHead(404); res.end(); }
});
server.listen(0, '127.0.0.1', () => process.send?.({ port: server.address().port }));
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });

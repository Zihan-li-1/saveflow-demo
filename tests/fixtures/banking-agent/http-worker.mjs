// Test-only HTTP host. No real provider requests or production credentials.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { buildParsedIntent } from '../../../src/agent/clarification/merge-intent.mjs';
import { bankingCore } from '../../../src/banking-core/core.mjs';
import { handleBankingAgent } from '../../../server/banking-agent.mjs';
import netlifyHandler from '../../../netlify/functions/banking-agent.mjs';

process.env.SAVEFLOW_ACCESS_CODE = 'integration-access-code-1234';
process.env.CONTINUATION_TOKEN_SECRET = 'integration-continuation-secret-1234';
process.env.DASHSCOPE_API_KEY = 'test-only-provider-secret';
globalThis.fetch = async (_url, options) => {
  const message = JSON.parse(options.body).messages.at(-1).content;
  const intent = message.includes('账单') ? buildParsedIntent('bill.summary', {}) : buildParsedIntent('transfer.create', {
    payee_ref: message.includes('王先生') ? '王先生' : '张三',
    amount: { amount_minor: 50000, currency: 'CNY' },
    ...(message.includes('活期') ? { source_account_ref: '活期账户' } : {}),
  });
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(intent) } }] });
};
const server = http.createServer(async (req, res) => {
  if (req.url === '/test-state') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ balance: bankingCore.repository.getAccount('ACC-CHECKING').balanceFen, transactions: bankingCore.repository.getTransactions().length }));
    return;
  }
  if (req.url !== '/api/banking-agent') {
    if (process.argv.includes('--ui')) {
      const root = path.resolve('out');
      const file = path.resolve(root, '.' + (req.url === '/' ? '/index.html' : new URL(req.url, 'http://localhost').pathname));
      if (file.startsWith(root + path.sep)) {
        try {
          const content = await readFile(file);
          res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
          res.end(content); return;
        } catch { /* fall through to 404 */ }
      }
    }
    res.writeHead(404); res.end(); return;
  }
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method, headers: req.headers,
    ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Readable.toWeb(req), duplex: 'half' }),
  });
  const response = await (process.argv.includes('--netlify') ? netlifyHandler(request) : handleBankingAgent(request));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
});
server.listen(0, '127.0.0.1', () => {
  const address = { port: server.address().port, pid: process.pid };
  if (process.send) process.send(address);
  else console.log(JSON.stringify(address));
});

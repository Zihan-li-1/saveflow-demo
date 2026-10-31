// Local QA only. Real model inference; optional fault truncates an actual reply.
import http from 'node:http';
import { Readable } from 'node:stream';
import next from 'next';
import { handleBankingAgent } from '../../server/banking-agent.mjs';
import { createBankingCore } from '../../src/banking-core/core.mjs';
import { requestSavingsAdvice } from '../../server/savings-advisor.mjs';
import { createSavingsAdviceRuntimeClient } from '../../server/trueforge-savings-runtime.mjs';

const port = Number(process.env.SAVINGS_QA_PORT || 3113);
const app = next({ dev: true, hostname: '127.0.0.1', port });
await app.prepare();
const nextHandler = app.getRequestHandler();
const env = { ...process.env, DASHSCOPE_API_KEY: '', SAVEFLOW_AGENT_DIAGNOSTICS: 'true' };
const core = createBankingCore();
let truncateNext = false, serial = 0;
const state = { adviceCalls: 0, financialWrites: 0, diagnostics: [] };
const forbidden = async () => { state.financialWrites++; throw new Error('QA forbids financial writes'); };
const safeCore = { ...core, prepare: forbidden, decide: forbidden, execute: forbidden };
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/test-state') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(state)); return; }
  if (pathname === '/test-truncate-next' && req.method === 'POST') { truncateNext = true; res.end('{}'); return; }
  if (pathname !== '/api/banking-agent') return nextHandler(req, res);
  const request = new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers, body: Readable.toWeb(req), duplex: 'half' });
  request.headers.set('x-forwarded-for', `savings-live-qa-${++serial}`);
  const response = await handleBankingAgent(request, { env, core: safeCore,
    diagnosticSink: line => { const entry = JSON.parse(line); if (entry.event === 'savings_advice_review') state.diagnostics.push(entry); },
    savingsAdvisor: async (facts, options) => {
      const truncate = truncateNext; truncateNext = false;
      const live = createSavingsAdviceRuntimeClient({ env });
      const client = { createSession: signal => live.createSession(signal), cancel: id => live.cancel(id),
        async runTurn(...args) { state.adviceCalls++; const raw = await live.runTurn(...args); return truncate ? raw.slice(0, -1) : raw; } };
      return requestSavingsAdvice(facts, { ...options, client });
    },
  });
  res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
});
server.listen(port, '127.0.0.1', () => process.send?.({ port }));
process.once('SIGTERM', () => { server.closeAllConnections(); server.close(); app.close().finally(() => process.exit(0)); });

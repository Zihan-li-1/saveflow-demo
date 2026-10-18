// Local transport adapter: opaque MCP credentials stay off the model context.
// No business calculations, Core implementation, or additional financial tools.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { canonical } from '../../src/banking-core/errors.mjs';

const tools = new Set(['bill_summary', 'card_get', 'subscription_list', 'product_list', 'transfer_preview', 'card_budget_preview', 'card_freeze_preview', 'card_unfreeze_preview']);
const failure = code => { const r = { ok: false, kind: 'business_error', error: { code, message: 'MCP 续接请求无效或暂时不可用。' } }; return { isError: true, structuredContent: r, content: [{ type: 'text', text: JSON.stringify(r) }] }; };

export function createTokenBridge({ upstream, now = Date.now, ttlMs = 300000, capacity = 1000 }) {
  const tokens = new Map();
  function clean() { for (const [k, v] of tokens) if (v.expiresAt <= now()) tokens.delete(k); }
  function replaceCredential(result, name) {
    const r = result.structuredContent;
    if (!r?.continuationToken) return result;
    const recoverable = name === 'transfer_preview' && r.kind === 'core_error' && r.action === 'transfer.create' && r.error?.code === 'INSUFFICIENT_BALANCE' &&
      r.recovery?.action === 'transfer.create' && r.recovery.status === 'needs_clarification' && r.recovery.slot === 'source_account_ref';
    if ((!['needs_clarification', 'awaiting_confirmation'].includes(r.kind) && !recoverable) || typeof r.continuationToken !== 'string') return failure('BRIDGE_FORMAT_ERROR');
    clean(); if (tokens.size >= capacity) return failure('BRIDGE_CAPACITY');
    const token = `tfg1_${randomBytes(16).toString('hex')}`;
    tokens.set(token, { name, original: r.continuationToken, expiresAt: now() + ttlMs });
    const data = { ...r, continuationToken: token };
    return { ...result, structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
  }
  return {
    async call(name, args = {}) {
      if (!tools.has(name)) return failure('TOOL_NOT_ALLOWED');
      clean(); let state;
      if (args.continuationToken !== undefined) {
        state = tokens.get(args.continuationToken);
        if (!state || state.name !== name) return failure('CONTINUATION_INVALID');
        const fingerprint = canonical(args);
        if (state.fingerprint && state.fingerprint !== fingerprint) return failure('CONTINUATION_CONSUMED');
        state.fingerprint = fingerprint;
        state.promise ??= upstream.callTool({ name, arguments: { ...args, continuationToken: state.original } })
          .then(r => replaceCredential(r, name)).catch(() => failure('BRIDGE_UPSTREAM_FAILED'));
        return await state.promise;
      }
      try { return replaceCredential(await upstream.callTool({ name, arguments: args }), name); }
      catch { return failure('BRIDGE_UPSTREAM_FAILED'); }
    },
  };
}

export async function startTokenBridge({ upstreamUrl = process.env.SAVEFLOW_BRIDGE_UPSTREAM_URL ?? 'http://127.0.0.1:3333/mcp', port = 3334, host = process.env.SAVEFLOW_BRIDGE_HOST ?? '127.0.0.1' } = {}) {
  const upstream = new Client({ name: 'saveflow-local-token-bridge', version: '1.0.0' });
  await upstream.connect(new StreamableHTTPClientTransport(new URL(upstreamUrl)));
  const list = await upstream.listTools();
  const allowed = list.tools.filter(t => tools.has(t.name));
  const bridge = createTokenBridge({ upstream });
  const http = createServer(async (request, response) => {
    if (request.url !== '/mcp') { response.writeHead(404).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    const server = new Server({ name: 'saveflow-token-bridge', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allowed }));
    server.setRequestHandler(CallToolRequestSchema, async req => bridge.call(req.params.name, req.params.arguments));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.once('close', () => { void server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(request, response); }
    catch { if (!response.headersSent) response.writeHead(502).end(); else response.end(); }
  });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, host, resolve); });
  http.once('close', () => { void upstream.close(); });
  return http;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const http = await startTokenBridge();
  console.log('Local MCP credential bridge: http://127.0.0.1:3334/mcp');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { http.close(); http.closeAllConnections(); });
}

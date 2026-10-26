// Explicit UI-test host: memory database and deterministic understanding stub.
// Never imported or deployed by production handlers.
import http from 'node:http';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { handlePurchaseRequest } from '../../server/purchase-api.mjs';
import { createPurchaseSkill } from '../../src/skills/scenario/purchase-skill.mjs';
import { createCommerceClient } from '../../src/skills/commerce/commerce-client.mjs';
import { createCommerceMockServer } from '../../server/commerce/mock-service.mjs';
import { createPurchaseTestStore } from './purchase-memory-store.mjs';

const token = 'ui-isolated-commerce-token', now = () => Date.parse('2026-10-26T00:00:00Z');
const commerceServer = createCommerceMockServer({ token, now });
await new Promise(resolve => commerceServer.listen(0, '127.0.0.1', resolve));
const store = createPurchaseTestStore();
const skill = createPurchaseSkill({ store, now, schedulerEnabled: true,
  commerce: createCommerceClient({ baseUrl: `http://127.0.0.1:${commerceServer.address().port}`, token }) });
const env = { SAVEFLOW_ACCESS_CODE: 'purchase-ui-test-access', CONTINUATION_TOKEN_SECRET: 'purchase-ui-test-secret-longer-than-32-characters' };
const root = resolve('out'), types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const server = http.createServer(async (req, res) => {
  try {
    if (req.url?.split('?')[0] === '/api/purchase') {
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: new Headers(req.headers),
        body: Readable.toWeb(req), duplex: 'half' });
      const response = await handlePurchaseRequest(request, { env, now, getSkill: async () => skill,
        parseIntent: async (_message, options) => ({ schemaVersion: '1.0.0', action: 'scenario.plan_purchase',
          slots: { ...options.context?.slots, selection_mode: 'guided', preferences: { flower_colors: ['pink'], flower_materials: ['rose'], cake_flavors: ['fruit'], cake_servings: 6, ingredient_exclusions: ['nuts'] } }, missingSlots: [], status: 'ready_for_resolution' }) });
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return;
    }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file = resolve(root, '.' + pathname);
    if (!file.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
    if (pathname.endsWith('/')) file = resolve(file, 'index.html');
    const bytes = await readFile(file); res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }); res.end(bytes);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(4411, '127.0.0.1', () => console.info('UI test fixture http://127.0.0.1:4411/shopping/ — memory DB, model stub, real local Commerce HTTP'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); commerceServer.close(); process.exit(0); });

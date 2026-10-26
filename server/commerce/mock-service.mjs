import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { giftCatalog } from './gift-catalog.mjs';
import { purchasePreferencesSchema } from '../../src/skills/scenario/purchase-contract.mjs';
import { matchesGiftPreferences } from '../../src/skills/commerce/gift-filters.mjs';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ref = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const searchSchema = z.strictObject({ category: z.enum(['flowers', 'cake']), preferences: purchasePreferencesSchema,
  region: ref, budget_minor: z.number().int().min(1).max(1e9), cursor: ref.optional() });
const quoteSchema = z.strictObject({ product_ref: ref, sku_ref: ref, quantity: z.number().int().min(1).max(10), address_ref: ref, region: ref,
  delivery_window: z.strictObject({ starts_at: z.iso.datetime({ offset: true }), ends_at: z.iso.datetime({ offset: true }) }) });
const orderSchema = z.strictObject({ quote_ref: ref, idempotency_key: ref });
const lookupSchema = z.strictObject({ idempotency_key: ref });
const fail = code => { throw Object.assign(new Error(code), { code }); };
function parse(schema, input) { const result = schema.safeParse(input); if (!result.success) fail('VALIDATION_ERROR'); return result.data; }
function eligible(p, input) {
  if (p.category !== input.category || !p.regions.includes(input.region) || p.inventory < 1 || p.price_minor + p.delivery_fee_minor + p.packaging_fee_minor > input.budget_minor) return false;
  return matchesGiftPreferences(p, input.preferences);
}

/** Isolated Mock provider; this is deliberately NOT a real commerce adapter.
 * Fault injection is constructor-only and never exposed through HTTP.
 */
export function createCommerceMockServer({ now = Date.now, token, faults = {}, stateFile } = {}) {
  if (typeof token !== 'string' || token.length < 16) throw new Error('Mock service token must contain at least 16 characters');
  const file = stateFile ? resolve(stateFile) : undefined;
  const saved = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  if (saved && (saved.version !== 1 || !['catalog', 'quotes', 'orders', 'cursors'].every(key => Array.isArray(saved[key])))) throw new Error('Invalid Mock provider state; do not discard existing order records');
  const catalog = saved?.catalog ?? structuredClone(giftCatalog);
  const quotes = new Map(saved?.quotes), orders = new Map(saved?.orders), cursors = new Map(saved?.cursors);
  // ponytail: one provider process per file. Use a database-backed provider for
  // multiple replicas; the application workflow store already uses PostgreSQL.
  const persist = () => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify({ version: 1, catalog, quotes: [...quotes], orders: [...orders], cursors: [...cursors] }), { mode: 0o600 });
    renameSync(file + '.tmp', file);
  };
  const stamp = () => ({ as_of: new Date(now()).toISOString(), context_snapshot_id: 'commerce_mock_v1',
    evidence: [{ source: 'commerce_mock', synthetic_demo_only: true }], execution_environment: 'mock', synthetic_demo_only: true });
  const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
  const server = createServer(async (req, res) => {
    try {
      // Public synthetic product details contain no address or order information.
      if (req.method === 'GET' && req.url?.startsWith('/products/')) {
        const product = catalog.find(p => p.canonical_url === req.url);
        if (!product) return send(res, 404, { code: 'PRODUCT_NOT_FOUND' });
        return send(res, 200, { title: '模拟商品，仅供演示，无法真实购买', product, ...stamp() });
      }
      const expected = Buffer.from(`Bearer ${token}`), actual = Buffer.from(req.headers.authorization ?? '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return send(res, 401, { code: 'UNAUTHORIZED' });
      if (req.method !== 'POST') return send(res, 405, { code: 'METHOD_NOT_ALLOWED' });
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 16384) return send(res, 413, { code: 'REQUEST_TOO_LARGE' }); chunks.push(chunk); }
      let input; try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { fail('VALIDATION_ERROR'); }
      if (req.url === '/search') {
        const data = parse(searchSchema, input);
        const query = JSON.stringify({ ...data, cursor: undefined });
        let offset = 0;
        if (data.cursor) { const page = cursors.get(data.cursor); if (!page || page.query !== query || page.expires <= now()) fail('INVALID_CURSOR'); offset = page.offset; }
        const matches = catalog.filter(p => eligible(p, data));
        let next_cursor = null;
        if (matches.length > offset + 3) { next_cursor = randomUUID(); cursors.set(next_cursor, { query, offset: offset + 3, expires: now() + 300000 }); }
        persist();
        return send(res, 200, { candidates: matches.slice(offset, offset + 3), next_cursor, ...stamp() });
      }
      if (req.url === '/quote') {
        const data = parse(quoteSchema, input), product = catalog.find(p => p.product_ref === data.product_ref && p.sku_ref === data.sku_ref);
        if (!product || product.inventory < data.quantity) fail('PRODUCT_UNAVAILABLE');
        if (!product.regions.includes(data.region)) fail('DELIVERY_UNAVAILABLE');
        if (Date.parse(data.delivery_window.starts_at) <= now() || Date.parse(data.delivery_window.ends_at) <= Date.parse(data.delivery_window.starts_at)) fail('DELIVERY_UNAVAILABLE');
        const q = { ...data, quote_ref: randomUUID(), merchant_ref: product.merchant_ref, merchant_name: product.merchant_name, items_amount_minor: product.price_minor * data.quantity,
          delivery_fee_minor: product.delivery_fee_minor, packaging_fee_minor: product.packaging_fee_minor,
          total: { amount_minor: product.price_minor * data.quantity + product.delivery_fee_minor + product.packaging_fee_minor, currency: 'CNY' },
          expires_at: new Date(now() + 300000).toISOString(), payment_mode: 'mock_no_payment', cancellation_terms: '模拟订单，未付款可取消；不代表真实商户条款', ...stamp() };
        quotes.set(q.quote_ref, q); persist(); return send(res, 200, q);
      }
      if (req.url === '/orders/status') {
        const data = parse(lookupSchema, input), entry = orders.get(data.idempotency_key);
        if (!entry) return send(res, 404, { code: 'ORDER_NOT_FOUND' });
        return send(res, 200, entry.receipt);
      }
      if (req.url === '/orders') {
        const data = parse(orderSchema, input), old = orders.get(data.idempotency_key);
        if (old) { if (old.quote_ref !== data.quote_ref) fail('IDEMPOTENCY_CONFLICT'); return send(res, 200, old.receipt); }
        const q = quotes.get(data.quote_ref); if (!q) fail('QUOTE_NOT_FOUND');
        if (Date.parse(q.expires_at) <= now()) fail('QUOTE_EXPIRED');
        const product = catalog.find(p => p.product_ref === q.product_ref);
        if (faults.priceChanged || product.price_minor * q.quantity !== q.items_amount_minor) fail('PREVIEW_STALE');
        if (faults.outOfStock || product.inventory < q.quantity) fail('PRODUCT_UNAVAILABLE');
        product.inventory -= q.quantity;
        const receipt = { provider_order_ref: randomUUID(), idempotency_key: data.idempotency_key, quote_ref: q.quote_ref,
          status: 'created_pending_payment', total: q.total, merchant_ref: q.merchant_ref, ...stamp() };
        orders.set(data.idempotency_key, { quote_ref: q.quote_ref, receipt });
        persist();
        if (faults.dropNextOrderResponse) { faults.dropNextOrderResponse = false; res.destroy(); return; }
        return send(res, 200, receipt);
      }
      send(res, 404, { code: 'CAPABILITY_UNAVAILABLE' });
    } catch (error) { send(res, 400, { code: error.code ?? 'INTERNAL_ERROR' }); }
  });
  server.requestTimeout = 10000;
  return server;
}

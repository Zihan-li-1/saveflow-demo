import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommerceMockServer } from '../server/commerce/mock-service.mjs';
import { createCommerceClient } from '../src/skills/commerce/commerce-client.mjs';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function setup(t, faults = {}) {
  let clock = Date.parse('2026-10-24T00:00:00Z');
  const token = 'isolated-test-service-token';
  const server = createCommerceMockServer({ now: () => clock, token, faults });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { client: createCommerceClient({ baseUrl, token }), baseUrl, advance: ms => { clock += ms; } };
}
const search = { category: 'flowers', preferences: {}, region: 'demo-shanghai', budget_minor: 100000 };
async function quote(client) {
  const found = await client.search(search);
  return client.quote({ product_ref: found.candidates[0].product_ref, sku_ref: found.candidates[0].sku_ref, quantity: 1,
    address_ref: 'demo_address', region: 'demo-shanghai', delivery_window: { starts_at: '2026-11-01T09:00:00+08:00', ends_at: '2026-11-01T12:00:00+08:00' } });
}
test('HTTP catalog paginates real Mock detail links and enforces hard filters', async t => {
  const { client, baseUrl } = await setup(t);
  const first = await client.search(search);
  const second = await client.search({ ...search, cursor: first.next_cursor });
  assert.ok(first.candidates.length > 0 && second.candidates.length > 0);
  assert.equal(new Set([...first.candidates, ...second.candidates].map(p => p.product_ref)).size, first.candidates.length + second.candidates.length);
  const detail = await fetch(baseUrl + first.candidates[0].canonical_url);
  assert.equal(detail.status, 200); assert.match(await detail.text(), /模拟商品/);
  const cakes = await client.search({ ...search, category: 'cake', preferences: { ingredient_exclusions: ['nuts'] } });
  assert.ok(cakes.candidates.length > 0);
  assert.ok(cakes.candidates.every(p => p.allergens_known && !p.ingredients.includes('nuts')));
  assert.equal((await client.search({ ...search, region: 'unsupported' })).candidates.length, 0);
  assert.equal((await client.search({ ...search, budget_minor: 1 })).candidates.length, 0);
  await assert.rejects(client.search({ ...search, cursor: 'invented' }), { code: 'INVALID_CURSOR' });
});
test('quotes include fees and expired/changed quotes cannot create orders', async t => {
  const faults = {};
  const { client, advance } = await setup(t, faults);
  const q = await quote(client);
  assert.equal(q.total.amount_minor, q.items_amount_minor + q.delivery_fee_minor + q.packaging_fee_minor);
  faults.priceChanged = true;
  await assert.rejects(client.execute({ quote_ref: q.quote_ref, idempotency_key: 'order_a' }), { code: 'PREVIEW_STALE' });
  faults.priceChanged = false; advance(300001);
  await assert.rejects(client.execute({ quote_ref: q.quote_ref, idempotency_key: 'order_a' }), { code: 'QUOTE_EXPIRED' });
});
test('HTTP order replay is idempotent and conflicting requests cannot overwrite it', async t => {
  const { client } = await setup(t);
  const q = await quote(client);
  const request = { quote_ref: q.quote_ref, idempotency_key: 'order_a' };
  const [a, b] = await Promise.all([client.execute(request), client.execute(request)]);
  assert.deepEqual(a, b); assert.equal(a.status, 'created_pending_payment');
  assert.equal(a.synthetic_demo_only, true);
  assert.deepEqual(await client.status({ idempotency_key: 'order_a' }), a);
  const another = await quote(client);
  await assert.rejects(client.execute({ ...request, quote_ref: another.quote_ref }), { code: 'IDEMPOTENCY_CONFLICT' });
});
test('response loss recovers the same accepted order by lookup', async t => {
  const faults = { dropNextOrderResponse: true };
  const { client } = await setup(t, faults);
  const q = await quote(client);
  await assert.rejects(client.execute({ quote_ref: q.quote_ref, idempotency_key: 'lost_order' }), { code: 'ORDER_STATUS_UNKNOWN' });
  const receipt = await client.status({ idempotency_key: 'lost_order' });
  assert.equal(receipt.status, 'created_pending_payment');
  assert.equal((await client.execute({ quote_ref: q.quote_ref, idempotency_key: 'lost_order' })).provider_order_ref, receipt.provider_order_ref);
});
test('HTTP service rejects missing credentials and unregistered payload fields', async t => {
  const { client, baseUrl } = await setup(t);
  assert.equal((await fetch(baseUrl + '/search', { method: 'POST', body: '{}' })).status, 401);
  await assert.rejects(client.search({ ...search, confirmed: true }), { code: 'VALIDATION_ERROR' });
});
test('Chinese allergen aliases and unknown hard restrictions fail closed', async t => {
  const { client } = await setup(t);
  const result = await client.search({ ...search, category: 'cake', preferences: { ingredient_exclusions: ['坚果'] } });
  assert.ok(result.candidates.every(p => !p.ingredients.includes('nuts') && p.allergens_known));
  const unknown = await client.search({ ...search, category: 'cake', preferences: { ingredient_exclusions: ['unknown_allergen'] } });
  assert.equal(unknown.candidates.length, 0);
});
test('configured Mock provider storage preserves order lookup and replay after restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'saveflow-commerce-')), stateFile = join(dir, 'state.json'), token = 'persistent-mock-test-token';
  let server;
  const start = async () => {
    server = createCommerceMockServer({ token, stateFile });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return createCommerceClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token });
  };
  const close = () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  t.after(async () => { await close(); await unlink(stateFile).catch(() => {}); await unlink(stateFile + '.tmp').catch(() => {}); await rmdir(dir); });
  let client = await start();
  const found = await client.search(search), product = found.candidates[0];
  const q = await client.quote({ product_ref: product.product_ref, sku_ref: product.sku_ref, quantity: 1, address_ref: 'demo_address', region: 'demo-shanghai',
    delivery_window: { starts_at: '2027-11-01T09:00:00+08:00', ends_at: '2027-11-01T12:00:00+08:00' } });
  const request = { quote_ref: q.quote_ref, idempotency_key: 'persistent_order' }, receipt = await client.execute(request);
  await close(); client = await start();
  assert.deepEqual(await client.status({ idempotency_key: request.idempotency_key }), receipt);
  assert.deepEqual(await client.execute(request), receipt);
});

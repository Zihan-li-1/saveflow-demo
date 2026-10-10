import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  handleRefundInvestment,
  handleRoundUpInvestment,
  planCheckoutLiquidity,
  planLargePurchase,
} from '../src/skills/wealth/wealth-skill.mjs';
import { createTestWealthActionPort } from './fixtures/wealth-test-port.mjs';

const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const catalog = json('./fixtures/commerce/catalog.json');
const events = json('./fixtures/commerce/events.json');
const capabilities = json('./fixtures/commerce/capabilities.json');

test('large purchase becomes a short-term recommendation goal without subscribing', () => {
  const result = planLargePurchase({ item: catalog[0], purchase_date: '2026-09-20', cashflow: { investable_amount_minor: 200000 } });
  assert.equal(result.action, 'wealth.recommend');
  assert.equal(result.suggested_slots.goal.kind, 'short_term_purchase');
  assert.equal(result.execution_allowed, false);
});

test('checkout liquidity separates redemption and order confirmations and refreshes quote', () => {
  const result = planCheckoutLiquidity({
    quote: catalog[0],
    upcoming_obligations_minor: 100000,
    available_cash_minor: 250000,
    card_available_minor: 100000,
    redeemable_holding: { holding_id: 'holding_001', amount_minor: 400000, settlement: 'T+1' },
  });
  assert.equal(result.steps[0].action, 'wealth.redeem');
  assert.equal(result.steps[0].confirmation_scope, 'redemption_only');
  assert.equal(result.steps[1].action, 'wealth.redemption.settlement.wait');
  assert.equal(result.steps[2].action, 'commerce.quote.refresh');
  assert.equal(result.steps[3].confirmation_scope, 'order_only');
  assert.equal(result.atomic, false);
});

test('refund investment waits for settled event and deduplicates event IDs', () => {
  const state = { processed_event_ids: new Set() };
  const isTrustedEvent = event => events.includes(event);
  assert.equal(handleRefundInvestment({ event: events[0], state, isTrustedEvent }).subscription_candidate, null);
  const first = handleRefundInvestment({ event: events[1], state, isTrustedEvent });
  assert.equal(first.subscription_candidate.amount.amount_minor, 59900);
  assert.equal(first.subscription_candidate.requires_user_review, true);
  assert.equal(handleRefundInvestment({ event: events[1], state, isTrustedEvent }).duplicate, true);
  assert.equal(handleRefundInvestment({ event: { ...events[1], event_id: 'untrusted_refund' }, state, isTrustedEvent }).subscription_candidate, null);
  assert.equal(handleRefundInvestment({ event: { ...events[1], event_id: 'no_verifier' }, state }).subscription_candidate, null);
});

test('round-up only consumes posted transactions and never silently invests', () => {
  const state = { accumulated_minor: 0, processed_event_ids: new Set() };
  const isTrustedEvent = event => events.includes(event);
  const ignored = handleRoundUpInvestment({ event: { ...events[2], status: 'pending' }, state, threshold_minor: 100, isTrustedEvent });
  assert.equal(ignored.subscription_candidate, null);
  const preview = handleRoundUpInvestment({ event: events[2], state, threshold_minor: 60, isTrustedEvent });
  assert.equal(preview.subscription_candidate.amount.amount_minor, 66);
  assert.equal(preview.subscription_candidate.requires_user_review, true);
  assert.equal(preview.executed, false);
  assert.equal(state.accumulated_minor, 66);
  assert.equal(handleRoundUpInvestment({ event: { ...events[2], event_id: 'untrusted_transaction' }, state, threshold_minor: 60, isTrustedEvent }).subscription_candidate, null);
  assert.equal(handleRoundUpInvestment({ event: { ...events[2], event_id: 'no_verifier' }, state, threshold_minor: 60 }).subscription_candidate, null);
});

test('checkout liquidity reports no redemption route when holding is unavailable', () => {
  const result = planCheckoutLiquidity({ quote: catalog[0], upcoming_obligations_minor: 100000, available_cash_minor: 0, card_available_minor: 0 });
  assert.equal(result.can_proceed, false);
  assert.equal(result.steps.some(step => step.action === 'wealth.redeem'), false);
});

test('card spending capacity cannot pay existing bill obligations', () => {
  const result = planCheckoutLiquidity({ quote: { item_id: 'small_item', price_minor: 10000 }, upcoming_obligations_minor: 100000, available_cash_minor: 0, card_available_minor: 100000, redeemable_holding: { holding_id: 'holding_001', amount_minor: 100000, settlement: 'T+1' } });
  assert.equal(result.shortfall_minor, 100000);
  assert.equal(capabilities['commerce.order.execute'], false);
});

test('test action port enforces confirmation, expiry, snapshot and idempotency on cloned state', () => {
  const port = createTestWealthActionPort({
    accounts: [{ id: 'ACC-CHECKING', availableBalanceFen: 500000 }],
    holdings: [{ id: 'holding_001', productId: 'product_002', amountFen: 200000, unitsMilli: 200000 }],
    now: '2026-09-01T00:00:00+08:00',
  });
  const request = { action: 'wealth.subscribe', input: { productId: 'product_002', amountFen: 10000, currency: 'CNY', sourceAccountId: 'ACC-CHECKING' } };
  const prepared = port.prepare(request, { idempotency_key: 'idem-1', context_snapshot_id: 'snap-1' });
  assert.throws(() => port.execute(prepared.operation_id), /confirmation/i);
  assert.throws(() => port.confirm(prepared.operation_id, { preview_hash: prepared.preview.preview_hash, context_snapshot_id: 'snap-changed', decided_at: '2026-09-01T00:01:00+08:00' }), /context/i);
  const replay = port.prepare(request, { idempotency_key: 'idem-1', context_snapshot_id: 'snap-1' });
  assert.equal(replay.operation_id, prepared.operation_id);
  assert.throws(() => port.prepare({ ...request, input: { ...request.input, amountFen: 20000 } }, { idempotency_key: 'idem-1', context_snapshot_id: 'snap-1' }), /conflict/i);
  const expiring = port.prepare(request, { idempotency_key: 'idem-expired', context_snapshot_id: 'snap-1' });
  assert.throws(() => port.confirm(expiring.operation_id, { preview_hash: expiring.preview.preview_hash, context_snapshot_id: 'snap-1', decided_at: '2026-09-01T00:06:00+08:00' }), /expired/i);
  port.confirm(prepared.operation_id, { preview_hash: prepared.preview.preview_hash, context_snapshot_id: 'snap-1', decided_at: '2026-09-01T00:01:00+08:00' });
  const receipt = port.execute(prepared.operation_id);
  assert.equal(receipt.status, 'succeeded');
  assert.equal(port.snapshot().accounts[0].availableBalanceFen, 490000);
});

test('partial failure keeps both redemption and failed order receipts', () => {
  const port = createTestWealthActionPort({ accounts: [], holdings: [{ id: 'holding_001', productId: 'product_002', amountFen: 200000, unitsMilli: 200000 }], now: '2026-09-01T00:00:00+08:00' });
  const prepared = port.prepare({ action: 'wealth.redeem', input: { holdingId: 'holding_001', quantityKind: 'amount', amountFen: 10000, currency: 'CNY' } }, { idempotency_key: 'redeem-before-order', context_snapshot_id: 'snap-1' });
  port.confirm(prepared.operation_id, { preview_hash: prepared.preview.preview_hash, context_snapshot_id: 'snap-1', decided_at: '2026-09-01T00:01:00+08:00' });
  const redemptionReceipt = port.execute(prepared.operation_id);
  const orderReceipt = { receipt_id: 'commerce_receipt_1', status: 'failed', reason: 'inventory_changed' };
  assert.deepEqual([redemptionReceipt.status, orderReceipt.status], ['succeeded', 'failed']);
  assert.equal(port.snapshot().holdings[0].amountFen, 190000);
});

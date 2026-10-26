import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyPurchaseState, reserveBudget, amendBudget, allocateOrder, recordOrderOutcome, cancelBudget, planningAvailable } from '../src/skills/scenario/purchase-budget.mjs';

test('reservation does not mutate bank facts and prevents over-allocation', () => {
  const state = emptyPurchaseState(), bank = { account_ref: 'account_1', available_minor: 100000, obligations_minor: 0 };
  const before = structuredClone(bank);
  reserveBudget(state, { workflow_ref: 'a', amount_minor: 70000, ...bank });
  assert.throws(() => reserveBudget(state, { workflow_ref: 'b', amount_minor: 70000, ...bank }), { code: 'INSUFFICIENT_PLANNING_BALANCE' });
  assert.deepEqual(bank, before); assert.equal(planningAvailable(state, bank), 30000);
});
test('budget amendment preserves existing obligations and checks only additional available funds', () => {
  const state = emptyPurchaseState(), context = { account_ref: 'acc', available_minor: 200000, obligations_minor: 0 };
  reserveBudget(state, { workflow_ref: 'a', amount_minor: 100000, ...context });
  allocateOrder(state, { workflow_ref: 'a', operation_ref: 'o', amount_minor: 70000 });
  assert.throws(() => amendBudget(state, { workflow_ref: 'a', amount_minor: 60000, ...context }), { code: 'BUDGET_BELOW_COMMITTED' });
  assert.throws(() => amendBudget(state, { workflow_ref: 'a', amount_minor: 300000, ...context }), { code: 'INSUFFICIENT_PLANNING_BALANCE' });
  amendBudget(state, { workflow_ref: 'a', amount_minor: 150000, ...context });
  assert.equal(state.reservations.a.unallocated_minor, 80000); assert.equal(state.reservations.a.occupied_minor, 70000);
});
test('unknown order retains budget, repeat receipt is idempotent and cancellation releases only free funds', () => {
  const state = emptyPurchaseState();
  reserveBudget(state, { workflow_ref: 'a', account_ref: 'account_1', amount_minor: 100000, available_minor: 100000, obligations_minor: 0 });
  allocateOrder(state, { workflow_ref: 'a', operation_ref: 'flower', amount_minor: 31500 });
  recordOrderOutcome(state, 'flower', 'unknown');
  allocateOrder(state, { workflow_ref: 'a', operation_ref: 'cake', amount_minor: 41500 });
  recordOrderOutcome(state, 'cake', 'failed');
  const r = state.reservations.a;
  assert.equal(r.unallocated_minor, 68500); assert.equal(r.occupied_minor, 31500);
  cancelBudget(state, 'a'); assert.equal(r.released_minor, 68500); assert.equal(r.occupied_minor, 31500);
  recordOrderOutcome(state, 'flower', 'paid'); recordOrderOutcome(state, 'flower', 'paid');
  assert.equal(r.consumed_minor, 31500); assert.equal(r.occupied_minor, 0);
  recordOrderOutcome(state, 'flower', 'created_pending_payment');
  assert.equal(state.operations.flower.status, 'paid');
  assert.equal(r.total_minor, r.unallocated_minor + r.occupied_minor + r.consumed_minor + r.released_minor);
  assert.throws(() => allocateOrder(state, { workflow_ref: 'a', operation_ref: 'extra', amount_minor: 100 }), { code: 'INVALID_TRANSITION' });
});
test('bank reconciliation prevents counting the same paid order twice', () => {
  const state = emptyPurchaseState(), bank = { account_ref: 'account_1', available_minor: 200000, obligations_minor: 0 };
  reserveBudget(state, { workflow_ref: 'a', amount_minor: 100000, ...bank });
  allocateOrder(state, { workflow_ref: 'a', operation_ref: 'flower', amount_minor: 31500 });
  recordOrderOutcome(state, 'flower', 'paid');
  assert.equal(planningAvailable(state, bank), 100000);
  assert.equal(planningAvailable(state, { ...bank, available_minor: 168500, reconciled_operation_refs: ['flower'] }), 100000);
  assert.equal(planningAvailable(state, { ...bank, available_minor: 168500 }), 68500);
});
test('same operation cannot allocate twice or change amount; invalid amounts fail', () => {
  const state = emptyPurchaseState();
  reserveBudget(state, { workflow_ref: 'a', account_ref: 'acc', amount_minor: 100000, available_minor: 100000, obligations_minor: 0 });
  const input = { workflow_ref: 'a', operation_ref: 'o', amount_minor: 90000 };
  allocateOrder(state, input); allocateOrder(state, input);
  assert.equal(state.reservations.a.occupied_minor, 90000);
  assert.throws(() => allocateOrder(state, { ...input, amount_minor: 80000 }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => allocateOrder(state, { ...input, operation_ref: 'b', amount_minor: 20000 }), { code: 'BUDGET_EXCEEDED' });
  assert.throws(() => allocateOrder(state, { ...input, operation_ref: 'c', amount_minor: -1 }), { code: 'VALIDATION_ERROR' });
});

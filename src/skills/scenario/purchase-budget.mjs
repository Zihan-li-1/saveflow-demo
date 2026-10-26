// Mutate only a transactional working copy. This module never writes bank data.
const fail = code => { throw Object.assign(new Error(code), { code }); };
const amount = (value, zero = false) => { if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > 1e9) fail('VALIDATION_ERROR'); };
const ref = value => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value) || Object.hasOwn(Object.prototype, value)) fail('VALIDATION_ERROR'); };
export function emptyPurchaseState() { return { workflows: {}, reservations: {}, operations: {}, jobs: {}, events: {} }; }

/** reconciled_operation_refs must come from trusted bank/order matching, never a model. */
export function planningAvailable(state, { account_ref, available_minor, obligations_minor = 0, reconciled_operation_refs = [] }) {
  ref(account_ref); amount(available_minor, true); amount(obligations_minor, true);
  const reconciled = new Set(reconciled_operation_refs);
  let reserved = 0;
  for (const r of Object.values(state.reservations)) {
    if (r.account_ref !== account_ref) continue;
    reserved += r.unallocated_minor + r.occupied_minor + r.consumed_minor;
    for (const op of Object.values(state.operations)) {
      if (op.workflow_ref === r.workflow_ref && op.allocation === 'consumed' && reconciled.has(op.operation_ref)) reserved -= op.amount_minor;
    }
  }
  return Math.max(0, available_minor - obligations_minor - reserved);
}

export function reserveBudget(state, input) {
  const { workflow_ref, account_ref, amount_minor } = input;
  ref(workflow_ref); ref(account_ref); amount(amount_minor);
  const existing = state.reservations[workflow_ref];
  if (existing) {
    if (existing.total_minor !== amount_minor || existing.account_ref !== account_ref) fail('IDEMPOTENCY_CONFLICT');
    return existing;
  }
  if (planningAvailable(state, input) < amount_minor) fail('INSUFFICIENT_PLANNING_BALANCE');
  return state.reservations[workflow_ref] = { workflow_ref, account_ref, total_minor: amount_minor,
    unallocated_minor: amount_minor, occupied_minor: 0, consumed_minor: 0, released_minor: 0, cancelled: false };
}

export function allocateOrder(state, { workflow_ref, operation_ref, amount_minor }) {
  ref(workflow_ref); ref(operation_ref); amount(amount_minor);
  const existing = state.operations[operation_ref];
  if (existing) {
    if (existing.workflow_ref !== workflow_ref || existing.amount_minor !== amount_minor) fail('IDEMPOTENCY_CONFLICT');
    return existing;
  }
  const r = state.reservations[workflow_ref];
  if (!r) fail('WORKFLOW_NOT_FOUND');
  if (r.cancelled) fail('INVALID_TRANSITION');
  if (r.unallocated_minor < amount_minor) fail('BUDGET_EXCEEDED');
  r.unallocated_minor -= amount_minor; r.occupied_minor += amount_minor;
  return state.operations[operation_ref] = { operation_ref, workflow_ref, amount_minor, status: 'executing', allocation: 'occupied' };
}

export function amendBudget(state, input) {
  const { workflow_ref, account_ref, amount_minor } = input;
  ref(workflow_ref); amount(amount_minor);
  const r = state.reservations[workflow_ref]; if (!r || r.cancelled) fail('INVALID_TRANSITION');
  if (account_ref !== r.account_ref) fail('FUNDING_ACCOUNT_CHANGE_REQUIRES_NEW_PLAN');
  if (amount_minor < r.occupied_minor + r.consumed_minor + r.released_minor) fail('BUDGET_BELOW_COMMITTED');
  const difference = amount_minor - r.total_minor;
  if (difference > planningAvailable(state, input)) fail('INSUFFICIENT_PLANNING_BALANCE');
  r.unallocated_minor += difference; r.total_minor = amount_minor;
  return r;
}

export function recordOrderOutcome(state, operation_ref, status) {
  ref(operation_ref);
  if (!['unknown', 'created_pending_payment', 'accepted', 'paid', 'fulfilling', 'delivered', 'failed', 'cancelled'].includes(status)) fail('VALIDATION_ERROR');
  const op = state.operations[operation_ref]; if (!op) fail('OPERATION_NOT_FOUND');
  const r = state.reservations[op.workflow_ref];
  // Paid cancellation/refunds need a separate settled-refund contract. Never
  // release money merely because an out-of-order event says cancelled/failed.
  const rank = { paid: 1, fulfilling: 2, delivered: 3 };
  if (op.allocation === 'consumed') {
    if ((rank[status] ?? 0) > (rank[op.status] ?? 0)) op.status = status;
    return op;
  }
  if (op.allocation === 'released') return op;
  if (rank[status]) {
    r.occupied_minor -= op.amount_minor; r.consumed_minor += op.amount_minor; op.allocation = 'consumed';
  } else if (['failed', 'cancelled'].includes(status)) {
    r.occupied_minor -= op.amount_minor;
    r[r.cancelled ? 'released_minor' : 'unallocated_minor'] += op.amount_minor; op.allocation = 'released';
  }
  op.status = status;
  return op;
}

export function cancelBudget(state, workflow_ref) {
  ref(workflow_ref); const r = state.reservations[workflow_ref]; if (!r) fail('WORKFLOW_NOT_FOUND');
  r.cancelled = true; r.released_minor += r.unallocated_minor; r.unallocated_minor = 0;
  return r;
}

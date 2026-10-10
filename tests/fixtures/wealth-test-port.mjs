import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Test-only clone of the future Banking Core Wealth Action Port. */
export function createTestWealthActionPort({ accounts, holdings, now }) {
  const state = { accounts: structuredClone(accounts), holdings: structuredClone(holdings) };
  const byOperation = new Map();
  const byIdempotency = new Map();

  function prepare(request, { idempotency_key, context_snapshot_id }) {
    if (!['wealth.subscribe', 'wealth.redeem'].includes(request.action)) throw new Error('unsupported action');
    const fingerprint = digest(request);
    const existingId = byIdempotency.get(idempotency_key);
    if (existingId) {
      const existing = byOperation.get(existingId);
      if (existing.fingerprint !== fingerprint) throw new Error('idempotency conflict');
      return structuredClone(existing.prepared);
    }
    const operation_id = `wealth_op_${byOperation.size + 1}`;
    const preview_hash = digest({ operation_id, request, context_snapshot_id });
    const expires_at = new Date(Date.parse(now) + 5 * 60 * 1000).toISOString();
    const prepared = { operation_id, state: 'awaiting_confirmation', preview: { preview_hash, expires_at, context_snapshot_id, request: structuredClone(request) } };
    byOperation.set(operation_id, { fingerprint, request: structuredClone(request), prepared, state: 'awaiting_confirmation' });
    byIdempotency.set(idempotency_key, operation_id);
    return structuredClone(prepared);
  }

  function confirm(operation_id, decision) {
    const operation = byOperation.get(operation_id);
    if (!operation) throw new Error('operation not found');
    if (operation.state !== 'awaiting_confirmation') throw new Error('invalid confirmation state');
    if (decision.preview_hash !== operation.prepared.preview.preview_hash) throw new Error('preview hash mismatch');
    if (decision.context_snapshot_id !== operation.prepared.preview.context_snapshot_id) throw new Error('context snapshot changed');
    if (Date.parse(decision.decided_at) > Date.parse(operation.prepared.preview.expires_at)) throw new Error('preview expired');
    operation.state = 'confirmed';
    return { operation_id, state: 'confirmed' };
  }

  function execute(operation_id) {
    const operation = byOperation.get(operation_id);
    if (!operation) throw new Error('operation not found');
    if (operation.state !== 'confirmed') throw new Error('confirmation required');
    const request = operation.request;
    if (request.action === 'wealth.subscribe') {
      const account = state.accounts.find(item => item.id === request.input.sourceAccountId);
      if (!account || account.availableBalanceFen < request.input.amountFen) throw new Error('insufficient balance');
      account.availableBalanceFen -= request.input.amountFen;
      const holding = state.holdings.find(item => item.productId === request.input.productId);
      if (holding) {
        holding.amountFen += request.input.amountFen;
        holding.unitsMilli += request.input.amountFen;
      } else {
        state.holdings.push({ id: `holding_${request.input.productId}`, productId: request.input.productId, amountFen: request.input.amountFen, unitsMilli: request.input.amountFen });
      }
    } else {
      const holding = state.holdings.find(item => item.id === request.input.holdingId);
      if (!holding) throw new Error('holding not found');
      const amount = request.input.quantityKind === 'amount' ? request.input.amountFen : request.input.unitsMilli;
      if (holding.amountFen < amount || holding.unitsMilli < amount) throw new Error('insufficient holding');
      holding.amountFen -= amount;
      holding.unitsMilli -= amount;
    }
    operation.state = 'succeeded';
    operation.receipt = { receipt_id: `wealth_receipt_${operation_id}`, operation_id, action: request.action, status: 'succeeded', executed_at: now, synthetic_demo_only: true };
    return structuredClone(operation.receipt);
  }

  return { prepare, confirm, execute, snapshot: () => structuredClone(state) };
}

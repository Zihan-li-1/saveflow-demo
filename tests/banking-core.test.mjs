import { test } from 'node:test';
import assert from 'node:assert/strict';
import seed from '../src/data/saveflow_mock_data.json' with { type: 'json' };
import { createBankingCore } from '../src/banking-core/core.mjs';
import { OperationStore } from '../src/banking-core/operation-store.mjs';
import { getLegacyContext, legacyRequest } from '../src/banking-core/legacy-adapter.mjs';
import { canTransitionAction, transitionAction } from '../src/banking-core/action-machine.mjs';
import { toWire, fromWire, transferFromResolvedIntent } from '../src/banking-core/wire.mjs';

const input = { fromAccountId: 'ACC-CHECKING', payeeId: 'payee_001', amountFen: 50000, currency: 'CNY' };
const unwrap = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
async function prepare(core, changes = {}) { return unwrap(await core.prepare({ action: 'transfer_money', input: { ...input, ...changes } })); }
async function confirm(core, prepared) {
  return unwrap(await core.decide(prepared.operationId, { previewHash: prepared.preview.previewHash, decision: 'confirm', confirmedStepIds: prepared.preview.stepIds }));
}
const execute = (core, prepared) => core.execute(prepared.operationId, prepared.preview.previewHash);
const balance = core => core.repository.getAccount(input.fromAccountId).availableBalanceFen;

test('B repository: all shared entities, fen normalization, seed provenance and defensive copies', () => {
  const core = createBankingCore(), repo = core.repository;
  assert.equal(repo.getAccounts().length, 2);
  assert.equal(repo.getAccount('ACC-SAVINGS').type, 'saving');
  assert.equal(balance(core), 500000);
  assert.equal(repo.getTransactions().length, 36);
  assert.equal(repo.getTransactions({ month: '2026-08' }).length, 12);
  assert.equal(repo.getCards().length, 2); assert.equal(repo.getSubscriptions().length, 2);
  assert.equal(repo.getPayee('payee_001').name, '张三');
  assert.equal(repo.getPayees().filter(p => p.aliases.includes('王先生')).length, 2);
  assert.deepEqual(repo.getInvestmentProducts().map(p => p.liquidity), ['T+0', 'T+1', 'AT_MATURITY']);
  assert.equal(repo.getContextInfo().asOf, '2026-09-01T00:00:00+08:00');
  repo.getAccounts()[0].balanceFen = 1;
  repo.getPayees()[0].name = '改名';
  repo.getTransactions()[0].amountFen = 1;
  assert.equal(balance(core), 500000); assert.equal(repo.getPayee('payee_001').name, '张三');
  assert.equal(repo.getTransactions()[0].amountFen, 1200000);
});

test('B transfer lifecycle: prepare + confirm never debit; execute creates ledger entry and uniform receipt', async () => {
  const core = createBankingCore(); const count = core.repository.getTransactions().length;
  const p = await prepare(core);
  assert.match(p.operationId, /^op_/); assert.match(p.preview.previewHash, /^[a-f0-9]{64}$/);
  assert.equal(p.risk.riskLevel, 'L3'); assert.equal(balance(core), 500000);
  assert.equal(p.preview.exactEffects[0].balanceAfterFen, 450000);
  assert.equal((await execute(core, p)).error.code, 'CONFIRMATION_REQUIRED');
  await confirm(core, p); assert.equal(balance(core), 500000);
  const receipt = unwrap(await execute(core, p));
  assert.equal(receipt.status, 'succeeded'); assert.equal(balance(core), 450000);
  assert.equal(receipt.operationId, p.operationId); assert.equal(receipt.stepId, p.preview.stepIds[0]);
  assert.equal(core.repository.getTransactions().length, count + 1);
  assert.deepEqual(unwrap(await core.getOperation(p.operationId)).receipt, receipt);
  assert.deepEqual(core.getAuditEvents().map(e => e.state), ['preparing', 'risk_check', 'awaiting_confirmation', 'confirmed', 'executing', 'succeeded']);
  assert.equal(JSON.stringify(core.getAuditEvents()).includes('张三'), false);
  assert.equal(seed.accounts[0].availableBalance, 5000);
});

test('B risk: insufficient balance and unknown entities produce standard errors, zero debit', async () => {
  for (const [patch, code] of [[{ amountFen: 50000000 }, 'INSUFFICIENT_BALANCE'], [{ payeeId: 'missing' }, 'PAYEE_NOT_FOUND'], [{ fromAccountId: 'missing' }, 'ACCOUNT_NOT_FOUND']]) {
    const core = createBankingCore();
    const result = await core.prepare({ action: 'transfer_money', input: { ...input, ...patch } });
    assert.equal(result.ok, false); assert.equal(result.error.code, code); assert.equal(result.error.uncertain, false);
    assert.equal(unwrap(await core.getOperation(result.operationId)).receipt.status, 'failed');
    assert.equal(balance(core), 500000);
  }
  const core = createBankingCore({ policy: { version: 'test', maxTransferFen: 100, previewTtlMs: 1000 } });
  assert.equal((await core.prepare({ action: 'transfer_money', input })).error.code, 'LIMIT_EXCEEDED');
});

test('B input: reject fractional fen, unsupported currency, hidden confirmation and unknown actions', async () => {
  const core = createBankingCore();
  for (const amountFen of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '50000']) {
    const r = await core.prepare({ action: 'transfer_money', input: { ...input, amountFen } });
    assert.equal(r.error.code, 'VALIDATION_ERROR');
  }
  for (const extra of [{ currency: 'USD' }, { confirmed: true }, { riskLevel: 'L0' }]) assert.equal((await core.prepare({ action: 'transfer_money', input: { ...input, ...extra } })).ok, false);
  assert.equal((await core.prepare({ action: 'purchase_product', input })).error.code, 'UNKNOWN_ACTION');
  assert.equal((await core.prepare({ action: 'transfer_money', input, confirmed: true })).ok, false);
  assert.equal(balance(core), 500000);
});

test('B idempotency: 20 concurrent retries return the same receipt with one debit', async () => {
  const core = createBankingCore(); const p = await prepare(core); await confirm(core, p);
  const results = await Promise.all(Array.from({ length: 20 }, async () => unwrap(await execute(core, p))));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(balance(core), 450000);
  assert.equal(core.repository.getTransactions().filter(t => t.operationId === p.operationId).length, 1);
  results[0].effects[0].amountFen = 1;
  assert.equal(unwrap(await core.getOperation(p.operationId)).receipt.effects[0].amountFen, 50000);
});

test('B confirmation: tampered preview/hash/steps and bare boolean cannot authorize money', async () => {
  const core = createBankingCore(); const p = await prepare(core);
  assert.equal((await core.decide(p.operationId, { confirmed: true })).error.code, 'CONFIRMATION_INVALID');
  assert.equal((await core.decide(p.operationId, { previewHash: 'bad', decision: 'confirm', confirmedStepIds: p.preview.stepIds })).error.code, 'CONFIRMATION_INVALID');
  assert.equal((await core.decide(p.operationId, { previewHash: p.preview.previewHash, decision: 'confirm', confirmedStepIds: [] })).error.code, 'CONFIRMATION_INVALID');
  p.preview.exactEffects[0].amountFen = 1;
  await confirm(core, p); const receipt = unwrap(await execute(core, p));
  assert.equal(receipt.effects[0].amountFen, 50000);
  assert.equal((await core.execute(p.operationId, 'bad')).error.code, 'CONFIRMATION_INVALID');
});

test('B cancellation is final and idempotent, never posts a transaction', async () => {
  const core = createBankingCore(); const p = await prepare(core);
  const decision = { previewHash: p.preview.previewHash, decision: 'reject', confirmedStepIds: [] };
  assert.equal(unwrap(await core.decide(p.operationId, decision)).status, 'cancelled');
  assert.equal(unwrap(await core.decide(p.operationId, decision)).status, 'cancelled');
  assert.equal(unwrap(await execute(core, p)).status, 'cancelled');
  assert.equal((await core.decide(p.operationId, { ...decision, decision: 'confirm', confirmedStepIds: p.preview.stepIds })).error.code, 'INVALID_STATE');
  assert.equal(balance(core), 500000);
});

test('B expiry: checked at both confirmation and execute; pending state becomes final failed receipt', async () => {
  for (const confirmFirst of [false, true]) {
    let time = Date.parse('2026-09-22T00:00:00Z');
    const core = createBankingCore({ now: () => time }); const p = await prepare(core);
    if (confirmFirst) await confirm(core, p);
    time += 300000;
    const result = confirmFirst ? await execute(core, p) : await core.decide(p.operationId, { previewHash: p.preview.previewHash, decision: 'confirm', confirmedStepIds: p.preview.stepIds });
    assert.equal(result.error.code, 'PREVIEW_EXPIRED'); assert.equal(balance(core), 500000);
    assert.equal(unwrap(await core.getOperation(p.operationId)).status, 'failed');
  }
});

test('B concurrent independent transfers recheck balance/version instead of overspending or stale execution', async () => {
  for (const amountFen of [50000, 400000]) {
    const core = createBankingCore();
    const [a, b] = await Promise.all([prepare(core, { amountFen }), prepare(core, { amountFen })]);
    await confirm(core, a); await confirm(core, b); unwrap(await execute(core, a));
    assert.equal((await execute(core, b)).error.code, amountFen === 400000 ? 'INSUFFICIENT_BALANCE' : 'PREVIEW_STALE');
    assert.equal(balance(core), 500000 - amountFen);
  }
});

test('B unknown outcomes: only CHECK is allowed, missing records never mean failed or succeeded', async () => {
  assert.equal(transitionAction('executing', 'UNCERTAIN'), 'unknown');
  for (const e of ['CONFIRM', 'EXECUTE', 'RESET', 'CANCEL']) assert.equal(canTransitionAction('unknown', e), false);
  assert.equal(transitionAction('unknown', 'CHECK'), 'checking');
  assert.equal(transitionAction('checking', 'UNCERTAIN'), 'unknown');
  const result = unwrap(await createBankingCore().getOperation('unknown_key'));
  assert.equal(result.state, 'unknown'); assert.equal(result.status, 'pending');
});

test('B old plan adapter shares operation store, cannot re-use transfer key or fake money effects', async () => {
  const core = createBankingCore(); const inputPlan = { monthlySavingFen: 250000, saveRateBps: 1000, confirmed: true };
  const first = await legacyRequest('create-plan', inputPlan, 'old-plan', core);
  assert.deepEqual(await legacyRequest('create-plan', { confirmed: true, saveRateBps: 1000, monthlySavingFen: 250000 }, 'old-plan', core), first);
  assert.equal(unwrap(await core.getOperation('old-plan')).receipt.action, 'legacy.create-plan');
  assert.deepEqual(unwrap(await core.getOperation('old-plan')).receipt.effects, []);
  await assert.rejects(legacyRequest('create-plan', { ...inputPlan, monthlySavingFen: 100 }, 'old-plan', core), { code: 'IDEMPOTENCY_CONFLICT' });
  const p = await prepare(core); await confirm(core, p); unwrap(await execute(core, p));
  await assert.rejects(legacyRequest('create-plan', inputPlan, p.operationId, core), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal((await legacyRequest('operation-status', { operationId: p.operationId }, '', core)).status, 'pending');
  assert.equal(balance(core), 450000);
});

test('B user scoping: shared store does not reveal another owner operation', async () => {
  const store = new OperationStore(); const a = createBankingCore({ store });
  const source = structuredClone(seed); source.user.id = 'another_user';
  const b = createBankingCore({ store, source }); const p = await prepare(a); await confirm(a, p); unwrap(await execute(a, p));
  assert.equal(unwrap(await b.getOperation(p.operationId)).status, 'pending');
  assert.equal((await b.execute(p.operationId, p.preview.previewHash)).error.code, 'OPERATION_NOT_FOUND');
  assert.equal(balance(b), 500000);
});

test('B legacy context is computed from raw transactions, consistent with savings progress', async () => {
  const source = structuredClone(seed);
  source.transactions.find(t => t.date.startsWith('2026-08') && t.type === 'expense').amount += 123;
  const before = getLegacyContext(createBankingCore().repository), after = getLegacyContext(createBankingCore({ source }).repository);
  assert.equal(after.totalExpenseFen - before.totalExpenseFen, 12300);
  assert.equal(before.savedAmountFen, 0);
  assert.equal(before.defaultMonthlySavingFen, 250000);
  assert.equal(before.currentMonth, '2026-08');
});

test('B v1.1 wire boundary preserves integers; resolved intent uses entity evidence, never names or monthlySavingFen', async () => {
  const core = createBankingCore(); const p = await prepare(core);
  const wire = toWire(p); assert.equal(wire.preview.exact_effects[0].amount_minor, 50000);
  assert.deepEqual(fromWire(wire), p);
  const resolved = { action: 'transfer.create', state: 'ready_for_planning', resolved_slots: { amount: { amount_minor: 50000, currency: 'CNY' } }, references: [{ slot: 'source_account_ref', entity_id: 'ACC-CHECKING', source: 'financial_context' }, { slot: 'payee_ref', entity_id: 'payee_001', source: 'user_selection' }] };
  assert.deepEqual(transferFromResolvedIntent(resolved), { action: 'transfer_money', input });
  assert.throws(() => transferFromResolvedIntent({ ...resolved, references: [] }));
  assert.throws(() => transferFromResolvedIntent({ ...resolved, action: 'create_plan' }));
});

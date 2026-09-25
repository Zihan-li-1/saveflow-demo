/* eslint-disable @typescript-eslint/no-require-imports -- CJS loader compiles the TS agent modules. */
const { readFileSync } = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  });
  module._compile(outputText, filename);
};

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dispatchParsedIntent } = require('../src/agent/dispatcher.ts');
const { handleBillSummary } = require('../src/agent/handlers/bill-handler.ts');
const { handleTransfer } = require('../src/agent/handlers/transfer-handler.ts');
const { createTransferRepositoryAdapter } = require('../src/skill/transfer/repository-adapter.ts');
const { ParsedIntentValidationError } = require('../src/agent/validate-parsed-intent.ts');

const intent = (action, slots, missingSlots, status) => ({
  schemaVersion: '1.0.0', action, slots, missingSlots, status,
});
const readyTransfer = intent('transfer.create', {
  payee_ref: '张三',
  amount: { amount_minor: 50000, currency: 'CNY' },
  source_account_ref: '活期账户',
}, [], 'ready_for_resolution');
const readyBill = intent('bill.summary', { month: '2026-08' }, [], 'ready_for_resolution');

function spies() {
  const calls = { bill: 0, transfer: 0 };
  return {
    calls,
    dependencies: {
      billHandler: async (value) => { calls.bill++; return { ok: true, kind: 'bill_result', action: value.action, data: 'bill', evidence: [] }; },
      transferHandler: async (value) => { calls.transfer++; return { ok: true, kind: 'transfer_resolution', action: value.action, data: 'transfer' }; },
    },
  };
}

test('routes transfer.create only to transferHandler', async () => {
  const { dependencies, calls } = spies();
  const result = await dispatchParsedIntent(readyTransfer, dependencies);
  assert.equal(result.kind, 'transfer_resolution');
  assert.deepEqual(calls, { bill: 0, transfer: 1 });
});

test('routes bill.summary only to billHandler', async () => {
  const { dependencies, calls } = spies();
  const result = await dispatchParsedIntent(readyBill, dependencies);
  assert.equal(result.kind, 'bill_result');
  assert.deepEqual(calls, { bill: 1, transfer: 0 });
});

test('does not call handlers for parser clarification or unsupported intent', async () => {
  const { dependencies, calls } = spies();
  const clarification = await dispatchParsedIntent(intent('transfer.create', { payee_ref: '张三' }, ['amount', 'source_account_ref'], 'needs_clarification'), dependencies);
  assert.deepEqual(clarification, {
    ok: false, kind: 'needs_clarification', action: 'transfer.create', source: 'parser', missingSlots: ['amount', 'source_account_ref'],
  });
  const unsupported = await dispatchParsedIntent(intent('unsupported', {}, [], 'unsupported'), dependencies);
  assert.deepEqual(unsupported, { ok: false, kind: 'unsupported' });
  assert.deepEqual(calls, { bill: 0, transfer: 0 });
});

test('rejects invalid intents before either handler is called', async () => {
  const { dependencies, calls } = spies();
  for (const value of [
    { ...readyTransfer, tool: 'action.execute' },
    { ...readyTransfer, confirmed: true },
    { ...readyTransfer, riskLevel: 'L0' },
    { ...readyTransfer, operationId: 'op_1' },
    { ...readyTransfer, action: 'card.freeze' },
    { ...readyTransfer, slots: { ...readyTransfer.slots, amount: { amount_minor: 500.5, currency: 'CNY' } } },
  ]) {
    await assert.rejects(dispatchParsedIntent(value, dependencies), ParsedIntentValidationError);
  }
  assert.deepEqual(calls, { bill: 0, transfer: 0 });
});

test('handler errors become skill_error and never fall through to the other handler', async () => {
  const calls = { bill: 0, transfer: 0 };
  const result = await dispatchParsedIntent(readyTransfer, {
    billHandler: async () => { calls.bill++; throw new Error('bill should not run'); },
    transferHandler: async () => { calls.transfer++; throw new Error('resolver unavailable'); },
  });
  assert.deepEqual(result, {
    ok: false, kind: 'skill_error', action: 'transfer.create',
    error: { code: 'SKILL_ERROR', message: 'resolver unavailable' },
  });
  assert.deepEqual(calls, { bill: 0, transfer: 1 });
});

test('real bill handler reads the shared repository and reflects changed transactions', async () => {
  const { createFinancialContext } = await import('../src/banking-core/repository.mjs');
  const seed = JSON.parse(readFileSync(require.resolve('../src/data/saveflow_mock_data.json'), 'utf8'));
  const first = await handleBillSummary(readyBill, createFinancialContext(seed).repository);
  assert.equal(first.ok, true);
  assert.equal(first.kind, 'bill_result');
  assert.equal(first.evidence[0].source, 'synthetic_demo_only');

  seed.transactions.push({
    id: 'TXN-EXTRA-202608', date: '2026-08-31', accountId: 'ACC-CHECKING', type: 'expense',
    category: '餐饮', merchant: '新增测试交易', amount: 1, currency: 'CNY', status: 'posted', isSynthetic: true,
  });
  const second = await handleBillSummary(readyBill, createFinancialContext(seed).repository);
  assert.equal(second.data.transactionCount, first.data.transactionCount + 1);
  assert.equal(second.data.totalExpenseFen, first.data.totalExpenseFen + 100);
  assert.equal(second.data.categoryTotals['餐饮'], first.data.categoryTotals['餐饮'] + 100);
  assert.ok(second.evidence[0].entityIds.includes('TXN-EXTRA-202608'));
});

test('real transfer handler resolves raw account and payee references without executing Banking Core', async () => {
  const { createFinancialContext } = await import('../src/banking-core/repository.mjs');
  const repository = createFinancialContext().repository;
  const result = await handleTransfer(readyTransfer, { repository: createTransferRepositoryAdapter(repository) });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'transfer_resolution');
  assert.equal(result.data.state, 'ready_for_planning');
  assert.equal(result.data.references.some((reference) => reference.entity_id === 'ACC-CHECKING'), true);
  assert.equal(result.data.references.some((reference) => reference.entity_id === 'payee_001'), true);
});

test('ambiguous D resolution remains a resolver clarification', async () => {
  const result = await handleTransfer(readyTransfer, {
    repository: {
      queryAccount: () => ({ id: 'ACC-CHECKING', currency: 'CNY', availableBalanceFen: 100000 }),
      queryPayeesByName: () => [
        { id: 'payee_003', name: '王先生', aliases: ['王先生'] },
        { id: 'payee_004', name: '王强', aliases: ['王先生'] },
      ],
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'needs_clarification');
  assert.equal(result.source, 'resolver');
  assert.equal(result.candidates.length, 2);
});

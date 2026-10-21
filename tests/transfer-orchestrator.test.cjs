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
const { createBankingCore } = require('../src/banking-core/core.mjs');
const { createTransferRepositoryAdapter } = require('../src/skill/transfer/repository-adapter.ts');
const { handleTransfer } = require('../src/agent/handlers/transfer-handler.ts');
const { dispatchParsedIntent } = require('../src/agent/dispatcher.ts');
const { prepareTransferPreview, orchestrateTransferPreview } = require('../src/agent/transfer-orchestrator.ts');

const ready = {
  schemaVersion: '1.0.0', action: 'transfer.create',
  slots: { payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' }, source_account_ref: '活期账户' },
  missingSlots: [], status: 'ready_for_resolution',
};

async function dispatchedWith(core, intent = ready) {
  return dispatchParsedIntent(intent, {
    billHandler: async value => ({ ok: true, kind: 'bill_result', action: value.action, data: 'bill', evidence: [] }),
    transferHandler: value => handleTransfer(value, { repository: createTransferRepositoryAdapter(core.repository) }),
  });
}

test('unique transfer reaches Core and returns only its formal awaiting-confirmation preview', async () => {
  const core = createBankingCore();
  const beforeBalance = core.repository.getAccount('ACC-CHECKING').availableBalanceFen;
  const beforeTransactions = core.repository.getTransactions().length;
  const result = await prepareTransferPreview(await dispatchedWith(core), core);
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'transfer_preview');
  assert.equal(result.data.state, 'awaiting_confirmation');
  assert.match(result.data.operationId, /^op_/);
  assert.equal(result.data.risk.riskLevel, 'L3');
  assert.equal(result.data.preview.exactEffects[0].amountFen, 50000);
  assert.equal(core.repository.getAccount('ACC-CHECKING').availableBalanceFen, beforeBalance);
  assert.equal(core.repository.getTransactions().length, beforeTransactions);
});

test('clarification, bill, and skill errors never call Core prepare', async () => {
  let prepares = 0;
  const core = { prepare: async () => { prepares++; throw new Error('must not prepare'); } };
  const ambiguous = await dispatchedWith(createBankingCore(), {
    ...ready, slots: { ...ready.slots, payee_ref: '王先生' },
  });
  const missing = await dispatchedWith(createBankingCore(), {
    ...ready, slots: { payee_ref: '张三' }, missingSlots: ['amount', 'source_account_ref'], status: 'needs_clarification',
  });
  const bill = await dispatchedWith(createBankingCore(), {
    schemaVersion: '1.0.0', action: 'bill.summary', slots: { month: '2026-08' }, missingSlots: [], status: 'ready_for_resolution',
  });
  for (const result of [ambiguous, missing, bill, { ok: false, kind: 'skill_error', action: 'transfer.create', error: { code: 'SKILL_ERROR', message: 'resolver unavailable' } }]) {
    const output = await prepareTransferPreview(result, core);
    assert.notEqual(output.kind, 'transfer_preview');
  }
  assert.equal(prepares, 0);
});

test('Core rejection is preserved and does not become a successful preview', async () => {
  const core = createBankingCore();
  const beforeBalance = core.repository.getAccount('ACC-CHECKING').availableBalanceFen;
  const beforeTransactions = core.repository.getTransactions().length;
  const result = await prepareTransferPreview(await dispatchedWith(core, {
    ...ready, slots: { ...ready.slots, amount: { amount_minor: 50000000, currency: 'CNY' } },
  }), core);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'core_error');
  assert.equal(result.error.code, 'INSUFFICIENT_BALANCE');
  assert.equal(result.operationId.startsWith('op_'), true);
  assert.equal(core.repository.getAccount('ACC-CHECKING').availableBalanceFen, beforeBalance);
  assert.equal(core.repository.getTransactions().length, beforeTransactions);
});

test('orchestrator dispatches before handing off and never invokes decide or execute', async () => {
  const core = createBankingCore();
  let decides = 0; let executes = 0;
  const wrapped = {
    ...core,
    prepare: core.prepare.bind(core),
    decide: () => { decides++; throw new Error('must not decide'); },
    execute: () => { executes++; throw new Error('must not execute'); },
  };
  const result = await orchestrateTransferPreview(ready, {
    billHandler: async value => ({ ok: true, kind: 'bill_result', action: value.action, data: 'bill', evidence: [] }),
    transferHandler: value => handleTransfer(value, { repository: createTransferRepositoryAdapter(core.repository) }),
  }, wrapped);
  assert.equal(result.kind, 'transfer_preview');
  assert.equal(decides, 0);
  assert.equal(executes, 0);
});

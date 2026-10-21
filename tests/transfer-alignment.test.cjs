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

// 锁定 .ts（typed blueprint）与 runtime.mjs（实际运行的机器）行为对齐：
// accountNoMasked / selections 复用已选实体 / 澄清结果携带 slot+reason。

test('payee resolution exposes accountNoMasked and copies aliases', async () => {
  const adapter = createTransferRepositoryAdapter(createBankingCore().repository);
  const [zhangsan] = await adapter.queryPayeesByName('张三');
  assert.equal(zhangsan.id, 'payee_001');
  assert.deepEqual(zhangsan.aliases, ['张三']);
  assert.match(zhangsan.accountNoMasked, /^\*+\d+$/);
});

test('ambiguous payee returns all candidates and forwards slot/reason to the handler', async () => {
  const adapter = createTransferRepositoryAdapter(createBankingCore().repository);
  const result = await handleTransfer(
    { action: 'transfer.create', slots: { payee_ref: '王先生', amount: { amount_minor: 50000, currency: 'CNY' }, source_account_ref: '活期账户' } },
    { repository: adapter },
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'needs_clarification');
  assert.equal(result.slot, 'payee_ref');
  assert.equal(result.reason, 'ambiguous_payee');
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every((c) => typeof c.accountNoMasked === 'string' && c.accountNoMasked.length > 0));
});

test('payee_not_found clarification carries slot and reason', async () => {
  const adapter = createTransferRepositoryAdapter(createBankingCore().repository);
  const result = await handleTransfer(
    { action: 'transfer.create', slots: { payee_ref: '不存在的收款人XYZ', amount: { amount_minor: 50000, currency: 'CNY' }, source_account_ref: '活期账户' } },
    { repository: adapter },
  );
  assert.equal(result.kind, 'needs_clarification');
  assert.equal(result.slot, 'payee_ref');
  assert.equal(result.reason, 'payee_not_found');
});

test('payee selections reuse the exact entity and skip re-ambiguation', async () => {
  const adapter = createTransferRepositoryAdapter(createBankingCore().repository, { payee_ref: { entityId: 'payee_003' } });
  const payees = await adapter.queryPayeesByName('王先生');
  assert.equal(payees.length, 1);
  assert.equal(payees[0].id, 'payee_003');
  assert.equal(payees[0].name, '房东王先生');
  assert.match(payees[0].accountNoMasked, /^\*+\d+$/);
});

test('source account selections reuse the exact entity', async () => {
  const adapter = createTransferRepositoryAdapter(createBankingCore().repository, { source_account_ref: { entityId: 'ACC-CHECKING' } });
  const account = await adapter.queryAccount('任意不匹配的名字');
  assert.equal(account.id, 'ACC-CHECKING');
});

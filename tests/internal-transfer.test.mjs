import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { createLowBalanceCore } from './fixtures/low-balance-core.mjs';
import { handleTransfer, transferRepository } from '../src/agent/runtime.mjs';
import { validateParsedIntent, ParsedIntentValidationError } from '../src/agent/validate-parsed-intent.mjs';
import { buildParsedIntent } from '../src/agent/clarification/merge-intent.mjs';
import { validRecoverySlot } from '../src/lib/agent-error-policy.mjs';

// 本人账户互转意图解析、澄清与正式转账预览入口。

const resolve = async (core, slots, selections) => handleTransfer({ action: 'transfer.create', slots }, transferRepository(core.repository, selections));
const clarification = result => { assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.kind, 'needs_clarification'); return result; };

test('内部互转识别：从活期转 100 元到储蓄 → 解析为本人账户双边方向', async () => {
  const core = createBankingCore();
  const result = await resolve(core, {
    source_account_ref: '活期账户',
    target_account_ref: '储蓄账户',
    amount: { amount_minor: 10000, currency: 'CNY' },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.kind, 'transfer_resolution');
  assert.equal(result.data.state, 'ready_for_planning');

  const p = result.data.preview;
  assert.equal(p.kind, 'internal_transfer');
  assert.equal(p.source_account_id, 'ACC-CHECKING');
  assert.equal(p.target_account_id, 'ACC-SAVINGS');
  assert.equal(p.amount_minor, 10000);
  assert.equal(p.currency, 'CNY');
  assert.equal(p.source_available_balance_minor, 3000000);
  assert.equal(p.source_estimated_balance_after_minor, 2990000);
  assert.equal(p.target_available_balance_minor, 1000000);
  assert.equal(p.target_estimated_balance_after_minor, 1010000);
  // 同币种内部互转：总额守恒（转出减少 = 转入增加）。
  assert.equal(p.source_available_balance_minor + p.target_available_balance_minor, p.source_estimated_balance_after_minor + p.target_estimated_balance_after_minor);
  // 方向解析：references 记录两端本人账户，且不产生任何 payee 引用。
  const refs = result.data.references;
  assert.deepEqual(refs.map(ref => ref.slot).sort(), ['source_account_ref', 'target_account_ref']);
  assert.equal(refs.find(ref => ref.slot === 'source_account_ref').entity_id, 'ACC-CHECKING');
  assert.equal(refs.find(ref => ref.slot === 'target_account_ref').entity_id, 'ACC-SAVINGS');
});

test('外部转账不被误判：payee_ref 仍走对外转账路径', async () => {
  const core = createBankingCore();
  const result = await resolve(core, {
    payee_ref: '张三',
    source_account_ref: '活期账户',
    amount: { amount_minor: 50000, currency: 'CNY' },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.kind, 'transfer_resolution');
});

test('缺转出账户：只说了转入账户，需澄清来源', async () => {
  const core = createBankingCore();
  const result = clarification(await resolve(core, {
    target_account_ref: '活期账户',
    amount: { amount_minor: 10000, currency: 'CNY' },
  }));
  assert.equal(result.slot, 'source_account_ref');
  assert.equal(result.reason, 'missing_slot');
});

test('转出与转入为同一账户：拒绝并澄清，不生成预览', async () => {
  const core = createBankingCore();
  const result = clarification(await resolve(core, {
    source_account_ref: '活期账户',
    target_account_ref: '活期账户',
    amount: { amount_minor: 10000, currency: 'CNY' },
  }));
  assert.equal(result.reason, 'same_account');
  assert.equal(result.slot, 'target_account_ref');
});

test('转入账户不是本人可用账户：澄清', async () => {
  const core = createBankingCore();
  const result = clarification(await resolve(core, {
    source_account_ref: '活期账户',
    target_account_ref: '不存在的账户',
    amount: { amount_minor: 10000, currency: 'CNY' },
  }));
  assert.equal(result.reason, 'target_account_not_found');
  assert.equal(result.slot, 'target_account_ref');
});

test('转出账户余额不足：澄清，不生成预览', async () => {
  const core = createLowBalanceCore(); // 活期可用余额 5000 分，储蓄 0
  const result = clarification(await resolve(core, {
    source_account_ref: '活期账户',
    target_account_ref: '储蓄账户',
    amount: { amount_minor: 1000000, currency: 'CNY' }, // ¥10000 > ¥50
  }));
  assert.equal(result.reason, 'insufficient_balance');
});

test('别名/类型冲突：多个本人账户匹配时询问，不擅自取第一个', async () => {
  const accounts = [
    { id: 'ACC-CHECKING', name: '模拟活期账户', type: 'checking', status: 'active', availableBalanceFen: 3000000, currency: 'CNY' },
    { id: 'ACC-CHECKING-2', name: '模拟活期账户', type: 'checking', status: 'active', availableBalanceFen: 1000000, currency: 'CNY' },
  ];
  const repository = {
    async getAccounts() { return accounts; },
    async getAccount(id) { return accounts.find(account => account.id === id); },
    async getPayees() { return []; },
    async getPayee() { return null; },
  };
  const result = clarification(await handleTransfer({ action: 'transfer.create', slots: { source_account_ref: '活期账户', target_account_ref: '储蓄账户', amount: { amount_minor: 10000, currency: 'CNY' } } }, transferRepository(repository)));
  assert.equal(result.reason, 'ambiguous_account');
  assert.equal(result.slot, 'source_account_ref');
});

test('储蓄转活期方向不颠倒，显式本人互转类型允许随后补账户', async () => {
  const core = createBankingCore();
  const result = await resolve(core, {
    transfer_type: 'internal', source_account_ref: '储蓄', target_account_ref: '活期',
    amount: { amount_minor: 10000, currency: 'CNY' },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.references.find(ref => ref.slot === 'source_account_ref').entity_id, 'ACC-SAVINGS');
  assert.equal(result.data.references.find(ref => ref.slot === 'target_account_ref').entity_id, 'ACC-CHECKING');
});

// —— ParsedIntent 契约层：方向槽位与互斥 ——

test('契约：payee_ref 与 target_account_ref 互斥，不得同时出现', () => {
  assert.throws(() => validateParsedIntent({
    schemaVersion: '1.0.0', action: 'transfer.create',
    slots: { payee_ref: '张三', target_account_ref: '活期账户', amount: { amount_minor: 10000, currency: 'CNY' }, source_account_ref: '活期账户' },
    missingSlots: [], status: 'ready_for_resolution',
  }), ParsedIntentValidationError);
});

test('契约：target_account_ref 必须是原始用户称谓，不接受账户实体 ID', () => {
  assert.throws(() => validateParsedIntent({
    schemaVersion: '1.0.0', action: 'transfer.create',
    slots: { target_account_ref: 'ACC-SAVINGS', amount: { amount_minor: 10000, currency: 'CNY' }, source_account_ref: '活期账户' },
    missingSlots: [], status: 'ready_for_resolution',
  }), ParsedIntentValidationError);
});

test('契约：本人互转用 target_account_ref 时，缺来源账户应标记为 needs_clarification', () => {
  const intent = validateParsedIntent({
    schemaVersion: '1.0.0', action: 'transfer.create',
    slots: { target_account_ref: '活期账户', amount: { amount_minor: 10000, currency: 'CNY' } },
    missingSlots: ['source_account_ref'], status: 'needs_clarification',
  });
  assert.equal(intent.status, 'needs_clarification');
  assert.deepEqual(intent.missingSlots, ['source_account_ref']);
});

// —— 续接路径：方向感知的必需槽位与可恢复槽位 ——

test('续接：本人互转已选 target_account_ref，补齐来源账户后 buildParsedIntent 不再误报 payee_ref 缺失', () => {
  const intent = buildParsedIntent('transfer.create', {
    target_account_ref: '储蓄账户',
    source_account_ref: '活期账户',
    amount: { amount_minor: 10000, currency: 'CNY' },
  });
  assert.equal(intent.status, 'ready_for_resolution');
  assert.deepEqual(intent.missingSlots, []);
});

test('续接：本人互转只缺来源账户时，缺的应是 source_account_ref 而非 payee_ref', () => {
  const intent = buildParsedIntent('transfer.create', {
    target_account_ref: '储蓄账户',
    amount: { amount_minor: 10000, currency: 'CNY' },
  });
  assert.equal(intent.status, 'needs_clarification');
  assert.deepEqual(intent.missingSlots, ['source_account_ref']);
});

test('续接：对外转账仍要求 payee_ref，未被内部互转规则误伤', () => {
  const intent = buildParsedIntent('transfer.create', {
    source_account_ref: '活期账户',
    amount: { amount_minor: 10000, currency: 'CNY' },
  });
  assert.equal(intent.status, 'needs_clarification');
  assert.deepEqual(intent.missingSlots, ['transfer_type']);
  const selected = buildParsedIntent('transfer.create', { transfer_type: 'external', source_account_ref: '活期账户', amount: { amount_minor: 10000, currency: 'CNY' } });
  assert.deepEqual(selected.missingSlots, ['payee_ref']);
});

test('方向不明确时 transfer_type 是必需澄清槽位', () => {
  const intent = buildParsedIntent('transfer.create', { amount: { amount_minor: 10000, currency: 'CNY' } });
  assert.deepEqual(intent.missingSlots, ['transfer_type', 'source_account_ref']);
  assert.equal(intent.status, 'needs_clarification');
});

test('可恢复槽位：target_account_ref 是 transfer.create 的合法恢复槽位，且不削弱既有槽位', () => {
  assert.equal(validRecoverySlot('transfer.create', 'target_account_ref'), true);
  assert.equal(validRecoverySlot('transfer.create', 'source_account_ref'), true);
  assert.equal(validRecoverySlot('transfer.create', 'payee_ref'), true);
  assert.equal(validRecoverySlot('transfer.create', 'amount'), true);
  assert.equal(validRecoverySlot('transfer.create', 'transfer_type'), true);
  assert.equal(validRecoverySlot('transfer.create', 'card_ref'), false);
});

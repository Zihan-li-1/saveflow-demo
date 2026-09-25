/* eslint-disable @typescript-eslint/no-require-imports -- CJS test exercises the ESM HTTP entry. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBankingCore } = require('../src/banking-core/core.mjs');
const { handleBankingAgent } = require('../server/banking-agent.mjs');

const env = { SAVEFLOW_ACCESS_CODE: 'test-access-code-1234', CONTINUATION_TOKEN_SECRET: 'test-continuation-secret-1234' };
let requestNumber = 0;
const request = body => new Request('http://localhost/api/banking-agent', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE,
    'x-forwarded-for': `clarification-test-${++requestNumber}`,
  },
  body: JSON.stringify(body),
});

const transfer = slots => ({
  schemaVersion: '1.0.0', action: 'transfer.create', slots,
  missingSlots: ['payee_ref', 'amount', 'source_account_ref'].filter(slot => slots[slot] === undefined),
  status: ['payee_ref', 'amount', 'source_account_ref'].every(slot => slots[slot] !== undefined) ? 'ready_for_resolution' : 'needs_clarification',
});
const bill = slots => ({ schemaVersion: '1.0.0', action: 'bill.summary', slots, missingSlots: slots.month ? [] : ['month'], status: slots.month ? 'ready_for_resolution' : 'needs_clarification' });

function parseIntent(message) {
  if (/账单/.test(message)) return bill(/8月/.test(message) ? { month: '2026-08' } : {});
  if (/重名/.test(message)) return transfer({ payee_ref: '王先生', amount: { amount_minor: 50000, currency: 'CNY' }, source_account_ref: '活期账户' });
  if (/缺金额/.test(message)) return transfer({ payee_ref: '张三', source_account_ref: '活期账户' });
  return transfer({ payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' } });
}

async function json(response) { return response.json(); }

test('缺账户先展示真实账户选项，选择后返回 Core 正式预览', async () => {
  const core = createBankingCore();
  let prepares = 0;
  let decides = 0;
  let executes = 0;
  const wrapped = {
    ...core,
    prepare: async input => { prepares++; return core.prepare(input); },
    decide: () => { decides++; throw new Error('澄清入口禁止确认'); },
    execute: () => { executes++; throw new Error('澄清入口禁止执行'); },
  };
  const first = await handleBankingAgent(request({ message: '给张三转500元' }), { env, core: wrapped, parseIntent, now: () => 1000 });
  const firstBody = await json(first);
  assert.equal(firstBody.data.kind, 'clarification');
  assert.equal(firstBody.data.choices.length, 2);
  assert.equal(firstBody.data.continuationToken.includes('ACC-CHECKING'), false);
  assert.equal(prepares, 0);
  assert.equal(firstBody.data.choices[0].label, core.repository.getAccounts()[0].name);
  const before = core.repository.getAccount('ACC-CHECKING').availableBalanceFen;
  const transactionCount = core.repository.getTransactions().length;
  const second = await handleBankingAgent(request({ continuationToken: firstBody.data.continuationToken, choice: { optionId: firstBody.data.choices[0].optionId } }), { env, core: wrapped, parseIntent, now: () => 1000 });
  const secondBody = await json(second);
  assert.equal(secondBody.data.status, 'awaiting_confirmation');
  assert.equal(secondBody.data.preview.exactEffects[0].fromAccountId, 'ACC-CHECKING');
  assert.equal(secondBody.data.operationId.startsWith('op_'), true);
  assert.equal(prepares, 1);
  assert.equal(decides, 0);
  assert.equal(executes, 0);
  assert.equal(core.repository.getAccount('ACC-CHECKING').availableBalanceFen, before);
  assert.equal(core.repository.getTransactions().length, transactionCount);
});

test('未配置续接密钥时澄清入口明确报配置错误，不信任客户端草稿', async () => {
  const core = createBankingCore();
  let prepares = 0;
  const wrapped = { ...core, prepare: async input => { prepares++; return core.prepare(input); } };
  const result = await handleBankingAgent(request({ message: '给张三转500元' }), {
    env: { SAVEFLOW_ACCESS_CODE: env.SAVEFLOW_ACCESS_CODE }, core: wrapped, parseIntent, now: () => 1200,
  });
  const body = await json(result);
  assert.equal(result.status, 503);
  assert.equal(body.code, 'CONTINUATION_CONFIG_ERROR');
  assert.equal(prepares, 0);
});

test('非法金额在 prepare 前被拦截，三种格式均明确保持 prepareCalls 为零', async () => {
  for (const answer of ['0 元', '-1 元', '1.001 元']) {
    const core = createBankingCore();
    let prepares = 0;
    const wrapped = { ...core, prepare: async input => { prepares++; return core.prepare(input); } };
    const firstBody = await json(await handleBankingAgent(request({ message: '缺金额' }), { env, core: wrapped, parseIntent, now: () => 1500 }));
    const secondBody = await json(await handleBankingAgent(request({ continuationToken: firstBody.data.continuationToken, message: answer }), { env, core: wrapped, parseIntent, now: () => 1500 }));
    assert.equal(secondBody.data.kind, 'clarification');
    assert.equal(prepares, 0, answer);
  }
});

test('缺金额可用自然语言补齐，金额转换为整数分', async () => {
  const core = createBankingCore();
  const firstBody = await json(await handleBankingAgent(request({ message: '缺金额' }), { env, core, parseIntent, now: () => 2000 }));
  assert.equal(firstBody.data.slot, 'amount');
  const secondBody = await json(await handleBankingAgent(request({ continuationToken: firstBody.data.continuationToken, message: '500元' }), { env, core, parseIntent, now: () => 2000 }));
  assert.equal(secondBody.data.preview.exactEffects[0].amountFen, 50000);
});

test('缺月份可补齐后返回真实账单统计和证据', async () => {
  const core = createBankingCore();
  const firstBody = await json(await handleBankingAgent(request({ message: '查账单' }), { env, core, parseIntent, now: () => 3000 }));
  assert.equal(firstBody.data.slot, 'month');
  const secondBody = await json(await handleBankingAgent(request({ continuationToken: firstBody.data.continuationToken, message: '2026年8月' }), { env, core, parseIntent, now: () => 3000 }));
  assert.equal(secondBody.data.status, 'bill_result');
  assert.equal(secondBody.data.data.transactionCount, 12);
  assert.equal(secondBody.data.evidence[0].source, 'synthetic_demo_only');
});

test('重名收款人必须明确选择，候选标签包含脱敏账号', async () => {
  const core = createBankingCore();
  let prepares = 0;
  const wrapped = { ...core, prepare: async input => { prepares++; return core.prepare(input); } };
  const firstBody = await json(await handleBankingAgent(request({ message: '重名' }), { env, core: wrapped, parseIntent, now: () => 4000 }));
  assert.equal(firstBody.data.choices.length, 2);
  assert.match(firstBody.data.choices[0].label, /1003|1004/);
  assert.equal(prepares, 0);
  const secondBody = await json(await handleBankingAgent(request({ continuationToken: firstBody.data.continuationToken, choice: { optionId: firstBody.data.choices[1].optionId } }), { env, core: wrapped, parseIntent, now: () => 4000 }));
  assert.equal(secondBody.data.preview.exactEffects[0].payeeId, 'payee_004');
  assert.equal(prepares, 1);
});

test('账户余额不足时保留 Core 错误，不伪装成预览', async () => {
  const core = createBankingCore();
  let prepares = 0;
  const wrapped = { ...core, prepare: async input => { prepares++; return core.prepare(input); } };
  const firstBody = await json(await handleBankingAgent(request({ message: '给张三转500元' }), { env, core: wrapped, parseIntent, now: () => 4500 }));
  const secondBody = await json(await handleBankingAgent(request({ continuationToken: firstBody.data.continuationToken, choice: { optionId: firstBody.data.choices[1].optionId } }), { env, core: wrapped, parseIntent, now: () => 4500 }));
  assert.equal(secondBody.code, 'INSUFFICIENT_BALANCE');
  assert.equal(secondBody.data.status, 'core_error');
  assert.equal(secondBody.data.error.code, 'INSUFFICIENT_BALANCE');
  assert.equal(prepares, 1);
});

test('改口换任务、伪造选项和无法理解回答都不会进入 Core', async () => {
  const core = createBankingCore();
  let prepares = 0;
  const wrapped = { ...core, prepare: async input => { prepares++; return core.prepare(input); } };
  const draft = await json(await handleBankingAgent(request({ message: '给张三转500元' }), { env, core: wrapped, parseIntent, now: () => 5000 }));
  const changed = await json(await handleBankingAgent(request({ continuationToken: draft.data.continuationToken, message: '查8月账单' }), { env, core: wrapped, parseIntent, now: () => 5000 }));
  assert.equal(changed.data.status, 'bill_result');
  const amountDraft = await json(await handleBankingAgent(request({ message: '缺金额' }), { env, core: wrapped, parseIntent, now: () => 5000 }));
  const unclear = await json(await handleBankingAgent(request({ continuationToken: amountDraft.data.continuationToken, message: '随便吧' }), { env, core: wrapped, parseIntent, now: () => 5000 }));
  assert.equal(unclear.data.kind, 'clarification');
  const forged = await handleBankingAgent(request({ continuationToken: `${amountDraft.data.continuationToken}x`, message: '500元' }), { env, core: wrapped, parseIntent, now: () => 5000 });
  assert.equal(forged.status, 400);
  assert.equal(prepares, 0);
  const expired = await handleBankingAgent(request({ continuationToken: amountDraft.data.continuationToken, message: '500元' }), { env, core: wrapped, parseIntent, now: () => 400000 });
  assert.equal(expired.status, 400);
  assert.equal(prepares, 0);
  const invalidChoice = await handleBankingAgent(request({ continuationToken: draft.data.continuationToken, choice: { optionId: 'opt_fake' } }), { env, core: wrapped, parseIntent, now: () => 5000 });
  assert.equal(invalidChoice.status, 400);
  assert.equal(prepares, 0);
});

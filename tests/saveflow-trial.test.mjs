import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createFinancialContext } from '../src/banking-core/repository.mjs';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { handleBankingAgent } from '../server/banking-agent.mjs';
import { buildParsedIntent } from '../src/agent/clarification/merge-intent.mjs';
import seed from '../src/data/saveflow_mock_data.json' with { type: 'json' };
import { startTrialMcpServer } from '../server/mcp/saveflow-trial.mjs';

async function withClient(repository, verify, options = {}) {
  const server = startTrialMcpServer({ host: '127.0.0.1', port: 0, repository, ...options });
  const client = new Client({ name: 'saveflow-trial-test', version: '0.1.0' });
  try {
    await once(server, 'listening');
    const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
    await client.connect(new StreamableHTTPClientTransport(url));
    await verify(client, url);
  } finally {
    await client.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

const call = (client, args) => client.callTool({ name: 'bill_summary', ...(args === undefined ? {} : { arguments: args }) });
const callTool = async (client, name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent ?? { ok: false, error: { code: 'SCHEMA_ERROR', message: result.content[0].text } };
};
const env = { SAVEFLOW_ACCESS_CODE: 'trial-test-access-1234', CONTINUATION_TOKEN_SECRET: 'trial-test-continuation-secret' };

async function withCoreClient(verify, { source = seed, now = () => 1000 } = {}) {
  const core = createBankingCore({ source, now });
  const calls = { prepare: 0, decide: 0, execute: 0 };
  const wrapped = {
    ...core,
    prepare: async request => { calls.prepare++; return core.prepare(request); },
    decide: () => { calls.decide++; throw new Error('MCP must never decide'); },
    execute: () => { calls.execute++; throw new Error('MCP must never execute'); },
  };
  await withClient(core.repository, client => verify(client, core, calls), { core: wrapped, env, now });
  assert.equal(calls.decide, 0);
  assert.equal(calls.execute, 0);
}

test('HTTP MCP handshake exposes the trial tools and returns seed statistics and evidence', async () => {
  await withClient(undefined, async client => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['bill_summary', 'card_get', 'transfer_preview', 'card_budget_preview', 'card_freeze_preview', 'card_unfreeze_preview', 'subscription_list', 'product_list']);
    for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(tools[0].inputSchema.properties), ['month']);
    assert.equal(tools[0].inputSchema.additionalProperties, false);
    const result = await call(client, { month: '2026-08' });
    assert.ok(!result.isError);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.equal(result.structuredContent.ok, true);
    assert.equal(result.structuredContent.data.month, '2026-08');
    assert.equal(result.structuredContent.data.totalIncomeFen, 1200000);
    assert.equal(result.structuredContent.data.totalExpenseFen, 846000);
    assert.equal(result.structuredContent.data.transactionCount, 12);
    assert.equal(result.structuredContent.data.categoryTotals['餐饮'], 145000);
    assert.equal(result.structuredContent.amountUnit, 'fen');
    assert.equal(result.structuredContent.evidence[0].source, 'synthetic_demo_only');
    assert.equal(result.structuredContent.evidence[0].asOf, '2026-09-01T00:00:00+08:00');
    assert.equal(result.structuredContent.evidence[0].entityIds.length, 12);
  });
});

test('missing, invalid months and user IDs never enter the repository', async () => {
  let reads = 0;
  const repository = {
    getTransactions() { reads++; throw new Error('invalid input reached bill calculation'); },
    getContextInfo() { reads++; throw new Error('invalid input reached context'); },
  };
  await withClient(repository, async client => {
    for (const args of [undefined, {}]) {
      const result = await call(client, args);
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, 'MISSING_MONTH');
      assert.deepEqual(result.structuredContent.missingSlots, ['month']);
    }
    for (const month of ['', '2026-00', '2026-13', '2026-8', '2026-08-01', ' 2026-08', '0000-01', '２０２６-08']) {
      const result = await call(client, { month });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, 'INVALID_MONTH');
    }
    for (const args of [{ month: null }, { month: 202608 }, { month: '2026-08', userId: 'OTHER' }, { month: '2026-08', user_id: 'OTHER' }]) {
      const result = await call(client, args);
      assert.equal(result.isError, true);
    }
    assert.equal(reads, 0);
  });
});

test('month filtering returns different months and an honest empty result', async () => {
  await withClient(undefined, async client => {
    const july = (await call(client, { month: '2026-07' })).structuredContent;
    assert.equal(july.ok, true);
    assert.ok(july.evidence[0].entityIds.every(id => id.startsWith('TXN-202607')));
    assert.notEqual(july.data.totalExpenseFen, 846000);
    const empty = (await call(client, { month: '2026-10' })).structuredContent;
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.data, { month: '2026-10', totalIncomeFen: 0, totalExpenseFen: 0, transactionCount: 0, categoryTotals: {} });
    assert.deepEqual(empty.evidence[0].entityIds, []);
  });
});

test('repository failures are MCP tool errors instead of fabricated summaries', async () => {
  const seedRepository = createFinancialContext().repository;
  for (const method of ['getTransactions', 'getContextInfo']) {
    const repository = { ...seedRepository, [method]: async () => { throw new Error(`${method} unavailable`); } };
    await withClient(repository, async client => {
      const result = await call(client, { month: '2026-08' });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.ok, false);
      assert.equal(result.structuredContent.error.code, 'BILL_SUMMARY_FAILED');
      assert.equal(result.structuredContent.error.message, `${method} unavailable`);
      assert.equal(result.structuredContent.data, undefined);
    });
  }
});

test('other tool names are unavailable', async () => {
  await withClient(undefined, async client => {
    for (const name of ['transfer', 'card', 'action.decide', 'action.execute']) {
      const result = await client.callTool({ name, arguments: {} });
      assert.equal(result.isError, true);
    }
  });
});

test('card_get resolves real card names and clarifies missing, unknown and duplicate names without preparing', async () => {
  await withCoreClient(async (client, core, calls) => {
    const before = core.repository.getCards();
    const exact = await callTool(client, 'card_get', { card_ref: ' 娱乐虚拟卡 ' });
    assert.equal(exact.ok, true);
    assert.deepEqual(exact.data.card, core.repository.getCard('CARD-ENT'));
    assert.equal(exact.evidence[0].source, 'synthetic_demo_only');
    for (const args of [{}, { card_ref: '我的卡' }, { card_ref: '不存在的卡' }]) {
      const clarification = await callTool(client, 'card_get', args);
      assert.equal(clarification.kind, 'needs_clarification');
      assert.equal(clarification.choices.length, 2);
      assert.ok(clarification.choices.every(choice => Object.keys(choice).sort().join() === 'label,optionId'));
      const selected = await callTool(client, 'card_get', { continuationToken: clarification.continuationToken, choice: { optionId: clarification.choices[1].optionId } });
      assert.equal(selected.data.card.id, 'CARD-ENT');
    }
    assert.equal(calls.prepare, 0);
    assert.deepEqual(core.repository.getCards(), before);
  });
  const source = structuredClone(seed);
  source.cards[1].name = source.cards[0].name;
  await withCoreClient(async client => {
    const clarification = await callTool(client, 'card_get', { card_ref: source.cards[0].name });
    assert.equal(clarification.choices.length, 2);
    const selected = await callTool(client, 'card_get', { continuationToken: clarification.continuationToken, message: '第二个' });
    assert.equal(selected.data.card.id, 'CARD-ENT');
  }, { source });
});

test('transfer_preview shares account choices, amount supplementation, payee disambiguation and edits', async () => {
  await withCoreClient(async (client, core, calls) => {
    const accounts = core.repository.getAccounts();
    const transactions = core.repository.getTransactions();
    const draft = await callTool(client, 'transfer_preview', { payee_ref: '王先生' });
    assert.equal(draft.slot, 'source_account_ref');
    assert.equal(draft.choices.length, 2);
    assert.equal(calls.prepare, 0);
    const amountDraft = await callTool(client, 'transfer_preview', { continuationToken: draft.continuationToken, choice: { optionId: draft.choices[0].optionId } });
    assert.equal(amountDraft.slot, 'amount');
    const payees = await callTool(client, 'transfer_preview', { continuationToken: amountDraft.continuationToken, message: '500元' });
    assert.equal(payees.slot, 'payee_ref');
    assert.equal(payees.choices.length, 2);
    assert.match(payees.choices[1].label, /1004/);
    assert.equal(calls.prepare, 0);
    const preview = await callTool(client, 'transfer_preview', { continuationToken: payees.continuationToken, choice: { optionId: payees.choices[1].optionId } });
    assert.equal(preview.status, 'awaiting_confirmation');
    assert.equal(preview.previewOnly, true);
    assert.equal(preview.preview.exactEffects[0].payeeId, 'payee_004');
    assert.equal(preview.preview.exactEffects[0].amountFen, 50000);
    const edited = await callTool(client, 'transfer_preview', { continuationToken: preview.continuationToken, message: '改成600元' });
    assert.equal(edited.preview.exactEffects[0].amountFen, 60000);
    const changed = await callTool(client, 'transfer_preview', { continuationToken: edited.continuationToken, message: '收款人改成李四' });
    assert.equal(changed.preview.exactEffects[0].payeeId, 'payee_002');
    assert.equal(calls.prepare, 3);
    assert.deepEqual(core.repository.getAccounts(), accounts);
    assert.deepEqual(core.repository.getTransactions(), transactions);
    assert.ok(core.getAuditEvents().every(event => !['confirmed', 'executing', 'succeeded'].includes(event.state)));
  });
});

test('forged, expired and cross-tool continuation tokens and injected IDs cannot prepare', async () => {
  let time = 1000;
  await withCoreClient(async (client, core, calls) => {
    const card = await callTool(client, 'card_get', {});
    const transfer = await callTool(client, 'transfer_preview', { payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' } });
    for (const [name, args, code] of [
      ['card_get', { continuationToken: card.continuationToken + 'x', message: '第一个' }, 'CONTINUATION_INVALID'],
      ['card_get', { continuationToken: card.continuationToken, choice: { optionId: 'opt_forged' } }, 'INVALID_CHOICE'],
      ['transfer_preview', { continuationToken: card.continuationToken, message: '500元' }, 'CONTINUATION_ACTION_MISMATCH'],
      ['transfer_preview', { continuationToken: transfer.continuationToken, choice: { optionId: transfer.choices[0].optionId }, amount: { amount_minor: 1, currency: 'CNY' } }, 'INVALID_REQUEST'],
      ['transfer_preview', { continuationToken: transfer.continuationToken, message: '查账单' }, 'CONTINUATION_ACTION_MISMATCH'],
      ['card_get', { card_ref: 'CARD-ENT' }, 'VALIDATION_ERROR'],
      ['transfer_preview', { source_account_ref: 'ACC-CHECKING' }, 'VALIDATION_ERROR'],
      ['transfer_preview', { payee_ref: 'payee_001' }, 'VALIDATION_ERROR'],
    ]) {
      const result = await callTool(client, name, args);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, code);
    }
    for (const args of [{ card_ref: '娱乐虚拟卡', userId: 'OTHER' }, { card_ref: '娱乐虚拟卡', confirmed: true }, { card_ref: '娱乐虚拟卡', action: 'action.execute' }, { continuationToken: card.continuationToken, choice: { optionId: card.choices[0].optionId, entityId: 'CARD-ENT' } }]) {
      assert.equal((await callTool(client, 'card_get', args)).ok, false);
    }
    time = 400000;
    const expired = await callTool(client, 'transfer_preview', { continuationToken: transfer.continuationToken, message: '第一个' });
    assert.equal(expired.error.code, 'CONTINUATION_INVALID');
    assert.equal(calls.prepare, 0);
    assert.equal(core.getAuditEvents().length, 0);
  }, { now: () => time });
});

test('invalid transfer amounts never prepare; valid insufficient-balance requests preserve Core errors', async () => {
  await withCoreClient(async (client, core, calls) => {
    const slots = { source_account_ref: '活期账户', payee_ref: '张三' };
    for (const amount of [{ amount_minor: 0, currency: 'CNY' }, { amount_minor: -1, currency: 'CNY' }, { amount_minor: 1.1, currency: 'CNY' }, { amount_minor: 1, currency: 'USD' }]) {
      assert.equal((await callTool(client, 'transfer_preview', { ...slots, amount })).ok, false);
    }
    const draft = await callTool(client, 'transfer_preview', slots);
    for (const message of ['0元', '-1元', '1.001元']) {
      assert.equal((await callTool(client, 'transfer_preview', { continuationToken: draft.continuationToken, message })).kind, 'needs_clarification');
    }
    assert.equal(calls.prepare, 0);
    const failure = await callTool(client, 'transfer_preview', { ...slots, amount: { amount_minor: 500001, currency: 'CNY' } });
    assert.equal(failure.ok, false);
    assert.equal(failure.error.code, 'INSUFFICIENT_BALANCE');
    assert.equal(calls.prepare, 1);
    assert.equal(core.repository.getAccount('ACC-CHECKING').balanceFen, 500000);
  });
});

test('HTTP and MCP can resume the same shared clarification rules in both directions', async () => {
  await withCoreClient(async (client, core) => {
    let requestNumber = 0;
    const sendHttp = async body => {
      const response = await handleBankingAgent(new Request('http://localhost/api/banking-agent', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'x-forwarded-for': `mcp-parity-${++requestNumber}` },
        body: JSON.stringify(body),
      }), { env, core, now: () => 1000, parseIntent: async () => buildParsedIntent('transfer.create', { payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' } }) });
      assert.equal(response.status, 200);
      return (await response.json()).data;
    };
    const httpDraft = await sendHttp({ message: '给张三转500元' });
    const mcpPreview = await callTool(client, 'transfer_preview', { continuationToken: httpDraft.continuationToken, choice: { optionId: httpDraft.choices[0].optionId } });
    assert.equal(mcpPreview.preview.exactEffects[0].amountFen, 50000);
    const httpEdited = await sendHttp({ continuationToken: mcpPreview.continuationToken, message: '改成600元' });
    assert.equal(httpEdited.preview.exactEffects[0].amountFen, 60000);
  });
});

test('card budget and freeze tools create Core previews without changing financial or card state', async () => {
  await withCoreClient(async (client, core, calls) => {
    const financialCards = () => core.repository.getCards().map(({ previewGeneration, ...card }) => { void previewGeneration; return card; });
    const cards = financialCards();
    const accounts = core.repository.getAccounts();
    const transactions = core.repository.getTransactions();
    const draft = await callTool(client, 'card_budget_preview', {});
    assert.equal(draft.slot, 'card_ref');
    const amountDraft = await callTool(client, 'card_budget_preview', { continuationToken: draft.continuationToken, choice: { optionId: draft.choices[1].optionId } });
    assert.equal(amountDraft.slot, 'amount');
    const budget = await callTool(client, 'card_budget_preview', { continuationToken: amountDraft.continuationToken, message: '100元' });
    assert.equal(budget.previewOnly, true);
    assert.equal(budget.status, 'awaiting_confirmation');
    assert.equal(budget.action, 'card.set_budget');
    assert.equal(budget.preview.exactEffects[0].after.monthlyBudgetFen, 10000);
    assert.ok(budget.preview.warnings.some(warning => warning.includes('超预算')));
    const zero = await callTool(client, 'card_budget_preview', { continuationToken: budget.continuationToken, message: '改成0元' });
    assert.equal(zero.preview.exactEffects[0].after.monthlyBudgetFen, 0);
    const freeze = await callTool(client, 'card_freeze_preview', { card_ref: '娱乐虚拟卡' });
    assert.equal(freeze.preview.exactEffects[0].after.status, 'frozen');
    assert.equal(freeze.previewOnly, true);
    const reselect = await callTool(client, 'card_freeze_preview', { continuationToken: freeze.continuationToken, message: '换卡' });
    const other = await callTool(client, 'card_freeze_preview', { continuationToken: reselect.continuationToken, choice: { optionId: reselect.choices[0].optionId } });
    assert.equal(other.preview.exactEffects[0].cardId, 'CARD-MAIN');
    assert.equal((await callTool(client, 'card_unfreeze_preview', { card_ref: '娱乐虚拟卡' })).error.code, 'INVALID_STATE');
    assert.deepEqual(financialCards(), cards);
    assert.deepEqual(core.repository.getAccounts(), accounts);
    assert.deepEqual(core.repository.getTransactions(), transactions);
    assert.equal(calls.prepare, 4);
    assert.ok(core.getAuditEvents().every(event => !['confirmed', 'executing', 'succeeded'].includes(event.state)));
    assert.ok(core.repository.getCard('CARD-ENT').previewGeneration > 0);
  });
});

test('unfreeze preview uses the existing frozen-card rules without unfreezing it', async () => {
  const source = structuredClone(seed);
  source.cards[1].status = 'frozen';
  await withCoreClient(async (client, core, calls) => {
    const result = await callTool(client, 'card_unfreeze_preview', { card_ref: '娱乐虚拟卡' });
    assert.equal(result.previewOnly, true);
    assert.equal(result.preview.exactEffects[0].before.status, 'frozen');
    assert.equal(result.preview.exactEffects[0].after.status, 'active');
    assert.equal(core.repository.getCard('CARD-ENT').status, 'frozen');
    assert.equal((await callTool(client, 'card_freeze_preview', { card_ref: '娱乐虚拟卡' })).error.code, 'INVALID_STATE');
    assert.equal(calls.prepare, 1);
  }, { source });
});

test('budget validation, wrong-action tokens and injected approval fields never prepare', async () => {
  await withCoreClient(async (client, core, calls) => {
    for (const amount of [{ amount_minor: -1, currency: 'CNY' }, { amount_minor: 10000001, currency: 'CNY' }, { amount_minor: 1.5, currency: 'CNY' }, { amount_minor: 1, currency: 'USD' }]) {
      assert.equal((await callTool(client, 'card_budget_preview', { card_ref: '娱乐虚拟卡', amount })).ok, false);
    }
    const draft = await callTool(client, 'card_budget_preview', {});
    const mismatch = await callTool(client, 'card_freeze_preview', { continuationToken: draft.continuationToken, message: '第一个' });
    assert.equal(mismatch.error.code, 'CONTINUATION_ACTION_MISMATCH');
    for (const name of ['card_budget_preview', 'card_freeze_preview', 'card_unfreeze_preview', 'transfer_preview']) {
      for (const field of ['userId', 'confirmed', 'consent', 'operationId', 'previewHash', 'decision', 'action', 'riskLevel']) {
        assert.equal((await callTool(client, name, { [field]: 'injected' })).ok, false);
      }
    }
    assert.equal(calls.prepare, 0);
    assert.equal(core.getAuditEvents().length, 0);
  });
});

test('subscription and product tools return repository data and evidence with no mutations', async () => {
  await withCoreClient(async (client, core, calls) => {
    const cards = core.repository.getCards();
    const accounts = core.repository.getAccounts();
    const transactions = core.repository.getTransactions();
    for (const [name, expected] of [['subscription_list', core.repository.getSubscriptions()], ['product_list', core.repository.getInvestmentProducts()]]) {
      const result = await callTool(client, name);
      assert.equal(result.ok, true);
      assert.deepEqual(result.data, expected);
      assert.deepEqual(result.evidence[0].entityIds, expected.map(item => item.id));
      assert.equal(result.evidence[0].source, 'synthetic_demo_only');
      assert.equal(result.context.asOf, '2026-09-01T00:00:00+08:00');
      assert.equal((await callTool(client, name, { userId: 'OTHER' })).ok, false);
    }
    assert.equal(calls.prepare, 0);
    assert.equal(core.getAuditEvents().length, 0);
    assert.deepEqual(core.repository.getCards(), cards);
    assert.deepEqual(core.repository.getAccounts(), accounts);
    assert.deepEqual(core.repository.getTransactions(), transactions);
  });
});

test('readonly query failures and missing continuation configuration return tool errors', async () => {
  const repository = { ...createFinancialContext().repository, getSubscriptions: () => { throw new Error('offline'); }, getInvestmentProducts: () => { throw new Error('offline'); } };
  await withClient(repository, async client => {
    for (const name of ['subscription_list', 'product_list']) {
      const result = await callTool(client, name);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'INTERNAL_ERROR');
    }
    const missing = await callTool(client, 'card_get', {});
    assert.equal(missing.error.code, 'CONTINUATION_CONFIG_ERROR');
  }, { env: {} });
});

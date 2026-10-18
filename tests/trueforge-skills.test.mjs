import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTrialMcpServer } from '../server/mcp/saveflow-trial.mjs';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { createTrueforgeSkillAdapter, routeTrueforgeSkill, validateSkillResult } from '../server/trueforge-skill-adapter.mjs';
import { trialAgentSpec, createTrueforgeClient } from '../server/trueforge-client.mjs';
import { handleBankingAgent } from '../server/banking-agent.mjs';
import { handleBanking } from '../server/banking.mjs';
import { createTokenBridge } from '../server/mcp/trueforge-token-bridge.mjs';
import seed from '../src/data/saveflow_mock_data.json' with { type: 'json' };

const env = { SAVEFLOW_ACCESS_CODE: 'multi-test-access-code', CONTINUATION_TOKEN_SECRET: 'multi-test-token-secret',
  TRUEFORGE_BASE_URL: 'http://localhost:8790', TRUEFORGE_MODEL: 'test/deepseek-v4-1-flash', TRUEFORGE_MCP_SERVER: 'sv-trial', SAVEFLOW_TRUEFORGE_READ_ENABLED: 'true' };
const body = message => ({ message, consent: true, history: [] });
function event(tool, args, result, isError = false) {
  return { turnId: 'turn-test', calls: [{ id: 'call-test', threadId: 'main', function: { name: tool, arguments: JSON.stringify(args) }, toolInfo: { type: 'mcp', name: tool, serverId: 'sv-trial', serverName: 'sv-trial' } }],
    responses: [{ type: 'tool.response', toolCallId: 'call-test', threadId: 'main', content: JSON.stringify(isError ? { error: [{ type: 'text', text: JSON.stringify(result) }] } : result) }] };
}
// Real MCP + adapter protocol integration with a simulated TrueForge transport; not Agent E2E.
async function withMcp(verify, options = {}) {
  const core = createBankingCore(options.source ? { source: options.source } : {}); let prepares = 0;
  const restricted = { ...core, prepare: async input => { prepares++; return core.prepare(input); }, decide: () => assert.fail('never decide'), execute: () => assert.fail('never execute') };
  const server = startTrialMcpServer({ host: '127.0.0.1', port: 0, core: restricted, ...options });
  const mcp = new Client({ name: 'multiskill-test', version: '1' }); const seen = [];
  try {
    await once(server, 'listening'); await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
    const factory = tool => ({ createSession: async () => { seen.push({ create: tool }); return 'private-session'; }, cancel: async () => {}, runTurn: async (id, msg) => {
      const { toolArguments: args } = JSON.parse(msg); seen.push({ tool, args, id });
      const r = await mcp.callTool({ name: tool, arguments: args });
      return event(tool, args, r.structuredContent ?? { ok: false, error: { code: 'SCHEMA_ERROR' } }, r.isError);
    } });
    await verify({ core, mcp, seen, factory, prepares: () => prepares });
  } finally { await mcp.close(); await new Promise(r => { server.close(r); server.closeAllConnections(); }); }
}

test('A: three distinct business schemas map real MCP values without preparing Core', async () => {
  await withMcp(async ({ factory, prepares }) => {
    const a = createTrueforgeSkillAdapter({ env, clientFactory: factory });
    const c = await a.handle(body('查看娱乐虚拟卡'), { scope: 'a' }); assert.equal(c.data.data.card.id, 'CARD-ENT'); assert.equal(c.data.data.card.monthlyBudgetFen, 80000);
    const s = await a.handle(body('查询订阅'), { scope: 'a' }); assert.equal(s.data.status, 'subscription_result'); assert.equal(s.data.data.subscriptions.length, 2); assert.equal(s.data.data.subscriptions[0].monthlyFeeFen, 3000);
    const p = await a.handle(body('查询理财产品'), { scope: 'a' }); assert.equal(p.data.data.products.length, 3); assert.equal(p.data.data.products[0].expectedYield, 150);
    assert.equal(prepares(), 0);
  });
});
test('A: unknown cards clarify instead of inventing data; choice stays in one session and duplicates share one turn', async () => {
  await withMcp(async ({ factory, seen }) => {
    const a = createTrueforgeSkillAdapter({ env, clientFactory: factory });
    const first = await a.handle(body('查看不存在卡'), { scope: 'a' }); assert.equal(first.code, 'NEEDS_CLARIFICATION'); assert.equal(first.data.data, undefined);
    assert.equal(first.data.choices.length, 2); const token = first.data.continuationToken; assert.ok(token.startsWith('tfm1.'));
    const choice = first.data.choices[1]; const b = { continuationToken: token, choice: { optionId: choice.optionId } };
    const [x, y] = await Promise.all([a.handle(b, { scope: 'a' }), a.handle(b, { scope: 'a' })]);
    assert.equal(x.data.data.card.id, 'CARD-ENT'); assert.deepEqual(x, y); assert.equal(seen.filter(v => v.create).length, 1);
    assert.equal(seen.filter(v => v.args?.choice).length, 1); assert.notEqual(seen[2].args.continuationToken, token);
    assert.equal((await a.handle({ ...body('查询理财产品'), continuationToken: token }, { scope: 'a' })).code, 'CONTINUATION_ACTION_MISMATCH');
  });
});
test('A: signed, scoped, expired and cross-session choices reject before tools run', async () => {
  await withMcp(async ({ factory, seen }) => {
    let clock = 0; const a = createTrueforgeSkillAdapter({ env, clientFactory: factory, now: () => clock });
    const first = await a.handle(body('查看我的卡'), { scope: 'a' });
    const b = { continuationToken: first.data.continuationToken, choice: { optionId: first.data.choices[0].optionId } };
    assert.equal((await a.handle(b, { scope: 'b' })).code, 'CONTINUATION_INVALID');
    assert.equal((await a.handle({ ...b, continuationToken: b.continuationToken + 'x' }, { scope: 'a' })).code, 'CONTINUATION_INVALID');
    assert.equal((await a.handle({ ...b, choice: { optionId: 'foreign' } }, { scope: 'a' })).code, 'INVALID_CHOICE');
    clock = 300000; assert.equal((await a.handle(b, { scope: 'a' })).code, 'CONTINUATION_INVALID'); assert.equal(seen.filter(v => v.args).length, 1);
  });
});
test('A: linked-event validation rejects wrong tool, action, source, IDs and malformed financial fields', async () => {
  await withMcp(async ({ mcp }) => {
    const r = (await mcp.callTool({ name: 'subscription_list', arguments: {} })).structuredContent;
    const t = event('subscription_list', {}, r);
    for (const mutate of [v => v.calls[0].toolInfo.name = 'product_list', v => v.responses[0].toolCallId = 'other', v => v.calls.push(v.calls[0]), v => v.calls[0].function.arguments = '{"userId":"other"}']) {
      const v = structuredClone(t); mutate(v); assert.throws(() => validateSkillResult(v, { tool: 'subscription_list', serverName: 'sv-trial', expectedArgs: {} }), { code: 'TRUEFORGE_FORMAT_ERROR' });
    }
    for (const mutate of [v => v.kind = 'product_result', v => v.data[0].monthlyFeeFen = 1.2, v => v.evidence[0].source = 'bank', v => v.evidence[0].entityIds = []]) {
      const v = structuredClone(r); mutate(v); assert.throws(() => validateSkillResult(event('subscription_list', {}, v), { tool: 'subscription_list', serverName: 'sv-trial', expectedArgs: {} }), { code: 'TRUEFORGE_FORMAT_ERROR' });
    }
  });
});
test('A: real MCP query failures return explicit errors without success cards', async () => {
  await withMcp(async ({ factory }) => {
    const a = createTrueforgeSkillAdapter({ env, clientFactory: factory }); const r = await a.handle(body('查询订阅'), { scope: 'a' });
    assert.equal(r.code, 'TRIAL_TOOL_FAILED'); assert.equal(r.data.status, 'error'); assert.equal(r.data.data, undefined);
  }, { repository: { getSubscriptions: () => { throw new Error('private upstream credential'); } } });
});
test('A: allowlist, feature switches and ambiguous routing preserve non-pilot Harness', async () => {
  for (const tool of ['card_get', 'subscription_list', 'product_list']) assert.deepEqual(trialAgentSpec(env, tool).mcpServers[0].enableTools, [tool]);
  assert.throws(() => trialAgentSpec(env, 'action.execute'));
  for (const msg of ['冻结我的卡', '给张三转500元', '查账单', '查询订阅并取消', '产品申购', '查看我的卡然后转账', '聊聊理财']) assert.equal(routeTrueforgeSkill(msg, env), undefined);
  assert.equal(routeTrueforgeSkill('查询订阅', { ...env, SAVEFLOW_TRUEFORGE_READ_ENABLED: 'false' }), undefined);
  const request = new Request('http://localhost/api/banking-agent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'x-forwarded-for': 'multi-disabled' }, body: JSON.stringify(body('查看娱乐虚拟卡')) });
  const r = await handleBankingAgent(request, { env: { ...env, SAVEFLOW_TRUEFORGE_READ_ENABLED: 'false' }, core: createBankingCore(), trueforgeSkillAdapter: { handle: () => assert.fail('off') }, parseIntent: async () => ({ schemaVersion: '1.0.0', action: 'card.get', slots: { card_ref: '娱乐虚拟卡' }, missingSlots: [], status: 'ready_for_resolution' }) });
  assert.equal((await r.json()).data.data.card.id, 'CARD-ENT');
});

const transferEnv = { ...env, SAVEFLOW_TRUEFORGE_TRANSFER_ENABLED: 'true' };
test('bridge keeps Core failure as failure while binding its recovery alias to transfer only', async () => {
  const recovery = { ok: false, kind: 'core_error', action: 'transfer.create', error: { code: 'INSUFFICIENT_BALANCE' }, continuationToken: 'private-signed-core-state',
    recovery: { action: 'transfer.create', status: 'needs_clarification', slot: 'source_account_ref' } };
  const forwarded = [];
  const bridge = createTokenBridge({ upstream: { callTool: async call => { forwarded.push(call); return { isError: true, structuredContent: recovery }; } } });
  const r = await bridge.call('transfer_preview', {}); assert.equal(r.isError, true); assert.equal(r.structuredContent.ok, false);
  const alias = r.structuredContent.continuationToken; assert.match(alias, /^tfg1_[a-f0-9]{32}$/);
  assert.equal((await bridge.call('card_get', { continuationToken: alias })).structuredContent.error.code, 'CONTINUATION_INVALID');
  await bridge.call('transfer_preview', { continuationToken: alias, message: '改成400元' });
  assert.equal(forwarded.at(-1).arguments.continuationToken, recovery.continuationToken);
  const bad = createTokenBridge({ upstream: { callTool: async () => ({ isError: true, structuredContent: { ...recovery, action: 'card.freeze' } }) } });
  assert.equal((await bad.call('transfer_preview', {})).structuredContent.error.code, 'BRIDGE_FORMAT_ERROR');
});
test('insufficient-balance recovery preserves selected payee, exposes real balances and permits a new payer without execution', async () => {
  await withMcp(async ({ factory, core, prepares, seen }) => {
    const before = structuredClone(core.repository.getAccounts());
    const a = createTrueforgeSkillAdapter({ env: transferEnv, clientFactory: factory });
    let r = await a.handle(body('给王先生转500元'), { scope: 'balance' });
    assert.match(r.data.choices[0].label, /5000\.00/); assert.match(r.data.choices[1].label, /0\.00/);
    r = await a.handle({ continuationToken: r.data.continuationToken, choice: { optionId: r.data.choices[1].optionId } }, { scope: 'balance' });
    r = await a.handle({ continuationToken: r.data.continuationToken, choice: { optionId: r.data.choices[0].optionId } }, { scope: 'balance' });
    assert.equal(r.httpStatus, 400); assert.equal(r.code, 'INSUFFICIENT_BALANCE'); assert.equal(r.data.status, 'error'); assert.equal(r.data.preview, undefined);
    const c = r.data.recovery; assert.match(c.question, /模拟储蓄账户.*¥0\.00.*¥500\.00/); assert.equal(c.slot, 'source_account_ref');
    assert.ok(c.continuationToken.startsWith('tfm1.')); assert.equal(c.operationId, undefined);
    assert.equal((await a.handle({ continuationToken: c.continuationToken, choice: { optionId: c.choices[0].optionId } }, { scope: 'other' })).code, 'CONTINUATION_INVALID');
    const recovered = await a.handle({ continuationToken: c.continuationToken, choice: { optionId: c.choices[0].optionId } }, { scope: 'balance' });
    const effect = recovered.data.preview.exactEffects[0];
    assert.equal(effect.fromAccountId, 'ACC-CHECKING'); assert.equal(effect.payeeId, 'payee_003'); assert.equal(effect.amountFen, 50000);
    assert.equal(prepares(), 2); assert.equal(seen.filter(v => v.create).length, 1); assert.deepEqual(core.repository.getAccounts(), before);
  });
});
test('amount correction after failed prepare retains the signed payee choice and never reconstructs it from a label', async () => {
  await withMcp(async ({ factory, seen }) => {
    const a = createTrueforgeSkillAdapter({ env: transferEnv, clientFactory: factory });
    let r = await a.handle(body('从模拟活期账户给王先生转6000元'), { scope: 'amount-recovery' });
    r = await a.handle({ continuationToken: r.data.continuationToken, choice: { optionId: r.data.choices[0].optionId } }, { scope: 'amount-recovery' });
    assert.equal(r.code, 'INSUFFICIENT_BALANCE'); const token = r.data.recovery.continuationToken;
    const recovered = await a.handle({ ...body('改成400元'), continuationToken: token }, { scope: 'amount-recovery' });
    assert.equal(recovered.data.preview.exactEffects[0].payeeId, 'payee_003'); assert.equal(recovered.data.preview.exactEffects[0].amountFen, 40000);
    assert.deepEqual(Object.keys(seen.at(-1).args).sort(), ['continuationToken', 'message']);
  });
});
test('cross-skill: new card task has its own session; explicit transfer resume preserves entities and rejects injected cross-task tokens', async () => {
  await withMcp(async ({ factory, seen, prepares }) => {
    const a = createTrueforgeSkillAdapter({ env: transferEnv, clientFactory: factory });
    const transfer = await a.handle(body('从模拟活期账户转账500元给房东王先生'), { scope: 'switch' });
    const token = transfer.data.continuationToken;
    const before = seen.length;
    for (const message of ['查看我的卡', '查询8月账单']) assert.equal((await a.handle({ ...body(message), continuationToken: token }, { scope: 'switch' })).code, 'CONTINUATION_ACTION_MISMATCH');
    assert.equal(seen.length, before); // Reject before any TrueForge turn/MCP call.
    const card = await a.handle(body('查看我的卡'), { scope: 'switch' }); assert.equal(card.data.slot, 'card_ref');
    const resolved = await a.handle({ continuationToken: card.data.continuationToken, choice: { optionId: card.data.choices[0].optionId } }, { scope: 'switch' });
    assert.equal(resolved.data.status, 'card_result');
    const edited = await a.handle({ ...body('改成300元'), continuationToken: token }, { scope: 'switch' });
    assert.equal(edited.data.preview.exactEffects[0].amountFen, 30000); assert.equal(edited.data.preview.exactEffects[0].payeeId, 'payee_003');
    assert.equal(edited.data.preview.exactEffects[0].fromAccountId, 'ACC-CHECKING');
    assert.equal(seen.filter(v => v.create).length, 2); assert.equal(prepares(), 2);
    assert.equal((await a.handle({ ...body('取消'), continuationToken: edited.data.continuationToken }, { scope: 'switch' })).data.status, 'cancelled');
    assert.equal((await a.handle(body('从模拟活期账户转账200元给房东王先生'), { scope: 'switch' })).data.preview.exactEffects[0].amountFen, 20000);
    assert.equal(seen.filter(v => v.create).length, 3);
  });
});
test('transfer regression: exact amount-first phrase and edit preserve resolved account/payee in one session', async () => {
  await withMcp(async ({ factory, core, seen, prepares }) => {
    const a = createTrueforgeSkillAdapter({ env: transferEnv, clientFactory: factory });
    const before = structuredClone(core.repository.getAccounts());
    const first = await a.handle(body('从模拟活期账户转账500元给房东王先生'), { scope: 'regression' });
    assert.equal(first.code, 'OK');
    const initial = first.data.preview.exactEffects[0];
    assert.equal(initial.fromAccountId, 'ACC-CHECKING'); assert.equal(initial.payeeId, 'payee_003'); assert.equal(initial.amountFen, 50000);
    const edited = await a.handle({ ...body('改成转账400元'), continuationToken: first.data.continuationToken }, { scope: 'regression' });
    assert.equal(edited.data.status, 'awaiting_confirmation');
    assert.deepEqual(edited.data.preview.exactEffects[0], { ...initial, amountFen: 40000, balanceAfterFen: 460000, availableBalanceAfterFen: 460000 });
    assert.notEqual(edited.data.preview.previewHash, first.data.preview.previewHash);
    assert.equal(seen.filter(v => v.create).length, 1); assert.equal(prepares(), 2);
    assert.equal(seen[2].args.message, '改成转账400元'); assert.ok(seen[2].args.continuationToken);
    assert.deepEqual(core.repository.getAccounts(), before);
    for (const message of ['改成转账-1元', '改成转账0元', '改成转账400.001元']) {
      assert.equal((await a.handle({ ...body(message), continuationToken: edited.data.continuationToken }, { scope: 'regression' })).code, 'INVALID_AMOUNT');
    }
    assert.equal(prepares(), 2);
    assert.equal((await a.handle({ ...body('确认转账'), continuationToken: edited.data.continuationToken }, { scope: 'regression' })).code, 'PREVIEW_ONLY');
    assert.equal(prepares(), 2);
    const payee = await a.handle({ ...body('收款人改成李四'), continuationToken: edited.data.continuationToken }, { scope: 'regression' });
    assert.equal(payee.data.preview.exactEffects[0].fromAccountId, initial.fromAccountId);
    assert.equal(payee.data.preview.exactEffects[0].amountFen, 40000); assert.equal(payee.data.preview.exactEffects[0].payeeId, 'payee_002');
    assert.equal((await a.handle({ ...body('改成转账300元'), continuationToken: first.data.continuationToken }, { scope: 'regression' })).code, 'CONTINUATION_STALE');
    const restarted = createTrueforgeSkillAdapter({ env: transferEnv, clientFactory: () => assert.fail('invalid session must not invoke TrueForge') });
    assert.equal((await restarted.handle({ ...body('改成转账300元'), continuationToken: payee.data.continuationToken }, { scope: 'regression' })).code, 'CONTINUATION_INVALID');
  });
});
test('transfer regression: narrow routing excludes mixed tasks and remains disabled by default', () => {
  const input = '从模拟活期账户转账500元给房东王先生';
  assert.deepEqual(routeTrueforgeSkill(input, transferEnv), { tool: 'transfer_preview', args: { source_account_ref: '模拟活期账户', payee_ref: '房东王先生', amount: { amount_minor: 50000, currency: 'CNY' } } });
  assert.equal(routeTrueforgeSkill(input, env), undefined);
  for (const msg of [input + '然后冻结我的卡', '从模拟活期账户转账500元给王先生并确认执行', '改成转账400元']) assert.equal(routeTrueforgeSkill(msg, transferEnv), undefined);
});
test('B: real Core transfer preview, edits, chat confirmation and cancellation never change ledger', async () => {
  await withMcp(async ({ factory, core, prepares, seen }) => {
    const before = core.repository.getAccounts(); const transactions = core.repository.getTransactions();
    const a = createTrueforgeSkillAdapter({ env: transferEnv, clientFactory: factory });
    const first = await a.handle(body('从活期账户给张三转500元'), { scope: 'a' });
    assert.equal(first.data.status, 'awaiting_confirmation'); assert.equal(first.data.preview.exactEffects[0].amountFen, 50000);
    assert.ok(first.data.operationId.startsWith('tfpreview:op_')); assert.equal(first.data.previewOnly, true); assert.equal(first.data.executionAllowed, false);
    const token = first.data.continuationToken;
    const denied = await a.handle({ ...body('确认'), continuationToken: token }, { scope: 'a' }); assert.equal(denied.code, 'PREVIEW_ONLY'); assert.equal(prepares(), 1);
    const edited = await a.handle({ ...body('改成600元'), continuationToken: token }, { scope: 'a' }); assert.equal(edited.data.preview.exactEffects[0].amountFen, 60000);
    assert.notEqual(first.data.preview.previewHash, edited.data.preview.previewHash);
    const latest = edited.data.continuationToken;
    const changed = await a.handle({ ...body('改给李四'), continuationToken: latest }, { scope: 'a' }); assert.equal(changed.data.preview.exactEffects[0].payeeName, '李四');
    assert.equal((await a.handle({ ...body('改成600元'), continuationToken: token }, { scope: 'a' })).code, 'CONTINUATION_STALE');
    const cancelled = await a.handle({ ...body('取消'), continuationToken: changed.data.continuationToken }, { scope: 'a' }); assert.equal(cancelled.data.status, 'cancelled');
    assert.equal((await a.handle({ ...body('改成700元'), continuationToken: changed.data.continuationToken }, { scope: 'a' })).code, 'CONTINUATION_STALE');
    assert.equal(seen.filter(v => v.create).length, 1); assert.equal(prepares(), 3);
    assert.deepEqual(core.repository.getAccounts(), before); assert.deepEqual(core.repository.getTransactions(), transactions);
  });
});
test('B: missing account, editing before preview and ambiguous payee choices preserve one Session without guessed IDs', async () => {
  await withMcp(async ({ factory, seen, prepares }) => {
    const a = createTrueforgeSkillAdapter({ env: transferEnv, clientFactory: factory });
    let r = await a.handle(body('给王先生转500元'), { scope: 'a' }); assert.equal(r.data.slot, 'source_account_ref');
    r = await a.handle({ ...body('改成600元'), continuationToken: r.data.continuationToken }, { scope: 'a' }); assert.equal(r.data.slot, 'source_account_ref');
    r = await a.handle({ continuationToken: r.data.continuationToken, choice: { optionId: r.data.choices[0].optionId } }, { scope: 'a' }); assert.equal(r.data.slot, 'payee_ref'); assert.equal(r.data.choices.length, 2);
    r = await a.handle({ continuationToken: r.data.continuationToken, choice: { optionId: r.data.choices[1].optionId } }, { scope: 'a' });
    assert.equal(r.data.preview.exactEffects[0].amountFen, 60000); assert.equal(r.data.preview.exactEffects[0].payeeName, '王强');
    assert.equal(prepares(), 1); assert.equal(seen.filter(v => v.create).length, 1);
    assert.ok(seen.filter(v => v.args).every(v => ![v.args.payee_ref, v.args.source_account_ref].some(ref => typeof ref === 'string' && /^(?:payee_|ACC-|CARD-)/.test(ref))));
  });
});
test('B: invalid amounts, insufficient balance, malformed previews and cross-tool credentials do not form cards', async () => {
  await withMcp(async ({ factory, mcp, prepares }) => {
    const a = createTrueforgeSkillAdapter({ env: transferEnv, clientFactory: factory });
    for (const value of ['0', '-1', '1.234', '五百', '99999999999999999999']) assert.equal((await a.handle(body(`给张三转${value}元`), { scope: 'a' })).code, 'INVALID_AMOUNT');
    assert.equal(prepares(), 0);
    const failed = await a.handle(body('从活期账户给张三转6000元'), { scope: 'a' }); assert.equal(failed.code, 'INSUFFICIENT_BALANCE'); assert.equal(failed.data.data, undefined);
    const initial = await a.handle(body('查看我的卡'), { scope: 'a' });
    assert.equal((await a.handle({ ...body('给张三转500元'), continuationToken: initial.data.continuationToken }, { scope: 'a' })).code, 'CONTINUATION_ACTION_MISMATCH');
    const args = { source_account_ref: '活期账户', payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' } };
    const r = (await mcp.callTool({ name: 'transfer_preview', arguments: args })).structuredContent;
    for (const mutate of [v => v.preview.previewHash = 'fake', v => v.preview.exactEffects[0].amountFen++, v => v.action = 'card.freeze', v => v.previewOnly = false, v => v.risk.allowed = false]) {
      const v = structuredClone(r); mutate(v); assert.throws(() => validateSkillResult(event('transfer_preview', args, v), { tool: 'transfer_preview', serverName: 'sv-trial', expectedArgs: args }), { code: 'TRUEFORGE_FORMAT_ERROR' });
    }
  });
});
test('B: backend rejects preview IDs for decide/execute/status even with flags off and no state Map', async () => {
  const core = { decide: () => assert.fail('no decide'), execute: () => assert.fail('no execute'), getOperation: () => assert.fail('no status') };
  for (const action of ['action.decide', 'action.execute', 'action.status']) {
    const id = 'tfpreview:op_authentic-id';
    const r = await handleBanking(new Request('http://localhost/api/banking', { method: 'POST', headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'Idempotency-Key': id },
      body: JSON.stringify({ schema_version: '1.1.0', action, input: { operation_id: id, preview_hash: 'a'.repeat(64) } }) }), { env, core });
    assert.equal(r.status, 403); assert.equal((await r.json()).code, 'FORBIDDEN');
  }
});

test('bridge: credential aliases preserve fields, bind tools/expiry, and forward duplicate resumes once', async () => {
  let calls = 0, clock = 0;
  const upstream = { async callTool({ arguments: a }) {
    calls++;
    if (a.continuationToken) assert.equal(a.continuationToken, 'original-encrypted-mcp-credential');
    const r = { ok: true, kind: 'needs_clarification', continuationToken: 'original-encrypted-mcp-credential', choices: [{ optionId: 'option1', label: '真实候选' }] };
    return { structuredContent: r, content: [{ type: 'text', text: JSON.stringify(r) }] };
  } };
  const bridge = createTokenBridge({ upstream, now: () => clock });
  const first = await bridge.call('card_get', {}); const alias = first.structuredContent.continuationToken;
  assert.match(alias, /^tfg1_[a-f0-9]{32}$/); assert.deepEqual(first.structuredContent.choices, [{ optionId: 'option1', label: '真实候选' }]);
  assert.equal((await bridge.call('transfer_preview', { continuationToken: alias })).structuredContent.error.code, 'CONTINUATION_INVALID');
  assert.equal((await bridge.call('card_get', { continuationToken: alias + 'x' })).structuredContent.error.code, 'CONTINUATION_INVALID');
  const args = { continuationToken: alias, choice: { optionId: 'option1' } };
  const [a, b] = await Promise.all([bridge.call('card_get', args), bridge.call('card_get', args)]); assert.deepEqual(a, b); assert.equal(calls, 2);
  assert.equal((await bridge.call('card_get', { ...args, choice: { optionId: 'foreign' } })).structuredContent.error.code, 'CONTINUATION_CONSUMED');
  clock = 300000; assert.equal((await bridge.call('card_get', args)).structuredContent.error.code, 'CONTINUATION_INVALID');
  assert.equal((await bridge.call('action.execute', {})).structuredContent.error.code, 'TOOL_NOT_ALLOWED');
});

test('SDK gate: exact arguments are approved once, repeated tool requests are denied before MCP', async () => {
  const recorded = [];
  const call = { id: 'call1', function: { name: 'product_list', arguments: '{}' }, toolInfo: { type: 'mcp', name: 'product_list', serverName: 'sv-trial', serverId: 'sv-trial' } };
  const second = { ...call, id: 'call2' };
  const model = (id, c) => ({ type: 'model.message', id, threadId: 'main', toolCalls: [c] });
  const pending = (id, c) => ({ type: 'turn.done', id, state: { status: 'done', requiredActions: [{ type: 'tool.approval_required', threadId: 'main', toolCalls: [{ id: c.id }] }] } });
  const rounds = [
    [{ type: 'turn.created', id: 'start1', turnId: 'turn1' }, model('m1', call), pending('end1', call)],
    [{ type: 'turn.created', id: 'start2', turnId: 'turn2' }, { type: 'tool.response', id: 'result1', toolCallId: 'call1', threadId: 'main', content: '{"ok":true}' }, model('m2', second), pending('end2', second)],
    [{ type: 'turn.created', id: 'start3', turnId: 'turn3' }, { type: 'tool.response', id: 'denied', toolCallId: 'call2', threadId: 'main', content: 'Denied by caller' }, { type: 'turn.done', id: 'end3', state: { status: 'done', requiredActions: [] } }],
  ];
  const sdk = { sessions: { get: async () => ({ data: { id: 's1', shared: false, agent: { spec: trialAgentSpec(env, 'product_list') } } }), createTurnStream: async (_id, input) => {
    recorded.push(input); const events = rounds.shift(); return { withMetadata: async function* () { for (const data of events) yield { data }; } };
  } } };
  const r = await createTrueforgeClient({ env, tool: 'product_list', sdk }).runTurn('s1', JSON.stringify({ toolArguments: {} }));
  assert.equal(recorded[1].input[0].approval.status, 'allow'); assert.equal(recorded[2].input[0].approval.status, 'deny');
  assert.equal(r.calls.length, 1); assert.equal(r.responses.length, 1); assert.equal(r.calls[0].id, 'call1');
  let requests = 0;
  const badSdk = { sessions: { ...sdk.sessions, createTurnStream: async () => { requests++; return { withMetadata: async function* () {
    if (requests > 1) { yield { data: { type: 'turn.created', id: 'empty-start', turnId: 'empty' } }; yield { data: { type: 'turn.done', id: 'empty-end', state: { status: 'done', requiredActions: [] } } }; return; }
    yield { data: { type: 'turn.created', id: 's', turnId: 't' } }; yield { data: model('bad', { ...call, function: { ...call.function, arguments: '{"execute":true}' } }) }; yield { data: pending('d', call) };
  } }; } } };
  await assert.rejects(createTrueforgeClient({ env, tool: 'product_list', sdk: badSdk }).runTurn('s1', '{"toolArguments":{}}'), { code: 'TRUEFORGE_FORMAT_ERROR' });
  assert.equal(requests, 2);
});

const cardEnv = { ...transferEnv, SAVEFLOW_TRUEFORGE_CARD_PREVIEW_ENABLED: 'true' };
const financialCards = core => core.repository.getCards().map(card => { const copy = { ...card }; delete copy.previewGeneration; return copy; });
test('C: budget boundaries, edits, card changes and cancellation prepare without financial writes', async () => {
  await withMcp(async ({ factory, core, prepares }) => {
    const before = financialCards(core); const a = createTrueforgeSkillAdapter({ env: cardEnv, clientFactory: factory });
    let r = await a.handle(body('设置娱乐虚拟卡预算1000元'), { scope: 'a' }); assert.equal(r.data.preview.exactEffects[0].after.monthlyBudgetFen, 100000);
    const first = r.data.continuationToken;
    r = await a.handle({ ...body('改成2000元'), continuationToken: first }, { scope: 'a' }); assert.equal(r.data.preview.exactEffects[0].after.monthlyBudgetFen, 200000);
    r = await a.handle({ ...body('换成日常虚拟卡'), continuationToken: r.data.continuationToken }, { scope: 'a' }); assert.equal(r.data.preview.exactEffects[0].cardId, 'CARD-MAIN');
    assert.equal((await a.handle({ ...body('改成2000元'), continuationToken: first }, { scope: 'a' })).code, 'CONTINUATION_STALE');
    assert.equal((await a.handle({ ...body('取消'), continuationToken: r.data.continuationToken }, { scope: 'a' })).data.status, 'cancelled');
    for (const amount of [0, 100000]) {
      const p = await a.handle(body(`设置娱乐虚拟卡预算${amount}元`), { scope: 'a' }); assert.equal(p.data.preview.exactEffects[0].after.monthlyBudgetFen, amount * 100);
    }
    for (const value of ['-1', '100000.01', '1.234', '很多']) assert.equal((await a.handle(body(`设置娱乐虚拟卡预算${value}元`), { scope: 'a' })).code, 'INVALID_AMOUNT');
    assert.equal(prepares(), 5); assert.deepEqual(financialCards(core), before);
  });
});
test('C: freeze/missing card clarification and invalid unfreeze preserve actual card state', async () => {
  await withMcp(async ({ factory, core }) => {
    const a = createTrueforgeSkillAdapter({ env: cardEnv, clientFactory: factory });
    let r = await a.handle(body('冻结我的卡'), { scope: 'a' }); assert.equal(r.code, 'NEEDS_CLARIFICATION');
    r = await a.handle({ continuationToken: r.data.continuationToken, choice: { optionId: r.data.choices[1].optionId } }, { scope: 'a' });
    assert.equal(r.data.preview.exactEffects[0].after.status, 'frozen'); assert.equal(core.repository.getCard('CARD-ENT').status, 'active');
    const bad = await a.handle(body('解冻娱乐虚拟卡'), { scope: 'a' }); assert.equal(bad.code, 'INVALID_STATE'); assert.equal(bad.data.preview, undefined);
    const refused = await a.handle({ ...body('确认'), continuationToken: r.data.continuationToken }, { scope: 'a' }); assert.equal(refused.code, 'PREVIEW_ONLY');
    const invalid = await a.handle({ ...body('给张三转500元'), continuationToken: r.data.continuationToken }, { scope: 'a' }); assert.equal(invalid.code, 'CONTINUATION_ACTION_MISMATCH');
  });
});
test('C: isolated frozen fixture supports real unfreeze preview and rejects freezing an already frozen card', async () => {
  const source = structuredClone(seed); source.cards[1].status = 'frozen'; source.datasetId += '-frozen-test';
  await withMcp(async ({ factory, core }) => {
    const a = createTrueforgeSkillAdapter({ env: cardEnv, clientFactory: factory });
    const r = await a.handle(body('解冻娱乐虚拟卡'), { scope: 'a' }); assert.equal(r.data.status, 'awaiting_confirmation');
    assert.equal(r.data.preview.exactEffects[0].before.status, 'frozen'); assert.equal(r.data.preview.exactEffects[0].after.status, 'active');
    assert.equal(core.repository.getCard('CARD-ENT').status, 'frozen');
    assert.equal((await a.handle(body('冻结娱乐虚拟卡'), { scope: 'a' })).code, 'INVALID_STATE');
  }, { source });
});
test('C: wrong card effects, fractional budgets, evidence and unauthorized tools are rejected', async () => {
  await withMcp(async ({ mcp }) => {
    const args = { card_ref: '娱乐虚拟卡', amount: { amount_minor: 100000, currency: 'CNY' } };
    const r = (await mcp.callTool({ name: 'card_budget_preview', arguments: args })).structuredContent;
    for (const mutate of [v => v.action = 'card.freeze', v => v.preview.exactEffects[0].after.monthlyBudgetFen = 1.1, v => v.preview.exactEffects[0].before.status = 'invalid', v => v.evidence[0].entityIds = ['other'], v => v.preview.exactEffects[0].previewGeneration = 0]) {
      const v = structuredClone(r); mutate(v); assert.throws(() => validateSkillResult(event('card_budget_preview', args, v), { tool: 'card_budget_preview', serverName: 'sv-trial', expectedArgs: args }), { code: 'TRUEFORGE_FORMAT_ERROR' });
    }
    for (const tool of ['card_budget_preview', 'card_freeze_preview', 'card_unfreeze_preview']) {
      assert.deepEqual(trialAgentSpec(cardEnv, tool).mcpServers[0].enableTools, [tool]);
      assert.deepEqual(trialAgentSpec(cardEnv, tool).mcpServers[0].requireApprovalForTools, ['@all']);
    }
    assert.throws(() => trialAgentSpec(cardEnv, 'action.decide')); assert.throws(() => trialAgentSpec(cardEnv, 'action.execute'));
  });
});

test('multi-skill timeout/client abort/network failure cancels once, never retries or leaks raw errors', async () => {
  for (const mode of ['timeout', 'abort', 'network']) {
    let runs = 0, cancels = 0; const controller = new AbortController();
    const a = createTrueforgeSkillAdapter({ env, timeoutMs: 15, clientFactory: () => ({ createSession: async () => 'session', cancel: async () => { cancels++; },
      runTurn: async (_id, _msg, signal) => { runs++; if (mode === 'network') throw new Error('private service address and credential');
        return await new Promise((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
      } }) });
    if (mode === 'abort') setTimeout(() => controller.abort(), 3);
    const r = await a.handle(body('查询订阅'), { scope: 'a', signal: controller.signal });
    assert.equal(r.httpStatus, mode === 'network' ? 502 : 504); assert.equal(runs, 1); assert.equal(cancels, 1);
    assert.ok(!JSON.stringify(r).includes('credential')); assert.equal(r.data.data, undefined);
  }
});

test('SDK gate: a malformed unexecuted candidate can be corrected, with only one actual tool response', async () => {
  const inputs = []; let round = 0;
  const toolInfo = { type: 'mcp', name: 'product_list', serverId: 'sv-trial', serverName: 'sv-trial' };
  const sdk = { sessions: {
    get: async () => ({ data: { id: 's', shared: false, agent: { spec: trialAgentSpec(env, 'product_list') } } }),
    createTurnStream: async (_id, request) => {
      inputs.push(request.input); const i = round++;
      const events = [{ type: 'turn.created', id: `start${i}`, turnId: `turn${i}` }];
      if (i < 2) {
        const id = i === 0 ? 'bad-call' : 'valid-call';
        if (i === 1) events.push({ type: 'tool.response', id: 'denied-result', threadId: 'main', toolCallId: 'bad-call', content: 'Not executed' });
        events.push({ type: 'model.message', id: `model${i}`, threadId: 'main', toolCalls: [{ id, function: { name: 'product_list', arguments: i === 0 ? '{"arguments":{}}' : '{}' }, toolInfo }] });
        events.push({ type: 'turn.done', id: `end${i}`, state: { status: 'done', requiredActions: [{ type: 'tool.approval_required', threadId: 'main', toolCalls: [{ id }] }] } });
      } else events.push({ type: 'tool.response', id: 'valid-result', threadId: 'main', toolCallId: 'valid-call', content: '{"ok":true}' }, { type: 'turn.done', id: 'end2', state: { status: 'done', requiredActions: [] } });
      return { withMetadata: async function* () { for (const data of events) yield { data }; } };
    },
  } };
  const r = await createTrueforgeClient({ env, tool: 'product_list', sdk }).runTurn('s', '{"toolArguments":{}}');
  assert.equal(inputs[1][0].approval.status, 'deny'); assert.equal(inputs[2][0].approval.status, 'allow');
  assert.equal(r.calls.length, 1); assert.equal(r.calls[0].id, 'valid-call'); assert.equal(r.responses.length, 1);
});

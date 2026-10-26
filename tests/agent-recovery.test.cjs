/* eslint-disable @typescript-eslint/no-require-imports -- Load real browser TS/TSX and Node HTTP handlers. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  module._compile(ts.transpileModule(readFileSync(filename, 'utf8').replace(/from "@\/lib\//g, 'from "../lib/'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, filename);
};
require.extensions['.css'] = () => {};
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { mountSaveflow } = require('./fixtures/saveflow-hook.cjs');
const { createBankingCore } = require('../src/banking-core/core.mjs');
const { handleBankingAgent } = require('../server/banking-agent.mjs');
const { handleBanking } = require('../server/banking.mjs');
const { askBankingAgent } = require('../src/lib/banking-agent-client.ts');
const { BankingCardPreview } = require('../src/app/BankingCardCards.tsx');
const { BankingReadCard } = require('../src/app/BankingReadCards.tsx');
const { agentErrorPolicy } = require('../src/lib/agent-error-policy.mjs');
const { validRecoverySlot } = require('../src/lib/agent-error-policy.mjs');
const { buildParsedIntent } = require('../src/agent/clarification/merge-intent.mjs');
const { verifyContinuationToken } = require('../src/agent/clarification/continuation-token.mjs');
const env = { SAVEFLOW_ACCESS_CODE: 'recovery-test-access-1234', CONTINUATION_TOKEN_SECRET: 'recovery-test-secret-1234' };
let sequence = 0;
const bill = () => buildParsedIntent('bill.summary', { month: '2026-08' });
const card = (action, card_ref = '我的卡') => buildParsedIntent(action, { card_ref });
const transfer = amount => buildParsedIntent('transfer.create', { payee_ref: '张三', source_account_ref: '活期账户', ...(amount !== undefined ? { amount: { amount_minor: amount, currency: 'CNY' } } : {}) });
function app(t, { parseIntent = async () => bill(), source, changeCore } = {}) {
  let time = Date.parse('2026-10-22T04:00:00Z');
  const actual = createBankingCore({ ...(source ? { source } : {}), now: () => time });
  let core = changeCore?.(actual) ?? actual;
  const posts = [], responses = [];
  let loseExecute = false, offline = false;
  const original = global.fetch;
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body); posts.push(body);
    if (offline) throw new TypeError('offline');
    const request = new Request(`http://localhost${url}`, init);
    request.headers.set('x-forwarded-for', `recover-${++sequence}`);
    const response = url.endsWith('/api/banking-agent')
      ? await handleBankingAgent(request, { env, core, parseIntent, now: () => time })
      : await handleBanking(request, { env, core });
    responses.push(await response.clone().json());
    if (loseExecute && body.action === 'action.execute') { loseExecute = false; throw new TypeError('lost response after commit'); }
    return response;
  };
  t.after(() => { global.fetch = original; });
  return { core: actual, posts, responses, hook: mountSaveflow(), setOffline: v => { offline = v; }, loseNextExecute: () => { loseExecute = true; }, expire: () => { time += 300001; }, setCore: value => { core = value; } };
}
const last = hook => hook.current.messages.at(-1);
const choices = hook => last(hook).banking.choices;
async function send(hook, text) { await hook.current.startDemo(text); return hook.render(); }
async function choose(hook, choice) { await hook.current.chooseBankingOption(choice.optionId, choice.label); return hook.render(); }

test('unfreeze active card: no retry, fresh eligible choices, preserved context and usable composer', async t => {
  const source = structuredClone(require('../src/data/saveflow_mock_data.json')); source.cards[0].status = 'frozen';
  const a = app(t, { source, parseIntent: async () => card('card.unfreeze', '娱乐虚拟卡') });
  const h = a.hook;
  const oldToken = h.current.bankingContinuation;
  await send(h, '解冻娱乐虚拟卡');
  assert.ok(h.current.canStart); assert.notEqual(h.current.stage, 'analyzing');
  assert.ok(last(h).text.includes('正常使用状态，无需解冻'));
  assert.equal(h.current.bankingFailure, null);
  assert.ok(last(h).banking.choices.length > 0);
  assert.notEqual(h.current.bankingContinuation, oldToken);
  const draft = verifyContinuationToken(h.current.bankingContinuation, env.CONTINUATION_TOKEN_SECRET, Date.parse('2026-10-22T04:00:00Z'));
  assert.equal(draft.action, 'card.unfreeze');
  assert.ok(draft.choices.every(c => a.core.repository.getCard(c.entityId).status === 'frozen'));
  assert.equal(a.responses.at(-1).data.error.category, 'business_conflict');
  assert.equal(a.responses.at(-1).data.error.retryable, false);
  await choose(h, choices(h)[0]);
  assert.equal(last(h).kind, 'banking_card_preview');
  assert.ok(h.current.activeCardOperationId);
  assert.ok(h.current.canStart);
});

test('no eligible unfreeze card explains current state, shows no retry and accepts a new query', async t => {
  const a = app(t, { parseIntent: async text => text === '查看我的卡' ? card('card.get') : card('card.unfreeze', '娱乐虚拟卡') });
  const h = a.hook; await send(h, '解冻娱乐虚拟卡');
  assert.ok(last(h).text.includes('正常使用状态，无需解冻'));
  assert.ok(last(h).text.includes('没有符合条件'));
  assert.equal(h.current.bankingFailure.retryable, false); assert.equal(h.current.bankingContinuation, null);
  assert.ok(h.current.canStart);
  await send(h, '查看我的卡'); assert.ok(choices(h).length); assert.ok(h.current.canStart);
});

test('nonexistent ordinal and forged option renew choices from current repository, not previous result', async t => {
  const a = app(t, { parseIntent: async message => message === '第9张' ? buildParsedIntent('card.get', { card_ref: '第9张' }) : card('card.get') });
  const h = a.hook; await send(h, '查看我的卡');
  const oldChoices = choices(h).map(c => c.optionId), oldToken = h.current.bankingContinuation;
  await send(h, '第9张');
  assert.equal(last(h).kind, 'banking_clarification');
  assert.ok(last(h).text.includes('没有找到'));
  assert.ok(choices(h).every(c => !oldChoices.includes(c.optionId)));
  assert.notEqual(h.current.bankingContinuation, oldToken);
  // A forged button cannot be rendered, and direct HTTP cannot select an entity with it.
  const response = await global.fetch('/api/banking-agent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE }, body: JSON.stringify({ continuationToken: h.current.bankingContinuation, choice: { optionId: 'forged' } }) });
  const result = await response.json();
  assert.equal(result.code, 'INVALID_CHOICE'); assert.equal(result.data.error.retryable, false);
  assert.ok(result.data.recovery.choices.length > 0);
  assert.ok(h.current.canStart);
});

test('ambiguous input keeps authenticated business draft; two failed turns can still select and query', async t => {
  const a = app(t, { parseIntent: async (text, options) => options.context ? { schemaVersion: '1.0.0', action: 'clarify', slots: {}, missingSlots: ['action'], status: 'needs_clarification' } : card('card.get') });
  const h = a.hook; await send(h, '查看那张卡');
  for (const text of ['第9张', '不知道选哪个']) {
    await send(h, text);
    assert.equal(last(h).banking.action, 'card.get');
    assert.equal(last(h).banking.slot, 'card_ref');
    assert.ok(choices(h).length); assert.ok(h.current.canStart);
  }
  await choose(h, choices(h)[0]);
  assert.equal(last(h).kind, 'banking_card'); assert.ok(h.current.canStart);
});

test('expired continuation is discarded and business can restart without clearing history', async t => {
  const a = app(t, { parseIntent: async text => text === '查八月账单' ? bill() : card('card.get') });
  const h = a.hook; await send(h, '查看我的卡');
  const old = h.current.bankingContinuation, option = choices(h)[0]; a.expire();
  await choose(h, option);
  assert.equal(h.current.bankingFailure.category, 'session_expired');
  assert.equal(h.current.bankingFailure.retryable, false);
  assert.equal(h.current.bankingContinuation, null); assert.ok(h.current.canStart);
  const count = h.current.messages.length;
  h.current.restartBankingFlow(); h.render();
  assert.equal(h.current.messages.length, count);
  await send(h, '查八月账单');
  assert.equal(last(h).kind, 'banking_bill');
  assert.equal(a.posts.at(-1).continuationToken, undefined); assert.notEqual(h.current.bankingContinuation, old);
});

test('invalid amount repairs missing amount while retaining payee/account; no prepare on invalid input', async t => {
  let prepareCalls = 0;
  const a = app(t, { parseIntent: async text => transfer(text === '负一元' ? -100 : text === '五百元' ? 50000 : undefined), changeCore: core => ({ ...core, prepare: input => { prepareCalls++; return core.prepare(input); } }) });
  const h = a.hook; await send(h, '给张三转钱'); await send(h, '负一元');
  assert.equal(prepareCalls, 0); assert.equal(last(h).banking.slot, 'amount');
  assert.equal(a.responses.at(-1).data.error.category, 'invalid_input');
  assert.equal(a.responses.at(-1).data.error.retryable, false); assert.ok(h.current.canStart);
  const state = verifyContinuationToken(h.current.bankingContinuation, env.CONTINUATION_TOKEN_SECRET, Date.parse('2026-10-22T04:00:00Z'));
  assert.equal(state.slots.payee_ref, '张三'); assert.equal(state.slots.source_account_ref, '活期账户'); assert.equal(state.slots.amount, undefined);
  await send(h, '五百元'); assert.equal(last(h).kind, 'banking_preview'); assert.equal(prepareCalls, 1);
});

test('risk rejection cannot retry or execute; fresh independent request works', async t => {
  const source = structuredClone(require('../src/data/saveflow_mock_data.json')); source.cards[1].status = 'frozen';
  const a = app(t, { source, parseIntent: async text => text === '查八月账单' ? bill() : card('card.unfreeze', '娱乐虚拟卡'), changeCore: core => ({ ...core,
    prepare: async () => ({ ok: false, error: { code: 'FORBIDDEN', message: '银行风控禁止此操作', uncertain: false } }),
    execute: () => assert.fail('risk rejection must never execute'),
  }) });
  const h = a.hook; await send(h, '解冻娱乐卡');
  assert.equal(h.current.bankingFailure.category, 'restricted'); assert.equal(h.current.bankingFailure.retryable, false);
  const before = a.posts.length; await h.current.retryAnalysis(); assert.equal(a.posts.length, before);
  assert.ok(h.current.canStart); assert.equal(h.current.activeCardOperationId, null);
  await send(h, '查八月账单'); assert.equal(last(h).kind, 'banking_bill');
});

test('temporary network failure allows safe Agent retry and releases loading; never auto-retries', async t => {
  const a = app(t); const h = a.hook; a.setOffline(true);
  await send(h, '查八月账单');
  assert.equal(h.current.bankingFailure.category, 'transient'); assert.equal(h.current.bankingFailure.retryable, true);
  assert.ok(h.current.canStart); assert.equal(a.posts.length, 1);
  a.setOffline(false); await h.current.retryAnalysis(); h.render();
  assert.equal(last(h).kind, 'banking_bill'); assert.equal(a.posts.length, 2); assert.ok(h.current.canStart);
});

test('execute commits but response is lost: double click/Agent retry cannot repeat; status recovers original receipt', async t => {
  const a = app(t, { parseIntent: async () => transfer(50000) }); const h = a.hook;
  await send(h, '从活期账户给张三转500元');
  const preview = last(h).banking, before = a.core.repository.getAccount('ACC-CHECKING').availableBalanceFen;
  a.loseNextExecute();
  const confirm = h.current.confirmTransferOperation;
  await Promise.all([confirm(preview), confirm(preview)]); h.render();
  assert.equal(a.core.repository.getAccount('ACC-CHECKING').availableBalanceFen, before - 50000);
  assert.equal(a.posts.filter(p => p.action === 'action.execute').length, 1);
  assert.equal(h.current.activeTransferOperationId, null);
  assert.ok(h.current.messages.find(m => m.banking?.operationId === preview.operationId).banking.outcomePending);
  assert.ok(h.current.canStart); assert.equal(h.current.transferBusy, false);
  await confirm(preview); await h.current.retryAnalysis();
  assert.equal(a.posts.filter(p => p.action === 'action.execute').length, 1);
  await send(h, '再提出一项请求');
  const newPreview = last(h).banking;
  assert.ok(h.current.messages.some(m => m.banking?.operationId === preview.operationId));
  assert.equal(h.current.activeTransferOperationId, null);
  await h.current.confirmTransferOperation(newPreview);
  assert.equal(a.posts.filter(p => p.action === 'action.execute').length, 1);
  await h.current.checkTransferOperation(preview); h.render();
  assert.equal(last(h).kind, 'banking_receipt');
  assert.equal(a.posts.filter(p => p.action === 'action.execute').length, 1);
  assert.equal(a.core.repository.getTransactions().filter(tx => tx.operationId === preview.operationId).length, 1);
});

test('selection made stale by another trusted operation is rechecked, and options are regenerated with current eligibility', async t => {
  const source = structuredClone(require('../src/data/saveflow_mock_data.json')); source.cards.forEach(c => { c.status = 'frozen'; });
  const a = app(t, { source, parseIntent: async () => card('card.unfreeze') }); const h = a.hook;
  await send(h, '解冻我的卡');
  const stale = choices(h)[0], oldIds = choices(h).map(c => c.optionId);
  const prepared = await a.core.prepare({ action: 'card.unfreeze', input: { cardId: source.cards[0].id } });
  assert.equal(prepared.ok, true);
  await a.core.decide(prepared.data.operationId, { previewHash: prepared.data.preview.previewHash, decision: 'confirm', confirmedStepIds: prepared.data.preview.stepIds });
  await a.core.execute(prepared.data.operationId, prepared.data.preview.previewHash);
  await choose(h, stale);
  assert.ok(last(h).text.includes('无需解冻'));
  assert.equal(choices(h).length, 1); assert.ok(choices(h)[0].label.includes('娱乐'));
  assert.ok(!oldIds.includes(choices(h)[0].optionId)); assert.ok(h.current.canStart);
});

test('a failed selection flow can switch directly to a complete bill request', async t => {
  const a = app(t, { parseIntent: async text => text === '查八月账单' ? bill() : text === '第9张' ? { schemaVersion: '1.0.0', action: 'clarify', slots: {}, missingSlots: ['action'], status: 'needs_clarification' } : card('card.get') });
  await send(a.hook, '查看我的卡'); await send(a.hook, '第9张'); await send(a.hook, '查八月账单');
  assert.equal(last(a.hook).kind, 'banking_bill'); assert.equal(a.hook.current.bankingContinuation, null); assert.ok(a.hook.current.canStart);
});

test('known non-card business errors retain their code through Dispatcher instead of skill_error', async () => {
  const { dispatchParsedIntent } = require('../src/agent/runtime.mjs');
  const result = await dispatchParsedIntent(buildParsedIntent('subscription.list', {}), { subscriptionHandler: async () => { throw Object.assign(new Error('需要修改输入'), { code: 'VALIDATION_ERROR' }); } });
  assert.equal(result.kind, 'core_error'); assert.equal(result.error.code, 'VALIDATION_ERROR');
});

test('card execute timeout blocks reconfirmation until status query; rendered preview keeps query button', async t => {
  const a = app(t, { parseIntent: async () => card('card.freeze', '娱乐虚拟卡') }); const h = a.hook;
  await send(h, '冻结娱乐虚拟卡'); const preview = last(h).banking;
  a.loseNextExecute(); await h.current.confirmCardOperation(preview); h.render();
  assert.equal(h.current.activeCardOperationId, null); assert.ok(h.current.canStart); assert.equal(h.current.cardBusy, false);
  const data = h.current.messages.find(m => m.banking?.operationId === preview.operationId).banking;
  const html = renderToStaticMarkup(React.createElement(BankingCardPreview, { data, active: false, busy: false, onConfirm() {}, onReject() {}, onCheck() {} }));
  assert.ok(html.includes('结果待核实')); assert.match(html, /disabled="">确认并执行/); assert.ok(html.includes('查询操作状态'));
  await h.current.checkCardOperation(preview); h.render();
  assert.equal(a.core.repository.getCard('CARD-ENT').status, 'frozen');
  assert.equal(a.posts.filter(p => p.action === 'action.execute').length, 1);
});

test('all normal read Skill responses release composer and malicious retry policy is rejected', async t => {
  for (const action of ['__proto__', 'constructor', 'toString', 'card.execute']) assert.equal(validRecoverySlot(action, 'card_ref'), false);
  const a = app(t, { parseIntent: async () => buildParsedIntent('subscription.list', {}) });
  await send(a.hook, '查看订阅'); assert.ok(a.hook.current.canStart); assert.equal(a.hook.current.stage, 'answered');
  const original = global.fetch;
  global.fetch = async () => Response.json({ code: 'INVALID_STATE', requestId: 'r1', message: '业务冲突', data: { status: 'error', error: { code: 'INVALID_STATE', ...agentErrorPolicy('INVALID_STATE'), retryable: true } } }, { status: 409 });
  await assert.rejects(askBankingAgent({ message: 'test' }, env.SAVEFLOW_ACCESS_CODE, new AbortController().signal), { code: 'BANKING_AGENT_RESPONSE_ERROR' });
  global.fetch = original;
});

test('unknown write survives restart and bounded history/refresh with query context but no execution authority', async t => {
  const a = app(t, { parseIntent: async () => card('card.freeze', '娱乐虚拟卡') }); const h = a.hook;
  await send(h, '冻结娱乐虚拟卡'); const preview = last(h).banking;
  a.loseNextExecute(); await h.current.confirmCardOperation(preview); h.render();
  const count = h.current.messages.length; h.current.restart(); h.render();
  assert.equal(h.current.messages.length, count); assert.ok(h.current.canStart);
  const { saveBankingChat, restoreBankingChat } = require('../src/lib/banking-chat-storage.ts');
  const messages = [...h.current.messages, ...Array.from({ length: 110 }, (_, i) => ({ id: i + 100, role: 'user', text: '其他查询' }))];
  const restored = restoreBankingChat(saveBankingChat(messages, null, 1000, 2000), 2000000);
  assert.ok(restored); assert.equal(restored.messages.length, 100);
  const pending = restored.messages.find(m => m.banking?.operationId === preview.operationId);
  assert.equal(pending.banking.outcomePending, true); assert.equal(pending.banking.previewCurrent, false);
  assert.equal(restored.continuation, null);
  const legacy = messages.map(m => m.banking?.operationId === preview.operationId ? { ...m, banking: { ...m.banking, outcomePending: undefined, coreStage: 'unknown' } } : m);
  assert.ok(restoreBankingChat(saveBankingChat(legacy, null, 1000, 2000), 2000000)?.messages.some(m => m.banking?.operationId === preview.operationId));
});

test('rule save uses dedicated page confirmation, and a lost response recovers by querying the same operation', async t => {
  const ruleIntent = buildParsedIntent('scenario.create_rule', { trigger: { type: 'financial_event', value: 'balance_changed' }, conditions: { balance_below_minor: 100000 }, proposed_steps: [{ action: 'bill.analyze', parameters: {} }], authorization_scope: 'suggest_only' });
  const a = app(t, { parseIntent: async () => ruleIntent }); const h = a.hook;
  await send(h, '创建规则'); const preview = last(h).banking;
  const ruleId = preview.data.rule.id;
  assert.equal(await a.core.getScenarioRule(ruleId), undefined);
  const html = renderToStaticMarkup(React.createElement(BankingReadCard, { data: preview, active: true, busy: false, onConfirm() {}, onReject() {}, onCheck() {} }));
  assert.ok(html.includes('确认并保存规则')); assert.ok(html.includes('查询操作状态'));
  // Even a valid old signed continuation cannot authorize chat confirmation.
  const response = await global.fetch('/api/banking-agent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE }, body: JSON.stringify({ continuationToken: preview.continuationToken, message: '确认保存' }) });
  assert.equal((await response.json()).code, 'CONFIRMATION_REQUIRED'); assert.equal(await a.core.getScenarioRule(ruleId), undefined);
  a.loseNextExecute(); await h.current.confirmCardOperation(preview); h.render();
  assert.ok(await a.core.getScenarioRule(ruleId), JSON.stringify({ lastMessage: last(h).text, statuses: a.responses.map(p => ({ code: p.code, status: p.data?.status })) }));
  assert.equal((await a.core.getScenarioRule(ruleId)).status, 'active');
  assert.equal(h.current.activeCardOperationId, null); assert.ok(h.current.canStart);
  await h.current.checkCardOperation(preview); h.render();
  assert.ok(last(h).banking, last(h).text);
  assert.equal(last(h).banking.status, 'scenario_rule'); assert.equal(last(h).banking.data.rule.id, ruleId);
  assert.equal(a.posts.filter(p => p.action === 'action.execute').length, 1);
});

test('LIVE TrueForge: state conflict, invalid ordinal, valid selection and a new bill request all recover', { skip: process.env.SAVEFLOW_VERIFY_LIVE_RECOVERY !== 'true' }, async t => {
  const { parseTrueforgeBankingIntent } = await import('../server/trueforge-banking-runtime.mjs');
  const modelFetch = global.fetch; // SDK traffic must not enter the in-process browser HTTP adapter.
  const a = app(t, { parseIntent: (text, context) => parseTrueforgeBankingIntent(text, { ...context, env: process.env, fetchImpl: modelFetch }) });
  const h = a.hook;
  await send(h, '解冻娱乐虚拟卡');
  assert.equal(h.current.bankingFailure.category, 'business_conflict'); assert.equal(h.current.bankingFailure.retryable, false); assert.ok(h.current.canStart);
  await send(h, '查看我的卡'); assert.ok(choices(h).length);
  const oldIds = choices(h).map(c => c.optionId);
  await send(h, '第9张');
  assert.equal(last(h).kind, 'banking_clarification'); assert.equal(last(h).banking.action, 'card.get');
  assert.ok(choices(h).length); assert.ok(choices(h).every(c => !oldIds.includes(c.optionId))); assert.ok(h.current.canStart);
  await choose(h, choices(h)[0]); assert.equal(last(h).kind, 'banking_card'); assert.ok(h.current.canStart);
  await send(h, '查看今年六到九月的账单');
  assert.equal(last(h).kind, 'banking_bill'); assert.equal(last(h).banking.data.period.startDate, '2026-06-01'); assert.ok(h.current.canStart);
});

/* eslint-disable @typescript-eslint/no-require-imports -- Exercise real HTTP, ESM handlers and browser TypeScript validation. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, filename);
const { handleBankingAgent } = require('../server/banking-agent.mjs');
const { createBankingCore } = require('../src/banking-core/core.mjs');
const { createConversationStore } = require('../server/conversation-state.mjs');
const { verifyContinuationToken, issueContinuationToken } = require('../src/agent/clarification/continuation-token.mjs');
const { buildParsedIntent } = require('../src/agent/clarification/merge-intent.mjs');
const { askBankingAgent, BankingAgentError } = require('../src/lib/banking-agent-client.ts');
const env = { SAVEFLOW_ACCESS_CODE: 'conversation-http-access-1234', CONTINUATION_TOKEN_SECRET: 'conversation-http-secret-1234' };
const bill = () => buildParsedIntent('bill.summary', { month: '2026-08' });
const transfer = () => buildParsedIntent('transfer.create', { payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' } });
let serial = 0;
async function fixture(t, overrides = {}) {
  let clock = Date.parse('2026-10-22T04:00:00Z');
  const now = () => clock;
  const source = structuredClone(require('../src/data/saveflow_mock_data.json'));
  if (overrides.fundSavings) { source.accounts[1].balance = 1000; source.accounts[1].availableBalance = 1000; }
  const core = createBankingCore({ now, source });
  const calls = { prepares: 0, reads: 0, understands: [] };
  let observedState;
  const readCoreOperation = async id => {
    calls.reads++;
    const result = await core.getOperation(id);
    return result.ok && observedState ? { ok: true, data: { ...result.data, state: observedState, status: 'pending' } } : result;
  };
  const host = { store: createConversationStore({ now, readCoreOperation }), busy: new Set() };
  const beforeTransactions = core.repository.getTransactions().length;
  const parseIntent = async (message, options) => {
    calls.understands.push({ message, context: options.context, history: options.history });
    if (overrides.parseIntent) return overrides.parseIntent(message, options);
    if (message.includes('账单')) return bill();
    if (message === '查看我的卡') return buildParsedIntent('card.get', { card_ref: '我的卡' });
    if (options.context) {
      const slots = structuredClone(options.context.slots);
      if (message === '改成100元') slots.amount = { amount_minor: 10000, currency: 'CNY' };
      else if (message === '收款人改成李四') slots.payee_ref = '李四';
      else if (message === '改用储蓄账户') slots.source_account_ref = '储蓄账户';
      else if (message === '不清楚') return buildParsedIntent('clarify', {});
      return buildParsedIntent(options.context.action, slots);
    }
    return transfer();
  };
  const wrapped = { ...core, prepare: request => { calls.prepares++; return core.prepare(request); },
    getOperation: readCoreOperation,
    decide: () => assert.fail('Agent must not decide'), execute: () => assert.fail('Agent must not execute') };
  const server = http.createServer(async (req, res) => {
    const request = new Request(`http://${req.headers.host}/api/banking-agent`, { method: req.method, headers: req.headers,
      body: Readable.toWeb(req), duplex: 'half' });
    const response = await handleBankingAgent(request, { env, core: wrapped, now, parseIntent, conversationHost: host });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async body => {
    const r = await fetch(`${url}/api/banking-agent`, { method: 'POST', headers: { 'Content-Type': 'application/json',
      'X-Saveflow-Access': env.SAVEFLOW_ACCESS_CODE, 'X-Forwarded-For': `conversation-${++serial}` }, body: JSON.stringify(body) });
    return { httpStatus: r.status, ...await r.json() };
  };
  return { post, url, core, calls, host, now, beforeTransactions, setObservedState: value => { observedState = value; }, advance: ms => { clock += ms; } };
}
const session = payload => ({ conversationToken: payload.data.conversation.token, conversationRevision: payload.data.conversation.revision });
const continueTask = payload => ({ ...session(payload), taskId: payload.data.conversation.currentTask.taskId,
  taskMode: 'continue', continuationToken: payload.data.continuationToken });
async function preview(f) {
  const first = await f.post({ message: '给张三转500元' });
  assert.equal(first.code, 'NEEDS_CLARIFICATION');
  const result = await f.post({ ...continueTask(first), choice: { optionId: first.data.choices[0].optionId } });
  assert.equal(result.data.status, 'awaiting_confirmation', result.code);
  return result;
}

test('real HTTP: transfer suspends for an independent bill and resumes with revalidated slots and a new Core preview', async t => {
  const f = await fixture(t);
  const original = await preview(f);
  const originalTask = original.data.conversation.currentTask.taskId;
  const result = await f.post({ ...session(original), taskMode: 'new', message: '查看2026年8月账单',
    continuationToken: original.data.continuationToken, history: [{ role: 'user', content: '旧转账上下文' }] });
  assert.equal(result.data.status, 'bill_result');
  assert.equal(result.data.conversation.token, original.data.conversation.token);
  assert.notEqual(result.data.conversation.currentTask.taskId, originalTask);
  assert.equal(result.data.conversation.currentTask.status, 'completed');
  assert.equal(result.data.conversation.suspendedTasks[0].taskId, originalTask);
  const seen = f.calls.understands.at(-1);
  assert.equal(seen.context, undefined); assert.deepEqual(seen.history, []);
  const state = f.host.store.read(result.data.conversation.token);
  assert.equal(state.pendingPreview, null);
  assert.deepEqual(state.suspendedTasks[0].verifiedSlots, verifyContinuationToken(original.data.continuationToken, env.CONTINUATION_TOKEN_SECRET, f.now()).slots);
  const resumed = await f.post({ ...session(result), taskMode: 'resume', taskId: originalTask, continuationToken: original.data.continuationToken });
  assert.equal(resumed.data.status, 'awaiting_confirmation', resumed.code);
  assert.equal(resumed.data.conversation.currentTask.taskId, originalTask);
  assert.notEqual(resumed.data.operationId, original.data.operationId);
  assert.equal(resumed.data.preview.exactEffects[0].amountFen, 50000);
  assert.equal(resumed.data.preview.exactEffects[0].payeeId, 'payee_001');
  assert.equal(f.calls.prepares, 2);
  assert.equal(f.core.repository.getTransactions().length, f.beforeTransactions);
});

test('model action switch is re-understood without the old draft; a subsequent card query also has no transfer context', async t => {
  const f = await fixture(t); const original = await preview(f);
  const switched = await f.post({ ...session(original), continuationToken: original.data.continuationToken, message: '查看2026年8月账单' });
  assert.equal(switched.data.status, 'bill_result');
  assert.equal(f.calls.understands.at(-2).context.action, 'transfer.create');
  assert.equal(f.calls.understands.at(-1).context, undefined);
  const card = await f.post({ ...session(switched), message: '查看我的卡' });
  assert.equal(card.data.status, 'needs_clarification');
  assert.equal(f.calls.understands.at(-1).context, undefined);
  assert.equal(f.calls.prepares, 1);
});

test('each transfer parameter edit creates a distinct formal preview and consumes the prior credential', async t => {
  const f = await fixture(t, { fundSavings: true }); let current = await preview(f);
  const taskId = current.data.conversation.currentTask.taskId;
  for (const [message, field, expected] of [['改成100元', 'amountFen', 10000], ['收款人改成李四', 'payeeId', 'payee_002'], ['改用储蓄账户', 'fromAccountId', 'ACC-SAVINGS']]) {
    const previous = current;
    current = await f.post({ ...continueTask(current), message });
    assert.equal(current.data.status, 'awaiting_confirmation', current.code);
    assert.equal(current.data.conversation.currentTask.taskId, taskId);
    assert.notEqual(current.data.operationId, previous.data.operationId);
    assert.equal(current.data.preview.exactEffects[0][field], expected);
    const stale = await f.post({ conversationToken: current.data.conversation.token, continuationToken: previous.data.continuationToken, message });
    assert.equal(stale.code, 'CONTINUATION_STALE');
  }
  assert.equal(f.calls.prepares, 4);
});

test('cross-session task/credential substitution, internal IDs, stale revisions and unbound tokens are rejected before Core', async t => {
  const f = await fixture(t); const a = await preview(f); const b = await f.post({ message: '查看2026年8月账单' });
  const before = f.calls.prepares;
  const mixed = await f.post({ ...session(b), taskMode: 'continue', taskId: a.data.conversation.currentTask.taskId,
    continuationToken: a.data.continuationToken, message: '改成100元' });
  assert.equal(mixed.code, 'CONVERSATION_TASK_MISMATCH');
  assert.equal(mixed.data.conversation.token, b.data.conversation.token);
  const id = f.host.store.read(a.data.conversation.token).conversationId;
  assert.equal((await f.post({ conversationToken: id, message: '查账单' })).code, 'CONVERSATION_NOT_FOUND');
  assert.equal((await f.post({ ...continueTask(a), conversationRevision: 0, message: '改成100元' })).code, 'CONVERSATION_REVISION_CONFLICT');
  const unbound = issueContinuationToken({ action: 'transfer.create', slots: transfer().slots, pendingSlot: 'source_account_ref' }, env.CONTINUATION_TOKEN_SECRET, f.now());
  assert.equal((await f.post({ continuationToken: unbound, message: '改成100元' })).code, 'CONTINUATION_INVALID');
  const forged = await f.post({ ...session(a), continuationToken: 'forged', message: '改成100元' });
  assert.equal(forged.code, 'CONTINUATION_INVALID');
  assert.equal(forged.data.conversation.token, a.data.conversation.token);
  assert.equal(f.calls.prepares, before);
});

test('suspended tasks require explicit matching resume, expiry never resurrects a task', async t => {
  const f = await fixture(t); const a = await preview(f);
  const billResult = await f.post({ ...session(a), message: '查看2026年8月账单' });
  assert.equal((await f.post({ ...continueTask(a), conversationRevision: billResult.data.conversation.revision, message: '改成100元' })).code, 'CONVERSATION_TASK_MISMATCH');
  assert.equal((await f.post({ ...session(billResult), taskMode: 'resume', taskId: a.data.conversation.currentTask.taskId })).code, 'CONTINUATION_INVALID');
  f.advance(300001);
  const expired = await f.post({ conversationToken: a.data.conversation.token, taskMode: 'resume', taskId: a.data.conversation.currentTask.taskId, continuationToken: a.data.continuationToken });
  assert.equal(expired.code, 'CONTINUATION_INVALID');
  assert.equal(expired.data.conversation.token, a.data.conversation.token);
  const fresh = await f.post({ conversationToken: a.data.conversation.token, message: '查看2026年8月账单' });
  assert.equal(fresh.data.status, 'bill_result'); assert.equal(f.calls.prepares, 1);
});

test('Core confirmed, executing and unknown operations are read by original ID and cannot be edited or resumed', async t => {
  for (const phase of ['confirmed', 'executing', 'unknown']) {
    const f = await fixture(t); const a = await preview(f); const before = f.calls.prepares;
    // Confirmed uses actual Core. Executing/unknown simulate a trusted Core read
    // while retaining the actual prepared preview; this is not a model output.
    if (phase === 'confirmed') await f.core.decide(a.data.operationId, { previewHash: a.data.preview.previewHash, decision: 'confirm', confirmedStepIds: a.data.preview.stepIds });
    else f.setObservedState(phase);
    const reads = f.calls.reads;
    const result = await f.post({ ...continueTask(a), message: '改成100元' });
    assert.equal(result.code, 'CONVERSATION_OPERATION_LOCKED');
    assert.equal(result.message, '您的转账请求已收到，但我们暂时无法确认最终结果。为避免重复扣款，请先查询转账结果，暂时不要重新发起相同转账。');
    assert.equal(result.message.includes('confirmed'), false);
    assert.equal(result.data.operationId, a.data.operationId);
    assert.equal(result.data.error.uncertain, true);
    assert.equal(result.data.error.nextAction, 'query_status');
    assert.equal(f.calls.prepares, before);
    assert.ok(f.calls.reads > reads);
    const billResult = await f.post({ ...session(result), message: '查看2026年8月账单' });
    assert.equal(billResult.data.status, 'bill_result');
    const resume = await f.post({ ...session(billResult), taskMode: 'resume', taskId: a.data.conversation.currentTask.taskId, continuationToken: a.data.continuationToken });
    assert.equal(resume.code, 'CONVERSATION_OPERATION_LOCKED');
    const newWrite = await f.post({ ...session(resume), taskMode: 'new', message: '给张三转500元' });
    assert.equal(newWrite.code, 'CONVERSATION_OPERATION_LOCKED');
    assert.equal(f.calls.prepares, before);
  }
});

test('same-action new requests get a new task and cannot inherit the previous account or preview', async t => {
  const f = await fixture(t); const original = await preview(f);
  const next = await f.post({ ...session(original), taskMode: 'new', continuationToken: original.data.continuationToken, message: '给张三转500元' });
  assert.equal(next.data.status, 'needs_clarification');
  assert.equal(next.data.slot, 'source_account_ref');
  assert.notEqual(next.data.conversation.currentTask.taskId, original.data.conversation.currentTask.taskId);
  assert.equal(f.calls.understands.at(-1).context, undefined);
  const state = f.host.store.read(next.data.conversation.token);
  assert.equal(state.currentTask.verifiedSlots.source_account_ref, undefined);
  assert.equal(state.pendingPreview, null);
  assert.equal(f.calls.prepares, 1);
});

test('concurrent continuation requests cannot both reach Core.prepare; exact completed retry returns the original result', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { parseIntent: async (_message, options) => {
    if (!options.context) return transfer();
    entered(); await gate;
    return buildParsedIntent(options.context.action, { ...options.context.slots, amount: { amount_minor: 10000, currency: 'CNY' } });
  } });
  const original = await preview(f);
  const request = { ...continueTask(original), message: '改成100元' };
  const pending = f.post(request); await started;
  const duplicate = await f.post(request);
  assert.equal(duplicate.code, 'CONVERSATION_BUSY');
  assert.equal(duplicate.data.conversation.token, original.data.conversation.token);
  release(); const completed = await pending;
  assert.equal(completed.data.status, 'awaiting_confirmation');
  const retry = await f.post(request);
  assert.deepEqual(retry, completed);
  const replay = await f.post({ conversationToken: completed.data.conversation.token, continuationToken: original.data.continuationToken, message: '改成100元' });
  assert.equal(replay.code, 'CONTINUATION_STALE');
  assert.equal(f.calls.prepares, 2);
});

test('duplicate option submission is reusable only for the exact request and latest result revision', async t => {
  const f = await fixture(t);
  const first = await f.post({ message: '给张三转500元' });
  const request = { ...continueTask(first), choice: { optionId: first.data.choices[0].optionId } };
  const result = await f.post(request);
  assert.equal(result.data.status, 'awaiting_confirmation');
  assert.deepEqual(await f.post(request), result);
  assert.equal(f.calls.prepares, 1);
  const different = await f.post({ ...request, choice: { optionId: first.data.choices[1].optionId } });
  assert.equal(different.code, 'CONVERSATION_REVISION_CONFLICT');
  const edited = await f.post({ ...continueTask(result), message: '改成100元' });
  assert.equal(edited.data.preview.exactEffects[0].amountFen, 10000);
  assert.equal((await f.post(request)).code, 'CONVERSATION_REVISION_CONFLICT');
  assert.equal(f.calls.prepares, 2);
});

test('concurrent identical choices prepare once, BUSY is not success, and retry returns that one preview', async t => {
  const f = await fixture(t);
  const first = await f.post({ message: '给张三转500元' });
  const request = { ...continueTask(first), choice: { optionId: first.data.choices[0].optionId } };
  const results = await Promise.all([f.post(request), f.post(request)]);
  const success = results.find(result => result.code === 'OK');
  assert.ok(success);
  assert.ok(results.every(result => result.code === 'OK' || result.code === 'CONVERSATION_BUSY'));
  assert.deepEqual(await f.post(request), success);
  assert.equal(f.calls.prepares, 1);
});

test('cached preview cannot bypass later Core confirmation, executing/unknown results or task expiry', async t => {
  for (const phase of ['confirmed', 'executing', 'unknown', 'expired']) {
    const f = await fixture(t);
    const first = await f.post({ message: '给张三转500元' });
    const request = { ...continueTask(first), choice: { optionId: first.data.choices[0].optionId } };
    const result = await f.post(request);
    if (phase === 'confirmed') await f.core.decide(result.data.operationId, {
      decision: 'confirm', previewHash: result.data.preview.previewHash, confirmedStepIds: result.data.preview.stepIds,
    });
    else if (phase === 'expired') f.advance(300001);
    else f.setObservedState(phase); // Trusted Core read substitute, not model output.
    const retry = await f.post(request);
    assert.equal(retry.code, phase === 'expired' ? 'CONTINUATION_INVALID' : 'CONVERSATION_OPERATION_LOCKED');
    if (phase !== 'expired') { assert.equal(retry.data.operationId, result.data.operationId); assert.equal(retry.data.error.uncertain, true); assert.equal(retry.data.error.nextAction, 'query_status'); }
    assert.equal(f.calls.prepares, 1);
    assert.equal(f.core.repository.getTransactions().length, f.beforeTransactions);
  }
});

test('model proposals cannot change an explicitly continued task or smuggle execution parameters', async t => {
  let malicious = false;
  const f = await fixture(t, { parseIntent: async () => malicious ? { ...bill(), operationId: 'op_forged', confirmed: true } : transfer() });
  const original = await preview(f); malicious = true;
  const invalid = await f.post({ ...continueTask(original), message: '改成100元' });
  assert.equal(invalid.code, 'MODEL_FORMAT_ERROR');
  assert.equal(invalid.data.conversation.token, original.data.conversation.token);
  assert.equal(f.calls.prepares, 1);
  const g = await fixture(t); const source = await preview(g);
  const mismatch = await g.post({ ...continueTask(source), message: '查看2026年8月账单' });
  assert.equal(mismatch.code, 'CONVERSATION_ACTION_MISMATCH');
  assert.equal(g.calls.prepares, 1);
});

test('chat confirmation never calls Core.decide/execute, session expiry cannot restore authority', async t => {
  const f = await fixture(t); const original = await preview(f);
  const response = await f.post({ ...continueTask(original), message: '确认' });
  assert.equal(response.code, 'CONFIRMATION_REQUIRED');
  assert.equal(response.data.conversation.token, original.data.conversation.token);
  assert.equal((await f.core.getOperation(original.data.operationId)).data.state, 'awaiting_confirmation');
  f.advance(1800000);
  const expired = await f.post({ conversationToken: original.data.conversation.token, message: '查看2026年8月账单' });
  assert.equal(expired.code, 'CONVERSATION_EXPIRED');
  assert.equal(expired.data.conversation, undefined);
  const fresh = await f.post({ message: '查看2026年8月账单' });
  assert.equal(fresh.data.status, 'bill_result');
  assert.notEqual(fresh.data.conversation.token, original.data.conversation.token);
  assert.equal(fresh.data.conversation.operationReferences.length, 0);
});

test('an older preview executed through Core ends its owning task instead of allowing another edit', async t => {
  const f = await fixture(t); const original = await preview(f);
  const edited = await f.post({ ...continueTask(original), message: '改成100元' });
  await f.core.decide(original.data.operationId, { decision: 'confirm', previewHash: original.data.preview.previewHash, confirmedStepIds: original.data.preview.stepIds });
  const executed = await f.core.execute(original.data.operationId, original.data.preview.previewHash);
  assert.equal(executed.ok, true);
  const refused = await f.post({ ...continueTask(edited), message: '改成100元' });
  assert.equal(refused.code, 'CONVERSATION_TASK_FINISHED');
  assert.equal(refused.data.conversation.currentTask.status, 'completed');
  assert.equal(f.calls.prepares, 2);
  assert.equal(f.core.repository.getTransactions().length, f.beforeTransactions + 1);
});

test('all recoverable errors preserve session metadata, rotate options, and keep a new query usable', async t => {
  const f = await fixture(t); const first = await f.post({ message: '给张三转500元' });
  const invalid = await f.post({ ...continueTask(first), choice: { optionId: 'opt_fake' } });
  assert.equal(invalid.code, 'INVALID_CHOICE');
  assert.equal(invalid.data.conversation.token, first.data.conversation.token);
  assert.notEqual(invalid.data.recovery.continuationToken, first.data.continuationToken);
  const valid = await f.post({ ...session(invalid), continuationToken: invalid.data.recovery.continuationToken, choice: { optionId: invalid.data.recovery.choices[0].optionId } });
  assert.equal(valid.data.status, 'awaiting_confirmation');
  const malformed = await f.post({ ...session(valid), message: '查账单', confirmed: true });
  assert.equal(malformed.code, 'INVALID_REQUEST');
  assert.equal(malformed.data.conversation.token, valid.data.conversation.token);
  const ok = await f.post({ ...session(malformed), message: '查看2026年8月账单' });
  assert.equal(ok.data.status, 'bill_result');
});

test('HTTP → real askBankingAgent validates session metadata on success and recovery, rejects forged metadata', async t => {
  const f = await fixture(t); const actualFetch = global.fetch;
  let mutate;
  global.fetch = async (url, init) => {
    const response = await actualFetch(`${f.url}${url}`, { ...init, headers: { ...init.headers, 'X-Forwarded-For': `client-conversation-${++serial}` } });
    if (!mutate) return response;
    const payload = await response.json(); mutate(payload.data.conversation);
    return Response.json(payload, { status: response.status });
  };
  t.after(() => { global.fetch = actualFetch; });
  const signal = new AbortController().signal;
  const first = await askBankingAgent({ message: '给张三转500元' }, env.SAVEFLOW_ACCESS_CODE, signal);
  let recovery;
  await assert.rejects(askBankingAgent({ conversationToken: first.conversation.token, conversationRevision: first.conversation.revision,
    continuationToken: first.continuationToken, choice: { optionId: 'opt_fake' } }, env.SAVEFLOW_ACCESS_CODE, signal), e => {
    assert.ok(e instanceof BankingAgentError); assert.equal(e.code, 'INVALID_CHOICE');
    assert.equal(e.conversation.token, first.conversation.token); recovery = e.recovery; return true;
  });
  const billResult = await askBankingAgent({ conversationToken: recovery.conversation.token, conversationRevision: recovery.conversation.revision,
    taskMode: 'new', message: '查看2026年8月账单' }, env.SAVEFLOW_ACCESS_CODE, signal);
  assert.equal(billResult.status, 'bill_result');
  for (mutate of [v => { v.revision = -1; }, v => { v.token = 'conv_forged'; }, v => { v.token = `cs1.${'A'.repeat(43)}`; }, v => { v.currentTask.confirmed = true; }, v => { v.operationReferences.push({ operationId: 'op_fake', taskId: v.currentTask.taskId, coreState: 'fabricated' }); }]) {
    await assert.rejects(askBankingAgent({ conversationToken: billResult.conversation.token, taskMode: 'new', message: '查看2026年8月账单' }, env.SAVEFLOW_ACCESS_CODE, signal), e => e.code === 'BANKING_AGENT_RESPONSE_ERROR');
  }
});

test('session sync is read-only, uses no model, and current-task resume requires its original credential', async t => {
  const f = await fixture(t); const original = await preview(f);
  const before = { prepares: f.calls.prepares, understands: f.calls.understands.length };
  const sync = await f.post({ ...session(original), taskMode: 'sync' });
  assert.equal(sync.data.status, 'conversation_state');
  assert.equal(sync.data.conversation.token, original.data.conversation.token);
  assert.deepEqual({ prepares: f.calls.prepares, understands: f.calls.understands.length }, before);
  const forbidden = await f.post({ ...session(sync), taskMode: 'sync', message: '给张三转500元' });
  assert.equal(forbidden.code, 'INVALID_REQUEST');
  assert.deepEqual({ prepares: f.calls.prepares, understands: f.calls.understands.length }, before);
  const resumed = await f.post({ ...session(forbidden), taskMode: 'resume', taskId: original.data.conversation.currentTask.taskId, continuationToken: original.data.continuationToken });
  assert.equal(resumed.data.status, 'awaiting_confirmation');
  assert.notEqual(resumed.data.operationId, original.data.operationId);
  assert.equal(f.calls.understands.length, before.understands);
});

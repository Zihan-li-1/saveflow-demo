/* eslint-disable @typescript-eslint/no-require-imports -- Compile and mount the real Hook and page in Node. */
const { readFileSync } = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { create, act } = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;
const resolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...args) {
  return resolve.call(this, request.startsWith('@/') ? path.join(__dirname, '../src', request.slice(2)) : request, ...args);
};
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  module._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, filename);
};
require.extensions['.css'] = () => {};
const agent = require('../src/lib/banking-agent-client.ts');
const hook = require('../src/lib/use-saveflow.ts');
const { ApiError } = require('../src/lib/api/contracts.ts');
const realHook = hook.useSaveflow;
const realAsk = agent.askBankingAgent;
let flow, root, core, handleBanking, handleAgent;
hook.useSaveflow = () => { flow = realHook(); return flow; };
const Home = require('../src/app/page.tsx').default;
const env = { SAVEFLOW_ACCESS_CODE: 'test-access-code-1234', CONTINUATION_TOKEN_SECRET: 'test-continuation-secret-1234' };
const originalFetch = global.fetch;
let intent, calls, intercept, requestSequence = 0;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const reply = { text: 'test response', style: 'concise', safetyNotices: [] };
const composer = () => root.root.findAllByType('input').find(node => node.props.placeholder === '输入转账、账单或卡片请求…');
const loading = () => root.root.findAll(node => node.props.className === 'typing').length > 0;
const preview = () => { const message = flow.messages.findLast(message => message.banking?.status === 'awaiting_confirmation'); assert.ok(message, JSON.stringify(flow.messages)); return message.banking; };
const savingsObservation = facts => {
  const category = '购物';
  const previous = facts.history.map(month => month.category_expenses_minor[category]).filter(Number.isSafeInteger);
  const average = previous.reduce((sum, value) => sum + value, 0) / previous.length;
  const difference = facts.recent.category_expenses_minor[category] - average;
  const trend = difference > Math.max(1000, average * .1) ? 'up' : difference < -Math.max(1000, average * .1) ? 'down' : 'flat';
  return { category, trend, evidence_refs: [`recent:${category}`, `history:${facts.history[0].month}:${category}`], reason: '近期与历史演示数据仅供参考', uncertain: true };
};
async function mount() {
  calls = []; intercept = null;
  const storage = new Map();
  global.sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const { createBankingCore } = await import('../src/banking-core/core.mjs');
  core = createBankingCore();
  global.fetch = async (url, init) => {
    init.headers["x-forwarded-for"] = `lifecycle-${++requestSequence}`;
    const body = JSON.parse(init.body); calls.push(body.action || 'agent');
    const run = () => url === '/api/banking-agent'
      ? handleAgent(new Request(`http://localhost${url}`, init), { env, core, parseIntent: async () => intent, savingsAdvisor: async facts => ({ observations: [savingsObservation(facts)], category_budgets: Object.entries(facts.recent.category_expenses_minor).map(([category, suggested_minor]) => ({ category, suggested_minor, reason: '近期数据参考', evidence_refs: [`recent:${category}`] })), caveats: [], self_review: { passed: true, data_coverage: true, category_evidence: true, fixed_costs: true, budget_totals: true, uncertainty: true, failed_items: [] } }) })
      : handleBanking(new Request(`http://localhost${url}`, init), { env, core });
    return intercept ? intercept(body, run) : run();
  };
  await act(async () => { root = create(React.createElement(Home)); });
  await act(async () => { flow.setConsent(true); flow.setAccessCode(env.SAVEFLOW_ACCESS_CODE); flow.setInput('test'); });
}
const cardIntent = action => ({ schemaVersion: '1.0.0', action, slots: { card_ref: '娱乐虚拟卡', ...(action === 'card.set_budget' ? { amount: { amount_minor: 100000, currency: 'CNY' } } : {}), ...(action === 'card.set_controls' ? { online_payments_enabled: false } : {}) }, missingSlots: [], status: 'ready_for_resolution' });
async function start(action = 'card.get') {
  intent = cardIntent(action);
  await act(async () => { await flow.startDemo('test request'); });
}
function ready() {
  assert.equal(loading(), false);
  assert.equal(flow.canStart, true);
  assert.equal(composer().props.disabled, false);
  act(() => { flow.setInput('next request'); });
  assert.equal(root.root.findAllByType('button').find(node => node.props.className === 'send').props.disabled, !flow.consent);
}
before(async () => {
  ({ handleBanking } = await import('../server/banking.mjs'));
  ({ handleBankingAgent: handleAgent } = await import('../server/banking-agent.mjs'));
});
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; agent.askBankingAgent = realAsk; });
after(() => { global.fetch = originalFetch; delete global.sessionStorage; });

test('savings form resumes the goal and displays only a verified card', async () => {
  await mount();
  intent = { schemaVersion: '1.0.0', action: 'orchestrator.goal', slots: { goal_text: '年底存一万', amount: { amount_minor: 1000000, currency: 'CNY' }, deadline: '2026-12-31' }, missingSlots: [], status: 'ready_for_resolution' };
  await act(async () => { await flow.startDemo('年底存一万'); });
  const pending = flow.messages.findLast(message => message.banking?.status === 'needs_plan_inputs')?.banking;
  assert.ok(pending?.continuationToken);
  assert.equal(flow.messages.some(message => message.banking?.status === 'goal_plan'), false);
  const form = root.root.findAll(node => node.type === 'form' && node.props['aria-label'] === '补充储蓄计划数据')[0];
  assert.ok(form);
  const inputs = form.findAllByType('input');
  assert.equal(pending.recentSource, 'repository');
  assert.equal(inputs.length, 1);
  await act(async () => {
    inputs[0].props.onChange({ target: { value: '0' } });
  });
  const filled = root.root.findAll(node => node.type === 'form' && node.props['aria-label'] === '补充储蓄计划数据')[0];
  await act(async () => { filled.props.onSubmit({ preventDefault() {} }); await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.equal(flow.messages.findLast(message => message.banking?.status === 'goal_plan')?.banking?.data?.verification_status, 'verified');
  assert.ok(root.root.findAll(node => node.props['aria-label'] === '储蓄计划卡片').length);
  assert.equal(flow.canStart, true);
  const plan = flow.messages.findLast(message => message.banking?.status === 'goal_plan').banking;
  const beforeScreening = (await core.repository.getAccounts())[0].availableBalanceFen;
  const wealthForm = root.root.findAll(node => node.type === 'form' && node.props['aria-label'] === '储蓄目标理财筛选条件')[0];
  assert.ok(wealthForm);
  await act(async () => {
    wealthForm.findAllByType('input')[0].props.onChange({ target: { value: '1000' } });
    const selects = wealthForm.findAllByType('select');
    selects[0].props.onChange({ target: { value: 'R2' } });
    selects[1].props.onChange({ target: { value: 'T+1' } });
  });
  let submitted;
  intercept = (body, run) => { if (body.wealthInputs) submitted = body; return run(); };
  const filledWealth = root.root.findAll(node => node.type === 'form' && node.props['aria-label'] === '储蓄目标理财筛选条件')[0];
  await act(async () => { filledWealth.props.onSubmit({ preventDefault() {} }); await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.equal(submitted.continuationToken, plan.wealthHandoffToken);
  assert.deepEqual(submitted.wealthInputs, { investable_amount_minor: 100000, max_risk_level: 'R2', liquidity_requirement: 'T+1' });
  assert.equal(flow.messages.findLast(message => message.banking?.status === 'wealth_result')?.banking?.data?.kind, 'recommendation');
  assert.equal((await core.repository.getAccounts())[0].availableBalanceFen, beforeScreening);
});

test('refresh resumes the separate Wealth screening without skipping its required inputs', async () => {
  await mount();
  intent = { schemaVersion: '1.0.0', action: 'orchestrator.goal', slots: { goal_text: '年底存一万', amount: { amount_minor: 1000000, currency: 'CNY' }, deadline: '2026-12-31' }, missingSlots: [], status: 'ready_for_resolution' };
  await act(async () => { await flow.startDemo('年底存一万'); });
  const savings = root.root.findAll(node => node.type === 'form' && node.props['aria-label'] === '补充储蓄计划数据')[0];
  const inputs = savings.findAllByType('input');
  assert.equal(inputs.length, 1);
  await act(async () => {
    inputs[0].props.onChange({ target: { value: '0' } });
  });
  const filled = root.root.findAll(node => node.type === 'form' && node.props['aria-label'] === '补充储蓄计划数据')[0];
  await act(async () => { filled.props.onSubmit({ preventDefault() {} }); });
  const plan = flow.messages.findLast(message => message.banking?.status === 'goal_plan')?.banking;
  assert.ok(plan?.wealthHandoffToken);
  const task = plan.conversation.currentTask;
  assert.equal(task.action, 'wealth.recommend');
  assert.equal(flow.sessionTasks.find(item => item.taskId === task.taskId)?.canResume, true);
  await act(async () => { root.unmount(); root = create(React.createElement(Home)); });
  await act(async () => { flow.setAccessCode(env.SAVEFLOW_ACCESS_CODE); flow.setConsent(true); });
  await act(async () => { await flow.verifyBankingSession(); });
  assert.equal(flow.sessionTasks.find(item => item.taskId === task.taskId)?.canResume, true);
  await act(async () => { await flow.resumeBankingTask(task.taskId); });
  assert.equal(flow.messages.some(message => message.banking?.status === 'wealth_result'), false);
  const wealth = root.root.findAll(node => node.type === 'form' && node.props['aria-label'] === '储蓄目标理财筛选条件')[0];
  assert.ok(wealth);
  await act(async () => {
    wealth.findAllByType('input')[0].props.onChange({ target: { value: '1000' } });
    const selects = wealth.findAllByType('select');
    selects[0].props.onChange({ target: { value: 'R2' } });
    selects[1].props.onChange({ target: { value: 'T+1' } });
  });
  const filledWealth = root.root.findAll(node => node.type === 'form' && node.props['aria-label'] === '储蓄目标理财筛选条件')[0];
  await act(async () => { filledWealth.props.onSubmit({ preventDefault() {} }); });
  assert.equal(flow.messages.findLast(message => message.banking?.status === 'wealth_result')?.banking?.data?.kind, 'recommendation');
});

test('same page: card query → freeze → verify → bill → unfreeze → query → budget and controls', async () => {
  await mount();
  await start(); ready();
  for (const action of ['card.freeze', 'card.unfreeze', 'card.set_budget', 'card.set_controls']) {
    await start(action); ready();
    const data = preview();
    assert.equal(flow.stage, 'answered');
    assert.equal(flow.coreOperations[data.operationId], 'plan');
    assert.equal(root.root.findAllByType('button').findLast(node => node.children.includes('确认并执行')).props.disabled, false);
    await act(async () => { await flow.confirmCardOperation(data); });
    ready();
    assert.equal(flow.cardBusy, false);
    assert.equal(flow.activeCardOperationId, null);
    assert.equal(flow.coreOperations[data.operationId], 'success');
    const count = calls.filter(action => action === 'action.execute').length;
    await act(async () => { await flow.confirmCardOperation(data); });
    assert.equal(calls.filter(action => action === 'action.execute').length, count);
    if (action === 'card.freeze') {
      intent = { schemaVersion: '1.0.0', action: 'bill.summary', slots: { month: '2025-08' }, missingSlots: [], status: 'ready_for_resolution' };
      await act(async () => { await flow.startDemo('bill'); }); ready();
    }
    await start(); ready();
  }
});

test('all accepted read, clarification, scenario and preview statuses finish Agent loading', async () => {
  await mount();
  for (const status of ['bill_result', 'card_result', 'wealth_result', 'subscription_result', 'product_result', 'wealth_recommendation', 'wealth_comparison', 'risk_assessment_required', 'goal_plan', 'scenario_rule_preview', 'scenario_rule', 'scenario_event_review', 'cancelled', 'unsupported', 'needs_clarification', 'awaiting_confirmation']) {
    agent.askBankingAgent = async () => ({ status, reply });
    await start(); ready();
    assert.equal(flow.stage, status === 'needs_clarification' ? 'clarifying' : 'answered', status);
  }
});

test('Agent network failure, timeout and malformed status are recoverable', async () => {
  await mount();
  for (const error of [new ApiError('TIMEOUT', 'timeout'), new Error('network')]) {
    agent.askBankingAgent = async () => { throw error; };
    await start(); ready(); assert.equal(flow.stage, 'error');
  }
  agent.askBankingAgent = async () => ({ status: 'future_invalid_status', reply });
  await start(); ready(); assert.equal(flow.stage, 'error');
  agent.askBankingAgent = realAsk;
  await start(); ready();
});

for (const phase of ['action.decide', 'action.execute', 'card.get']) test(`Core ${phase} locks input and cross-Skill calls synchronously`, async () => {
  await mount(); await start('card.freeze');
  const data = preview(), gate = deferred();
  intercept = async (body, run) => { if (body.action === phase) await gate.promise; return run(); };
  let pending;
  await act(async () => { pending = flow.confirmCardOperation(data); });
  assert.equal(flow.canStart, false); assert.equal(composer().props.disabled, true);
  assert.equal(flow.cardBusy, true); assert.equal(loading(), false);
  const count = calls.length;
  await act(async () => { await flow.confirmCardOperation(data); await flow.startDemo('next'); flow.restart(); flow.changeModelMode('mock'); });
  assert.equal(calls.length, count); assert.equal(flow.modelMode, 'banking');
  await act(async () => { gate.resolve(); await pending; });
  ready(); assert.equal(calls.filter(action => action === 'action.execute').length, 1);
});

test('unknown execution never retries, retains ID and status query recovers original receipt', async () => {
  await mount(); await start('card.freeze'); const data = preview();
  intercept = async (body, run) => { const response = await run(); if (body.action === 'action.execute') throw new Error('lost response'); return response; };
  await act(async () => { await flow.confirmCardOperation(data); });
  assert.equal(flow.coreOperations[data.operationId], 'unknown');
  assert.equal(flow.canStart, true); assert.equal(composer().props.disabled, false); assert.equal(loading(), false); assert.equal(flow.cardBusy, false);
  const count = calls.length;
  await act(async () => { await flow.confirmCardOperation(data); flow.restart(); });
  assert.equal(calls.length, count);
  assert.ok(root.root.findAllByType('button').some(node => node.children.includes('查询操作状态') && !node.props.disabled));
  intercept = null;
  await start("card.get"); ready();
  assert.equal(flow.coreOperations[data.operationId], "unknown");
  await act(async () => { await flow.checkCardOperation(data); });
  ready(); assert.equal(flow.coreOperations[data.operationId], 'success');
  assert.equal(calls.filter(action => action === 'action.execute').length, 1);
});

test('verification failure stays unknown even when read error has uncertain=false', async () => {
  await mount(); await start('card.freeze'); const data = preview();
  intercept = async (body, run) => { if (body.action === 'card.get') throw new Error('read unavailable'); return run(); };
  await act(async () => { await flow.confirmCardOperation(data); });
  assert.equal(flow.coreOperations[data.operationId], 'unknown'); assert.equal(flow.cardBusy, false); assert.equal(flow.canStart, true);
  intercept = null;
  await act(async () => { await flow.checkCardOperation(data); }); ready();
});

test('reject ends preview without executing; safe Core rejection permits a new request', async () => {
  await mount(); await start('card.freeze'); let data = preview();
  await act(async () => { await flow.rejectCardOperation(data); }); ready();
  assert.equal(flow.coreOperations[data.operationId], 'cancelled');
  assert.equal(calls.includes('action.execute'), false);
  await start('card.freeze'); data = preview();
  intercept = async (body, run) => body.action === 'action.execute' ? Response.json({ schema_version: '1.1.0', request_id: 'r', code: 'PREVIEW_EXPIRED', message: 'expired' }, { status: 400 }) : run();
  await act(async () => { await flow.confirmCardOperation(data); }); ready(); assert.equal(flow.coreOperations[data.operationId], 'error');
});

test('transfer preview, receipt verification, duplicate guard and next Skill work on same page', async () => {
  await mount();
  intent = { schemaVersion: '1.0.0', action: 'transfer.create', slots: { payee_ref: '张三', source_account_ref: '活期账户', amount: { amount_minor: 10000, currency: 'CNY' } }, missingSlots: [], status: 'ready_for_resolution' };
  await act(async () => { await flow.startDemo('transfer'); }); ready();
  const data = preview(); assert.equal(flow.activeTransferOperationId, data.operationId);
  await act(async () => { await flow.confirmTransferOperation(data); }); ready();
  assert.equal(flow.coreOperations[data.operationId], 'success'); assert.equal(flow.transferBusy, false);
  await act(async () => { await flow.confirmTransferOperation(data); });
  assert.equal(calls.filter(action => action === 'action.execute').length, 1);
  await start(); ready();
});

test('wealth preview and verified receipt end independently from Agent request', async () => {
  await mount();
  intent = { schemaVersion: '1.0.0', action: 'wealth.subscribe', slots: { product_ref: '模拟灵活现金 A', amount: { amount_minor: 10000, currency: 'CNY' }, source_account_ref: '活期账户' }, missingSlots: [], status: 'ready_for_resolution' };
  await act(async () => { await flow.startDemo('wealth'); }); ready();
  const data = preview();
  await act(async () => { await flow.confirmCardOperation(data); }); ready();
  assert.equal(flow.coreOperations[data.operationId], 'success');
});

test('stale response/finally after reset cannot settle or overwrite the next request', async () => {
  await mount(); const old = deferred(), next = deferred(); let count = 0;
  agent.askBankingAgent = () => (++count === 1 ? old.promise : next.promise);
  let first, second;
  await act(async () => { first = flow.startDemo('first'); }); assert.equal(loading(), true);
  await act(async () => { flow.restart(); });
  await act(async () => { flow.setConsent(true); });
  await act(async () => { second = flow.startDemo('second'); });
  await act(async () => { old.resolve({ status: 'unsupported', reply }); await first; });
  assert.equal(flow.stage, 'analyzing'); assert.equal(loading(), true);
  await act(async () => { next.resolve({ status: 'unsupported', reply }); await second; }); ready();
  assert.equal(flow.messages.filter(message => message.text === reply.text).length, 1);
});

test('pending status and failed status query retain unknown without resubmission', async () => {
  await mount(); await start('card.freeze'); const data = preview();
  intercept = async (body, run) => { if (body.action === 'action.execute') throw new Error('disconnected before response'); return run(); };
  await act(async () => { await flow.confirmCardOperation(data); });
  intercept = null;
  await act(async () => { await flow.checkCardOperation(data); });
  assert.equal(flow.coreOperations[data.operationId], 'plan'); assert.equal(flow.canStart, true);
  assert.equal(flow.activeCardOperationId, data.operationId);
  intercept = async () => { throw new Error('offline'); };
  await act(async () => { await flow.checkCardOperation(data); });
  assert.equal(flow.coreOperations[data.operationId], 'unknown'); assert.equal(flow.cardBusy, false);
  assert.equal(calls.filter(action => action === 'action.execute').length, 1);
});

test('unknown survives remount with query entry and no execution authority', async () => {
  await mount(); await start('card.freeze'); const data = preview();
  intercept = async (body, run) => { const response = await run(); if (body.action === 'action.execute') throw new Error('lost response'); return response; };
  await act(async () => { await flow.confirmCardOperation(data); });
  await act(async () => { root.unmount(); });
  await act(async () => { root = create(React.createElement(Home)); });
  assert.equal(flow.coreOperations[data.operationId], 'unknown'); assert.equal(flow.canStart, true); assert.equal(flow.activeCardOperationId, null);
  await act(async () => { flow.setAccessCode(env.SAVEFLOW_ACCESS_CODE); });
  intercept = null;
  await act(async () => { await flow.checkCardOperation(data); }); ready();
  assert.equal(calls.filter(action => action === 'action.execute').length, 1);
});

test('unmounted Core verification cannot update a new Hook instance', async () => {
  await mount(); await start('card.freeze'); const data = preview(), gate = deferred();
  intercept = async (body, run) => { if (body.action === 'card.get') await gate.promise; return run(); };
  let pending;
  await act(async () => { pending = flow.confirmCardOperation(data); });
  await act(async () => { root.unmount(); root = create(React.createElement(Home)); });
  assert.equal(flow.coreOperations[data.operationId], 'unknown');
  const count = flow.messages.length;
  await act(async () => { gate.resolve(); await pending; });
  assert.equal(flow.messages.length, count); assert.equal(flow.coreOperations[data.operationId], 'unknown');
});

test('transfer verification failure retains query entry and never re-executes', async () => {
  await mount();
  intent = { schemaVersion: '1.0.0', action: 'transfer.create', slots: { payee_ref: '张三', source_account_ref: '活期账户', amount: { amount_minor: 10000, currency: 'CNY' } }, missingSlots: [], status: 'ready_for_resolution' };
  await act(async () => { await flow.startDemo('transfer'); }); const data = preview();
  intercept = async (body, run) => { if (body.action === 'transaction.list') throw new Error('verification offline'); return run(); };
  await act(async () => { await flow.confirmTransferOperation(data); });
  assert.equal(flow.coreOperations[data.operationId], 'unknown'); assert.equal(flow.transferBusy, false); assert.equal(flow.canStart, true);
  await act(async () => { await flow.confirmTransferOperation(data); });
  intercept = null;
  await act(async () => { await flow.checkTransferOperation(data); }); ready();
  assert.equal(calls.filter(action => action === 'action.execute').length, 1);
});

test('legacy trial bridge network loss is uncertain; read-only status uses original Core ID', async () => {
  await mount();
  const prepared = await core.prepare({ action: 'transfer_money', input: { fromAccountId: 'ACC-CHECKING', payeeId: 'payee_001', amountFen: 10000, currency: 'CNY' }, origin: 'agent_suggested' });
  assert.equal(prepared.ok, true);
  const data = { ...prepared.data, status: 'awaiting_confirmation', action: 'transfer.create', operationId: `tfpreview:${prepared.data.operationId}`, source: 'trueforge-mcp', reply };
  agent.askBankingAgent = async () => data;
  await start(); ready();
  const { handleExecuteTrial } = await import('../server/transfer-execute-bridge.mjs');
  const fetchBefore = global.fetch;
  global.fetch = async (url, init) => {
    if (url !== '/api/execute-trial') return fetchBefore(url, init);
    await handleExecuteTrial(new Request(`http://localhost${url}`, init), { env, core });
    throw new Error('lost bridge response');
  };
  await act(async () => { await flow.confirmTransferOperation(data); });
  assert.equal(flow.coreOperations[data.operationId], 'unknown'); assert.equal(flow.canStart, true);
  await act(async () => { await flow.confirmTransferOperation(data); });
  await act(async () => { await flow.checkTransferOperation(data); }); ready();
  assert.equal(flow.coreOperations[data.operationId], 'success');
});

test('real browser client handles HTTP failure and an aborted timeout signal, then accepts UI send', async () => {
  await mount();
  intercept = async () => Response.json({ code: 'SERVICE_UNAVAILABLE', message: 'offline' }, { status: 503 });
  await start(); ready(); assert.equal(flow.stage, 'error');
  const timeout = AbortSignal.timeout;
  try {
    AbortSignal.timeout = () => AbortSignal.abort(new DOMException('test timeout', 'TimeoutError'));
    const fetchBefore = global.fetch;
    global.fetch = (url, init) => { init.signal.throwIfAborted(); return fetchBefore(url, init); };
    await start(); ready(); assert.equal(flow.stage, 'error');
    global.fetch = fetchBefore;
  } finally { AbortSignal.timeout = timeout; }
  intercept = null; intent = cardIntent('card.get');
  await act(async () => { composer().props.onChange({ target: { value: 'query card' } }); });
  await act(async () => { await root.root.findAllByType('button').find(node => node.props.className === 'send').props.onClick(); });
  ready(); assert.equal(flow.messages.at(-1).kind, 'banking_card');
});

test('real clarification options remain usable after the Agent request ends', async () => {
  await mount(); intent = { ...cardIntent('card.freeze'), slots: { card_ref: '我的卡' } };
  await act(async () => { await flow.startDemo('冻结我的卡'); }); ready();
  assert.equal(flow.stage, 'clarifying');
  const choice = flow.messages.at(-1).banking.choices[0];
  await act(async () => { await flow.chooseBankingOption(choice.optionId, choice.label); });
  ready(); assert.equal(flow.stage, 'answered'); assert.ok(preview().operationId);
});

test('ConversationState UI: transfer clarification survives a card query and resumes with fresh account options', async () => {
  await mount();
  const { buildParsedIntent } = require('../src/agent/clarification/merge-intent.mjs');
  intent = buildParsedIntent('transfer.create', { payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' } });
  await act(async () => { await flow.startDemo('给张三转500元'); });
  const task = flow.sessionTasks.find(task => task.action === 'transfer.create');
  const oldOptions = flow.messages.at(-1).banking.choices.map(choice => choice.optionId);
  await start('card.get');
  assert.equal(flow.sessionTasks.find(t => t.taskId === task.taskId).status, 'suspended');
  await act(async () => { await flow.resumeBankingTask(task.taskId); });
  const renewed = flow.messages.at(-1).banking;
  assert.equal(renewed.slot, 'source_account_ref');
  assert.ok(renewed.choices.every(choice => !oldOptions.includes(choice.optionId)));
  await act(async () => { await flow.chooseBankingOption(renewed.choices[0].optionId, renewed.choices[0].label, renewed); });
  assert.equal(preview().preview.exactEffects[0].amountFen, 50000);
  ready();
});

test('ConversationState UI: bill focus preserves transfer task and editing the resumed task produces another preview', async () => {
  await mount();
  const { buildParsedIntent } = require('../src/agent/clarification/merge-intent.mjs');
  const slots = { payee_ref: '张三', source_account_ref: '活期账户', amount: { amount_minor: 50000, currency: 'CNY' } };
  intent = buildParsedIntent('transfer.create', slots);
  await act(async () => { await flow.startDemo('从活期账户给张三转500元'); });
  const original = preview(); const task = flow.sessionTasks.find(task => task.action === 'transfer.create');
  intent = buildParsedIntent('bill.summary', { month: '2026-08' });
  await act(async () => { await flow.startDemo('查看2026年8月账单'); });
  assert.equal(flow.activeTransferOperationId, null);
  await act(async () => { await flow.resumeBankingTask(task.taskId); });
  const resumed = preview(); assert.notEqual(resumed.operationId, original.operationId);
  intent = buildParsedIntent('transfer.create', { ...slots, amount: { amount_minor: 60000, currency: 'CNY' } });
  await act(async () => { await flow.editTransferPreview(resumed, '给张三转600元'); });
  const edited = preview(); assert.notEqual(edited.operationId, resumed.operationId);
  assert.equal(edited.preview.exactEffects[0].amountFen, 60000);
  assert.equal(edited.conversation.currentTask.taskId, task.taskId);
  ready();
});

test('ConversationState UI: explicit chat resume uses the unique server task and its original credential, not a model-created draft', async () => {
  await mount();
  const { buildParsedIntent } = require('../src/agent/clarification/merge-intent.mjs');
  intent = buildParsedIntent('transfer.create', { payee_ref: '张三', source_account_ref: '活期账户', amount: { amount_minor: 50000, currency: 'CNY' } });
  await act(async () => { await flow.startDemo('从活期账户给张三转500元'); });
  const original = preview();
  await start('card.get');
  intent = buildParsedIntent('clarify', {}); // No model may select or reconstruct the old task.
  let submitted;
  intercept = (body, run) => { submitted = body; return run(); };
  await act(async () => { await flow.startDemo('继续刚才的转账'); });
  assert.equal(submitted.taskMode, 'resume');
  assert.equal(submitted.taskId, original.conversation.currentTask.taskId);
  assert.equal(submitted.message, undefined);
  assert.equal(preview().conversation.currentTask.taskId, original.conversation.currentTask.taskId);
  assert.notEqual(preview().operationId, original.operationId);
  assert.equal(preview().preview.exactEffects[0].amountFen, 50000);
  ready();
});

test('ConversationState UI: ambiguous chat resume asks for task selection without calling the model or Core', async () => {
  await mount();
  const { buildParsedIntent } = require('../src/agent/clarification/merge-intent.mjs');
  intent = buildParsedIntent('transfer.create', { payee_ref: '张三', source_account_ref: '活期账户', amount: { amount_minor: 50000, currency: 'CNY' } });
  await act(async () => { await flow.startDemo('从活期账户给张三转500元'); });
  act(() => flow.restartBankingFlow());
  await act(async () => { await flow.startDemo('另给张三转500元'); });
  await start('card.get');
  assert.equal(flow.sessionTasks.filter(task => task.action === 'transfer.create').length, 2);
  const before = calls.length;
  await act(async () => { await flow.startDemo('继续刚才的转账'); });
  assert.equal(calls.length, before);
  assert.match(flow.validation, /选择要恢复的转账/);
  ready();
});

test('ConversationState UI: refresh restores only an opaque token, then sync and explicit resume obtain fresh authority', async () => {
  await mount();
  const { buildParsedIntent } = require('../src/agent/clarification/merge-intent.mjs');
  intent = buildParsedIntent('transfer.create', { payee_ref: '张三', source_account_ref: '活期账户', amount: { amount_minor: 50000, currency: 'CNY' } });
  await act(async () => { await flow.startDemo('从活期账户给张三转500元'); });
  const original = preview(); const token = original.conversation.token;
  const raw = sessionStorage.getItem('saveflow.banking-chat.v1');
  assert.equal(JSON.parse(raw).conversationToken, token);
  assert.ok(!raw.includes(env.SAVEFLOW_ACCESS_CODE));
  assert.equal(JSON.parse(raw).accessCode, undefined);
  await act(async () => { root.unmount(); root = create(React.createElement(Home)); });
  assert.equal(flow.sessionPhase, 'unverified'); assert.equal(flow.activeTransferOperationId, null);
  assert.equal(flow.accessCode, ''); assert.equal(flow.consent, false);
  const before = calls.length;
  await act(async () => { await flow.confirmTransferOperation(preview()); });
  assert.equal(calls.length, before);
  await act(async () => { flow.setAccessCode(env.SAVEFLOW_ACCESS_CODE); flow.setConsent(true); });
  await act(async () => { await flow.verifyBankingSession(); });
  assert.equal(flow.sessionPhase, 'ready'); assert.equal(flow.activeTransferOperationId, null);
  await act(async () => { await flow.resumeBankingTask(original.conversation.currentTask.taskId); });
  assert.notEqual(preview().operationId, original.operationId);
  assert.equal(preview().conversation.token, token);
  assert.equal(preview().historySnapshot, undefined);
  ready();
});

test('ConversationState UI: forged cached session is rejected and a new business works without clearing history', async () => {
  await mount(); await start('card.get');
  const key = 'saveflow.banking-chat.v1';
  const snapshot = JSON.parse(sessionStorage.getItem(key));
  snapshot.conversationToken = `cs1.${'A'.repeat(43)}`;
  sessionStorage.setItem(key, JSON.stringify(snapshot));
  await act(async () => { root.unmount(); root = create(React.createElement(Home)); });
  await act(async () => { flow.setAccessCode(env.SAVEFLOW_ACCESS_CODE); flow.setConsent(true); });
  await act(async () => { await flow.verifyBankingSession(); });
  assert.equal(flow.sessionPhase, 'failed'); ready();
  const oldCount = flow.messages.length;
  act(() => flow.restartBankingFlow());
  await start('card.get');
  assert.equal(flow.sessionPhase, 'ready');
  assert.ok(flow.messages.length > oldCount);
  ready();
});


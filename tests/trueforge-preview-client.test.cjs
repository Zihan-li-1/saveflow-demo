/* eslint-disable @typescript-eslint/no-require-imports -- Render the actual preview and use the actual TS client. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  const source = readFileSync(filename, 'utf8').replace(/from "@\/lib\//g, 'from "../lib/');
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, filename);
};
require.extensions['.css'] = () => {}; // Render markup without a browser stylesheet loader.
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { BankingCardPreview } = require('../src/app/BankingCardCards.tsx');
const { askBankingAgent, BankingAgentError, hasBankingChoices } = require('../src/lib/banking-agent-client.ts');
const { BankingTransferPreview } = require('../src/app/BankingTransferPreview.tsx');
const { BankingTransferReceipt } = require('../src/app/BankingTransferReceipt.tsx');
const { saveBankingChat, restoreBankingChat } = require('../src/lib/banking-chat-storage.ts');
const { updateBankingFlows, transferFlow } = require('../src/lib/banking-flow-state.ts');
const { bankingTaskBoundary } = require('../src/lib/trueforge-routing.mjs');
test('bill period clarification stays text-only until selectable choices or a bill result exists', () => {
  assert.equal(hasBankingChoices({ status: 'needs_clarification', action: 'bill.summary', question: '想看哪个月的账单？', choices: [] }), false);
  assert.equal(hasBankingChoices({ status: 'needs_clarification', action: 'bill.summary', question: '想看哪个时间段的账单？' }), false);
  assert.equal(hasBankingChoices({ status: 'needs_clarification', action: 'transfer.create', choices: [{ optionId: 'account-1', label: '模拟活期账户' }] }), true);
  assert.equal(hasBankingChoices({ status: 'bill_result', action: 'bill.summary', choices: [] }), false);
});
test('browser accepts validated insufficient-balance recovery only as an error/clarification, never a success card', async () => {
  const original = global.fetch;
  const data = { status: 'error', error: { code: 'INSUFFICIENT_BALANCE' }, recovery: { kind: 'clarification', status: 'needs_clarification', action: 'transfer.create', slot: 'source_account_ref', source: 'trueforge-mcp',
    question: '模拟储蓄账户可用 ¥0.00，请重新选择账户。', choices: [{ optionId: 'real-option', label: '模拟活期账户（可用 ¥5000.00）' }], continuationToken: `tfm1.${'a'.repeat(43)}.${'b'.repeat(43)}` } };
  try {
    global.fetch = async () => Response.json({ code: 'INSUFFICIENT_BALANCE', requestId: 'r1', reply: { text: '请重新选择账户。', style: 'concise', safetyNotices: ['余额不足。'] }, data }, { status: 400 });
    await assert.rejects(askBankingAgent({ message: '给王先生转500元' }, 'test-access', new AbortController().signal), e => e instanceof BankingAgentError && e.code === 'INSUFFICIENT_BALANCE' && e.recovery.status === 'needs_clarification');
    for (const recovery of [null, { ...data.recovery, continuationToken: 'private-session-id' }, { ...data.recovery, operationId: 'tfpreview:forged' }, { ...data.recovery, action: 'card.get' }, { ...data.recovery, choices: [] }]) {
      global.fetch = async () => Response.json({ code: 'INSUFFICIENT_BALANCE', requestId: 'r1', reply: { text: '请重新选择账户。', style: 'concise', safetyNotices: [] }, data: { ...data, recovery } }, { status: 400 });
      await assert.rejects(askBankingAgent({ message: 'test' }, 'test-access', new AbortController().signal), { code: 'BANKING_AGENT_RESPONSE_ERROR' });
    }
  } finally { global.fetch = original; }
});
test('task boundary separates new queries, transfer edits and ambiguous requests without changing tokens', () => {
  for (const message of ['查看我的卡', '查询8月账单', '查询2026年8月账单', '从模拟活期账户转账500元给房东王先生']) assert.equal(bankingTaskBoundary(message, 'transfer.create'), 'new');
  for (const message of ['改成300元', '改成转账300元', '收款人改成李四', '取消']) assert.equal(bankingTaskBoundary(message, 'transfer.create'), 'continue');
  for (const message of ['看看我的卡和账单', '帮我看看', '是卡还是账单呢']) assert.equal(bankingTaskBoundary(message, 'transfer.create'), 'clarify');
});

test('E and bill follow-up answers keep non-TrueForge continuation context', () => {
  assert.equal(bankingTaskBoundary('R2'), 'continue');
  assert.equal(bankingTaskBoundary('2026年8月'), 'continue');
  assert.equal(bankingTaskBoundary('确认保存'), 'continue');
  assert.equal(bankingTaskBoundary('比较理财产品'), 'new');
  assert.equal(bankingTaskBoundary('创建场景规则'), 'new');
});
test('per-operation state survives card/bill focus and refresh, rotates only the resumed operation, and expires', () => {
  const token = p => `${p}.${'a'.repeat(43)}.${'b'.repeat(43)}`;
  const transfer = { status: 'awaiting_confirmation', action: 'transfer.create', continuationToken: token('tfm1'), operationId: 'tfpreview:first' };
  let flows = updateBankingFlows({}, 'transfer', transfer, 1000);
  flows = updateBankingFlows(flows, 'card', { status: 'needs_clarification', action: 'card.get', continuationToken: token('tfm1'), slot: 'card_ref' }, 1100);
  flows = updateBankingFlows(flows, 'card', { status: 'card_result', action: 'card.get' }, 1200);
  assert.ok(transferFlow(flows, transfer, 1200)); assert.equal(Object.keys(flows).length, 1);
  assert.equal(flows.transfer.expiresAt, 301000); // Other Skills never extend the original operation's TTL.
  const messages = [{ id: 1, role: 'agent', kind: 'banking_preview', text: '原转账', banking: transfer }];
  const restored = restoreBankingChat(saveBankingChat(messages, null, 0, 1300, { flows, focusedFlowId: null }), 1400);
  assert.equal(restored.continuation, null); assert.equal(restored.focusedFlowId, null);
  assert.equal(transferFlow(restored.flows, transfer, 1400).token, transfer.continuationToken);
  flows = updateBankingFlows(restored.flows, 'transfer', { ...transfer, operationId: 'tfpreview:edited' }, 1500);
  assert.equal(transferFlow(flows, transfer, 1500), undefined);
  assert.ok(transferFlow(flows, { operationId: 'tfpreview:edited' }, 1500));
  flows = updateBankingFlows(flows, 'transfer', { status: 'cancelled', action: 'transfer.create' }, 1600);
  assert.equal(Object.keys(flows).length, 0);
  assert.equal(transferFlow(restored.flows, transfer, 301000), undefined);
  const expired = restoreBankingChat(saveBankingChat(messages, null, 0, 1300, { flows: restored.flows, focusedFlowId: null }), 301000);
  assert.equal(Object.keys(expired.flows).length, 0);
});
test('transfer controls: trial preview offers confirm via bridge; non-trial keeps legacy controls', () => {
  const render = (active, busy = false, trial = true) => renderToStaticMarkup(React.createElement(BankingTransferPreview, { data: { previewOnly: trial, source: trial ? 'trueforge-mcp' : undefined, preview: { exactEffects: [{ amountFen: 40000, accountName: '模拟活期账户', payeeName: '房东王先生' }] } }, active, busy, onEdit: () => assert.fail('render cannot issue operations') }));
  const current = render(true);
  for (const text of ['修改金额', '修改收款人', '取消', '确认转账', '¥400.00', '房东王先生']) assert.ok(current.includes(text), current);
  assert.ok(!current.includes('确认转账（未开放）'), current);
  assert.equal((current.match(/disabled=""/g) || []).length, 0);
  assert.equal((render(false).match(/disabled=""/g) || []).length, 4);
  assert.equal((render(true, true).match(/disabled=""/g) || []).length, 4);
  const direct = render(true, false, false);
  for (const text of ['确认转账', '取消本次转账', '查询转账状态', '修改金额', '修改收款人']) assert.ok(direct.includes(text), direct);
  assert.ok(!direct.includes('确认转账（未开放）'), direct);
  assert.equal((direct.match(/disabled=""/g) || []).length, 0);
});
test('refresh restores bounded synthetic history and unexpired opaque continuation, never original Core authority', () => {
  const token = `tfm1.${'a'.repeat(43)}.${'b'.repeat(43)}`;
  const messages = [{ id: 1, role: 'user', text: '改成转账400元' }, { id: 2, role: 'agent', kind: 'banking_preview', text: '正式预览', banking: { status: 'awaiting_confirmation', continuationToken: token } }, { id: 3, role: 'agent', kind: 'banking_card_preview', text: '旧卡片', banking: { status: 'awaiting_confirmation', continuationToken: 'private-original-core-token', previewCurrent: true } }];
  const raw = saveBankingChat(messages, token, 1000, 2000);
  assert.ok(!raw.includes('private-original-core-token'));
  const saved = restoreBankingChat(raw, 3000); assert.equal(saved.continuation, token); assert.equal(saved.messages.length, 3);
  assert.equal(saved.messages[2].banking.previewCurrent, false);
  assert.equal(restoreBankingChat(raw, 301000).continuation, null);
  assert.equal(restoreBankingChat(raw, 1802000), null);
  assert.equal(restoreBankingChat('{broken'), null);
  assert.equal(restoreBankingChat('x'.repeat(256001)), null);
  assert.equal(restoreBankingChat(JSON.stringify({ ...saved, messages: [{ ...messages[0], role: 'tool' }] }), 3000), null);
  assert.equal(restoreBankingChat(saveBankingChat(messages, 'raw-session-id', 1000, 2000), 3000).continuation, null);
});
test('trial card previews have no execution/status buttons even if active=true; legacy controls remain', () => {
  const data = { status: 'awaiting_confirmation', action: 'card.freeze', operationId: 'tfpreview:op_actual', source: 'trueforge-mcp', previewOnly: true, executionAllowed: false,
    preview: { exactEffects: [{ cardName: '娱乐虚拟卡', before: { status: 'active' }, after: { status: 'frozen' } }], warnings: [] } };
  const render = value => renderToStaticMarkup(React.createElement(BankingCardPreview, { data: value, active: true, busy: false, onConfirm: () => {}, onReject: () => {}, onCheck: () => {} }));
  const trial = render(data); assert.ok(trial.includes('仅供预览')); assert.ok(!trial.includes('<button'));
  const legacy = render({ ...data, operationId: 'op_legacy', source: undefined, previewOnly: undefined, executionAllowed: undefined });
  assert.ok(legacy.includes('确认并执行')); assert.ok(legacy.includes('查询操作状态'));
});
test('browser validator rejects trial IDs stripped of their preview-only metadata', async () => {
  const original = global.fetch;
  try {
    global.fetch = async () => Response.json({ code: 'OK', requestId: 'r1', reply: { text: '已取消。', style: 'concise', safetyNotices: [] }, data: { status: 'cancelled', source: 'trueforge-mcp', previewOnly: true, executionAllowed: false, operationId: 'tfpreview:op_actual' } });
    assert.equal((await askBankingAgent({ message: '取消' }, 'local-test-access-code', new AbortController().signal)).status, 'cancelled');
    global.fetch = async () => Response.json({ code: 'OK', requestId: 'r1', reply: { text: '已取消。', style: 'concise', safetyNotices: [] }, data: { status: 'cancelled', source: 'trueforge-mcp', previewOnly: true, executionAllowed: true, operationId: 'tfpreview:op_actual' } });
    await assert.rejects(askBankingAgent({ message: '取消' }, 'local-test-access-code', new AbortController().signal), { code: 'BANKING_AGENT_RESPONSE_ERROR' });
  } finally { global.fetch = original; }
});


test('clarification card renders options and invariant safety without repeating the bubble question', async () => {
  const { BankingClarificationCard } = require('../src/app/BankingClarificationCard.tsx');
  const { bankingReply } = await import('../server/banking-reply.mjs');
  const data = { status: 'needs_clarification', action: 'transfer.create', slot: 'source_account_ref', question: '请选择付款账户。', choices: [{ optionId: 'a', label: '模拟活期账户' }] };
  const cards = new Set(), bubbles = new Set();
  for (const style of ['concise', 'friendly', 'professional']) {
    const reply = bankingReply({ data, replyContext: { slots: { payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' } } } }, style);
    const html = renderToStaticMarkup(React.createElement(BankingClarificationCard, { data: { ...data, reply }, onChoice: () => assert.fail('render must not choose') }));
    cards.add(html); bubbles.add(reply.text);
    assert.ok(reply.text.includes('张三')); assert.ok(reply.text.includes('500.00')); assert.ok(reply.text.includes(data.question));
    assert.ok(!html.includes(data.question)); assert.ok(html.includes('模拟活期账户')); assert.ok(html.includes('不代表确认或执行操作'));
  }
  assert.equal(cards.size, 1); assert.equal(bubbles.size, 3);
});

test('actual client and unified handler preserve reply/card separation across styles, including Core recovery', async () => {
  const { handleBankingAgent } = await import('../server/banking-agent.mjs');
  const { createBankingCore } = await import('../src/banking-core/core.mjs');
  const { buildParsedIntent } = await import('../src/agent/clarification/merge-intent.mjs');
  const { BankingBillCard } = require('../src/app/BankingBillCard.tsx');
  const env = { SAVEFLOW_ACCESS_CODE: 'client-test-access-code', CONTINUATION_TOKEN_SECRET: 'client-test-continuation-secret', SAVEFLOW_BANKING_RUNTIME: 'trueforge' };
  const original = global.fetch; let seq = 0, proposal, seen = [], sent = [];
  const core = createBankingCore();
  const client = { createSession: async () => 'private', cancel: async () => {}, runTurn: async (_id, wire) => { seen.push(JSON.parse(wire)); return JSON.stringify(proposal); } };
  const rendered = new Set(), cards = new Set(), bubbles = new Set();
  try {
    global.fetch = async (url, options) => {
      assert.equal(url, '/api/banking-agent'); sent.push(JSON.parse(options.body));
      return handleBankingAgent(new Request('http://localhost' + url, { ...options, headers: { ...options.headers, 'x-forwarded-for': `client-${++seq}` } }), { env, core, trueforgeRuntimeClient: client });
    };
    proposal = buildParsedIntent('bill.summary', { month: '2026-08' });
    for (const replyStyle of ['concise', 'friendly', 'professional']) {
      const answer = await askBankingAgent({ message: '查询2026年8月账单', replyStyle }, env.SAVEFLOW_ACCESS_CODE, new AbortController().signal);
      assert.equal(answer.reply.style, replyStyle); assert.equal(sent.at(-1).replyStyle, replyStyle);
      assert.equal(seen.at(-1).replyStyle, undefined); // Style never changes the understanding context.
      const { reply, requestId, ...data } = answer;
      assert.ok(requestId); cards.add(JSON.stringify(data)); bubbles.add(reply.text);
      rendered.add(renderToStaticMarkup(React.createElement(BankingBillCard, { data: answer })));
    }
    assert.equal(cards.size, 1); assert.equal(rendered.size, 1); assert.equal(bubbles.size, 3);
    proposal = buildParsedIntent('transfer.create', { source_account_ref: '储蓄账户', payee_ref: '张三', amount: { amount_minor: 999999999, currency: 'CNY' } });
    await assert.rejects(askBankingAgent({ message: '从储蓄账户给张三转9999999.99元', replyStyle: 'professional' }, env.SAVEFLOW_ACCESS_CODE, new AbortController().signal), e => {
      assert.ok(e instanceof BankingAgentError); assert.equal(e.code, 'INSUFFICIENT_BALANCE');
      assert.equal(e.recovery.reply.style, 'professional'); assert.ok(e.recovery.reply.text.includes('张三'));
      assert.ok(e.recovery.reply.text.includes('可用余额')); assert.equal(e.recovery.status, 'needs_clarification');
      assert.match(e.recovery.continuationToken, /^[\w-]{16}\.[\w-]{22}\.[\w-]+$/); return true;
    });
  } finally { global.fetch = original; }
});

test('unified clarification drafts survive refresh without restoring Core preview execution', () => {
  const token = `${'a'.repeat(16)}.${'b'.repeat(22)}.${'c'.repeat(100)}`;
  const draft = { status: 'needs_clarification', action: 'transfer.create', slot: 'source_account_ref', continuationToken: token, choices: [{ optionId: 'a', label: '账户' }] };
  const messages = [{ id: 1, role: 'agent', kind: 'banking_clarification', text: '给张三转500元，请选择账户。', banking: draft }];
  const flows = updateBankingFlows({}, 'draft', draft, 1000);
  const restored = restoreBankingChat(saveBankingChat(messages, token, 1000, 2000, { flows, focusedFlowId: 'draft' }), 3000);
  assert.equal(restored.continuation, token); assert.equal(restored.focusedFlowId, 'draft');
  assert.equal(restored.flows.draft.slot, 'source_account_ref'); assert.equal(restoreBankingChat(saveBankingChat(messages, token, 1000, 2000), 301001).continuation, null);
  const preview = { ...draft, status: 'awaiting_confirmation', operationId: 'op_real', previewCurrent: true };
  assert.deepEqual(updateBankingFlows({}, 'preview', preview, 1000), {}); // Only the live Core operation state can activate controls.
  const history = [{ id: 2, role: 'agent', kind: 'banking_card_preview', text: '预览', banking: preview }];
  const saved = restoreBankingChat(saveBankingChat(history, null, 0, 2000, { flows: updateBankingFlows({}, 'preview', preview, 1000), focusedFlowId: null }), 3000);
  assert.deepEqual(saved.flows, {}); assert.equal(saved.continuation, null); assert.equal(saved.messages[0].banking.previewCurrent, false);
});

test('executed transfer preview is read-only (no confirm/cancel) and renders a receipt card', () => {
  const data = { status: 'succeeded', action: 'transfer.create', operationId: 'tfpreview:op_done', source: 'trueforge-mcp', previewOnly: true, executed: true,
    preview: { summary: '已执行', exactEffects: [{ amountFen: 40000, accountName: '模拟活期账户', payeeName: '房东王先生' }] } };
  const done = renderToStaticMarkup(React.createElement(BankingTransferPreview, { data, active: true, busy: false, onEdit: () => {}, onConfirm: () => {}, onReject: () => {}, onCheck: () => {} }));
  assert.ok(done.includes('已完成'), done);
  assert.ok(!done.includes('<button'), done);
  assert.ok(!done.includes('确认转账') && !done.includes('取消本次转账'), done);
  const receipt = { receiptId: 'rcpt_1', operationId: 'op_done', action: 'transfer_money', planId: 'plan_1', stepId: 'step_1', status: 'succeeded', message: '模拟转账成功', executedAt: '2026-10-21T00:00:00.000Z', dataSource: 'synthetic_demo_only', transactionIds: ['txn_op_done'],
    effects: [{ kind: 'transfer_out', fromAccountId: 'ACC-CHECKING', accountName: '模拟活期账户', payeeId: 'payee_001', payeeName: '房东王先生', accountNoMasked: '**** 1234', amountFen: 40000, feeFen: 0, currency: 'CNY', balanceBeforeFen: 540000, balanceAfterFen: 500000, availableBalanceAfterFen: 500000, accountVersion: 2, memo: '', arrival: 'mock_immediate' }] };
  const verification = { availableBalanceFen: 500000, transactionId: 'txn_op_done', occurredAt: '2026-10-21T00:00:00.000Z', amountFen: 40000, status: 'posted' };
  const card = renderToStaticMarkup(React.createElement(BankingTransferReceipt, { receipt, verification }));
  for (const text of ['转账回执', '已完成', '收款人', '房东王先生', '¥400.00', '实际状态', '已成功（succeeded）', '交易编号', 'txn_op_done', 'rcpt_1', '2026-10-21T00:00:00.000Z', '后端交易记录', '已记账（posted）', '后端查询余额']) assert.ok(card.includes(text), card);
});

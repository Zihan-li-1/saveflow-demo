/* eslint-disable @typescript-eslint/no-require-imports -- Render the actual preview and use the actual TS client. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  const source = readFileSync(filename, 'utf8').replace(/from "@\/lib\//g, 'from "../lib/');
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, filename);
};
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { BankingCardPreview } = require('../src/app/BankingCardCards.tsx');
const { askBankingAgent, BankingAgentError } = require('../src/lib/banking-agent-client.ts');
const { BankingTransferPreview } = require('../src/app/BankingTransferPreview.tsx');
const { saveBankingChat, restoreBankingChat } = require('../src/lib/banking-chat-storage.ts');
const { updateBankingFlows, transferFlow } = require('../src/lib/banking-flow-state.ts');
const { bankingTaskBoundary } = require('../src/lib/trueforge-routing.mjs');
test('browser accepts validated insufficient-balance recovery only as an error/clarification, never a success card', async () => {
  const original = global.fetch;
  const data = { status: 'error', error: { code: 'INSUFFICIENT_BALANCE' }, recovery: { kind: 'clarification', status: 'needs_clarification', action: 'transfer.create', slot: 'source_account_ref', source: 'trueforge-mcp',
    question: '模拟储蓄账户可用 ¥0.00，请重新选择账户。', choices: [{ optionId: 'real-option', label: '模拟活期账户（可用 ¥5000.00）' }], continuationToken: `tfm1.${'a'.repeat(43)}.${'b'.repeat(43)}` } };
  try {
    global.fetch = async () => Response.json({ code: 'INSUFFICIENT_BALANCE', requestId: 'r1', data }, { status: 400 });
    await assert.rejects(askBankingAgent({ message: '给王先生转500元' }, 'test-access', new AbortController().signal), e => e instanceof BankingAgentError && e.code === 'INSUFFICIENT_BALANCE' && e.recovery.status === 'needs_clarification');
    for (const recovery of [null, { ...data.recovery, continuationToken: 'private-session-id' }, { ...data.recovery, operationId: 'tfpreview:forged' }, { ...data.recovery, action: 'card.get' }, { ...data.recovery, choices: [] }]) {
      global.fetch = async () => Response.json({ code: 'INSUFFICIENT_BALANCE', requestId: 'r1', data: { ...data, recovery } }, { status: 400 });
      await assert.rejects(askBankingAgent({ message: 'test' }, 'test-access', new AbortController().signal), { code: 'BANKING_AGENT_RESPONSE_ERROR' });
    }
  } finally { global.fetch = original; }
});
test('task boundary separates new queries, transfer edits and ambiguous requests without changing tokens', () => {
  for (const message of ['查看我的卡', '查询8月账单', '查询2026年8月账单', '从模拟活期账户转账500元给房东王先生']) assert.equal(bankingTaskBoundary(message, 'transfer.create'), 'new');
  for (const message of ['改成300元', '改成转账300元', '收款人改成李四', '取消']) assert.equal(bankingTaskBoundary(message, 'transfer.create'), 'continue');
  for (const message of ['看看我的卡和账单', '帮我看看', '是卡还是账单呢']) assert.equal(bankingTaskBoundary(message, 'transfer.create'), 'clarify');
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
  for (const text of ['确认转账', '取消本次转账', '查询转账状态']) assert.ok(direct.includes(text), direct);
  for (const text of ['修改金额', '修改收款人', '确认转账（未开放）']) assert.ok(!direct.includes(text), direct);
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
    global.fetch = async () => Response.json({ code: 'OK', requestId: 'r1', data: { status: 'cancelled', source: 'trueforge-mcp', previewOnly: true, executionAllowed: false, operationId: 'tfpreview:op_actual' } });
    assert.equal((await askBankingAgent({ message: '取消' }, 'local-test-access-code', new AbortController().signal)).status, 'cancelled');
    global.fetch = async () => Response.json({ code: 'OK', requestId: 'r1', data: { status: 'cancelled', source: 'trueforge-mcp', previewOnly: true, executionAllowed: true, operationId: 'tfpreview:op_actual' } });
    await assert.rejects(askBankingAgent({ message: '取消' }, 'local-test-access-code', new AbortController().signal), { code: 'BANKING_AGENT_RESPONSE_ERROR' });
  } finally { global.fetch = original; }
});

/* eslint-disable @typescript-eslint/no-require-imports -- Render the actual preview card and use the actual TS client. */
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
const { askBankingAgent } = require('../src/lib/banking-agent-client.ts');
const { BankingInternalTransferPreview } = require('../src/app/BankingInternalTransferPreview.tsx');
const { BankingTransferPreview } = require('../src/app/BankingTransferPreview.tsx');

const validReply = { text: '本人账户互转已识别。', style: 'concise', safetyNotices: ['只读预览，不能执行。'] };
const internalPreview = {
  kind: 'internal_transfer',
  source_account_id: 'ACC-CHECKING', source_account_name: '模拟活期账户',
  target_account_id: 'ACC-SAVINGS', target_account_name: '模拟储蓄账户',
  amount_minor: 10000, currency: 'CNY',
  source_available_balance_minor: 3000000, source_estimated_balance_after_minor: 2990000,
  target_available_balance_minor: 1000000, target_estimated_balance_after_minor: 1010000,
};

test('browser accepts internal_transfer_recognized only as a read-only success', async () => {
  const original = global.fetch;
  try {
    global.fetch = async () => Response.json({ code: 'OK', requestId: 'req_internal_1', reply: validReply, data: { status: 'internal_transfer_recognized', action: 'transfer.create', previewOnly: true, executionAllowed: false, preview: internalPreview } });
    const answer = await askBankingAgent({ message: '从活期账户转100元到储蓄账户' }, 'local-test-access-code', new AbortController().signal);
    assert.equal(answer.status, 'internal_transfer_recognized');
    assert.equal(answer.action, 'transfer.create');
    assert.equal(answer.previewOnly, true);
    assert.equal(answer.executionAllowed, false);
    assert.equal(answer.preview.kind, 'internal_transfer');
  } finally { global.fetch = original; }
});

test('browser rejects internal_transfer_recognized that claims execution or breaks conservation', async () => {
  const original = global.fetch;
  try {
    const data = overrides => ({ status: 'internal_transfer_recognized', action: 'transfer.create', previewOnly: true, executionAllowed: false, preview: internalPreview, ...overrides });
    const cases = [
      data({ executionAllowed: true }),                                          // 只读却声明可执行
      data({ previewOnly: false }),                                              // 未声明只读
      { status: 'internal_transfer_recognized', action: 'transfer.create', executionAllowed: false, preview: internalPreview }, // 缺 previewOnly
      data({ preview: { ...internalPreview, source_estimated_balance_after_minor: 2999999 } }), // 转出侧守恒破坏
      data({ preview: { ...internalPreview, target_estimated_balance_after_minor: 1010100 } }), // 转入侧守恒破坏
      data({ preview: { ...internalPreview, amount_minor: 0 } }),               // 金额非正
      data({ preview: { ...internalPreview, source_account_id: 'ACC-SAVINGS' } }), // 转入=转出
    ];
    for (const payload of cases) {
      global.fetch = async () => Response.json({ code: 'OK', requestId: 'req_internal_2', reply: validReply, data: payload });
      await assert.rejects(askBankingAgent({ message: 'test' }, 'local-test-access-code', new AbortController().signal), { code: 'BANKING_AGENT_RESPONSE_ERROR' });
    }
  } finally { global.fetch = original; }
});

test('internal transfer preview card is read-only and labels available balance, not book balance', () => {
  const data = { status: 'internal_transfer_recognized', action: 'transfer.create', previewOnly: true, executionAllowed: false, preview: internalPreview };
  const html = renderToStaticMarkup(React.createElement(BankingInternalTransferPreview, { data }));
  for (const text of ['本人账户互转预览', '只读预览', '不能执行', '模拟活期账户', '模拟储蓄账户', '¥100.00', '转出账户可用余额', '转入账户可用余额', '预计转出后', '预计转入后']) assert.ok(html.includes(text), `${text} missing in ${html}`);
  assert.ok(!html.includes('<button'), html); // 只读卡片不提供任何执行/确认入口
  assert.ok(!html.includes('确认'), html);
});

test('browser accepts a formal Core internal-transfer preview and renders the existing confirmation controls', async () => {
  const effect = {
    kind: 'transfer_internal', fromAccountId: 'ACC-CHECKING', accountName: '模拟活期账户',
    toAccountId: 'ACC-SAVINGS', targetAccountName: '模拟储蓄账户', amountFen: 10000, currency: 'CNY',
    sourceBalanceBeforeFen: 3000000, sourceBalanceAfterFen: 2990000, sourceAvailableBalanceAfterFen: 2990000, sourceAccountVersion: 0,
    targetBalanceBeforeFen: 1000000, targetBalanceAfterFen: 1010000, targetAvailableBalanceAfterFen: 1010000, targetAccountVersion: 0, memo: '',
  };
  const data = { status: 'awaiting_confirmation', action: 'transfer.create', operationId: 'op_internal_preview', continuationToken: 'opaque-token',
    preview: { previewHash: 'a'.repeat(64), summary: '本人账户互转', exactEffects: [effect] }, risk: { allowed: true, riskLevel: 'L3' } };
  const original = global.fetch;
  try {
    global.fetch = async () => Response.json({ code: 'OK', requestId: 'req_internal_3', reply: validReply, data });
    const accepted = await askBankingAgent({ message: '从活期转到储蓄' }, 'local-test-access-code', new AbortController().signal);
    assert.equal(accepted.status, 'awaiting_confirmation');
    const html = renderToStaticMarkup(React.createElement(BankingTransferPreview, { data: accepted, active: true, busy: false,
      onEdit() {}, onConfirm() {}, onReject() {}, onCheck() {} }));
    for (const text of ['模拟活期账户', '模拟储蓄账户', '转出账户余额', '转入账户余额', '确认转账']) assert.ok(html.includes(text), `${text} missing in ${html}`);
  } finally { global.fetch = original; }
});

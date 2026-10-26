/* eslint-disable @typescript-eslint/no-require-imports -- Render the actual OTP preview component, not a mock. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  const source = readFileSync(filename, 'utf8').replace(/from "@\/lib\//g, 'from "../lib/');
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, filename);
};
require.extensions['.css'] = () => {};

const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const TestRenderer = require('react-test-renderer');
const { BankingTransferPreview } = require('../src/app/BankingTransferPreview.tsx');

const data = (overrides = {}) => ({
  status: 'awaiting_confirmation',
  action: 'transfer.create',
  operationId: 'op_1',
  preview: { summary: '模拟转账', exactEffects: [{ amountFen: 40000, accountName: '模拟活期账户', payeeName: '房东王先生' }] },
  ...overrides,
});
const noop = () => {};
const render = props => renderToStaticMarkup(React.createElement(BankingTransferPreview, { data: data(), active: true, busy: false, onEdit: noop, onConfirm: noop, onReject: noop, onCheck: noop, ...props }));

test('OTP 弹窗仅在挑战绑定到当前 operationId 时出现（确认后），普通控件不渲染', () => {
  const otp = render({ verification: { operationId: 'op_1', challengeId: 'otp_x', expiresAt: '2026-10-26T00:00:00.000Z' } });
  for (const text of ['一次性验证码', '验证并转账', '取消验证', '这是一笔高风险转账']) assert.ok(otp.includes(text), otp);
  assert.ok(!otp.includes('>确认转账<'), otp); // 不再出现普通确认入口
});

test('未发起验证或挑战绑定其他 operationId 时不显示 OTP 弹窗', () => {
  const none = render({ verification: null });
  assert.ok(none.includes('确认转账'), none);
  assert.ok(!none.includes('一次性验证码'), none);
  const mismatched = render({ verification: { operationId: 'op_other', challengeId: 'otp_x', expiresAt: '2026-10-26T00:00:00.000Z' } });
  assert.ok(mismatched.includes('确认转账'), mismatched);
  assert.ok(!mismatched.includes('一次性验证码'), mismatched);
});

test('OTP 验证码绝不进入 DOM：弹窗只渲染输入框，不渲染明文码', () => {
  const html = render({ verification: { operationId: 'op_1', challengeId: 'otp_x', expiresAt: '2026-10-26T00:00:00.000Z' } });
  assert.ok(!html.includes('123456'), html);
  assert.ok(!html.includes('value="123456"'), html);
});

test('错误状态以 role="alert" 渲染', () => {
  const html = render({ verification: { operationId: 'op_1', challengeId: 'otp_x', expiresAt: '2026-10-26T00:00:00.000Z' }, otpError: '验证码错误，还可尝试 2 次。' });
  assert.ok(html.includes('role="alert"'), html);
  assert.ok(html.includes('验证码错误，还可尝试 2 次。'), html);
});

test('验证码不足 6 位时提交按钮禁用', () => {
  const html = render({ verification: { operationId: 'op_1', challengeId: 'otp_x', expiresAt: '2026-10-26T00:00:00.000Z' } });
  // 初始 code 为空 → 提交按钮 disabled，且仍可见「验证并转账」。
  assert.match(html, /验证并转账/);
  assert.match(html, /disabled=""/);
});

test('提交有效验证码调用 onVerify（携带 code），取消调用 onCancelVerification 而不执行', async () => {
  let verified = null; let cancelled = false; let confirmed = false;
  let renderer;
  const { act } = TestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(BankingTransferPreview, {
      data: data(),
      active: true, busy: false,
      onEdit: noop, onReject: noop, onCheck: noop,
      onConfirm: () => { confirmed = true; },
      verification: { operationId: 'op_1', challengeId: 'otp_x', expiresAt: '2026-10-26T00:00:00.000Z' },
      onVerify: (_d, code) => { verified = code; },
      onCancelVerification: () => { cancelled = true; },
    }));
  });
  const input = renderer.root.findByProps({ 'aria-label': '一次性验证码' });
  await act(async () => input.props.onChange({ target: { value: '123456' } }));
  const form = renderer.root.findByType('form');
  await act(async () => form.props.onSubmit({ preventDefault() {} }));
  assert.equal(verified, '123456');
  assert.equal(confirmed, false); // 提交验证码不等于确认执行

  // 取消验证：清空并回调 onCancelVerification，不触发任何执行路径。
  const cancel = renderer.root.findByProps({ children: '取消验证' });
  await act(async () => cancel.props.onClick());
  assert.equal(cancelled, true);
  assert.equal(confirmed, false);
});

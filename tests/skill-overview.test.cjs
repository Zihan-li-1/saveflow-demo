/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (module, filename) => module._compile(ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, filename);
require.extensions['.css'] = module => { module.exports = new Proxy({}, { get: (_, key) => String(key) }); };
const React = require('react');
const { create, act } = require('react-test-renderer');
const { BankingSkillOverview } = require('../src/app/BankingSkillOverview.tsx');
const { validSkillOverview } = require('../src/lib/banking-agent-client.ts');
const overview = { schemaVersion: '1.0.0', groups: [['transfer', '智能转账'], ['bills', '账单分析'], ['wealth', '理财操作'], ['cards', '卡片管理'], ['subscriptions', '订阅/代扣管理'], ['cross_scenario', '跨场景联动']].map(([id, title]) => ({ id, title, description: `${title}说明`, status: 'available_demo', capabilities: [{ action: `${id}.demo`, label: `${title}能力`, status: 'available_demo', limitations: [] }], examples: [{ label: `${title}示例`, prompt: `体验${title}`, status: 'available_demo' }] })) };

test('skill overview renders six groups and selection only returns the prompt', async t => {
  global.IS_REACT_ACT_ENVIRONMENT = true; t.after(() => { global.IS_REACT_ACT_ENVIRONMENT = false; });
  const selected = []; let root;
  await act(async () => { root = create(React.createElement(BankingSkillOverview, { overview, onSelectExample: prompt => selected.push(prompt) })); });
  assert.equal(root.root.findAllByType('article').length, 6);
  await act(async () => root.root.findAllByType('button').find(button => button.props['aria-expanded'] !== undefined).props.onClick());
  const example = root.root.findAllByType('button').find(button => button.children.some(child => child === '智能转账示例'));
  await act(async () => example.props.onClick()); assert.deepEqual(selected, ['体验智能转账']);
  await act(async () => root.unmount());
});

test('historical capability snapshot disables its example entries', async () => {
  let root; await act(async () => { root = create(React.createElement(BankingSkillOverview, { overview, interactive: false, onSelectExample() { assert.fail('must not select'); } })); });
  await act(async () => root.root.findAllByType('button').find(button => button.props['aria-expanded'] !== undefined).props.onClick());
  assert.equal(root.root.findAllByType('button').filter(button => button.props.disabled).length, 1);
  await act(async () => root.unmount());
});

test('capability response validator rejects invented actions and internal authority fields', () => {
  const valid = structuredClone(overview);
  valid.groups[0].capabilities[0].action = 'transfer.create';
  for (const group of valid.groups.slice(1)) group.capabilities[0].action = 'bill.summary';
  assert.equal(validSkillOverview(valid), true);
  const invented = structuredClone(valid); invented.groups[0].capabilities[0].action = 'transfer.execute_anything';
  assert.equal(validSkillOverview(invented), false);
  const secret = structuredClone(valid); secret.groups[0].capabilities[0].operationId = 'op_secret';
  assert.equal(validSkillOverview(secret), false);
});

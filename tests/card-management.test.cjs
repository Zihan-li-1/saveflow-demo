/* eslint-disable @typescript-eslint/no-require-imports -- CJS test loads the actual TS synchronization helper. */
const { readFileSync } = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  });
  module._compile(outputText, filename);
};
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { budgetBalanceAlert, cardActivities, synchronizeManagedCards } = require('../src/lib/card-management.ts');
const { currentSubscriptions } = require('../src/lib/subscription-overview.ts');

const cards = [
  { id: 'CARD-MAIN', name: '日常虚拟卡', status: 'active', monthlyBudgetFen: 500000, monthlySpentFen: 0, onlinePaymentsEnabled: true, blockedCategories: [], alertThresholdFen: null, balanceReminderAmountFen: null, balanceReminderPercent: null, version: 1 },
  { id: 'CARD-ENT', name: '娱乐虚拟卡', status: 'active', monthlyBudgetFen: 80000, monthlySpentFen: 76000, onlinePaymentsEnabled: true, blockedCategories: [], alertThresholdFen: null, balanceReminderAmountFen: null, balanceReminderPercent: null, version: 1 },
];

test('card management initializes two cards and syncs only verified operation results', () => {
  const changed = { ...cards[1], status: 'frozen', version: 2 };
  const result = synchronizeManagedCards(cards, [
    { id: 1, role: 'agent', text: 'preview', kind: 'banking_card_preview', banking: { status: 'awaiting_confirmation', data: { card: changed } } },
    { id: 2, role: 'agent', text: 'verified', kind: 'banking_card', banking: { status: 'card_result', data: { card: changed } } },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].status, 'active');
  assert.equal(result[0].version, 1);
  assert.equal(result[1].status, 'frozen');
  assert.equal(result[1].version, 2);
});

test('budget balance alerts fire at amount, percentage and exhaustion thresholds', () => {
  assert.match(budgetBalanceAlert({ monthlyBudgetFen: 80000, monthlySpentFen: 76000, balanceReminderAmountFen: 5000, balanceReminderPercent: null }), /临界点/);
  assert.match(budgetBalanceAlert({ monthlyBudgetFen: 80000, monthlySpentFen: 65000, balanceReminderAmountFen: null, balanceReminderPercent: 20 }), /临界点/);
  assert.match(budgetBalanceAlert({ monthlyBudgetFen: 80000, monthlySpentFen: 80000, balanceReminderAmountFen: null, balanceReminderPercent: null }), /已用完/);
  assert.equal(budgetBalanceAlert({ monthlyBudgetFen: 80000, monthlySpentFen: 10000, balanceReminderAmountFen: 5000, balanceReminderPercent: null }), null);
});

test('card management ignores unknown cards and does not mutate initialization data', () => {
  const result = synchronizeManagedCards(cards, [{ id: 1, role: 'agent', text: 'unknown', kind: 'banking_card', banking: { status: 'card_result', data: { card: { ...cards[0], id: 'CARD-UNKNOWN' } } } }]);
  assert.deepEqual(result.map(card => card.id), ['CARD-MAIN', 'CARD-ENT']);
  result[0].blockedCategories.push('游戏');
  assert.deepEqual(cards[0].blockedCategories, []);
});

test('card management lists write previews and reflects their operation state', () => {
  const message = { id: 3, role: 'agent', text: 'preview', kind: 'banking_card_preview', banking: { operationId: 'op-card-1', status: 'awaiting_confirmation', action: 'card.set_budget', preview: { exactEffects: [{ kind: 'card_change', cardName: '娱乐虚拟卡', before: { monthlyBudgetFen: 80000 }, after: { monthlyBudgetFen: 100000 } }] } } };
  assert.deepEqual(cardActivities([message], {}), [{ id: 'op-card-1', cardName: '娱乐虚拟卡', label: '调整月预算', detail: '新预算 ¥1000.00', status: '待确认' }]);
  assert.equal(cardActivities([message], { 'op-card-1': 'success' })[0].status, '已完成');
});

test('subscription overview starts with initialized data and follows the latest query result', () => {
  const initial = [{ id: 's1', name: '视频会员', monthlyFeeFen: 3000, status: 'active', isPotentiallyUnused: true }];
  assert.deepEqual(currentSubscriptions(initial, []), initial);
  const latest = [{ id: 's2', name: '云存储', monthlyFeeFen: 2000, status: 'cancelled', isPotentiallyUnused: false }];
  const messages = [{ id: 1, role: 'agent', kind: 'banking_read', banking: { status: 'subscription_result', data: { subscriptions: initial } } }, { id: 2, role: 'agent', kind: 'banking_read', banking: { status: 'subscription_result', data: { subscriptions: latest } } }];
  assert.deepEqual(currentSubscriptions(initial, messages), latest);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateParsedIntent } from '../src/agent/validate-parsed-intent.mjs';
import { handleBankingAgent } from '../server/banking-agent.mjs';
import { bankingIntentSystemPrompt } from '../server/banking-intent-parser.mjs';
import { bankingAgentSpec } from '../server/trueforge-banking-runtime.mjs';
import { normalizePurchaseSlots, purchaseDateFields, purchaseIntentFromMessage } from '../src/lib/purchase-flow.mjs';

test('purchase keeps a known month/day without inventing a time, and defaults the year to the current one', () => {
  for (const expression of ['9.1号', '九月一号', '9月1日', '9/1']) {
    assert.deepEqual(purchaseDateFields(expression, '2026-10-29'), { date: '2026-09-01', start: '', end: '' });
    assert.equal(purchaseDateFields(expression, '2026-08-01').date, '2026-09-01');
  }
  assert.deepEqual(purchaseDateFields('2026-09-01 09:00-12:00', '2026-10-29'), { date: '2026-09-01', start: '09:00', end: '12:00' });
  assert.equal(purchaseDateFields('2025年12月31日', '2026-10-29').date, '2025-12-31');
  for (const expression of ['2026-02-30', '九月三十一号', '十一一月一号', '下个月某天']) assert.equal(purchaseDateFields(expression, '2026-10-29').date, '');
  assert.deepEqual(normalizePurchaseSlots({ date_expression: '十一月一日', preferences: { occasion: '生日' } }, '2026-10-29'), {
    date_expression: '2026-11-01', budget_month: '2026-11', preferences: { occasion: '生日' },
  });
});

test('banking purchase response fills September 1 from the model slots before asking for missing time', async () => {
  const env = { SAVEFLOW_ACCESS_CODE: 'purchase-test-access', CONTINUATION_TOKEN_SECRET: 'purchase-test-continuation' };
  const intent = { schemaVersion: '1.0.0', action: 'scenario.plan_purchase', slots: {
    date_expression: '九月一号', date_meaning: 'order_on', items: [{ category: 'flowers', quantity: 1 }],
  }, missingSlots: [], status: 'ready_for_resolution' };
  const request = new Request('http://localhost/api/banking-agent', { method: 'POST', headers: {
    'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'content-type': 'application/json', 'x-forwarded-for': 'purchase-date-test',
  }, body: JSON.stringify({ consent: true, history: [], message: '提醒我在九月一号买花' }) });
  const response = await handleBankingAgent(request, { env, now: () => Date.parse('2026-08-15T00:00:00Z'), parseIntent: async () => intent });
  assert.equal(response.status, 200);
  const slots = (await response.json()).data.data.slots;
  assert.equal(slots.date_expression, '2026-09-01');
  assert.equal(slots.budget_month, '2026-09');
  assert.equal(slots.date_meaning, 'order_on');
  assert.equal(slots.budget, undefined);
});

test('purchase draft is a registered composite intent; model cannot confirm or supply entity IDs', () => {
  const draft = { schemaVersion: '1.0.0', action: 'scenario.plan_purchase', slots: { budget: { amount_minor: 100000, currency: 'CNY' } }, missingSlots: [], status: 'ready_for_resolution' };
  assert.deepEqual(validateParsedIntent(draft), draft);
  for (const slots of [{ confirmed: true }, { funding_account_ref: 'account_123' }, { tool: 'commerce.order.execute' }]) assert.throws(() => validateParsedIntent({ ...draft, slots }));
  assert.match(bankingIntentSystemPrompt, /scenario.plan_purchase/);
  assert.match(bankingAgentSpec({ TRUEFORGE_MODEL: 'test/model' }).instructions, /已注册的购物复合意图/);
});
test('banking HTTP routes birthday shopping to a business flow card without executing any steps', async () => {
  const env = { SAVEFLOW_ACCESS_CODE: 'purchase-test-access', CONTINUATION_TOKEN_SECRET: 'purchase-test-continuation' };
  const intent = { schemaVersion: '1.0.0', action: 'scenario.plan_purchase', slots: { items: [{ category: 'flowers', quantity: 1 }, { category: 'cake', quantity: 1 }] }, missingSlots: [], status: 'ready_for_resolution' };
  const req = new Request('http://localhost/api/banking-agent', { method: 'POST', headers: { 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'content-type': 'application/json', 'x-forwarded-for': 'purchase-route-test' }, body: JSON.stringify({ consent: true, history: [], message: '预留一千元，生日送花和蛋糕' }) });
  const response = await handleBankingAgent(req, { env, parseIntent: async () => intent });
  assert.equal(response.status, 200);
  const payload = await response.json(); assert.equal(payload.data.status, 'purchase_request');
  assert.deepEqual(payload.data.data.slots, intent.slots);
});

test('a model refusal on a shopping request still reaches the purchase flow', async () => {
  assert.deepEqual(purchaseIntentFromMessage('提醒我在九月一号买花'), { items: [{ category: 'flowers', quantity: 1 }], date_expression: '2026-09-01', date_meaning: 'order_on' });
  for (const message of ['取消鲜花订阅', '看看花呗账单', '转 200 给张三']) assert.equal(purchaseIntentFromMessage(message), null);
  const env = { SAVEFLOW_ACCESS_CODE: 'purchase-test-access', CONTINUATION_TOKEN_SECRET: 'purchase-test-continuation' };
  const refusal = { schemaVersion: '1.0.0', action: 'unsupported', slots: {}, missingSlots: [], status: 'unsupported' };
  const request = new Request('http://localhost/api/banking-agent', { method: 'POST', headers: {
    'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'content-type': 'application/json', 'x-forwarded-for': 'purchase-guard-test',
  }, body: JSON.stringify({ consent: true, history: [], message: '提醒我在九月一号买花' }) });
  const response = await handleBankingAgent(request, { env, now: () => Date.parse('2026-10-30T00:00:00Z'), parseIntent: async () => refusal });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.status, 'purchase_request');
  assert.equal(payload.data.data.slots.date_expression, '2026-09-01');
  assert.deepEqual(payload.data.data.slots.items, [{ category: 'flowers', quantity: 1 }]);
});

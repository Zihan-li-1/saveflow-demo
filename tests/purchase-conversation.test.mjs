import test from 'node:test';
import assert from 'node:assert/strict';
import { validateParsedIntent } from '../src/agent/validate-parsed-intent.mjs';
import { handleBankingAgent } from '../server/banking-agent.mjs';
import { bankingIntentSystemPrompt } from '../server/banking-intent-parser.mjs';
import { bankingAgentSpec } from '../server/trueforge-banking-runtime.mjs';

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

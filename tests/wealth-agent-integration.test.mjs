import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { handleBankingAgent } from '../server/banking-agent.mjs';
import { validateParsedIntent } from '../src/agent/validate-parsed-intent.mjs';

const env = { SAVEFLOW_ACCESS_CODE: 'test-access-code-1234', CONTINUATION_TOKEN_SECRET: 'test-continuation-secret-1234' };
let sequence = 0;
const parsed = (action, slots) => ({ schemaVersion: '1.0.0', action, slots, missingSlots: [], status: 'ready_for_resolution' });
async function send(core, intent) {
  const request = new Request('http://localhost/api/banking-agent', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'x-forwarded-for': `wealth-${++sequence}` }, body: JSON.stringify({ message: '理财请求' }),
  });
  const response = await handleBankingAgent(request, { env, core, parseIntent: async () => intent });
  return { status: response.status, body: await response.json() };
}

test('Wealth parser refuses model-supplied IDs and confirmation fields', () => {
  const intent = parsed('wealth.subscribe', { product_ref: '模拟灵活现金 A', amount: { amount_minor: 10000, currency: 'CNY' }, source_account_ref: '活期账户' });
  assert.equal(validateParsedIntent(intent), intent);
  assert.throws(() => validateParsedIntent({ ...intent, confirmed: true }));
  assert.throws(() => validateParsedIntent({ ...intent, slots: { ...intent.slots, product_ref: 'product_001' } }));
  assert.throws(() => validateParsedIntent({ ...intent, slots: { ...intent.slots, risk_level: 'R3' } }));
});

test('query actions resolve products and return synthetic evidence without a write', async () => {
  const core = createBankingCore();
  const recommend = await send(core, parsed('wealth.recommend', { goal: { kind: 'short_term_purchase', max_risk_level: 'R2' }, constraints: { investable_amount: { amount_minor: 100000, currency: 'CNY' }, max_settlement_days: 1 } }));
  assert.equal(recommend.status, 200);
  assert.equal(recommend.body.data.status, 'wealth_result');
  assert.equal(recommend.body.data.data.kind, 'recommendation');
  assert.equal(recommend.body.data.data.synthetic_demo_only, true);
  const compare = await send(core, parsed('wealth.compare', { product_refs: ['模拟灵活现金 A', '模拟稳健现金 B'] }));
  assert.equal(compare.body.data.data.kind, 'comparison');
  assert.equal(compare.body.data.data.products.length, 2);
  const risk = await send(core, parsed('wealth.assess_risk', { assessment_scope: 'investment' }));
  assert.equal(risk.body.data.data.kind, 'risk_assessment');
});

test('subscription requires preview and exact confirmation; repeated execution has one effect', async () => {
  const core = createBankingCore();
  const account = (await core.repository.getAccounts())[0];
  const response = await send(core, parsed('wealth.subscribe', { product_ref: '模拟灵活现金 A', amount: { amount_minor: 10000, currency: 'CNY' }, source_account_ref: account.name }));
  assert.equal(response.status, 200);
  const preview = response.body.data;
  assert.equal(preview.status, 'awaiting_confirmation');
  assert.equal(preview.risk.riskLevel, 'L3');
  assert.equal((await core.repository.getAccount(account.id)).availableBalanceFen, account.availableBalanceFen);
  const premature = await core.execute(preview.operationId, preview.preview.previewHash);
  assert.equal(premature.ok, false);
  assert.equal(premature.error.code, 'CONFIRMATION_REQUIRED');
  const decided = await core.decide(preview.operationId, { previewHash: preview.preview.previewHash, decision: 'confirm', confirmedStepIds: preview.preview.stepIds });
  assert.equal(decided.ok, true);
  const first = await core.execute(preview.operationId, preview.preview.previewHash);
  const second = await core.execute(preview.operationId, preview.preview.previewHash);
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.equal((await core.repository.getAccount(account.id)).availableBalanceFen, account.availableBalanceFen - 10000);
  assert.equal((await core.wealthPorts.getHoldings()).find(item => item.product_id === 'product_001').amount_fen, 10000);
});

test('redemption requires separate confirmation; changing holdings invalidates preview', async () => {
  const core = createBankingCore();
  const intent = parsed('wealth.redeem', { holding_ref: '模拟稳健现金 B', quantity_or_amount: { kind: 'amount', amount_minor: 10000, currency: 'CNY' } });
  const response = await send(core, intent);
  assert.equal(response.status, 200);
  const preview = response.body.data;
  assert.equal(preview.action, 'wealth.redeem');
  assert.equal((await core.wealthPorts.getHoldings()).find(item => item.id === 'holding_001').amount_fen, 200000);
  const decided = await core.decide(preview.operationId, { previewHash: preview.preview.previewHash, decision: 'confirm', confirmedStepIds: preview.preview.stepIds });
  assert.equal(decided.ok, true);
  const executed = await core.execute(preview.operationId, preview.preview.previewHash);
  assert.equal(executed.ok, true);
  assert.equal((await core.wealthPorts.getHoldings()).find(item => item.id === 'holding_001').amount_fen, 190000);
});

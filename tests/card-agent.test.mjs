import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { handleBankingAgent } from '../server/banking-agent.mjs';
import { validateParsedIntent } from '../src/agent/validate-parsed-intent.mjs';
import { bankingIntentSystemPrompt, parseBankingIntent } from '../server/banking-intent-parser.mjs';
import { handleBanking } from '../server/banking.mjs';
import { toWire } from '../src/banking-core/wire.mjs';

const env = { SAVEFLOW_ACCESS_CODE: 'test-access-code-1234', CONTINUATION_TOKEN_SECRET: 'test-continuation-secret-1234', DASHSCOPE_API_KEY: 'fake-key' };
let requestNumber = 0;
const card = (action, slots = {}) => {
  const required = action === 'card.set_budget' ? ['card_ref', 'amount'] : ['card_ref'];
  const missingSlots = required.filter(slot => !(slot in slots));
  return { schemaVersion: '1.0.0', action, slots, missingSlots, status: missingSlots.length ? 'needs_clarification' : 'ready_for_resolution' };
};
const request = body => new Request('http://localhost/api/banking-agent', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'x-forwarded-for': `card-agent-${++requestNumber}` }, body: JSON.stringify(body),
});
const send = async (body, options) => (await handleBankingAgent(request(body), { env, now: () => 1000, ...options })).json();

test('all four card actions have strict matching parser and runtime contracts', async () => {
  assert.match(bankingIntentSystemPrompt, /card\.get、card\.set_budget、card\.freeze、card\.unfreeze/);
  for (const action of ['card.get', 'card.set_budget', 'card.freeze', 'card.unfreeze']) {
    const slots = action === 'card.set_budget' ? { card_ref: '娱乐虚拟卡', amount: { amount_minor: 100000, currency: 'CNY' } } : { card_ref: '娱乐虚拟卡' };
    const value = card(action, slots);
    assert.equal(validateParsedIntent(value), value);
    const result = await parseBankingIntent('卡片请求', { env, fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }) });
    assert.equal(result.action, action);
  }
});

test('missing card and budget slots clarify; extra fields and forged entity IDs are rejected', () => {
  for (const action of ['card.get', 'card.freeze', 'card.unfreeze']) assert.deepEqual(validateParsedIntent(card(action)).missingSlots, ['card_ref']);
  assert.deepEqual(validateParsedIntent(card('card.set_budget', { card_ref: '娱乐虚拟卡' })).missingSlots, ['amount']);
  const ready = card('card.set_budget', { card_ref: '娱乐虚拟卡', amount: { amount_minor: 0, currency: 'CNY' } });
  assert.throws(() => validateParsedIntent({ ...ready, slots: { ...ready.slots, limit_type: 'monthly_total' } }));
  assert.throws(() => validateParsedIntent({ ...ready, action: 'card.set_limit' }));
  assert.throws(() => validateParsedIntent({ ...ready, slots: { ...ready.slots, card_id: 'CARD-ENT' } }));
  assert.throws(() => validateParsedIntent({ ...ready, slots: { ...ready.slots, card_ref: ' CARD-ENT ' } }));
  assert.throws(() => validateParsedIntent({ ...ready, confirmed: true }));
  assert.throws(() => validateParsedIntent({ ...ready, slots: { ...ready.slots, amount: { ...ready.slots.amount, tool: 'execute' } } }));
  assert.throws(() => validateParsedIntent({ ...ready, slots: { ...ready.slots, amount: { amount_minor: 10000001, currency: 'CNY' } } }));
});

test('Qwen boundary rejects a forged card ID before Skill or Core dispatch', async () => {
  const core = createBankingCore();
  let prepares = 0;
  const response = await handleBankingAgent(request({ message: '冻结我的卡' }), {
    env, core: { ...core, prepare: () => { prepares++; throw new Error('unexpected prepare'); } }, now: () => 1000,
    fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(card('card.freeze', { card_ref: 'CARD-ENT' })) } }] }),
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'MODEL_FORMAT_ERROR');
  assert.equal(prepares, 0);
});

test('HTTP entry runs Qwen JSON through parser, dispatcher and Card Handler', async () => {
  const core = createBankingCore();
  const query = await handleBankingAgent(request({ message: '查看娱乐虚拟卡' }), {
    env, core, now: () => 1000,
    fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(card('card.get', { card_ref: '娱乐虚拟卡' })) } }] }),
  });
  const queryBody = await query.json();
  assert.equal(query.status, 200);
  assert.equal(queryBody.data.status, 'card_result');
  assert.equal(queryBody.data.data.card.id, 'CARD-ENT');
  const modelOutput = card('card.unfreeze', { card_ref: '娱乐虚拟卡' });
  const response = await handleBankingAgent(request({ message: '解冻娱乐虚拟卡' }), {
    env, core, now: () => 1000,
    fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(modelOutput) } }] }),
  });
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.code, 'INVALID_STATE');
  assert.equal(body.data.action, 'card.unfreeze');
  assert.equal(core.repository.getCards()[1].status, 'active');
});

test('freeze my card offers signed choices and a formal preview without execution', async () => {
  const core = createBankingCore();
  const first = await send({ message: '冻结我的卡' }, { core, parseIntent: async () => card('card.freeze', { card_ref: '我的卡' }) });
  assert.equal(first.data.slot, 'card_ref');
  assert.equal(first.data.choices.length, 2);
  assert.equal(first.data.continuationToken.includes('CARD-MAIN'), false);
  const second = await send({ continuationToken: first.data.continuationToken, choice: { optionId: first.data.choices[1].optionId } }, { core });
  assert.equal(second.data.status, 'awaiting_confirmation');
  assert.equal(second.data.action, 'card.freeze');
  assert.equal(second.data.preview.exactEffects[0].cardId, 'CARD-ENT');
  assert.equal(second.data.preview.exactEffects[0].cardName, '娱乐虚拟卡');
  assert.equal(second.data.preview.exactEffects[0].before.status, 'active');
  assert.equal(second.data.preview.exactEffects[0].after.status, 'frozen');
  assert.equal(second.data.risk.riskLevel, 'L2');
  assert.match(second.data.preview.previewHash, /^[a-f0-9]{64}$/);
  assert.equal(second.data.evidence[0].entityIds[0], 'CARD-ENT');
  assert.equal(core.repository.getCards()[1].status, 'active');
  assert.equal((await core.getOperation(second.data.operationId)).data.state, 'awaiting_confirmation');
});

test('card lookup is read-only; budget amount can be supplied over multiple turns', async () => {
  const core = createBankingCore();
  const read = await send({ message: '查看娱乐虚拟卡' }, { core, parseIntent: async () => card('card.get', { card_ref: '娱乐虚拟卡' }) });
  assert.equal(read.data.status, 'card_result');
  assert.equal(read.data.data.card.id, 'CARD-ENT');
  const first = await send({ message: '调整娱乐虚拟卡月预算' }, { core, parseIntent: async () => card('card.set_budget', { card_ref: '娱乐虚拟卡' }) });
  assert.equal(first.data.slot, 'amount');
  const third = await send({ continuationToken: first.data.continuationToken, message: '1000元' }, { core });
  assert.equal(third.data.status, 'awaiting_confirmation');
  assert.equal(third.data.preview.exactEffects[0].after.monthlyBudgetFen, 100000);
  assert.equal(third.data.preview.exactEffects[0].before.monthlyBudgetFen, 80000);
  assert.equal(core.repository.getCards()[1].monthlyBudgetFen, 80000);
});

test('budget below spent is previewed with an over-budget warning', async () => {
  const core = createBankingCore();
  const response = await handleBankingAgent(request({ message: '把娱乐虚拟卡月预算改成100元' }), {
    env, core, now: () => 1000,
    parseIntent: async () => card('card.set_budget', { card_ref: '娱乐虚拟卡', amount: { amount_minor: 10000, currency: 'CNY' } }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.status, 'awaiting_confirmation');
  assert.match(body.data.preview.warnings.join(' '), /当前已超预算/);
  assert.equal(core.repository.getCards()[1].monthlyBudgetFen, 80000);
});

test('changing cards clears the signed prior selection; task switch discards old card state', async () => {
  const core = createBankingCore();
  const first = await send({ message: '调整卡片月预算' }, { core, parseIntent: async () => card('card.set_budget') });
  const picked = await send({ continuationToken: first.data.continuationToken, choice: { optionId: first.data.choices[0].optionId } }, { core });
  assert.equal(picked.data.slot, 'amount');
  const changed = await send({ continuationToken: picked.data.continuationToken, message: '换卡' }, { core });
  assert.equal(changed.data.slot, 'card_ref');
  const other = await send({ continuationToken: changed.data.continuationToken, choice: { optionId: changed.data.choices[1].optionId } }, { core });
  const final = await send({ continuationToken: other.data.continuationToken, message: '1000元' }, { core });
  assert.equal(final.data.preview.exactEffects[0].cardId, 'CARD-ENT');
  const switched = await send({ continuationToken: changed.data.continuationToken, message: '查账单' }, { core, parseIntent: async () => ({ schemaVersion: '1.0.0', action: 'bill.summary', slots: {}, missingSlots: ['month'], status: 'needs_clarification' }) });
  assert.equal(switched.data.action, 'bill.summary');
  assert.equal(switched.data.slot, 'month');
  const cardQuery = await send({ continuationToken: changed.data.continuationToken, message: '查看娱乐虚拟卡信息' }, { core, parseIntent: async () => card('card.get', { card_ref: '娱乐虚拟卡' }) });
  assert.equal(cardQuery.data.status, 'card_result');
  assert.equal(cardQuery.data.data.card.id, 'CARD-ENT');
  const forged = await handleBankingAgent(request({ continuationToken: first.data.continuationToken, choice: { optionId: 'opt_forged' } }), { env, core, now: () => 1000 });
  assert.equal(forged.status, 400);
});

test('natural language card budget reaches Core through Agent preview and dedicated HTTP confirmation', async () => {
  const core = createBankingCore();
  const parsed = card('card.set_budget', { card_ref: '娱乐虚拟卡', amount: { amount_minor: 10000, currency: 'CNY' } });
  const preview = await send({ message: '把娱乐虚拟卡每月预算改成100元' }, { core, parseIntent: async () => parsed });
  assert.equal(preview.data.status, 'awaiting_confirmation');
  assert.equal(core.repository.getCard('CARD-ENT').monthlyBudgetFen, 80000);
  const call = async (action, input, key) => {
    const response = await handleBanking(new Request('http://localhost/api/banking', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, ...(key ? { 'Idempotency-Key': key } : {}) },
      body: JSON.stringify({ schema_version: '1.1.0', action, input: toWire(input) }),
    }), { env, core });
    return { status: response.status, body: await response.json() };
  };
  const id = preview.data.operationId, hash = preview.data.preview.previewHash;
  assert.equal((await call('action.execute', { operationId: id, previewHash: hash }, id)).body.code, 'CONFIRMATION_REQUIRED');
  assert.equal(core.repository.getCard('CARD-ENT').monthlyBudgetFen, 80000);
  assert.equal((await call('action.decide', { operationId: id, previewHash: hash, decision: 'confirm', confirmedStepIds: preview.data.preview.stepIds })).body.code, 'OK');
  const executed = await call('action.execute', { operationId: id, previewHash: hash }, id);
  assert.equal(executed.body.code, 'OK');
  assert.equal(executed.body.data.status, 'succeeded');
  assert.equal((await call('action.execute', { operationId: id, previewHash: hash }, id)).body.data.receipt_id, executed.body.data.receipt_id);
  const query = await send({ message: '查看娱乐虚拟卡' }, { core, parseIntent: async () => card('card.get', { card_ref: '娱乐虚拟卡' }) });
  assert.equal(query.data.data.card.monthlyBudgetFen, 10000);
  assert.equal(query.data.data.card.version, 1);
});

import assert from 'node:assert/strict';
import { createBankingCore } from '../../src/banking-core/core.mjs';
import { buildParsedIntent } from '../../src/agent/clarification/merge-intent.mjs';
import { handleBankingAgent } from '../../server/banking-agent.mjs';
import { createBankingRuntimeClient } from '../../server/trueforge-banking-runtime.mjs';
import { fixedNow } from './natural-language-cases.mjs';
import seed from '../../src/data/saveflow_mock_data.json' with { type: 'json' };

let sequence = 0;
export async function exerciseLanguageCase(definition, { live = false, env = {} } = {}) {
  const now = definition.now ?? fixedNow;
  const source = structuredClone(seed);
  source.accounts[0].availableBalance = 50000; // Entirely synthetic, supports a 10000 yuan preview.
  source.transactions.push(...['2025-01-01', '2025-12-31', '2026-09-01', '2026-09-30', '2026-10-22', '2026-10-23'].map((date, i) => ({ ...source.transactions[1], id: `acceptance-${i}`, date, amount: i + 1 })));
  const actualCore = createBankingCore({ source, now });
  const queries = [], prepares = [], modelTurns = [];
  const repository = { ...actualCore.repository, getTransactions: async filter => { queries.push(filter ?? {}); return actualCore.repository.getTransactions(filter); } };
  const core = { ...actualCore, repository,
    prepare: input => { prepares.push(input); return actualCore.prepare(input); },
    decide: () => assert.fail('understanding cannot confirm'), execute: () => assert.fail('understanding cannot execute'),
  };
  const settings = { ...env, SAVEFLOW_ACCESS_CODE: 'synthetic-language-test-access', CONTINUATION_TOKEN_SECRET: 'synthetic-language-test-continuation', SAVEFLOW_BANKING_RUNTIME: 'trueforge' };
  const real = live ? createBankingRuntimeClient({ env: settings }) : undefined;
  const client = {
    createSession: signal => live ? real.createSession(signal) : Promise.resolve('fixture-session'),
    cancel: id => live ? real.cancel(id) : Promise.resolve(),
    async runTurn(id, wire, signal) {
      const input = JSON.parse(wire);
      const output = live ? await real.runTurn(id, wire, signal) : JSON.stringify(
        !input.context && definition.initialMissing ? { ...buildParsedIntent(definition.action, definition.slots), missingSlots: definition.initialMissing, status: 'needs_clarification' } :
        input.context && definition.ordinalChoice ? { ...buildParsedIntent(definition.action, { ...definition.answerSlots, [input.context.pendingSlot]: input.context.choices[1].rawValue }), choice: { optionId: input.context.choices[1].optionId } } :
        definition.action === 'clarify' ? { schemaVersion: '1.0.0', action: 'clarify', slots: {}, missingSlots: ['action'], status: 'needs_clarification' } :
          buildParsedIntent(definition.action, input.context && definition.answerSlots ? definition.answerSlots : definition.slots));
      modelTurns.push({ input, output: JSON.parse(output) });
      return output;
    },
  };
  const post = async body => {
    const response = await handleBankingAgent(new Request('http://localhost/api/banking-agent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-saveflow-access': settings.SAVEFLOW_ACCESS_CODE, 'x-forwarded-for': `language-${++sequence}` }, body: JSON.stringify(body) }), { env: settings, now, timezone: definition.timezone ?? 'Asia/Shanghai', core, trueforgeRuntimeClient: client });
    const result = await response.json();
    assert.equal(response.status, 200, `${result.code}: ${result.message}`);
    return result;
  };
  try {
  let result = await post({ message: definition.message });
  assert.equal(modelTurns[0].input.userMessage, definition.message);
  if (definition.answer) {
    assert.ok(result.data.continuationToken);
    result = await post({ message: definition.answer, continuationToken: result.data.continuationToken });
    assert.equal(modelTurns.length, 2);
    assert.deepEqual(modelTurns[1].input.context.slots, modelTurns[0].output.slots);
    if (definition.ordinalChoice) assert.equal(modelTurns[1].output.choice.optionId, modelTurns[1].input.context.choices[1].optionId);
  }
  if (definition.clarify) {
    assert.equal(result.data.status, 'needs_clarification');
    assert.equal(prepares.length, 0);
    assert.equal(queries.length, 0);
    if (!definition.slots.amount) assert.equal(modelTurns.at(-1).output.slots.amount, undefined);
  } else {
    const expected = definition.answerSlots ?? definition.slots;
    if (['transfer.create', 'card.set_budget'].includes(definition.action)) {
      if (result.data.status === 'needs_clarification') {
        assert.ok(result.data.choices?.length, 'missing entity must offer signed choices');
        const option = result.data.choices.find(item => item.label.includes(definition.action === 'transfer.create' ? '活期' : '娱乐'));
        result = await post({ continuationToken: result.data.continuationToken, choice: { optionId: option.optionId } });
      }
      assert.equal(result.data.status, 'awaiting_confirmation');
      const effect = result.data.preview.exactEffects[0];
      assert.equal(definition.action === 'transfer.create' ? effect.amountFen : effect.after.monthlyBudgetFen, expected.amount.amount_minor);
      assert.equal(prepares.length, definition.previewCount ?? (definition.answer && definition.slots.amount ? 2 : 1));
      if (definition.expectedPayeeId) assert.equal(effect.payeeId, definition.expectedPayeeId);
      assert.equal(actualCore.repository.getAccount('ACC-CHECKING').balanceFen, 5000000);
    } else if (definition.action === 'bill.summary') {
      assert.equal(result.data.status, 'bill_result');
      const expectedFilter = expected.month ? { month: expected.month } : { startDate: expected.period.start_date, endDate: expected.period.end_date, timezone: expected.period.timezone };
      assert.deepEqual(queries, [expectedFilter]);
      assert.equal(result.data.data.transactionCount, actualCore.repository.getTransactions(expectedFilter).length);
      assert.ok(result.data.data.coverage.warning);
    } else {
      assert.equal(result.data.status, 'goal_plan');
      assert.equal(result.data.data.targetAmountFen, expected.amount.amount_minor);
      assert.equal(result.data.data.deadline, expected.deadline);
      assert.equal(result.data.data.execution_allowed, false);
    }
  }
  return { message: definition.message, answer: definition.answer, modelTurns, queries, prepares, resultStatus: result.data.status, resultData: result.data.data, previewEffects: result.data.preview?.exactEffects };
  } catch (error) {
    error.languageEvidence = { modelTurns, queries, prepares };
    throw error;
  }
}

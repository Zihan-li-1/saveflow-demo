/* eslint-disable @typescript-eslint/no-require-imports -- CJS test loads the actual TS client. */
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
const { askBankingAgent } = require('../src/lib/banking-agent-client.ts');

const env = { SAVEFLOW_ACCESS_CODE: 'test-access-code-1234', CONTINUATION_TOKEN_SECRET: 'test-continuation-secret-1234' };
const card = action => ({ schemaVersion: '1.0.0', action, slots: { card_ref: '娱乐虚拟卡' }, missingSlots: [], status: 'ready_for_resolution' });

test('browser client accepts real HTTP card query and write-preview envelopes', async () => {
  const { handleBankingAgent } = await import('../server/banking-agent.mjs');
  const { createBankingCore } = await import('../src/banking-core/core.mjs');
  const core = createBankingCore();
  const original = global.fetch;
  let action = 'card.get';
  try {
    global.fetch = async (url, init) => handleBankingAgent(new Request(`http://localhost${url}`, init), {
      env, core, now: () => 1000, parseIntent: async () => card(action),
    });
    const read = await askBankingAgent({ message: '查看娱乐虚拟卡' }, env.SAVEFLOW_ACCESS_CODE, new AbortController().signal);
    assert.equal(read.status, 'card_result');
    assert.equal(read.data.card.name, '娱乐虚拟卡');
    assert.equal(read.evidence[0].entityIds[0], 'CARD-ENT');
    action = 'card.freeze';
    const write = await askBankingAgent({ message: '冻结娱乐虚拟卡' }, env.SAVEFLOW_ACCESS_CODE, new AbortController().signal);
    assert.equal(write.status, 'awaiting_confirmation');
    assert.equal(write.preview.exactEffects[0].cardName, '娱乐虚拟卡');
    assert.equal(write.preview.exactEffects[0].before.status, 'active');
    assert.equal(write.preview.exactEffects[0].after.status, 'frozen');
    assert.equal(write.risk.riskLevel, 'L2');
    assert.equal(core.repository.getCards()[1].status, 'active');
    global.fetch = async () => Response.json({ code: 'OK', requestId: 'r1', data: { status: 'card_action_request', action: 'card.freeze', data: { request: { action: 'card.freeze' }, requirements: { explicitUserConfirmation: true } } } });
    await assert.rejects(askBankingAgent({ message: '冻结娱乐虚拟卡' }, env.SAVEFLOW_ACCESS_CODE, new AbortController().signal), { code: 'BANKING_AGENT_RESPONSE_ERROR' });
  } finally { global.fetch = original; }
});

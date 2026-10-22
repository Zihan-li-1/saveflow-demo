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
const { createBankingClient } = require('../src/lib/api/banking-client.ts');
const { askBankingAgent } = require('../src/lib/banking-agent-client.ts');

const env = { SAVEFLOW_ACCESS_CODE: 'test-access-code-1234', CONTINUATION_TOKEN_SECRET: 'test-continuation-secret-1234' };
test('browser accepts Wealth result, preview and the verified execution receipt', async () => {
  const { handleBankingAgent } = await import('../server/banking-agent.mjs');
  const { handleBanking } = await import('../server/banking.mjs');
  const { createBankingCore } = await import('../src/banking-core/core.mjs');
  const core = createBankingCore();
  const oldFetch = global.fetch;
  let action = 'wealth.recommend';
  try {
    global.fetch = async (url, init) => handleBankingAgent(new Request(`http://localhost${url}`, init), {
      env, core, parseIntent: async () => action === 'wealth.recommend'
        ? { schemaVersion: '1.0.0', action, slots: { goal: { kind: 'steady_growth' } }, missingSlots: [], status: 'ready_for_resolution' }
        : { schemaVersion: '1.0.0', action, slots: { product_ref: '模拟灵活现金 A', amount: { amount_minor: 10000, currency: 'CNY' }, source_account_ref: '活期账户' }, missingSlots: [], status: 'ready_for_resolution' },
    });
    const read = await askBankingAgent({ message: '推荐模拟理财' }, env.SAVEFLOW_ACCESS_CODE, new AbortController().signal);
    assert.equal(read.status, 'wealth_result');
    action = 'wealth.subscribe';
    const prepared = await askBankingAgent({ message: '申购模拟灵活现金 A' }, env.SAVEFLOW_ACCESS_CODE, new AbortController().signal);
    assert.equal(prepared.status, 'awaiting_confirmation');
    const client = createBankingClient({ mode: 'http', baseUrl: 'http://localhost', accessCode: () => env.SAVEFLOW_ACCESS_CODE, fetchImpl: (url, init) => handleBanking(new Request(url, init), { env, core }) });
    const decision = await client.request('action.decide', { operationId: prepared.operationId, previewHash: prepared.preview.previewHash, decision: 'confirm', confirmedStepIds: prepared.preview.stepIds });
    assert.equal(decision.state, 'confirmed');
    const receipt = await client.request('action.execute', { operationId: prepared.operationId, previewHash: prepared.preview.previewHash });
    assert.equal(receipt.action, 'wealth.subscribe');
    assert.equal(receipt.status, 'succeeded');
    assert.equal(receipt.effects[0].kind, 'wealth_change');
  } finally { global.fetch = oldFetch; }
});

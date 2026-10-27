/* eslint-disable @typescript-eslint/no-require-imports -- Verify the production browser storage functions with real server credentials. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, filename);
const { saveBankingChat, restoreBankingChat } = require('../src/lib/banking-chat-storage.ts');
const { updateBankingFlows } = require('../src/lib/banking-flow-state.ts');
const { createBankingCore } = require('../src/banking-core/core.mjs');
const { handleBankingAgent } = require('../server/banking-agent.mjs');
const { buildParsedIntent } = require('../src/agent/clarification/merge-intent.mjs');
const env = { SAVEFLOW_ACCESS_CODE: 'storage-test-private-access', CONTINUATION_TOKEN_SECRET: 'storage-test-private-secret' };
let seq = 0;
async function fixture() {
  const core = createBankingCore(); const now = Date.now();
  const intent = buildParsedIntent('transfer.create', { payee_ref: '张三', source_account_ref: '活期账户', amount: { amount_minor: 50000, currency: 'CNY' } });
  const response = await handleBankingAgent(new Request('http://localhost/api/banking-agent', { method: 'POST', headers: {
    'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'x-forwarded-for': `storage-${++seq}`,
  }, body: JSON.stringify({ message: '从活期账户给张三转500元' }) }), { env, core, parseIntent: async () => intent });
  const { data } = await response.json();
  return { core, data, now, messages: [{ id: 1, role: 'agent', text: '正式预览', kind: 'banking_preview', banking: data }],
    flows: updateBankingFlows({}, 'ignored-local-key', data, now) };
}
test('tab snapshot persists opaque routing credentials, strips auth/unknown fields, and never restores preview authority', async () => {
  const f = await fixture();
  f.messages[0].accessCode = env.SAVEFLOW_ACCESS_CODE;
  f.messages[0].banking.apiKey = 'not-for-storage';
  const task = f.data.conversation.currentTask.taskId;
  f.flows[task].apiKey = 'not-for-storage';
  const raw = saveBankingChat(f.messages, null, f.now, f.now, { flows: f.flows, focusedFlowId: null,
    conversationToken: f.data.conversation.token, accessCode: env.SAVEFLOW_ACCESS_CODE, apiKey: env.CONTINUATION_TOKEN_SECRET, consent: true });
  for (const secret of [env.SAVEFLOW_ACCESS_CODE, env.CONTINUATION_TOKEN_SECRET, 'not-for-storage']) assert.ok(!raw.includes(secret));
  const snapshot = JSON.parse(raw);
  assert.equal(snapshot.version, 2); assert.equal(snapshot.consent, undefined);
  assert.equal(snapshot.messages[0].banking.conversation, undefined);
  const restored = restoreBankingChat(raw, f.now + 1);
  assert.equal(restored.conversationToken, f.data.conversation.token);
  assert.equal(restored.flows[task].previewOperationId, f.data.operationId);
  assert.equal(restored.messages[0].banking.historySnapshot, true);
  assert.equal(restored.messages[0].banking.previewCurrent, false);
});
test('P2-3 version-one message metadata migrates into unverified opaque task references', async () => {
  const f = await fixture(); const task = f.data.conversation.currentTask.taskId;
  const old = JSON.stringify({ version: 1, savedAt: f.now, messages: f.messages, continuation: null,
    continuationExpiresAt: f.now + 300000, flows: {}, focusedFlowId: null });
  const restored = restoreBankingChat(old, f.now + 1);
  assert.equal(restored.conversationToken, f.data.conversation.token);
  assert.equal(restored.flows[task].token, f.data.continuationToken);
  assert.equal(restored.messages[0].banking.historySnapshot, true);
  assert.deepEqual(restored.messages[0].banking.choices, []);
});
test('cached task flags cannot survive restoration as confirmation permission; fresh server metadata removes foreign flows', async () => {
  const f = await fixture(); const other = await fixture();
  const raw = JSON.parse(saveBankingChat(f.messages, null, f.now, f.now, { flows: { ...f.flows, ...other.flows }, focusedFlowId: null, conversationToken: f.data.conversation.token }));
  raw.messages[0].banking.previewCurrent = true; raw.messages[0].banking.historySnapshot = false;
  raw.messages[0].banking.confirmed = true;
  const restored = restoreBankingChat(JSON.stringify(raw), f.now + 1);
  assert.equal(restored.messages[0].banking.previewCurrent, false);
  assert.equal(restored.messages[0].banking.historySnapshot, true);
  const reconciled = updateBankingFlows(restored.flows, '', { status: 'conversation_state', conversation: f.data.conversation }, f.now + 1);
  assert.equal(Object.keys(reconciled).length, 1);
  assert.equal(reconciled[other.data.conversation.currentTask.taskId], undefined);
  assert.equal((await f.core.getOperation(f.data.operationId)).data.state, 'awaiting_confirmation');
});

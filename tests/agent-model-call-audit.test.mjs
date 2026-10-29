import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { buildParsedIntent } from '../src/agent/clarification/merge-intent.mjs';
import { handleBankingAgent } from '../server/banking-agent.mjs';

const baseEnv = { SAVEFLOW_BANKING_RUNTIME: 'trueforge', SAVEFLOW_AGENT_DIAGNOSTICS: 'true',
  SAVEFLOW_ACCESS_CODE: 'audit-access-code-1234', CONTINUATION_TOKEN_SECRET: 'audit-continuation-secret-1234',
  TRUEFORGE_BASE_URL: 'http://localhost:8790', TRUEFORGE_MODEL: 'audit/model' };
const url = 'https://audit.example/api/banking-agent';
const makeRequest = body => new Request(url, { method: 'POST', headers: {
  'content-type': 'application/json', 'x-saveflow-access': baseEnv.SAVEFLOW_ACCESS_CODE, origin: 'https://audit.example',
}, body: JSON.stringify(body) });

function runtime(resolve) {
  let calls = 0;
  return { get calls() { return calls; }, createSession: async () => 'audit-session', cancel: async () => {},
    runTurn: async (_id, wire) => { calls++; return JSON.stringify(await resolve(JSON.parse(wire))); } };
}

test('diagnostics distinguish TrueForge call from deterministic continuation choice', async () => {
  const events = [];
  const client = runtime(input => input.context
    ? buildParsedIntent('transfer.create', { payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' } })
    : buildParsedIntent('transfer.create', { payee_ref: '张三', amount: { amount_minor: 50000, currency: 'CNY' } }));
  const core = createBankingCore();
  const first = await handleBankingAgent(makeRequest({ message: '给张三转500元' }), { env: baseEnv, core, trueforgeRuntimeClient: client, diagnosticSink: line => events.push(JSON.parse(line)) });
  const firstBody = await first.json();
  assert.equal(firstBody.data.status, 'needs_clarification');
  assert.equal(client.calls, 1);
  const second = await handleBankingAgent(makeRequest({ continuationToken: firstBody.data.continuationToken, choice: { optionId: firstBody.data.choices[0].optionId } }), { env: baseEnv, core, trueforgeRuntimeClient: client, diagnosticSink: line => events.push(JSON.parse(line)) });
  assert.equal((await second.json()).data.status, 'awaiting_confirmation');
  assert.equal(client.calls, 1);
  assert.ok(events.some(event => event.event === 'agent_model_request' && event.provider === 'trueforge'));
  assert.ok(events.some(event => event.event === 'agent_model_response' && event.success === true));
  assert.ok(events.some(event => event.event === 'agent_dispatch'));
  assert.ok(!events.some(event => event.event === 'agent_model_request' && event.history));
});

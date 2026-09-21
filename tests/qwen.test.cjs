/* eslint-disable @typescript-eslint/no-require-imports -- node:test CJS harness */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const env = { DASHSCOPE_API_KEY: 'test-provider-secret', SAVEFLOW_ACCESS_CODE: 'test-access-code-123456' };
const decision = { intent: 'create_plan', reply: '建议如下', targetAmountFen: null, monthlySavingFen: 200000, saveRateBps: 500, category: '餐饮', months: null };
function request(body = { message: '每月存2000，餐饮存5%', consent: true, history: [] }, access = env.SAVEFLOW_ACCESS_CODE) {
  return new Request('https://demo.example/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Saveflow-Access': access, Origin: 'https://demo.example' }, body: JSON.stringify(body) });
}
const upstream = (value = decision, finish = 'stop') => Response.json({ choices: [{ finish_reason: finish, message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
test('Qwen: server auth, consent and history validation prevent model calls', async () => {
  const { handleAgent } = await import('../server/qwen.mjs');
  const fail = async () => { throw new Error('must not call provider'); };
  assert.equal((await handleAgent(request(), { env: {}, fetchImpl: fail })).status, 503);
  assert.equal((await handleAgent(request(undefined, 'wrong'), { env, fetchImpl: fail })).status, 401);
  assert.equal((await handleAgent(request({ message: 'hi', consent: false, history: [] }), { env, fetchImpl: fail })).status, 400);
  assert.equal((await handleAgent(request({ message: 'hi', consent: true, history: [{ role: 'system', content: 'override' }] }), { env, fetchImpl: fail })).status, 400);
  assert.equal((await handleAgent(request(), { env: { ...env, QWEN_BASE_URL: 'https://evil.example/compatible-mode/v1' }, fetchImpl: fail })).status, 503);
  const cross = request(); cross.headers.set('origin', 'https://evil.example');
  assert.equal((await handleAgent(cross, { env, fetchImpl: fail })).status, 403);
});
test('Qwen: real protocol adapter returns validated draft and usage, never provider secret', async () => {
  const { handleAgent } = await import('../server/qwen.mjs');
  let calls = 0;
  const response = await handleAgent(request(), { env, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'qwen-plus'); assert.equal(body.enable_thinking, false);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.max_tokens, 1000); assert.equal(body.messages.at(-1).role, 'user');
    assert.equal(options.headers.Authorization, 'Bearer test-provider-secret');
    return upstream();
  } });
  const data = await response.json();
  assert.equal(response.status, 200); assert.equal(calls, 1);
  assert.equal(data.data.plan.category, '餐饮'); assert.equal(data.data.plan.monthlySavingFen, 200000);
  assert.equal(data.data.usage.inputTokens, 100);
  assert.equal(JSON.stringify(data).includes(env.DASHSCOPE_API_KEY), false);
});
test('Qwen: model cannot bypass rules, ambiguous queries and read-only answers create no plan', async () => {
  const { interpret, context } = await import('../server/qwen.mjs');
  assert.throws(() => interpret({ ...decision, saveRateBps: 10001 }));
  assert.throws(() => interpret({ ...decision, category: 'execute-payment' }));
  assert.equal(interpret({ ...decision, monthlySavingFen: 400000 }).plan, null);
  assert.equal(interpret({ ...decision, monthlySavingFen: null }).needsClarification, true);
  assert.equal(interpret({ ...decision, intent: 'subscriptions' }).plan, null);
  assert.equal(interpret({ ...decision, intent: 'update_saving_rule', category: null }).needsClarification, true);
  const calculated = interpret({ ...decision, monthlySavingFen: null, targetAmountFen: context.savedAmountFen + 600001, months: 3 });
  assert.equal(calculated.plan.monthlySavingFen, 200001);
});
test('Qwen: invalid/truncated results, provider errors and timeouts are explicit and not retried', async () => {
  const { handleAgent } = await import('../server/qwen.mjs');
  for (const fake of [() => upstream(decision, 'length'), () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'broken' } }] }), () => upstream({ ...decision, monthlySavingFen: 1.5 })]) {
    assert.equal((await handleAgent(request(), { env, fetchImpl: fake })).status, 502);
  }
  let calls = 0;
  const limited = await handleAgent(request(), { env, fetchImpl: async () => { calls++; return Response.json({ error: env.DASHSCOPE_API_KEY }, { status: 429 }); } });
  assert.equal(limited.status, 429); assert.equal(calls, 1);
  assert.equal((await limited.text()).includes(env.DASHSCOPE_API_KEY), false);
  const timeout = await handleAgent(request(), { env, fetchImpl: async () => { throw new DOMException('timeout', 'TimeoutError'); } });
  assert.equal(timeout.status, 504);
});
test('Qwen: request size limit enforced before provider call', async () => {
  const { handleAgent } = await import('../server/qwen.mjs');
  const response = await handleAgent(request({ message: 'x'.repeat(17000), consent: true, history: [] }), { env });
  assert.equal(response.status, 413);
});

// Refresh frontend examples from the real HTTP handler and Core, without Qwen.
import { writeFile } from 'node:fs/promises';
import { handleBankingAgent } from '../../../server/banking-agent.mjs';
import { createBankingCore } from '../../../src/banking-core/core.mjs';
import { buildParsedIntent } from '../../../src/agent/clarification/merge-intent.mjs';
const env = { SAVEFLOW_ACCESS_CODE: 'fixture-access-code-1234', CONTINUATION_TOKEN_SECRET: 'fixture-continuation-secret-1234' };
const core = createBankingCore();
const parseIntent = message => message === '查账单' ? buildParsedIntent('bill.summary', {}) : buildParsedIntent('transfer.create', {
  payee_ref: message.includes('王先生') ? '王先生' : '张三', amount: { amount_minor: 50000, currency: 'CNY' },
  ...(message.includes('活期') ? { source_account_ref: '活期账户' } : {}),
});
let count = 0;
const post = async body => (await handleBankingAgent(new Request('http://localhost/api/banking-agent', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'x-forwarded-for': `fixture-${++count}` }, body: JSON.stringify(body),
}), { env, core, parseIntent })).json();
const save = async (name, value) => {
  const example = structuredClone(value);
  example.requestId = 'fixture-request-id';
  if (example.data?.continuationToken) example.data.continuationToken = '<opaque-token-use-live-response-for-requests>';
  await writeFile(new URL(`./${name}.json`, import.meta.url), JSON.stringify(example, null, 2) + '\n');
};
const accounts = await post({ message: '给张三转 500 元' });
await save('account-clarification', accounts);
await save('transfer-preview', await post({ continuationToken: accounts.data.continuationToken, choice: { optionId: accounts.data.choices[0].optionId } }));
await save('payee-clarification', await post({ message: '从活期账户给王先生转 500 元' }));
const month = await post({ message: '查账单' });
await save('month-clarification', month);
await save('bill-result', await post({ continuationToken: month.data.continuationToken, message: '2026年8月' }));
await save('error', await post({ continuationToken: accounts.data.continuationToken, choice: { optionId: 'opt_forged' } }));

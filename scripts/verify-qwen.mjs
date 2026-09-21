// One real request using synthetic data. Never print credentials or raw provider errors.
import nextEnv from '@next/env';
import { handleAgent } from '../server/qwen.mjs';

nextEnv.loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
const key = process.env.DASHSCOPE_API_KEY?.trim();
const access = process.env.SAVEFLOW_ACCESS_CODE || '';
const checks = {
  apiKeyConfigured: Boolean(key && !key.includes('你的') && !key.includes('这里')),
  accessCodeValid: access.length >= 16 && access.length <= 128 && /^[\x21-\x7e]+$/.test(access),
  model: process.env.QWEN_MODEL === 'qwen-plus' || !process.env.QWEN_MODEL ? 'qwen-plus' : 'custom',
};
console.log(JSON.stringify({ configuration: checks }));
if (!checks.apiKeyConfigured || !checks.accessCodeValid) process.exit(1);
if (process.argv.includes('--check')) process.exit(0);

let attempted = false;
let providerStatus = null;
let networkCode = null;
const request = new Request('http://localhost/api/agent', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Saveflow-Access': access, Origin: 'http://localhost' },
  body: JSON.stringify({ message: '我想每月存2000元，餐饮消费自动存5%。', history: [], consent: true }),
});
const started = Date.now();
const response = await handleAgent(request, { fetchImpl: async (...args) => {
  attempted = true;
  try {
    const result = await fetch(...args);
    providerStatus = result.status;
    return result;
  } catch (error) {
    const code = error?.cause?.code;
    networkCode = typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'NETWORK_ERROR';
    throw error;
  }
} });
const payload = await response.json();
const plan = payload.data?.plan;
const matches = plan?.monthlySavingFen === 200000 && plan?.saveRateBps === 500 && plan?.category === '餐饮';
console.log(JSON.stringify({ status: response.status, code: payload.code, attempted, providerStatus, networkCode, elapsedMs: Date.now() - started,
  ...(response.ok ? { intent: payload.data.intent, plan, usage: payload.data.usage, expectedParametersMatch: matches } : { message: payload.message }),
}));
if (!response.ok || !matches) process.exitCode = 1;

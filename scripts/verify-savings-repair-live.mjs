import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { collectSavingsData } from '../server/savings-data.mjs';
import { calculateSavingsEvidence } from '../server/savings-advisor.mjs';
try { process.loadEnvFile('.env.local'); } catch { /* caller can supply env */ }
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const directory = 'docs/verification/savings-repair';
await mkdir(directory, { recursive: true });
const child = fork('tests/fixtures/savings-live-ui-server.mjs', [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const [{ port }] = await once(child, 'message');
const url = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report = { date: '2026-10-30', baseCommit: '416433c', model: process.env.TRUEFORGE_MODEL,
  inference: 'real TrueForge/DeepSeek in every advice request, including the truncated-reply fault; no fixed model outputs',
  transport: 'real Chrome -> HTTP -> authenticated handler -> installed SDK', cases: [], pageErrors: 0, financialWrites: 0 };
const redact = value => {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['continuationToken', 'wealthHandoffToken', 'conversation'].includes(key)).map(([key, item]) => [key, redact(item)]));
};
const state = async () => (await fetch(`${url}/test-state`)).json();
const contexts = [];
async function pageForGoal(goal = '我要在2026年12月31日前存够一万元') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); contexts.push(context);
  await context.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
  const page = await context.newPage(); page.on('pageerror', () => report.pageErrors++);
  await page.goto(url);
  await page.getByLabel('演示访问码', { exact: true }).fill(process.env.SAVEFLOW_ACCESS_CODE);
  await page.locator('.consent-control input').check();
  const pending = await request(page, async () => { await page.locator('.composer input').fill(goal); await page.locator('.composer input').press('Enter'); });
  assert.equal(pending.body.data.status, 'needs_plan_inputs');
  assert.equal(pending.body.data.recentSource, 'repository');
  return page;
}
async function request(page, action, expected = 200) {
  const waiting = page.waitForResponse(r => r.url().endsWith('/api/banking-agent') && r.request().method() === 'POST', { timeout: 60000 });
  await action(); const response = await waiting; const body = await response.json();
  assert.equal(response.status(), expected, `${body.code}: ${body.message}`);
  await page.locator('.typing').waitFor({ state: 'detached' });
  return { httpStatus: response.status(), body, posted: response.request().postDataJSON() };
}
const form = page => page.getByRole('form', { name: '补充储蓄计划数据' });
async function submit(page, saved = '2000', expected = 200) {
  await form(page).getByLabel('本目标已存金额（元）', { exact: true }).fill(saved);
  return request(page, () => form(page).getByRole('button', { name: '核算并生成储蓄计划' }).click(), expected);
}
async function screenshot(page, filename) {
  const card = page.getByRole('region', { name: '储蓄计划卡片' });
  await card.getByText('已完成算术与证据复核 · 只读', { exact: true }).waitFor();
  await card.evaluate(element => { for (let p = element.parentElement; p; p = p.parentElement) Object.assign(p.style, { overflow: 'visible', height: 'auto', maxHeight: 'none' }); });
  await card.screenshot({ path: `${directory}/${filename}` });
}
function verify(response) {
  const data = response.body.data;
  assert.equal(data.status, 'goal_plan'); assert.equal(data.data.verification_status, 'verified'); assert.equal(data.data.execution_allowed, false);
  assert.equal(data.data.advice.category_budgets.length, 9);
  assert.equal(data.data.advice.observations.length, 9);
  return data.data;
}
try {
  const headers = process.env.TRUEFORGE_TOKEN ? { Authorization: `Bearer ${process.env.TRUEFORGE_TOKEN}` } : {};
  const registryResponse = await fetch(`${process.env.TRUEFORGE_BASE_URL}/api/v1/models`, { headers });
  assert.ok(registryResponse.ok);
  const registry = await registryResponse.json();
  const selected = registry.data.find(item => item.name === process.env.TRUEFORGE_MODEL);
  assert.ok(selected && /deepseek/i.test(selected.model_id));
  report.resolvedModel = { name: selected.name, modelId: selected.model_id, provider: selected.provider.name };
  const financial = await collectSavingsData(createBankingCore().repository, '2026-10-30');
  assert.equal(financial.history.length, 8);
  const comparisons = calculateSavingsEvidence({ recent: financial.recent, history: financial.history, sources: financial.sources, required_monthly_minor: 400000 }).comparisons;
  report.historyMonths = financial.history.length;
  for (let i = 0; i < 3; i++) {
    const page = await pageForGoal();
    const response = await submit(page); const data = verify(response);
    for (const item of data.advice.observations) assert.equal(item.trend, comparisons.find(comparison => comparison.category === item.category).trend);
    report.cases.push({ name: `eight-month nine-category live generation ${i + 1}`, passed: true, requestId: response.body.requestId, httpStatus: response.httpStatus });
    if (!i) {
      await writeFile(`${directory}/verified-response.json`, JSON.stringify({ httpStatus: response.httpStatus, redactions: 'signed continuation and conversation credentials removed', body: redact(response.body) }, null, 2) + '\n');
      await screenshot(page, 'verified-plan.png');
    }
  }
  const gapPage = await pageForGoal('我要在2026年12月31日前存够100万元');
  const gapResponse = await submit(gapPage, '0'); const gap = verify(gapResponse);
  assert.equal(gap.advice.feasible, false); assert.ok(gap.advice.remaining_gap_minor > 0);
  report.cases.push({ name: 'income cannot cover large savings goal; genuine shortfall retained', passed: true, requestId: gapResponse.body.requestId,
    required_monthly_minor: gap.calculation.required_monthly_minor, remaining_gap_minor: gap.advice.remaining_gap_minor });
  await writeFile(`${directory}/shortfall-response.json`, JSON.stringify({ httpStatus: gapResponse.httpStatus, body: redact(gapResponse.body) }, null, 2) + '\n');
  const retryPage = await pageForGoal();
  await fetch(`${url}/test-truncate-next`, { method: 'POST' });
  const before = await state();
  const rejected = await submit(retryPage, '650', 502);
  assert.equal(rejected.body.code, 'ADVICE_REVIEW_FAILED');
  assert.equal(rejected.body.data.error.category, 'advice_review');
  assert.equal(rejected.body.data.error.retryable, true);
  assert.equal(await form(retryPage).getByLabel('本目标已存金额（元）', { exact: true }).inputValue(), '650');
  assert.equal(await retryPage.getByRole('region', { name: '储蓄计划卡片' }).count(), 0);
  await retryPage.waitForTimeout(750);
  const afterFailure = await state();
  assert.equal(afterFailure.adviceCalls, before.adviceCalls + 1);
  assert.ok(afterFailure.diagnostics.some(entry => entry.requestId === rejected.body.requestId && entry.stage === 'json_parse' && entry.reason === 'json_invalid'));
  const retried = await request(retryPage, () => retryPage.getByRole('button', { name: '重试本次请求', exact: true }).click());
  const retryData = verify(retried);
  assert.deepEqual(retried.posted.planInputs, rejected.posted.planInputs);
  assert.equal(retried.posted.continuationToken, rejected.posted.continuationToken);
  assert.equal(retryData.calculation.saved_amount_minor, 65000);
  report.cases.push({ name: 'actual live model reply truncated after inference; JSON rejected; form retained; explicit retry uses same signed inputs', passed: true,
    failureRequestId: rejected.body.requestId, retryRequestId: retried.body.requestId, noAutomaticRetry: true, sameSignedInputs: true });
  await screenshot(retryPage, 'manual-retry-verified.png');
  const final = await state(); report.adviceCalls = final.adviceCalls; report.financialWrites = final.financialWrites; report.diagnostics = final.diagnostics;
  assert.equal(final.financialWrites, 0); assert.equal(report.pageErrors, 0); assert.equal(final.adviceCalls, 6);
  report.passed = true;
} catch (error) { report.passed = false; report.failure = error.code || error.message; process.exitCode = 1; }
finally {
  await writeFile(`${directory}/live-checks.json`, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report) + '\n'); await browser.close(); child.kill();
}

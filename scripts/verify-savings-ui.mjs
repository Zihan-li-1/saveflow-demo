// Real page -> real HTTP handler -> configured TrueForge/DeepSeek. No mocked replies.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
try { process.loadEnvFile('.env.local'); } catch { /* host may provide env */ }
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.env.SAVINGS_UI_URL || 'http://127.0.0.1:3110';
const directory = 'docs/verification/savings-trueforge';
const report = { date: '2026-10-30', model: process.env.TRUEFORGE_MODEL, transport: 'real HTTP + installed TrueForge SDK',
  modelOutput: 'live, no injected JSON', browser: 'Chrome headless', checks: [], pageErrors: 0, financialWrites: 0 };
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await context.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
const page = await context.newPage();
page.on('pageerror', () => report.pageErrors++);
page.on('request', request => {
  if (request.url().endsWith('/api/banking') && ['action.prepare', 'action.decide', 'action.execute'].includes(request.postDataJSON()?.action)) report.financialWrites++;
});
async function request(action) {
  const waiting = page.waitForResponse(r => r.url().endsWith('/api/banking-agent') && r.request().method() === 'POST', { timeout: 60000 });
  await action();
  const response = await waiting;
  const result = await response.json();
  report.lastResponse = { code: result.code, status: result.data?.status };
  assert.equal(response.status(), 200, result.code);
  await page.locator('.typing').waitFor({ state: 'detached' });
  return result.data;
}
try {
  const headers = process.env.TRUEFORGE_TOKEN ? { Authorization: `Bearer ${process.env.TRUEFORGE_TOKEN}` } : {};
  const registryResponse = await fetch(`${process.env.TRUEFORGE_BASE_URL}/api/v1/models`, { headers });
  assert.ok(registryResponse.ok, 'model registry unavailable');
  const registry = await registryResponse.json();
  const selectedModel = registry.data.find(model => model.name === process.env.TRUEFORGE_MODEL);
  assert.ok(selectedModel && /deepseek/i.test(selectedModel.model_id), 'configured model must resolve to DeepSeek');
  report.resolvedModel = { name: selectedModel.name, modelId: selectedModel.model_id, provider: selectedModel.provider.name };
  await page.goto(url);
  await page.getByLabel('演示访问码', { exact: true }).fill(process.env.SAVEFLOW_ACCESS_CODE);
  await page.locator('.consent-control input').check();
  const initial = await request(async () => {
    await page.locator('.composer input').fill('我要在2026年12月31日前存够一万元');
    await page.locator('.composer input').press('Enter');
  });
  assert.equal(initial.status, 'needs_plan_inputs');
  report.checks.push('live understanding keeps orchestrator.goal and asks for signed savings inputs');
  const form = page.getByRole('form', { name: '补充储蓄计划数据' });
  await form.getByLabel('本目标已存金额（元）', { exact: true }).fill('2000');
  const expenses = { 房租: 3000, 餐饮: 1450, 交通: 400, 通信: 100, 日用品: 500, 娱乐: 1120, 购物: 1280, 订阅: 90, 其他: 520 };
  if (initial.recentSource === 'user_provided') {
    await form.getByLabel('月收入（元）', { exact: true }).fill('12000');
    for (const category of initial.categories) await form.getByLabel(category, { exact: true }).fill(String(expenses[category] ?? 0));
  }
  const plan = await request(() => form.getByRole('button', { name: '核算并生成储蓄计划' }).click());
  assert.equal(plan.status, 'goal_plan');
  assert.equal(plan.data.verification_status, 'verified');
  assert.equal(plan.data.execution_allowed, false);
  assert.equal(plan.data.calculation.saved_amount_minor, 200000);
  assert.equal(plan.data.calculation.required_monthly_minor, 400000);
  assert.equal(plan.data.advice.category_budgets.length, initial.categories.length);
  const card = page.getByRole('region', { name: '储蓄计划卡片' });
  await card.getByText('已完成算术与证据复核 · 只读', { exact: true }).waitFor();
  await card.getByText('¥2,000.00', { exact: true }).waitFor();
  report.checks.push('saved amount submitted through signed form; live advice independently verified and rendered', 'goal math and all category budgets displayed');
  report.calculation = { saved_minor: plan.data.calculation.saved_amount_minor, required_monthly_minor: plan.data.calculation.required_monthly_minor,
    remaining_gap_minor: plan.data.advice.remaining_gap_minor, feasible: plan.data.advice.feasible };
  assert.equal(report.financialWrites, 0);
  assert.equal(report.pageErrors, 0);
  report.checks.push('no financial write requests; no browser errors');
  await page.getByLabel('演示访问码', { exact: true }).fill('');
  // Expand only the QA page's scroll ancestors so the entire rendered card is visible.
  await card.evaluate(element => {
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      Object.assign(ancestor.style, { overflow: 'visible', height: 'auto', maxHeight: 'none' });
    }
  });
  await card.screenshot({ path: `${directory}/verified-plan.png` });
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = error.code || error.message;
  process.exitCode = 1;
} finally {
  await writeFile(`${directory}/live-ui.json`, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report) + '\n');
  await browser.close();
}

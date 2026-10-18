// Deployment acceptance against a PR preview only. Never target production,
// record credentials/tokens, confirm a payment, or modify account data.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd(), true);
const base = new URL(process.env.SAVEFLOW_PREVIEW_URL);
if (base.protocol !== 'https:' || !/^deploy-preview-\d+--[a-z0-9-]+\.netlify\.app$/.test(base.hostname) || base.pathname !== '/' || base.search || base.hash) throw new Error('Set SAVEFLOW_PREVIEW_URL to the HTTPS PR Deploy Preview root');
const dir = 'docs/verification/netlify-preview';
await mkdir(dir, { recursive: true });
const report = { at: new Date().toISOString(), url: base.origin, checks: [], failures: [], requests: [], browserErrors: [], trueforgeObserved: false };
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ baseURL: base.origin, viewport: { width: 1440, height: 1000 } });
page.on('pageerror', e => report.browserErrors.push(e.message));
function failure(name, r) {
  const code = r?.json?.code;
  const classification = code === 'CONTINUATION_INVALID' || code === 'CONTINUATION_STALE' ? 'continuation state/scope; server instance logs needed to distinguish Map loss from scope/config mismatch'
    : ['DATABASE_NOT_CONFIGURED', 'SERVICE_UNAVAILABLE', 'CONTINUATION_CONFIG_ERROR', 'TRUEFORGE_CONFIG_ERROR'].includes(code) ? 'deployment configuration'
    : ['UNAUTHORIZED', 'FORBIDDEN'].includes(code) ? 'access or policy rejection'
    : ['TRUEFORGE_UNAVAILABLE', 'TRUEFORGE_TIMEOUT', 'MODEL_UNAVAILABLE', 'MODEL_AUTH_ERROR'].includes(code) ? 'upstream service/connectivity or credentials'
    : 'business or response contract';
  report.failures.push({ name, status: r?.status, code, requestId: r?.json?.requestId, classification });
}
async function send(message, action) {
  const pending = page.waitForResponse(r => r.url().endsWith('/api/banking-agent') && r.request().method() === 'POST', { timeout: 35000 });
  void pending.catch(() => {});
  if (action) await action(); else { await page.locator('.composer input').fill(message); await page.locator('.composer input').press('Enter'); }
  const response = await pending, json = await response.json(), sent = response.request().postDataJSON();
  report.requests.push({ message, status: response.status(), code: json.code, requestId: json.requestId, netlifyRequestId: response.headers()['x-nf-request-id'],
    sentContinuation: !!sent.continuationToken, resultStatus: json.data?.status, source: json.data?.source, previewOnly: json.data?.previewOnly,
    amountFen: json.data?.preview?.exactEffects?.[0]?.amountFen });
  if (json.data?.source === 'trueforge-mcp' || /^tf[mb]1\./.test(json.data?.continuationToken || '')) report.trueforgeObserved = true;
  await page.waitForFunction(() => !document.querySelector('.composer input')?.disabled);
  return { status: response.status(), json, data: json.data };
}
async function select(r, text) {
  const c = r.data.choices.find(c => c.label.includes(text));
  assert.ok(c, 'Expected server-issued account/payee choice');
  return send('选择' + c.label, () => page.getByRole('button', { name: c.label, exact: true }).click());
}
try {
  const response = await page.goto(base.origin);
  assert.equal(response.status(), 200);
  await page.locator('.composer input').waitFor();
  report.checks.push('preview page loads and hydrates');
  await page.getByLabel('演示访问码', { exact: true }).fill(process.env.SAVEFLOW_ACCESS_CODE || '');
  await page.locator('.consent-control input').check();
  let r = await send('查询2026年8月账单');
  if (r.status === 200 && r.data?.status === 'bill_result' && r.data.data.transactionCount === 12) { await page.locator('.bill-report').waitFor(); report.checks.push('bill query and original bill card'); } else failure('bill query/card', r);
  r = await send('查看日常虚拟卡');
  if (r.status === 200 && r.data?.status === 'card_result') report.checks.push('card query'); else failure('card query', r);
  r = await send('给王先生转500元');
  if (r.status === 200 && r.data?.status === 'needs_clarification') {
    report.checks.push('transfer account clarification');
    r = await select(r, '模拟活期账户');
    if (r.status === 200 && r.data?.status === 'needs_clarification') {
      report.checks.push('account selection across requests');
      r = await select(r, '房东王先生');
      if (r.status === 200 && r.data?.preview?.exactEffects?.[0]?.amountFen === 50000) {
        report.checks.push('payee selection and formal 500-yuan preview');
        const operationId = r.data.operationId;
        r = await send('修改金额为400元', async () => {
          await page.locator('.banking-preview-card').filter({ hasText: operationId }).getByRole('button', { name: '修改金额', exact: true }).click();
          await page.getByLabel('新金额（元）', { exact: true }).fill('400');
          await page.getByRole('button', { name: '生成新预览', exact: true }).click();
        });
        if (r.status === 200 && r.data?.preview?.exactEffects?.[0]?.amountFen === 40000) report.checks.push('amount edit across requests'); else failure('amount edit', r);
        r = await send('确认转账');
        if (r.status === 403 && r.json.code === 'PREVIEW_ONLY') report.checks.push('chat confirmation cannot execute transfer'); else failure('chat confirmation guard', r);
        r = await send('取消');
        if (r.status === 200 && r.data?.status === 'cancelled') report.checks.push('cancel preview'); else failure('cancel preview', r);
      } else failure('transfer formal preview', r);
    } else failure('account selection across requests', r);
  } else failure('transfer account clarification', r);
  if (!report.trueforgeObserved) report.failures.push({ name: 'TrueForge routing', classification: 'No TrueForge source/token observed; successful fallback responses do not establish a TrueForge trial' });
  await page.screenshot({ path: `${dir}/preview-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  report.mobileHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  await page.screenshot({ path: `${dir}/preview-mobile.png`, fullPage: true });
  if (report.browserErrors.length || report.mobileHorizontalOverflow) report.failures.push({ name: 'browser layout/runtime', classification: 'UI' });
} catch {
  report.failures.push({ name: 'verification stopped', classification: 'browser/network/dependency; remaining steps not verified' });
} finally {
  await browser.close();
  report.demoBusinessAcceptancePassed = report.failures.length === 0;
  await writeFile(`${dir}/preview-ui-report.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!report.demoBusinessAcceptancePassed) process.exitCode = 1;
}

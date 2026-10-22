import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd(), true);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = 'http://127.0.0.1:4300';
const dir = '.next/docker-check/ui'; await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 1000 } });
const report = { at: new Date().toISOString(), url: baseURL, actualDockerHttpMcpAndHostTrueforge: true, requests: [], checks: [], browserErrors: [] };
page.on('pageerror', error => report.browserErrors.push(error.message));
const authorize = async () => { await page.getByLabel('演示访问码', { exact: true }).fill(process.env.SAVEFLOW_ACCESS_CODE); await page.locator('.consent-control input').check(); };
async function send(message, action, expectedStatus = 200) {
  const start = Date.now(), pending = page.waitForResponse(r => r.url().endsWith('/api/banking-agent') && r.request().method() === 'POST', { timeout: 30000 }); void pending.catch(() => {});
  if (action) await action(); else { await page.locator('.composer input').fill(message); await page.locator('.composer input').press('Enter'); }
  const response = await pending, json = await response.json(), sent = response.request().postDataJSON();
  report.requests.push({ message, httpStatus: response.status(), code: json.code, elapsedMs: Date.now() - start, sentContinuation: !!sent.continuationToken,
    status: json.data?.status, action: json.data?.action, slot: json.data?.slot, effect: json.data?.preview?.exactEffects?.[0], bill: json.data?.status === 'bill_result' ? json.data.data : undefined,
    recoveryQuestion: json.data?.recovery?.question });
  assert.equal(response.status(), expectedStatus); assert.ok(Date.now() - start < 30000);
  await page.waitForFunction(() => !document.querySelector('.composer input').disabled);
  return json.data;
}
async function select(data, text, status = 200) {
  const c = data.choices.find(c => c.label.includes(text)); assert.ok(c);
  return send(`选择${c.label}`, () => page.getByRole('button', { name: c.label, exact: true }).click(), status);
}
try {
  await page.goto(baseURL); await authorize();
  let r = await send('查询2026年8月账单'); assert.equal(r.data.totalIncomeFen, 1200000); assert.equal(r.data.totalExpenseFen, 846000); assert.equal(r.data.transactionCount, 12);
  await page.locator('.bill-report').waitFor(); report.checks.push('production static UI hydration and real bill statistics');
  r = await send('给王先生转500元'); assert.ok(r.choices.some(c => c.label.includes('5000.00')));
  r = await select(r, '模拟储蓄账户'); r = await select(r, '房东王先生', 400);
  assert.equal(r.error.code, 'INSUFFICIENT_BALANCE'); assert.equal(await page.locator('.banking-preview-card').count(), 0);
  assert.match(r.recovery.question, /¥0\.00.*¥500\.00/); report.checks.push('zero balance rejected without a fake preview, actionable recovery');
  r = await select(r.recovery, '模拟活期账户'); assert.equal(r.preview.exactEffects[0].amountFen, 50000); assert.equal(r.preview.exactEffects[0].payeeId, 'payee_003');
  r = await send('改成400元'); assert.equal(r.preview.exactEffects[0].amountFen, 40000); const preview = r;
  r = await send('查看日常虚拟卡'); assert.equal(r.status, 'card_result'); report.checks.push('account recovery, amount edit and cross-Skill card query');
  const rows = await page.locator('.message-row').count(); await page.reload(); await page.getByText('改成400元', { exact: true }).waitFor();
  assert.equal(await page.locator('.message-row').count(), rows); assert.equal(await page.getByLabel('演示访问码', { exact: true }).inputValue(), ''); await authorize();
  r = await send('刷新后返回转账改300元', async () => {
    await page.locator('.banking-preview-card').filter({ hasText: preview.operationId }).getByRole('button', { name: '修改金额', exact: true }).click();
    await page.getByLabel('新金额（元）', { exact: true }).fill('300'); await page.getByRole('button', { name: '生成新预览', exact: true }).click();
  });
  assert.equal(r.preview.exactEffects[0].amountFen, 30000); assert.equal(r.preview.exactEffects[0].payeeId, 'payee_003'); assert.equal(r.preview.exactEffects[0].fromAccountId, 'ACC-CHECKING');
  const operationId = r.operationId, hash = r.preview.previewHash;
  report.checks.push('refresh restores history and original transfer continuation; new formal 300 yuan preview');
  await send('确认转账', undefined, 403);
  const blocked = await page.request.post('/api/banking', { headers: { 'X-Saveflow-Access': process.env.SAVEFLOW_ACCESS_CODE, 'Idempotency-Key': operationId }, data: { schema_version: '1.1.0', action: 'action.execute', input: { operation_id: operationId, preview_hash: hash } } }); assert.equal(blocked.status(), 403);
  assert.equal((await send('取消')).status, 'cancelled'); report.checks.push('chat confirmation and direct Core execution refused; cancellation without execution');
  await page.locator('.banking-preview-card').last().scrollIntoViewIfNeeded(); await page.screenshot({ path: `${dir}/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: `${dir}/mobile.png`, fullPage: true });
  report.mobileHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.deepEqual(report.browserErrors, []); report.success = true;
} catch (error) { report.success = false; report.error = error.message; process.exitCode = 1; await page.screenshot({ path: `${dir}/failure.png`, fullPage: true }); }
finally { await browser.close(); await writeFile(`${dir}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }

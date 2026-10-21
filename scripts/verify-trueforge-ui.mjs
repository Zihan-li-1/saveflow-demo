// Optional Playwright runner against the actual local UI and actual TrueForge/MCP.
// Install Playwright separately; it is not a production dependency.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.SAVEFLOW_UI_URL || 'http://127.0.0.1:3000';
if (!process.env.SAVEFLOW_ACCESS_CODE) throw new Error('Set the local demo access code');
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const report = { realServices: true, checks: [], requests: [] };
const expectedError = process.env.SAVEFLOW_UI_EXPECTED_ERROR;
async function setup() {
  await page.goto(baseUrl);
  await page.getByLabel('演示访问码', { exact: true }).fill(process.env.SAVEFLOW_ACCESS_CODE);
  await page.locator('.consent-control input').check();
}
async function send(message) {
  const start = Date.now();
  const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/banking-agent') && r.request().method() === 'POST', { timeout: 30000 });
  await page.locator('.composer input').fill(message);
  await page.locator('.composer input').press('Enter');
  const response = await responsePromise, payload = await response.json();
  const elapsedMs = Date.now() - start;
  report.requests.push({ message, elapsedMs, httpStatus: response.status(), code: payload.code,
    requestId: payload.requestId, status: payload.data?.status, bill: payload.data?.data });
  assert.ok(elapsedMs < 30000, 'Must finish within the actual browser timeout');
  return payload;
}
async function card(month, income, expense, count) {
  const element = page.locator('.banking-result-card').last();
  await element.getByText(`${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`, { exact: true }).waitFor();
  const text = await element.innerText();
  const money = value => new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value));
  for (const value of [`¥${money(income)}`, `¥${money(expense)}`, `${count} 笔`, '模拟演示数据']) assert.ok(text.includes(value), value);
  report.checks.push({ month, visibleCard: text });
}
try {
  await setup();
  if (expectedError) {
    const result = await send('查询 2026 年 8 月账单');
    assert.equal(result.code, expectedError); assert.equal(result.data.status, 'error');
    await page.getByText(new RegExp(`${expectedError}：`)).waitFor();
    assert.equal(await page.locator('.banking-result-card').count(), 0);
    report.checks.push({ expectedError, visibleError: 'error displayed without a business card' });
    await page.screenshot({ path: `.next/trueforge-${expectedError}-ui.png`, fullPage: true });
  } else {
  assert.equal((await send('查询 2026 年 8 月账单')).code, 'OK');
  await card('2026-08', '12000.00', '8460.00', 12);
  await page.screenshot({ path: '.next/trueforge-bill-ui.png', fullPage: true });
  await setup();
  const first = await send('查账单'); assert.equal(first.code, 'NEEDS_CLARIFICATION'); assert.deepEqual(first.data.choices, []);
  await page.getByText('想看哪个月的账单？例如 2026 年 8 月。', { exact: true }).first().waitFor();
  const next = await send('2026 年 8 月'); assert.equal(next.code, 'OK');
  await card('2026-08', '12000.00', '8460.00', 12);
  await setup(); assert.equal((await send('查询 2026 年 1 月账单')).code, 'OK');
  await card('2026-01', '0.00', '0.00', 0);
  await page.screenshot({ path: '.next/trueforge-zero-ui.png', fullPage: true });
  await setup(); const invalid = await send('查询 2026 年 13 月账单'); assert.equal(invalid.code, 'INVALID_MONTH');
  await page.getByText(/INVALID_MONTH：/).waitFor(); assert.equal(await page.locator('.banking-result-card').count(), 0);
  report.checks.push({ invalidMonth: 'error displayed without a business card' });
  }
  report.success = true;
} catch (error) {
  report.success = false; report.error = error.message;
  await page.screenshot({ path: '.next/trueforge-ui-failure.png', fullPage: true });
  process.exitCode = 1;
} finally {
  await mkdir('.next', { recursive: true });
  await writeFile(expectedError ? `.next/trueforge-${expectedError}-ui-report.json` : '.next/trueforge-ui-report.json', JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}

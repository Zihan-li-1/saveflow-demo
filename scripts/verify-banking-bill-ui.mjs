// Optional browser QA; Playwright stays outside the application's dependencies.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const before = process.argv.includes('--before');
const directory = 'docs/verification/bill-card';
const report = { realHttpChecks: [], fixtureChecks: [], screenshots: [] };
await mkdir(directory, { recursive: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
async function setup(target = page, access = process.env.SAVEFLOW_ACCESS_CODE) {
  assert.ok(access, 'Local access configuration is required');
  await target.goto(process.env.SAVEFLOW_UI_URL || 'http://127.0.0.1:3000');
  await target.getByLabel('演示访问码', { exact: true }).fill(access);
  await target.locator('.consent-control input').check();
}
async function send(message, target = page) {
  const pending = target.waitForResponse(r => r.url().endsWith('/api/banking-agent') && r.request().method() === 'POST', { timeout: 35000 });
  await target.locator('.composer input').fill(message);
  await target.locator('.composer input').press('Enter');
  const response = await pending;
  const payload = await response.json();
  assert.equal(response.status(), 200, `Unexpected HTTP status (${payload.code})`);
  return payload;
}
async function capture(name, target = page) {
  await target.getByLabel('演示访问码', { exact: true }).fill('');
  const card = target.locator('.banking-result-card').last();
  // Expand the capture height so the chat's scroll container cannot clip the report.
  // Keep the requested device width; restore its viewport after capture.
  const viewport = target.viewportSize();
  const height = await card.evaluate(element => Math.ceil(element.getBoundingClientRect().height));
  await target.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, height + 600) });
  await card.scrollIntoViewIfNeeded();
  await target.screenshot({ path: `${directory}/${name}-page.png`, fullPage: true });
  await card.screenshot({ path: `${directory}/${name}-card.png` });
  report.screenshots.push(`${name}-page.png`, `${name}-card.png`);
  await target.setViewportSize(viewport);
}
async function fits(target) {
  const result = await target.locator('.banking-result-card').last().evaluate(element => {
    const box = element.getBoundingClientRect();
    return { fitsViewport: box.left >= 0 && box.right <= window.innerWidth,
      fitsContent: [element, ...element.querySelectorAll('*')].every(node => node.clientWidth === 0 || node.scrollWidth <= node.clientWidth + 1) };
  });
  assert.deepEqual(result, { fitsViewport: true, fitsContent: true });
}
try {
  await setup();
  const bill = await send('查询 2026 年 8 月账单');
  assert.equal(bill.code, 'OK');
  assert.equal(bill.data.data.totalIncomeFen, 1200000);
  assert.equal(bill.data.data.totalExpenseFen, 846000);
  const card = page.locator('.banking-result-card').last();
  await card.waitFor();
  if (before) {
    await capture('before-desktop');
  } else {
    await card.getByText('¥12,000.00', { exact: true }).waitFor();
    const text = await card.innerText();
    for (const expected of ['月度收支概览', '¥8,460.00', '+¥3,540.00', '不是账户可用余额', '12 笔', '模拟演示数据', '2026年9月1日']) assert.ok(text.includes(expected), expected);
    await fits(page); await capture('after-desktop');
    report.realHttpChecks.push('August bill values, balance, metadata and desktop layout');
    await page.setViewportSize({ width: 390, height: 1000 });
    await fits(page); await capture('after-mobile');
    await page.setViewportSize({ width: 320, height: 1000 });
    await fits(page);
    report.realHttpChecks.push('390px and 320px bill layout');
    await page.setViewportSize({ width: 1440, height: 1100 });
    await setup();
    const clarification = await send('查账单');
    assert.equal(clarification.code, 'NEEDS_CLARIFICATION');
    assert.deepEqual(clarification.data.choices, []);
    const resumed = await send('2026 年 8 月');
    assert.equal(resumed.data.data.transactionCount, 12);
    report.realHttpChecks.push('Missing month and real clarification continuation');
    await setup();
    const zero = await send('查询 2026 年 1 月账单');
    assert.equal(zero.data.data.transactionCount, 0);
    await page.locator('.banking-result-card').getByText('0 笔', { exact: true }).waitFor();
    const zeroText = await page.locator('.banking-result-card').innerText();
    assert.ok(!/NaN|Infinity/.test(zeroText));
    assert.equal(await page.locator('.bill-report-categories').count(), 0);
    await capture('after-zero');
    report.realHttpChecks.push('Real zero-transaction month');
    // Explicit UI fixtures exercise extremes without changing server data or statistics.
    const fixturePage = await browser.newPage({ viewport: { width: 320, height: 1000 } });
    const long = structuredClone(bill);
    long.data.data.totalIncomeFen = Number.MAX_SAFE_INTEGER;
    long.data.data.totalExpenseFen = Number.MAX_SAFE_INTEGER - 100;
    delete long.data.data.categoryTotals;
    await fixturePage.route('**/api/banking-agent', route => route.fulfill({ json: long }));
    await setup(fixturePage, 'ui-fixture-test-access');
    await send('查询 2026 年 8 月账单', fixturePage);
    await fixturePage.locator('.bill-report-hero strong').waitFor();
    await fits(fixturePage); await capture('fixture-long-mobile', fixturePage);
    assert.equal(await fixturePage.locator('.bill-report-categories').count(), 0);
    report.fixtureChecks.push('Safe-integer maximum amounts at 320px; absent categories hidden (mock HTTP only)');
    await fixturePage.close();
  }
  report.success = true;
} catch {
  report.success = false;
  report.error = 'Browser QA failed; inspect local page and configuration. No request credentials recorded.';
  process.exitCode = 1;
} finally {
  await writeFile(`${directory}/${before ? 'before' : 'after'}-report.json`, JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify(report));
}

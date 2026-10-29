// Targeted real-browser check against dev:qwen; no injected understanding.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
try { process.loadEnvFile('.env.local'); } catch { /* Hosts can supply environment directly. */ }
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const directory = 'docs/verification/input-ready';
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const before = process.env.INPUT_READY_EXPECT_BLOCKED === 'true';
const report = { understanding: 'real configured model', browser: 'Chrome', results: [], writes: { decide: 0, execute: 0 }, pageErrors: 0 };
page.on('pageerror', () => report.pageErrors++);
page.on('request', request => {
  if (!request.url().endsWith('/api/banking')) return;
  const action = request.postDataJSON()?.action;
  if (action === 'action.decide') report.writes.decide++;
  if (action === 'action.execute') report.writes.execute++;
});
const composer = page.locator('.composer input');
async function send(text, expectedStatus) {
  const pending = page.waitForResponse(response => response.url().endsWith('/api/banking-agent') && response.request().method() === 'POST', { timeout: 60000 });
  await composer.fill(text); await composer.press('Enter');
  const response = await pending; const result = await response.json();
  assert.equal(response.status(), 200, result.code);
  assert.equal(result.data.status, expectedStatus);
  // Wait for the rendered business card, independently from the loading flag.
  await page.waitForFunction(status => {
    const selector = { awaiting_confirmation: '.banking-preview-card', bill_result: '.bill-report', card_result: '.banking-result-card' }[status];
    return selector && document.querySelector(selector);
  }, expectedStatus);
  const state = { status: result.data.status, typingVisible: await page.locator('.typing').isVisible(), inputEnabled: await composer.isEnabled() };
  if (!before) {
    await page.locator('.typing').waitFor({ state: 'detached', timeout: 5000 });
    await composer.fill('查看娱乐虚拟卡');
    assert.equal(await page.locator('.send').isEnabled(), true);
    state.typingVisible = await page.locator('.typing').isVisible(); state.inputEnabled = await composer.isEnabled(); state.sendEnabled = true;
  }
  report.results.push(state);
  return result;
}
try {
  await page.goto(process.env.INPUT_READY_URL || 'http://127.0.0.1:3105');
  await page.getByLabel('演示访问码', { exact: true }).fill(process.env.SAVEFLOW_ACCESS_CODE);
  await page.locator('.consent-control input').check();
  const transfer = await send('从活期账户给张三转500元', 'awaiting_confirmation');
  if (before) {
    assert.equal(report.results[0].typingVisible, true); assert.equal(report.results[0].inputEnabled, false);
    report.reproduced = true;
  } else {
    await send('查看2026年8月账单', 'bill_result');
    await send('查看娱乐虚拟卡', 'card_result');
    const next = await send('从活期账户给张三转100元', 'awaiting_confirmation');
    assert.notEqual(next.data.operationId, transfer.data.operationId);
    assert.match(next.data.operationId, /^op_/); // Only local simulated Core, never the external execution bridge.
    await page.locator('.banking-preview-card').last().getByRole('button', { name: '确认转账', exact: true }).click();
    await page.getByText('转账已完成，凭证可在账户概览中查看。', { exact: true }).waitFor({ timeout: 15000 });
    await send('查看娱乐虚拟卡', 'card_result');
    await send('查看2026年8月账单', 'bill_result');
    assert.deepEqual(report.writes, { decide: 1, execute: 1 });
    assert.equal(report.pageErrors, 0); report.passed = true;
  }
  await page.screenshot({ path: `${directory}/${before ? 'before' : 'after'}.png`, fullPage: true,
    mask: [page.getByLabel('演示访问码', { exact: true })] });
} catch (error) {
  report.failed = true; report.reason = error.code || error.name; process.exitCode = 1;
} finally {
  await writeFile(`${directory}/${before ? 'before' : 'after'}.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report)); await browser.close();
}

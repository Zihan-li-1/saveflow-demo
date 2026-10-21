import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd(), true);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir = '.next/balance-recovery'; await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ baseURL: 'http://127.0.0.1:3000', viewport: { width: 1440, height: 1000 } });
const report = { at: new Date().toISOString(), realTrueforgeMcpHttpUi: true, checks: [], requests: [], browserErrors: [] };
page.on('pageerror', error => report.browserErrors.push(error.message));
async function send(message, action, status = 200) {
  const start = Date.now(); const pending = page.waitForResponse(r => r.url().endsWith('/api/banking-agent'), { timeout: 30000 }); void pending.catch(() => {});
  if (action) await action(); else { await page.locator('.composer input').fill(message); await page.locator('.composer input').press('Enter'); }
  const response = await pending, json = await response.json();
  report.requests.push({ message, elapsedMs: Date.now() - start, httpStatus: response.status(), code: json.code, status: json.data?.status, slot: json.data?.slot,
    recovery: json.data?.recovery ? { question: json.data.recovery.question, choices: json.data.recovery.choices } : undefined, effect: json.data?.preview?.exactEffects?.[0] });
  assert.equal(response.status(), status); assert.ok(Date.now() - start < 30000);
  await page.waitForFunction(() => !document.querySelector('.composer input').disabled);
  return json.data;
}
const choice = (data, text) => { const c = data.choices.find(c => c.label.includes(text)); assert.ok(c); return send(`选择${c.label}`, () => page.getByRole('button', { name: c.label, exact: true }).click()); };
try {
  await page.goto('http://127.0.0.1:3000');
  await page.getByLabel('演示访问码', { exact: true }).fill(process.env.SAVEFLOW_ACCESS_CODE);
  await page.locator('.consent-control input').check();
  let r = await send('给王先生转500元');
  assert.ok(r.choices.some(c => c.label.includes('5000.00'))); assert.ok(r.choices.some(c => c.label.includes('0.00')));
  r = await choice(r, '模拟储蓄账户');
  const payee = r.choices.find(c => c.label.includes('房东王先生')); assert.ok(payee);
  r = await send('选择房东王先生', () => page.getByRole('button', { name: payee.label, exact: true }).click(), 400);
  assert.equal(r.error.code, 'INSUFFICIENT_BALANCE'); assert.equal(await page.locator('.banking-preview-card').count(), 0);
  assert.match(r.recovery.question, /模拟储蓄账户.*¥0\.00.*¥500\.00/);
  await page.locator('.banking-choice-card').last().scrollIntoViewIfNeeded(); await page.screenshot({ path: `${dir}/insufficient-recovery.png`, fullPage: true });
  report.checks.push('真实选择零余额储蓄账户 → Core拒绝500元，没有伪造预览；页面输入和新账户选项可用');
  r = await choice(r.recovery, '模拟活期账户');
  assert.equal(r.preview.exactEffects[0].amountFen, 50000); assert.equal(r.preview.exactEffects[0].fromAccountId, 'ACC-CHECKING'); assert.equal(r.preview.exactEffects[0].payeeId, 'payee_003');
  report.checks.push('仅重新选择活期账户即可生成500元正式预览，房东选择保留，不再消歧');
  r = await send('改成6000元', undefined, 400); assert.equal(r.error.code, 'INSUFFICIENT_BALANCE');
  assert.match(r.recovery.question, /¥5000\.00.*¥6000\.00/);
  r = await send('改成400元'); assert.equal(r.preview.exactEffects[0].amountFen, 40000); assert.equal(r.preview.exactEffects[0].payeeId, 'payee_003');
  report.checks.push('超余额金额仍拒绝；改成400元使用签名续接保留原账户和房东');
  const previewId = r.operationId;
  r = await send('查看日常虚拟卡'); assert.equal(r.status, 'card_result');
  r = await send('返回转账修改300元', async () => {
    await page.locator('.banking-preview-card').filter({ hasText: previewId }).getByRole('button', { name: '修改金额', exact: true }).click();
    await page.getByLabel('新金额（元）', { exact: true }).fill('300'); await page.getByRole('button', { name: '生成新预览', exact: true }).click();
  });
  assert.equal(r.preview.exactEffects[0].amountFen, 30000); assert.equal(r.preview.exactEffects[0].payeeId, 'payee_003');
  report.checks.push('余额恢复后仍能跨Skill查询卡片并返回修改，历史卡片完整');
  const id = r.operationId, hash = r.preview.previewHash;
  await send('确认转账', undefined, 403);
  const blocked = await page.request.post('/api/banking', { headers: { 'X-Saveflow-Access': process.env.SAVEFLOW_ACCESS_CODE, 'Idempotency-Key': id }, data: { schema_version: '1.1.0', action: 'action.execute', input: { operation_id: id, preview_hash: hash } } }); assert.equal(blocked.status(), 403);
  r = await send('取消'); assert.equal(r.status, 'cancelled');
  assert.equal(await page.locator('.banking-preview-card').count(), 3); assert.deepEqual(report.browserErrors, []);
  report.checks.push('三张真实历史预览保留；聊天确认和受控端点均不允许执行，取消不转账');
  report.success = true; await page.locator('.banking-preview-card').last().scrollIntoViewIfNeeded(); await page.screenshot({ path: `${dir}/recovered-preview.png`, fullPage: true });
} catch (error) { report.success = false; report.error = error.message; process.exitCode = 1; await page.screenshot({ path: `${dir}/failure.png`, fullPage: true }); }
finally { await browser.close(); await writeFile(`${dir}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }

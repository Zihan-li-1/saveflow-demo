import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd(), true);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir = '.next/transfer-debug-after';
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ baseURL: 'http://127.0.0.1:3000', viewport: { width: 1440, height: 1000 } });
const report = { at: new Date().toISOString(), realTrueforgeAndDeepseekAndMcp: true, checks: [], requests: [], browserErrors: [] };
page.on('pageerror', error => report.browserErrors.push(error.message));
let bankingRequests = 0;
page.on('request', r => { if (r.url().endsWith('/api/banking-agent')) bankingRequests++; });
async function authorize() {
  await page.getByLabel('演示访问码', { exact: true }).fill(process.env.SAVEFLOW_ACCESS_CODE);
  await page.locator('.consent-control input').check();
}
async function request(message, action) {
  const start = Date.now();
  const pending = page.waitForResponse(r => r.url().endsWith('/api/banking-agent') && r.request().method() === 'POST', { timeout: 30000 });
  void pending.catch(() => {});
  if (action) await action();
  else { await page.locator('.composer input').fill(message); await page.locator('.composer input').press('Enter'); }
  const response = await pending, json = await response.json();
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 30000);
  await page.waitForFunction(() => !document.querySelector('.composer input').disabled);
  report.requests.push({ message, elapsedMs, status: response.status(), code: json.code, source: json.data?.source, slot: json.data?.slot,
    operationId: json.data?.operationId, previewHash: json.data?.preview?.previewHash, effect: json.data?.preview?.exactEffects?.[0] });
  return json;
}
try {
  await page.goto('http://127.0.0.1:3000'); await authorize();
  const first = await request('从模拟活期账户转账500元给房东王先生');
  assert.equal(first.data.source, 'trueforge-mcp'); assert.equal(first.data.preview.exactEffects[0].amountFen, 50000);
  const original = first.data.preview.exactEffects[0];
  assert.equal(original.fromAccountId, 'ACC-CHECKING'); assert.equal(original.payeeId, 'payee_003');
  const second = await request('改成转账400元');
  assert.equal(second.data.preview.exactEffects[0].amountFen, 40000);
  assert.equal(second.data.preview.exactEffects[0].fromAccountId, original.fromAccountId);
  assert.equal(second.data.preview.exactEffects[0].payeeId, original.payeeId);
  assert.notEqual(second.data.preview.previewHash, first.data.preview.previewHash);
  assert.equal(await page.locator('.message-row').count(), 5); assert.equal(await page.locator('.banking-preview-card').count(), 2);
  assert.equal(await page.locator('.banking-preview-card').first().getByRole('button', { name: '修改金额', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('.banking-preview-card').last().getByRole('button', { name: '确认转账（未开放）', exact: true }).isDisabled(), true);
  report.checks.push('exact two-message reproduction: 500→400, same resolved payer/payee, new formal preview, full five-message history');
  const beforeReload = bankingRequests;
  await page.reload(); await page.getByText('改成转账400元', { exact: true }).waitFor();
  assert.equal(await page.locator('.message-row').count(), 5); assert.equal(bankingRequests, beforeReload);
  assert.equal(await page.getByLabel('演示访问码', { exact: true }).inputValue(), '');
  assert.equal(await page.locator('.consent-control input').isChecked(), false);
  await authorize();
  report.checks.push('refresh restores messages/opaque continuation, requires access code and consent again, sends no automatic request');
  const third = await request('card: 修改金额350', async () => {
    await page.locator('.banking-preview-card').last().getByRole('button', { name: '修改金额', exact: true }).click();
    await page.getByLabel('新金额（元）', { exact: true }).fill('350');
    await page.getByRole('button', { name: '生成新预览', exact: true }).click();
  });
  assert.equal(third.data.preview.exactEffects[0].amountFen, 35000); assert.equal(third.data.preview.exactEffects[0].payeeId, original.payeeId);
  const replay = await page.request.post('/api/banking-agent', { headers: { 'X-Saveflow-Access': process.env.SAVEFLOW_ACCESS_CODE }, data: { message: '改成转账350元', continuationToken: second.data.continuationToken, consent: true, history: [] } });
  assert.equal((await replay.json()).data.operationId, third.data.operationId);
  report.checks.push('amount form prevents reload and resumes restored Session; identical replay returns same operation without new preview');
  const clarification = await request('card: 修改收款人为王先生', async () => {
    await page.locator('.banking-preview-card').last().getByRole('button', { name: '修改收款人', exact: true }).click();
    await page.getByLabel('新收款人', { exact: true }).fill('王先生');
    await page.getByRole('button', { name: '生成新预览', exact: true }).click();
  });
  assert.equal(clarification.data.slot, 'payee_ref');
  const choice = clarification.data.choices.find(c => c.label.includes('王强')); assert.ok(choice);
  const changed = await request('candidate: 王强', () => page.getByRole('button', { name: choice.label, exact: true }).click());
  assert.equal(changed.data.preview.exactEffects[0].payeeId, 'payee_004');
  assert.equal(changed.data.preview.exactEffects[0].fromAccountId, original.fromAccountId); assert.equal(changed.data.preview.exactEffects[0].amountFen, 35000);
  report.checks.push('payee form uses real disambiguation choices and preserves payer/amount; no guessed IDs');
  assert.equal((await request('确认转账')).code, 'PREVIEW_ONLY');
  const cancelled = await request('card: 取消', () => page.locator('.banking-preview-card').last().getByRole('button', { name: '取消', exact: true }).click());
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal(await page.locator('.message-row').count(), 15); assert.equal(await page.locator('.banking-preview-card').count(), 4);
  const blocked = await page.request.post('/api/banking', { headers: { 'X-Saveflow-Access': process.env.SAVEFLOW_ACCESS_CODE, 'Idempotency-Key': changed.data.operationId }, data: { schema_version: '1.1.0', action: 'action.execute', input: { operation_id: changed.data.operationId, preview_hash: changed.data.preview.previewHash } } });
  assert.equal(blocked.status(), 403);
  const stale = await page.request.post('/api/banking-agent', { headers: { 'X-Saveflow-Access': process.env.SAVEFLOW_ACCESS_CODE }, data: { message: '改成转账300元', continuationToken: changed.data.continuationToken, consent: true, history: [] } });
  assert.equal((await stale.json()).code, 'CONTINUATION_STALE');
  report.checks.push('chat confirmation blocked, cancel button ends session, direct Core execution forbidden, cancelled credentials stale, all fifteen messages retained');
  assert.deepEqual(report.browserErrors, []);
  await page.locator('.banking-preview-card').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${dir}/transfer-history.png`, fullPage: true });
  report.success = true;
} catch (error) { report.success = false; report.error = error.message; await page.screenshot({ path: `${dir}/failure.png`, fullPage: true }); process.exitCode = 1; }
finally { await browser.close(); await writeFile(`${dir}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd(), true);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir = '.next/skill-switch-after'; await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ baseURL: 'http://127.0.0.1:3000', viewport: { width: 1440, height: 1000 } });
const report = { at: new Date().toISOString(), realTrueforgeMcpHttpUi: true, checks: [], requests: [], errors: [] };
const starts = [];
let browserHttpRequests = 0;
page.on('request', r => { if (r.url().endsWith('/api/banking-agent')) browserHttpRequests++; });
page.on('pageerror', error => report.errors.push(error.message));
const card = id => page.locator('.banking-preview-card').filter({ hasText: id });
const authorize = async () => { await page.getByLabel('演示访问码', { exact: true }).fill(process.env.SAVEFLOW_ACCESS_CODE); await page.locator('.consent-control input').check(); };
async function send(message, action) {
  starts.push(Date.now()); const start = Date.now();
  const pending = page.waitForResponse(r => r.url().endsWith('/api/banking-agent') && r.request().method() === 'POST', { timeout: 30000 }); void pending.catch(() => {});
  if (action) await action(); else { await page.locator('.composer input').fill(message); await page.locator('.composer input').press('Enter'); }
  const r = await pending, json = await r.json(), sent = r.request().postDataJSON();
  report.requests.push({ message, elapsedMs: Date.now() - start, status: r.status(), code: json.code, sentToken: !!sent.continuationToken,
    action: json.data?.action, resultStatus: json.data?.status, slot: json.data?.slot, operationId: json.data?.operationId, effect: json.data?.preview?.exactEffects?.[0], bill: json.data?.status === 'bill_result' ? json.data.data : undefined });
  assert.ok(Date.now() - start < 30000); assert.equal(r.status(), 200);
  await page.waitForFunction(() => !document.querySelector('.composer input').disabled);
  return { data: json.data, sent };
}
async function choose(result) {
  const choice = result.data.choices[0]; assert.ok(choice);
  return await send('选择真实卡片候选', () => page.getByRole('button', { name: choice.label, exact: true }).click());
}
async function edit(preview, amount) {
  return await send(`原预览修改为${amount}元`, async () => {
    await card(preview.data.operationId).getByRole('button', { name: '修改金额', exact: true }).click();
    await page.getByLabel('新金额（元）', { exact: true }).fill(String(amount));
    await page.getByRole('button', { name: '生成新预览', exact: true }).click();
  });
}
try {
  await page.goto('http://127.0.0.1:3000'); await authorize();
  const first = await send('从模拟活期账户转账500元给房东王先生');
  const revised = await send('改成300元'); assert.equal(revised.sent.continuationToken, first.data.continuationToken);
  assert.equal(revised.data.preview.exactEffects[0].amountFen, 30000); report.checks.push('转账预览 → 改成300元');
  const cards = await send('查看我的卡'); assert.equal(cards.sent.continuationToken, undefined); assert.equal(cards.data.action, 'card.get');
  const selected = await choose(cards); assert.equal(selected.data.status, 'card_result');
  assert.equal(await page.locator('.banking-preview-card').count(), 2); report.checks.push('转账预览 → 查看我的卡，单独凭据/真实候选，历史保留');
  const resumed = await edit(revised, 250); assert.equal(resumed.sent.continuationToken, revised.data.continuationToken);
  assert.equal(resumed.data.preview.exactEffects[0].amountFen, 25000); assert.equal(resumed.data.preview.exactEffects[0].payeeId, 'payee_003');
  assert.equal(resumed.data.preview.exactEffects[0].fromAccountId, 'ACC-CHECKING');
  assert.equal(await card(first.data.operationId).getByRole('button', { name: '修改金额', exact: true }).isDisabled(), true);
  report.checks.push('转账预览 → 卡片查询 → 返回修改原转账，账户/收款人不变，旧版本仍禁用');
  const partial = await send('查询8月账单'); assert.equal(partial.sent.continuationToken, undefined); assert.equal(partial.data.action, 'bill.summary');
  assert.equal(partial.data.status, 'needs_clarification'); assert.ok(partial.data.continuationToken.startsWith('tfb1.'));
  const bill = await send('2026年8月'); assert.equal(bill.sent.continuationToken, partial.data.continuationToken);
  assert.equal(bill.data.status, 'bill_result'); assert.equal(bill.data.data.totalExpenseFen, 846000);
  assert.equal(await page.locator('.banking-preview-card').count(), 3); report.checks.push('转账预览 → 查询8月账单：真实账单 Skill 澄清年份 → 2026年8月真实统计');
  starts.push(Date.now());
  const forged = await page.request.post('/api/banking-agent', { headers: { 'X-Saveflow-Access': process.env.SAVEFLOW_ACCESS_CODE }, data: { message: '查看我的卡', continuationToken: resumed.data.continuationToken, history: [], consent: true } });
  const rejection = await forged.json(); assert.equal(rejection.code, 'CONTINUATION_ACTION_MISMATCH'); assert.equal(forged.status(), 400);
  report.requests.push({ message: '卡片查询中强行携带转账token', status: forged.status(), code: rejection.code });
  report.checks.push('伪造跨动作携带转账凭据被服务端拒绝');
  const cancelled = await send('取消原转账', () => card(resumed.data.operationId).getByRole('button', { name: '取消', exact: true }).click());
  assert.equal(cancelled.sent.continuationToken, resumed.data.continuationToken); assert.equal(cancelled.data.status, 'cancelled');
  const fresh = await send('从模拟活期账户转账200元给房东王先生'); assert.equal(fresh.sent.continuationToken, undefined);
  assert.equal(fresh.data.preview.exactEffects[0].amountFen, 20000); report.checks.push('转账预览 → 取消 → 新转账使用新操作会话');
  // Preserve the existing 10/minute limit; wait for its actual window, never relax it.
  const waitMs = Math.max(0, starts[0] + 61000 - Date.now());
  console.log(JSON.stringify({ event: 'waiting_for_existing_rate_window', waitMs }));
  await new Promise(resolve => setTimeout(resolve, waitMs));
  const rows = await page.locator('.message-row').count();
  await page.reload(); await page.getByText('从模拟活期账户转账200元给房东王先生', { exact: true }).waitFor(); await authorize();
  assert.equal(await page.locator('.message-row').count(), rows);
  const afterRefresh = await send('查看我的卡'); assert.equal(afterRefresh.sent.continuationToken, undefined);
  assert.equal((await choose(afterRefresh)).data.status, 'card_result');
  const afterResume = await edit(fresh, 150); assert.equal(afterResume.sent.continuationToken, fresh.data.continuationToken);
  assert.equal(afterResume.data.preview.exactEffects[0].amountFen, 15000); report.checks.push('刷新后跨 Skill 查询，并返回修改刷新前的独立转账');
  const requestsBefore = browserHttpRequests;
  await page.locator('.composer input').fill('看看我的卡和账单'); await page.locator('.composer input').press('Enter');
  await page.getByText(/请明确要查询卡片/).waitFor(); assert.equal(browserHttpRequests, requestsBefore);
  report.checks.push('含糊/混合请求只澄清，不套用转账凭据');
  assert.equal(await card(afterResume.data.operationId).getByRole('button', { name: '确认转账（未开放）', exact: true }).isDisabled(), true);
  const blocked = await page.request.post('/api/banking', { headers: { 'X-Saveflow-Access': process.env.SAVEFLOW_ACCESS_CODE, 'Idempotency-Key': afterResume.data.operationId }, data: { schema_version: '1.1.0', action: 'action.execute', input: { operation_id: afterResume.data.operationId, preview_hash: afterResume.data.preview.previewHash } } });
  assert.equal(blocked.status(), 403); report.checks.push('确认仍禁用，直接 Core 执行仍403');
  assert.deepEqual(report.errors, []); report.success = true;
  await card(afterResume.data.operationId).scrollIntoViewIfNeeded(); await page.screenshot({ path: `${dir}/switch-history.png`, fullPage: true });
} catch (error) { report.success = false; report.error = error.message; process.exitCode = 1; await page.screenshot({ path: `${dir}/failure.png`, fullPage: true }); }
finally { await browser.close(); await writeFile(`${dir}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }

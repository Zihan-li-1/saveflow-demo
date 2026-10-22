import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd(), true);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const phase = process.argv[2] || 'A';
const dir = `.next/trueforge-multi-${phase}`;
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ baseURL: process.env.SAVEFLOW_UI_URL || 'http://127.0.0.1:3000', viewport: { width: 1440, height: 1000 } });
const report = { phase, realTrueforgeAndMcpAndUi: true, checks: [], requests: [] };
async function setup() {
  await page.goto(process.env.SAVEFLOW_UI_URL || 'http://127.0.0.1:3000');
  // Each scenario starts a new conversation explicitly. Reload now restores history.
  await page.getByTitle('重新开始演示', { exact: true }).click();
  await page.getByLabel('演示访问码', { exact: true }).fill(process.env.SAVEFLOW_ACCESS_CODE);
  await page.locator('.consent-control input').check();
}
async function send(message, chooseLabel) {
  const at = Date.now(); const response = page.waitForResponse(r => r.url().endsWith('/api/banking-agent') && r.request().method() === 'POST', { timeout: 30000 });
  void response.catch(() => {}); // Avoid an orphan rejection if a UI action itself fails.
  if (chooseLabel) await page.getByRole('button', { name: chooseLabel, exact: true }).click();
  else { await page.locator('.composer input').fill(message); await page.locator('.composer input').press('Enter'); }
  const r = await response, json = await r.json(); const elapsedMs = Date.now() - at; assert.ok(elapsedMs < 30000);
  report.requests.push({ message: message ?? 'candidate choice', elapsedMs, httpStatus: r.status(), code: json.code, status: json.data?.status, action: json.data?.action, source: json.data?.source });
  return json;
}
try {
  if (phase.startsWith('A')) {
    await setup(); const card = await send('查看娱乐虚拟卡'); assert.equal(card.data.data.card.id, 'CARD-ENT'); assert.equal(card.data.source, 'trueforge-mcp'); await page.getByText('娱乐虚拟卡', { exact: true }).last().waitFor(); report.checks.push('card query');
    await setup(); const first = await send('查看我的卡'); assert.equal(first.code, 'NEEDS_CLARIFICATION'); const c = first.data.choices.find(c => c.label.includes('娱乐虚拟卡')); assert.ok(c);
    const selected = await send(undefined, c.label); assert.equal(selected.data.data.card.id, 'CARD-ENT'); report.checks.push('ambiguous card choice in same session');
    await setup(); const unknown = await send('查看不存在卡'); assert.equal(unknown.code, 'NEEDS_CLARIFICATION'); assert.equal(unknown.data.data, undefined); report.checks.push('unknown card does not invent a result');
    await setup(); const s = await send('查询订阅'); assert.equal(s.data.data.subscriptions.length, 2); await page.getByRole('heading', { name: '模拟视频会员', exact: true }).waitFor(); await page.screenshot({ path: `${dir}/subscriptions.png`, fullPage: true }); report.checks.push('subscriptions from actual Mock');
    await setup(); const p = await send('查询理财产品'); assert.equal(p.data.data.products.length, 3); await page.getByRole('heading', { name: '模拟灵活现金 A', exact: true }).waitFor(); await page.screenshot({ path: `${dir}/products.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: `${dir}/products-mobile.png`, fullPage: true });
    const overflow = await page.locator('.financial-read-card').evaluate(el => el.scrollWidth > el.clientWidth + 1); assert.equal(overflow, false); report.checks.push('products and narrow card layout');
    await page.setViewportSize({ width: 1440, height: 1000 }); await setup(); const b = await send('查询2026年8月账单'); assert.equal(b.data.data.totalIncomeFen, 1200000); assert.equal(b.data.data.totalExpenseFen, 846000); assert.equal(b.data.data.transactionCount, 12); report.checks.push('bill regression');
  } else if (phase === 'B') {
    await setup(); let r = await send('给王先生转500元'); assert.equal(r.data.slot, 'source_account_ref');
    r = await send(undefined, r.data.choices[0].label); assert.equal(r.data.slot, 'payee_ref');
    r = await send(undefined, r.data.choices[1].label); assert.equal(r.data.status, 'awaiting_confirmation');
    assert.equal(r.data.preview.exactEffects[0].amountFen, 50000); assert.equal(r.data.preview.exactEffects[0].payeeName, '王强');
    assert.ok(r.data.operationId.startsWith('tfpreview:')); assert.equal(r.data.previewOnly, true);
    await page.getByText('仅供预览 · 尚未执行', { exact: true }).waitFor();
    const firstHash = r.data.preview.previewHash; const oldToken = r.data.continuationToken;
    r = await send('改成600元'); assert.equal(r.data.preview.exactEffects[0].amountFen, 60000); assert.notEqual(r.data.preview.previewHash, firstHash);
    const id = r.data.operationId;
    await page.locator('.banking-preview-card').last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${dir}/transfer.png`, fullPage: true }); report.checks.push('missing account, ambiguous payee, same session, real preview and changed amount');
    r = await send('确认'); assert.equal(r.code, 'PREVIEW_ONLY'); report.checks.push('chat confirmation rejected');
    r = await send('取消'); assert.equal(r.data.status, 'cancelled'); report.checks.push('local cancellation without execution');
    const blocked = await page.request.post('/api/banking', { headers: { 'X-Saveflow-Access': process.env.SAVEFLOW_ACCESS_CODE, 'Idempotency-Key': id }, data: { schema_version: '1.1.0', action: 'action.execute', input: { operation_id: id, preview_hash: firstHash } } }); assert.equal(blocked.status(), 403);
    report.checks.push('direct backend execution rejected');
    const stale = await page.request.post('/api/banking-agent', { headers: { 'X-Saveflow-Access': process.env.SAVEFLOW_ACCESS_CODE }, data: { history: [], consent: true, continuationToken: oldToken, message: '改成700元' } }); assert.equal((await stale.json()).code, 'CONTINUATION_STALE');
    await setup(); r = await send('从活期账户给张三转6000元'); assert.equal(r.code, 'INSUFFICIENT_BALANCE'); assert.equal(await page.locator('.banking-preview-card').count(), 0); report.checks.push('Core insufficient balance without a success card');
  } else if (phase === 'C') {
    await setup(); let r = await send('设置娱乐虚拟卡预算1000元'); assert.equal(r.data.preview.exactEffects[0].after.monthlyBudgetFen, 100000);
    const firstHash = r.data.preview.previewHash;
    r = await send('改成2000元'); assert.equal(r.data.preview.exactEffects[0].after.monthlyBudgetFen, 200000); assert.notEqual(r.data.preview.previewHash, firstHash);
    r = await send('换成日常虚拟卡'); assert.equal(r.data.preview.exactEffects[0].cardId, 'CARD-MAIN');
    assert.equal(await page.locator('.card-action-preview button').count(), 0);
    await page.locator('.card-action-preview').last().scrollIntoViewIfNeeded(); await page.screenshot({ path: `${dir}/budget-edit.png`, fullPage: true });
    report.checks.push('budget edit/card switch/new hash; original preview marked replaced; no execution buttons');
    r = await send('取消'); assert.equal(r.data.status, 'cancelled');
    await setup(); r = await send('设置娱乐虚拟卡预算0元'); assert.equal(r.data.preview.exactEffects[0].after.monthlyBudgetFen, 0);
    await setup(); r = await send('设置娱乐虚拟卡预算100000元'); assert.equal(r.data.preview.exactEffects[0].after.monthlyBudgetFen, 10000000);
    report.verifiedBudgetsFen = [100000, 200000, 0, 10000000];
    await setup(); r = await send('冻结娱乐虚拟卡'); assert.equal(r.data.preview.exactEffects[0].before.status, 'active'); assert.equal(r.data.preview.exactEffects[0].after.status, 'frozen');
    assert.equal(await page.locator('.card-action-preview button').count(), 0); await page.locator('.card-action-preview').last().scrollIntoViewIfNeeded(); await page.screenshot({ path: `${dir}/freeze.png`, fullPage: true });
    await setup(); r = await send('解冻娱乐虚拟卡'); assert.equal(r.code, 'INVALID_STATE'); assert.equal(await page.locator('.card-action-preview').count(), 0);
    report.checks.push('freeze preview does not freeze card; unfreezing active card rejected');
  } else if (phase === 'C-frozen') {
    report.fixture = 'ISOLATED frozen-card seed in memory; original seed file unchanged';
    await setup(); let r = await send('解冻我的卡'); assert.equal(r.code, 'NEEDS_CLARIFICATION'); const choice = r.data.choices.find(c => c.label.includes('娱乐虚拟卡'));
    r = await send(undefined, choice.label); assert.equal(r.data.preview.exactEffects[0].before.status, 'frozen'); assert.equal(r.data.preview.exactEffects[0].after.status, 'active');
    assert.equal(await page.locator('.card-action-preview button').count(), 0); await page.locator('.card-action-preview').last().scrollIntoViewIfNeeded(); await page.screenshot({ path: `${dir}/unfreeze.png`, fullPage: true });
    report.checks.push('missing-card clarification and actual unfreeze preview from isolated frozen fixture');
    await setup(); r = await send('冻结娱乐虚拟卡'); assert.equal(r.code, 'INVALID_STATE');
    await setup(); r = await send('查看娱乐虚拟卡'); assert.equal(r.data.data.card.status, 'frozen'); assert.equal(r.data.data.card.monthlyBudgetFen, 80000); assert.equal(r.data.data.card.version, 0);
    report.checks.push('already-frozen error; unfreeze preview leaves card frozen with original budget/version');
  } else if (phase === 'F-unavailable') {
    await setup(); const r = await send('查看娱乐虚拟卡'); assert.equal(r.code, 'TRUEFORGE_UNAVAILABLE');
    await page.getByText(/TRUEFORGE_UNAVAILABLE：/).waitFor();
    assert.equal(await page.locator('.banking-result-card').count(), 0); assert.equal(await page.locator('.card-action-preview').count(), 0);
    report.checks.push('real TrueForge outage produces error and no success card');
  } else throw new Error('Stage not implemented');
  report.success = true;
} catch (error) { report.success = false; report.error = error.message; await page.screenshot({ path: `${dir}/failure.png`, fullPage: true }); process.exitCode = 1; }
finally { await writeFile(`${dir}/report.json`, JSON.stringify(report, null, 2)); await browser.close(); console.log(JSON.stringify(report, null, 2)); }

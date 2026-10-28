// Real browser + running dev:qwen host + configured understanding service.
// Uses only synthetic demo data; never confirms or executes a transfer.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
try { process.loadEnvFile('.env.local'); } catch { /* Environment may be provided by the host. */ }
const directory = 'docs/verification/conversation-live-ui';
const report = { testDate: '2026-10-26', understanding: 'real configured model; no injected output',
  core: 'in-memory simulated Banking Core', browser: 'Chrome headless', cases: [], passed: 0, failed: 0, skipped: 0, pageErrors: 0 };
await mkdir(directory, { recursive: true });
if (!process.env.TRUEFORGE_BASE_URL || !process.env.TRUEFORGE_MODEL || !process.env.SAVEFLOW_ACCESS_CODE) {
  report.skipped = 1;
  report.cases.push({ name: 'live browser acceptance', skipped: true, reason: 'MODEL_OR_ACCESS_NOT_CONFIGURED' });
} else {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const url = process.env.CONVERSATION_UI_URL || 'http://127.0.0.1:3105';
  await context.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on('pageerror', () => report.pageErrors++);
  let writes = 0;
  page.on('request', request => {
    if (request.url().endsWith('/api/banking') && ['action.decide', 'action.execute'].includes(request.postDataJSON()?.action)) writes++;
  });
  const remember = name => { report.cases.push({ name, passed: true }); report.passed++; };
  const ready = async () => {
    await page.locator('.typing').waitFor({ state: 'detached', timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('.composer input')?.disabled);
  };
  const authorize = async () => {
    await page.getByLabel('演示访问码', { exact: true }).fill(process.env.SAVEFLOW_ACCESS_CODE);
    await page.locator('.consent-control input').check();
  };
  const request = async action => {
    const waiting = page.waitForResponse(response => response.url().endsWith('/api/banking-agent') && response.request().method() === 'POST', { timeout: 60000 });
    await action(); const response = await waiting; const result = await response.json();
    report.lastResponse = { code: result.code, status: result.data?.status, action: result.data?.action };
    assert.equal(response.status(), 200, result.code); await ready(); return result;
  };
  const send = text => request(async () => { await page.locator('.composer input').fill(text); await page.locator('.composer input').press('Enter'); });
  const panel = () => page.getByRole('region', { name: '会话与待继续业务' });
  try {
    await page.goto(url); await authorize();
    const first = await send('给张三转500元');
    assert.equal(first.data.status, 'needs_clarification');
    const originalTask = first.data.conversation.currentTask.taskId;
    const preview = await request(() => page.locator('.banking-choice-card').last().getByRole('button').filter({ hasText: '活期' }).click());
    assert.equal(preview.data.preview.exactEffects[0].amountFen, 50000);
    assert.equal(preview.data.conversation.currentTask.taskId, originalTask);
    remember('transfer Skill: missing account → signed option → formal preview');
    const bill = await send('查看2026年8月账单');
    assert.equal(bill.data.status, 'bill_result');
    const card = await send('查看娱乐虚拟卡');
    assert.equal(card.data.status, 'card_result');
    assert.equal(card.data.conversation.token, first.data.conversation.token);
    assert.equal(new Set([originalTask, bill.data.conversation.currentTask.taskId, card.data.conversation.currentTask.taskId]).size, 3);
    remember('one live session: transfer → bill → card; separate tasks, shared session');
    const resumed = await send('继续刚才的转账');
    assert.equal(resumed.data.conversation.currentTask.taskId, originalTask);
    assert.notEqual(resumed.data.operationId, preview.data.operationId);
    await page.locator('.banking-preview-card').last().getByRole('button', { name: '修改金额', exact: true }).click();
    await page.getByLabel('新金额（元）', { exact: true }).fill('600');
    const edited = await request(() => page.getByRole('button', { name: '生成新预览', exact: true }).click());
    assert.equal(edited.data.conversation.currentTask.taskId, originalTask);
    assert.equal(edited.data.preview.exactEffects[0].amountFen, 60000);
    assert.notEqual(edited.data.operationId, resumed.data.operationId);
    remember('explicit transfer resume → amount edit → distinct preview on the original task');
    await page.reload(); await ready();
    assert.equal(await page.getByLabel('演示访问码', { exact: true }).inputValue(), '');
    assert.equal(await page.locator('.consent-control input').isChecked(), false);
    await authorize();
    const synced = await request(() => panel().getByRole('button', { name: '核验并恢复会话', exact: true }).click());
    assert.equal(synced.data.status, 'conversation_state');
    assert.equal(synced.data.conversation.token, first.data.conversation.token);
    assert.equal(await page.locator('.banking-preview-card').last().getByRole('button', { name: '确认转账', exact: true }).isDisabled(), true);
    const restored = await request(() => panel().getByRole('button', { name: '继续转账', exact: true }).click());
    assert.equal(restored.data.conversation.currentTask.taskId, originalTask);
    assert.equal(restored.data.preview.exactEffects[0].amountFen, 60000);
    assert.notEqual(restored.data.operationId, edited.data.operationId);
    remember('browser reload on the same server process → reauthorize → sync → explicit resume');
    assert.equal(writes, 0); assert.equal(report.pageErrors, 0);
    remember('chat and recovery invoke no Core decision or execution; no browser page errors');
    await page.getByLabel('演示访问码', { exact: true }).fill('');
    await page.screenshot({ path: `${directory}/three-skills-restored.png`, fullPage: true });
  } catch (error) {
    report.failed++;
    report.cases.push({ name: 'live browser acceptance', passed: false, reason: error.code || error.name || 'VERIFICATION_FAILED' });
    // Assertion messages can contain generated credentials: persist only the code.
    process.exitCode = 1;
  } finally { await browser.close(); }
}
await writeFile(`${directory}/checks.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));

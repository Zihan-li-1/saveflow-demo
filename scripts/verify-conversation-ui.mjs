// Optional real Chromium QA. Playwright is external test tooling, not an app dependency.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const child = fork('tests/fixtures/conversation-ui-server.mjs', [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const [{ port }] = await once(child, 'message');
const url = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(error => { child.kill(); throw error; });
const access = 'conversation-ui-access-1234';
const report = { testDate: '2026-10-26', understanding: 'injected offline fixture; not real model', transport: 'real HTTP', browser: 'Chrome headless', cases: [], pageErrors: 0 };
const directory = 'docs/verification/conversation-ui';
const key = 'saveflow.banking-chat.v1';
const contexts = [];
async function fresh() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); contexts.push(context);
  await context.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
  const page = await context.newPage(); page.on('pageerror', () => report.pageErrors++);
  await page.goto(url); await authorize(page); return page;
}
async function authorize(page) {
  await page.getByLabel('演示访问码', { exact: true }).fill(access);
  await page.locator('.consent-control input').check();
}
async function ready(page) {
  await page.locator('.typing').waitFor({ state: 'detached' });
  await page.waitForFunction(() => !document.querySelector('.composer input')?.disabled);
  assert.equal(await page.locator('.composer input').isEnabled(), true);
}
async function request(page, action, expected = 200) {
  const waiting = page.waitForResponse(response => response.url().endsWith('/api/banking-agent') && response.request().method() === 'POST');
  await action(); const response = await waiting; const data = await response.json();
  assert.equal(response.status(), expected, data.code); await ready(page); return data;
}
const send = (page, text) => request(page, async () => { await page.locator('.composer input').fill(text); await page.locator('.composer input').press('Enter'); });
const panel = page => page.getByRole('region', { name: '会话与待继续业务' });
const state = async () => (await fetch(`${url}/test-state`)).json();
const control = body => fetch(`${url}/test-control`, { method: 'POST', body: JSON.stringify(body) });
const remember = (name, verified) => { assert.ok(verified); report.cases.push({ name, passed: true }); };
try {
  await mkdir(directory, { recursive: true });
  const a = await fresh();
  const first = await send(a, '给张三转500元');
  const oldChoices = first.data.choices.map(choice => choice.optionId);
  await send(a, '查看娱乐虚拟卡');
  const resumed = await request(a, () => panel(a).getByRole('button', { name: '恢复转账', exact: true }).click());
  assert.equal(resumed.data.slot, 'source_account_ref');
  assert.ok(resumed.data.choices.every(choice => !oldChoices.includes(choice.optionId)));
  const selected = await request(a, () => a.locator('.banking-choice-card').last().getByRole('button').first().click());
  assert.equal(selected.data.preview.exactEffects[0].amountFen, 50000);
  assert.equal(selected.data.conversation.token, first.data.conversation.token);
  remember('transfer clarification → card query → resume transfer with fresh options', true);

  const b = await fresh();
  const original = await send(b, '从活期账户给张三转500元');
  const bill = await send(b, '查看2026年8月账单');
  assert.equal(bill.data.status, 'bill_result');
  const card = await send(b, '查看娱乐虚拟卡');
  assert.equal(card.data.status, 'card_result');
  assert.equal(card.data.conversation.token, original.data.conversation.token);
  assert.notEqual(card.data.conversation.currentTask.taskId, bill.data.conversation.currentTask.taskId);
  remember('one session continuously visits transfer, bill and card Skills with separate task IDs', true);
  const returned = await send(b, '继续刚才的转账');
  assert.notEqual(returned.data.operationId, original.data.operationId);
  await b.locator('.banking-preview-card').last().getByRole('button', { name: '修改金额', exact: true }).click();
  await b.getByLabel('新金额（元）', { exact: true }).fill('600');
  const edited = await request(b, () => b.getByRole('button', { name: '生成新预览', exact: true }).click());
  assert.equal(edited.data.preview.exactEffects[0].amountFen, 60000);
  assert.notEqual(edited.data.operationId, returned.data.operationId);
  assert.equal(edited.data.conversation.currentTask.taskId, original.data.conversation.currentTask.taskId);
  remember('transfer preview → bill → resume → amount edit creates new preview', true);
  await b.getByLabel('演示访问码', { exact: true }).fill('');
  await b.setViewportSize({ width: 1440, height: 1800 });
  await panel(b).scrollIntoViewIfNeeded();
  await b.screenshot({ path: `${directory}/resumed-transfer.png`, fullPage: true });
  await b.locator('.banking-preview-card').last().screenshot({ path: `${directory}/latest-preview.png` });
  await panel(b).screenshot({ path: `${directory}/task-panel.png` });

  const token = edited.data.conversation.token;
  const cache = await b.evaluate(key => sessionStorage.getItem(key), key);
  assert.equal(JSON.parse(cache).conversationToken, token);
  assert.ok(!cache.includes(access)); assert.ok(!cache.includes('conversation-ui-token-secret-1234'));
  await b.reload(); await ready(b);
  assert.equal(await b.getByLabel('演示访问码', { exact: true }).inputValue(), '');
  assert.equal(await b.locator('.consent-control input').isChecked(), false);
  assert.equal(await b.locator('.banking-preview-card').last().getByRole('button', { name: '确认转账', exact: true }).isDisabled(), true);
  await authorize(b);
  const beforeSync = await state();
  const sync = await request(b, () => panel(b).getByRole('button', { name: '核验并恢复会话', exact: true }).click());
  assert.equal(sync.data.conversation.token, token);
  const afterSync = await state();
  assert.equal(afterSync.counts.prepare, beforeSync.counts.prepare); assert.equal(afterSync.counts.model, beforeSync.counts.model);
  assert.equal(await b.locator('.banking-preview-card').last().getByRole('button', { name: '确认转账', exact: true }).isDisabled(), true);
  const refreshed = await request(b, () => panel(b).getByRole('button', { name: '继续转账', exact: true }).click());
  assert.notEqual(refreshed.data.operationId, edited.data.operationId);
  assert.equal(refreshed.data.preview.exactEffects[0].amountFen, 60000);
  remember('browser reload → authenticated sync → explicit resume; storage grants no preview authority', true);
  remember('access code and server secret absent from browser storage', true);

  assert.notEqual(first.data.conversation.token, original.data.conversation.token);
  const cross = await b.evaluate(async ({ url, access, first, current }) => {
    const response = await fetch(`${url}/api/banking-agent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Saveflow-Access': access },
      body: JSON.stringify({ conversationToken: current.token, taskMode: 'continue', taskId: first.taskId, continuationToken: first.continuationToken, message: '给张三转100元' }) });
    return (await response.json()).code;
  }, { url, access, first: { taskId: selected.data.conversation.currentTask.taskId, continuationToken: selected.data.continuationToken }, current: refreshed.data.conversation });
  assert.equal(cross, 'CONVERSATION_TASK_MISMATCH');
  remember('two browser contexts isolate tasks and slot/credential ownership', true);

  const c = await fresh(); await send(c, '查看2026年8月账单');
  await c.evaluate(key => { const snapshot = JSON.parse(sessionStorage.getItem(key)); snapshot.conversationToken = `cs1.${'A'.repeat(43)}`; sessionStorage.setItem(key, JSON.stringify(snapshot)); }, key);
  await c.reload(); await authorize(c);
  const rejected = await request(c, () => panel(c).getByRole('button', { name: '核验并恢复会话', exact: true }).click(), 409);
  assert.equal(rejected.code, 'CONVERSATION_NOT_FOUND');
  await panel(c).getByRole('button', { name: '开始新业务', exact: true }).click();
  await send(c, '查看2026年8月账单');
  remember('forged cached session rejected; new request succeeds without clearing history', true);

  const d = await fresh(); await send(d, '从活期账户给张三转500元');
  const before = await state();
  let loseResponse = true;
  await d.route('**/api/banking', async route => {
    if (loseResponse && route.request().postDataJSON()?.action === 'action.execute') {
      loseResponse = false;
      await route.fetch(); // Real HTTP and Core commit; lose only the browser response.
      await route.abort('failed');
    } else await route.continue();
  });
  await d.locator('.banking-preview-card').last().getByRole('button', { name: '确认转账', exact: true }).click();
  await ready(d);
  await d.getByText(/结果待核实，操作编号/).waitFor();
  const lost = await state(); assert.equal(lost.counts.execute, before.counts.execute + 1); assert.equal(lost.transactions, before.transactions + 1);
  await d.reload(); await authorize(d);
  await request(d, () => panel(d).getByRole('button', { name: '核验并恢复会话', exact: true }).click());
  const queryResponse = d.waitForResponse(r => r.url().endsWith('/api/banking') && r.request().postDataJSON()?.action === 'action.status');
  await d.getByRole('button', { name: '查询操作状态', exact: true }).first().click(); await queryResponse;
  await d.getByText('转账已完成，凭证可在账户概览中查看。', { exact: true }).waitFor(); await ready(d);
  const recovered = await state(); assert.equal(recovered.counts.execute, lost.counts.execute); assert.equal(recovered.transactions, lost.transactions);
  remember('committed execute response lost → reload → query original receipt; no repeated execute', true);

  await b.reload(); await authorize(b);
  await control({ command: 'advance', ms: 1800001 });
  const expired = await request(b, () => panel(b).getByRole('button', { name: '核验并恢复会话', exact: true }).click(), 409);
  assert.equal(expired.code, 'CONVERSATION_EXPIRED');
  await panel(b).getByRole('button', { name: '开始新业务', exact: true }).click(); await send(b, '查看2026年8月账单');
  remember('expired process-local session rejected; composer and new business remain usable', true);
  assert.equal(report.pageErrors, 0);
  report.passed = report.cases.length;
  await writeFile(`${directory}/checks.json`, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ passed: report.passed, pageErrors: report.pageErrors, evidence: directory }) + '\n');
} catch (error) {
  const last = contexts.at(-1)?.pages().at(-1);
  if (last) {
    await last.getByLabel('演示访问码', { exact: true }).fill('').catch(() => {});
    await last.screenshot({ path: `${directory}/failure.png`, fullPage: true }).catch(() => {});
  }
  process.stdout.write(JSON.stringify({ completedCases: report.cases.map(test => test.name), counts: (await state()).counts, evidence: `${directory}/failure.png` }) + '\n');
  throw error;
} finally {
  await Promise.all(contexts.map(context => context.close())); await browser.close(); child.kill();
}

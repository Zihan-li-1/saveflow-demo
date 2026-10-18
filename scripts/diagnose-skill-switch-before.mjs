import nextEnv from '@next/env';
import { mkdir, writeFile } from 'node:fs/promises';
nextEnv.loadEnvConfig(process.cwd(), true);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const report = { at: new Date().toISOString(), requests: [] };
try {
  await page.goto('http://127.0.0.1:3000');
  await page.getByLabel('演示访问码', { exact: true }).fill(process.env.SAVEFLOW_ACCESS_CODE);
  await page.locator('.consent-control input').check();
  for (const message of ['从模拟活期账户转账500元给房东王先生', '查看我的卡', '查询8月账单']) {
    const pending = page.waitForResponse(r => r.url().endsWith('/api/banking-agent')); void pending.catch(() => {});
    await page.locator('.composer input').fill(message); await page.locator('.composer input').press('Enter');
    const r = await pending, json = await r.json();
    await page.waitForFunction(() => !document.querySelector('.composer input').disabled);
    const sent = r.request().postDataJSON();
    report.requests.push({ message, sentPreviousToken: !!sent.continuationToken, status: r.status(), code: json.code, resultStatus: json.data?.status, source: json.data?.source, previewCount: await page.locator('.banking-preview-card').count() });
  }
} finally {
  await browser.close(); await mkdir('.next/skill-switch-before', { recursive: true });
  await writeFile('.next/skill-switch-before/report.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));

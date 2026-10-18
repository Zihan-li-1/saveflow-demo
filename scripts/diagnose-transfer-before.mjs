// Local browser reproduction. Credentials and continuation tokens are never recorded.
import { mkdir, writeFile } from 'node:fs/promises';
import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd(), true);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir = '.next/transfer-debug-before';
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report = { at: new Date().toISOString(), scenarios: [] };
try {
  for (const first of ['从模拟活期账户转账500元给房东王先生', '从模拟活期账户给房东王先生转500元']) {
    const page = await browser.newPage({ baseURL: 'http://127.0.0.1:3000' });
    const scenario = { first, responses: [] }; report.scenarios.push(scenario);
    await page.goto('http://127.0.0.1:3000');
    await page.getByLabel('演示访问码', { exact: true }).fill(process.env.SAVEFLOW_ACCESS_CODE);
    await page.locator('.consent-control input').check();
    for (const message of [first, '改成转账400元']) {
      const response = page.waitForResponse(r => r.url().endsWith('/api/banking-agent'), { timeout: 35000 });
      void response.catch(() => {});
      await page.locator('.composer input').fill(message); await page.locator('.composer input').press('Enter');
      const r = await response; const json = await r.json();
      await page.waitForTimeout(300);
      scenario.responses.push({ message, httpStatus: r.status(), code: json.code, data: { ...json.data, continuationToken: json.data?.continuationToken ? '[redacted]' : undefined }, previewCount: await page.locator('.banking-preview-card').count(), rowCount: await page.locator('.message-row').count(), buttonCount: await page.locator('.banking-preview-card button').count() });
      if (r.status() !== 200) break;
    }
    scenario.rowsBeforeRefresh = await page.locator('.message-row').count();
    await page.reload(); await page.locator('.composer input').waitFor();
    scenario.rowsAfterRefresh = await page.locator('.message-row').count();
    await page.close();
  }
} finally { await browser.close(); await writeFile(`${dir}/reproduction.json`, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));

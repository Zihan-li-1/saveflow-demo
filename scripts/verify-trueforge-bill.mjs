// Standalone real-service probe. No UI, Core fallback, or fabricated tool results.
import { mkdir, writeFile } from 'node:fs/promises';
import { createTrueforgeClient } from '../server/trueforge-client.mjs';
import { validateBillToolResult } from '../server/trueforge-bill-adapter.mjs';
const client = createTrueforgeClient();
const started = Date.now();
let sessionId;
const report = { realService: true, sdkVersion: '0.2.1', turns: [] };
try {
  sessionId = await client.createSession(AbortSignal.timeout(25000));
  report.sessionId = sessionId;
  for (const message of process.argv.slice(2).length ? process.argv.slice(2) : ['查询 2026 年 8 月账单']) {
    const turnStart = Date.now();
    const requested = message.match(/(\d{4})\s*(?:年\s*|-)\s*(\d{1,2})\s*月?/);
    const expectedMonth = requested ? `${requested[1]}-${requested[2].padStart(2, '0')}` : undefined;
    const turn = await client.runTurn(sessionId, JSON.stringify({ userMessage: message, toolArguments: expectedMonth === undefined ? {} : { month: expectedMonth } }), AbortSignal.timeout(25000));
    const result = validateBillToolResult(turn, { serverName: process.env.TRUEFORGE_MCP_SERVER, expectedMonth });
    report.turns.push({ message, elapsedMs: Date.now() - turnStart, ...turn, result });
    console.log(JSON.stringify(report.turns.at(-1), null, 2));
  }
} catch (error) {
  report.error = { name: error.name, code: error.code || 'PROBE_FAILED' };
  if (sessionId) await client.cancel(sessionId);
  process.exitCode = 1;
} finally {
  report.elapsedMs = Date.now() - started;
  await mkdir('.next', { recursive: true });
  await writeFile('.next/trueforge-probe.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ elapsedMs: report.elapsedMs, error: report.error, report: '.next/trueforge-probe.json' }));
}

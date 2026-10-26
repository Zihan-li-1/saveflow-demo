import { mkdir, writeFile } from 'node:fs/promises';
import { languageCases } from '../tests/fixtures/natural-language-cases.mjs';
import { exerciseLanguageCase } from '../tests/fixtures/natural-language-harness.mjs';

try { process.loadEnvFile('.env.local'); } catch { /* hosts may configure the environment directly */ }
const report = { testDate: '2026-10-22', timezone: 'Asia/Shanghai', runtime: 'trueforge', model: process.env.TRUEFORGE_MODEL ?? 'unconfigured', syntheticDataOnly: true, cases: [] };
// Persist only schema/calendar evidence. Never save full model output or financial snapshots.
const safeEvidence = evidence => ({
  resultStatus: evidence?.resultStatus,
  modelTurns: evidence?.modelTurns?.map(({ input, output }) => ({
    calendar: { currentDate: input.calendar?.currentDate, timezone: input.calendar?.timezone, financialContextPresent: !!input.calendar?.financialData },
    action: output.action, status: output.status,
    ...(output.action === 'bill.summary' ? { time: { month: output.slots?.month, period: output.slots?.period } } : {}),
  })),
  queries: evidence?.queries,
});
for (const [index, definition] of languageCases.entries()) {
  try {
    const evidence = await exerciseLanguageCase(definition, { live: true, env: process.env });
    report.cases.push({ index: index + 1, passed: true, message: definition.message, ...safeEvidence(evidence) });
    console.log(JSON.stringify({ case: index + 1, passed: true, message: definition.message }));
  } catch (error) {
    // No upstream exception bodies, URLs, headers or credentials in the report.
    report.cases.push({ index: index + 1, passed: false, message: definition.message, reason: error.code ?? 'VERIFICATION_FAILED', ...safeEvidence(error.languageEvidence) });
    console.log(JSON.stringify({ case: index + 1, passed: false, message: definition.message, reason: report.cases.at(-1).reason }));
  }
}
report.passed = report.cases.filter(item => item.passed).length;
report.failed = report.cases.length - report.passed;
await mkdir('docs/verification/natural-language', { recursive: true });
await writeFile('docs/verification/natural-language/real-model.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, failed: report.failed }));
if (report.failed) process.exitCode = 1;

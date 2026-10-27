import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageCases } from './fixtures/natural-language-cases.mjs';
import { exerciseLanguageCase } from './fixtures/natural-language-harness.mjs';
import { understandingContext } from '../server/understanding-context.mjs';
import { validCalendarDate, transactionMatchesPeriod } from '../src/lib/calendar.mjs';
import { validateParsedIntent } from '../src/agent/validate-parsed-intent.mjs';
import { buildParsedIntent } from '../src/agent/clarification/merge-intent.mjs';
import { parseBankingIntent } from '../server/banking-intent-parser.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

for (const [i, definition] of languageCases.entries()) test(`wiring only ${i + 1}: ${definition.message} ${definition.answer ?? ''}`, async () => {
  await exerciseLanguageCase(definition);
});

test('real-model verifier reports missing configuration as skipped, never passed or a mocked model run', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'saveflow-no-model-'));
  const env = { ...process.env };
  delete env.TRUEFORGE_BASE_URL; delete env.TRUEFORGE_MODEL;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/verify-natural-language.mjs', import.meta.url))], {
    cwd: directory, env, encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(result.status, 0);
  const report = JSON.parse(await readFile(path.join(directory, 'docs/verification/natural-language/real-model.json'), 'utf8'));
  assert.equal(report.passed, 0); assert.equal(report.failed, 0); assert.equal(report.skipped, languageCases.length);
  assert.ok(report.cases.every(item => item.skipped && !item.passed));
});

test('clock uses injected timezone across date/year boundaries independently from financial data', () => {
  const now = () => Date.parse('2026-12-31T16:30:00Z');
  assert.equal(understandingContext({ now }).currentDate, '2027-01-01');
  assert.equal(understandingContext({ now, timezone: 'America/New_York' }).currentDate, '2026-12-31');
  assert.equal(understandingContext({ now, financialContext: { currentMonth: '2020-01' } }).currentDate, '2027-01-01');
  assert.throws(() => understandingContext({ timezone: 'Unknown/Nowhere' }));
});

test('legacy understanding receives the same draft, history, timezone and current date on a supplemental answer', async () => {
  const context = { action: 'transfer.create', slots: { payee_ref: '张三', source_account_ref: '活期账户' }, pendingSlot: 'amount', question: '要转多少？' };
  const result = await parseBankingIntent('一千五', { context, history: [{ role: 'assistant', content: '要转多少？' }], env: { DASHSCOPE_API_KEY: 'fixture-secret' }, now: () => Date.parse('2026-10-21T16:10:00Z'), fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.ok(payload.messages[0].content.includes('"currentDate":"2026-10-22"'));
    assert.ok(payload.messages[0].content.includes('"pendingSlot":"amount"'));
    assert.equal(payload.messages.at(-1).content, '一千五');
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(buildParsedIntent('transfer.create', { ...context.slots, amount: { amount_minor: 150000, currency: 'CNY' } })) } }] });
  } });
  assert.equal(result.slots.amount.amount_minor, 150000);
});

test('date range includes whole local end day, excludes next day, and month agrees with range', () => {
  const filter = { startDate: '2026-09-01', endDate: '2026-09-30', timezone: 'Asia/Shanghai' };
  for (const [at, included] of [['2026-08-31T15:59:59Z', false], ['2026-08-31T16:00:00Z', true], ['2026-09-30T15:59:59.999Z', true], ['2026-09-30T16:00:00Z', false]]) {
    assert.equal(transactionMatchesPeriod(at, filter), included);
    assert.equal(transactionMatchesPeriod(at, { month: '2026-09' }), included);
  }
  assert.equal(transactionMatchesPeriod('2026-11-01T04:00:00Z', { startDate: '2026-11-01', endDate: '2026-11-01', timezone: 'America/New_York' }), true);
});

test('rejects impossible dates, reversed/excessive ranges and invalid goal amounts/deadlines', () => {
  for (const date of ['2026-02-30', '2026-04-31', '2026-00-01', '2026-01-00', '1800-01-01']) assert.equal(validCalendarDate(date), false);
  assert.equal(validCalendarDate('2024-02-29'), true);
  for (const p of [
    { start_date: '2026-02-30', end_date: '2026-03-01' }, { start_date: '2026-10-01', end_date: '2026-09-30' },
    { start_date: '2025-01-01', end_date: '2026-01-02' },
  ]) assert.throws(() => buildParsedIntent('bill.summary', { period: { ...p, timezone: 'Asia/Shanghai', label: 'test' } }));
  for (const value of [-1, 0, 1.5, 100000001]) assert.throws(() => buildParsedIntent('orchestrator.goal', { goal_text: '存钱', amount: { amount_minor: value, currency: 'CNY' } }));
  assert.throws(() => validateParsedIntent({ ...buildParsedIntent('orchestrator.goal', { goal_text: '存钱' }), slots: { goal_text: '存钱', deadline: '2026-02-29' } }));
});

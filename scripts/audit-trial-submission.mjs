// Local review evidence; emit file names and detector names, never secret values.
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import nextEnv from '@next/env';
const { parsedEnv = {} } = nextEnv.loadEnvConfig(process.cwd(), true);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const files = [...new Set(execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean))];
const secrets = Object.entries(parsedEnv).filter(([key, value]) => /(?:KEY|SECRET|TOKEN|PASSWORD|ACCESS_CODE)$/.test(key) && value?.length >= 8);
const findings = [];
async function scan(path, category) {
  const bytes = await readFile(path);
  // Windows PowerShell redirects native output as UTF-16LE; scan its actual
  // text too, so log encoding cannot hide a configured credential.
  const content = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8');
  for (const [key, value] of secrets) if (content.includes(value)) findings.push({ path, category, detector: `configured:${key}` });
  for (const [detector, pattern] of [
    ['provider-key', /\bsk-[A-Za-z0-9_-]{24,}\b/],
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['trial-continuation', /\b(?:tfm1|tfb1)\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}\b/],
    ['bridge-alias', /\btfg1_[a-f0-9]{32}\b/],
  ]) if (pattern.test(content)) findings.push({ path, category, detector });
}
for (const file of files) if ((await stat(file)).isFile()) await scan(file, 'git-candidate');
let staticFiles = 0;
async function scanStatic(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await scanStatic(path); else { await scan(path, 'static-export'); staticFiles++; }
  }
}
await scanStatic('out');
const dockerEvidenceCode = `
  const fs = require('node:fs'), crypto = require('node:crypto');
  const secrets = Object.entries(process.env).filter(([k,v]) => /(?:KEY|SECRET|TOKEN|PASSWORD|ACCESS_CODE)$/.test(k) && v.length >= 8);
  let files = 0; const findings = [];
  function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = dir + '/' + e.name; if (e.isDirectory()) walk(p); else { files++; const s = fs.readFileSync(p).toString('utf8'); for (const [key,value] of secrets) if (s.includes(value)) findings.push({ path: p, key }); } } }
  walk('/app/out');
  const paths = ['src/banking-core/postgres-store.mjs', 'server/mcp/saveflow-trial.mjs'];
  console.log(JSON.stringify({ staticFiles: files, findings, envFilePresent: fs.existsSync('/app/.env.local'), uid: process.getuid(), websitePostgresConfigured: !!process.env.DATABASE_URL, hashes: Object.fromEntries(paths.map(p => [p, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')])) }));
`;
const runtimeBoundary = JSON.parse(execFileSync('docker', ['compose', '--env-file', '.env.local', 'exec', '-T', 'web', 'node', '-e', dockerEvidenceCode], { encoding: 'utf8' }));
const sourceHashMatches = await Promise.all(Object.entries(runtimeBoundary.hashes).map(async ([path, hash]) => hash === createHash('sha256').update(await readFile(path)).digest('hex')));
runtimeBoundary.sourceHashMatches = sourceHashMatches.every(Boolean);
const generated = ['next-env.d.ts', 'tsconfig.tsbuildinfo'];
const pending = [...new Set([
  ...execFileSync('git', ['diff', '--name-only', '-z'], { encoding: 'utf8' }).split('\0'),
  ...execFileSync('git', ['diff', '--cached', '--name-only', '-z'], { encoding: 'utf8' }).split('\0'),
  ...execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'),
].filter(Boolean))].sort();
const commits = [
  { title: 'feat(trueforge): add restricted query and preview trial harness', files: [] },
  { title: 'fix(postgres): serialize JSONB once and support legacy records', files: [] },
  { title: 'test(docker): verify isolated PostgreSQL persistence and document continuation blockers', files: [] },
];
for (const path of pending.filter(path => !generated.includes(path))) {
  const group = ['src/banking-core/postgres-store.mjs', 'tests/postgres-persistence.test.mjs'].includes(path) ? 1
    : /^(?:Dockerfile$|\.dockerignore$|compose(?:\.postgres)?\.yaml$|scripts\/(?:serve-container|configure-trueforge-docker|verify-docker[^/]*|audit-trial-submission)\.mjs$|docs\/(?:docker-test-report\.md|trueforge-submit-review\.md|verification\/(?:docker-check|postgres-fix)\/))/.test(path) ? 2 : 0;
  commits[group].files.push(path);
}
await writeFile('docs/verification/postgres-fix/proposed-commits.json', JSON.stringify({ suggestedOnly: true, commits, exclude: generated }, null, 2) + '\n');
const report = {
  at: new Date().toISOString(), branch: git('branch', '--show-current'), head: git('rev-parse', 'HEAD'), main: git('rev-parse', 'main'),
  envLocalIgnored: git('check-ignore', '.env.local') === '.env.local',
  envLocalTracked: files.includes('.env.local'), configuredSecretCount: secrets.length,
  scannedGitFiles: files.length, scannedStaticFiles: staticFiles, findings,
  runtimeBoundary,
  trackedGeneratedFilesToExcludeFromCommit: generated.filter(f => files.includes(f)),
  pendingFileCount: pending.length,
  files: files.map(path => ({ path, generated: generated.includes(path) })),
  sourceHashes: Object.fromEntries(await Promise.all(['src/banking-core/postgres-store.mjs', 'tests/postgres-persistence.test.mjs', 'server/mcp/saveflow-trial.mjs', 'compose.yaml', 'compose.postgres.yaml'].map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')]))),
};
await writeFile('docs/verification/postgres-fix/submission-audit.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, files: undefined }, null, 2));
if (findings.length || !report.envLocalIgnored || report.envLocalTracked || runtimeBoundary.findings.length || runtimeBoundary.envFilePresent || !runtimeBoundary.sourceHashMatches) process.exitCode = 1;

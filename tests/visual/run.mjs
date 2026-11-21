// Base-vs-head key-screen diff: `RF_VISUAL_BASE=<rev> node tests/visual/run.mjs`
// (npm run test:visual). Exports the base revision to a temp tree, screenshots the key
// screens from it, screenshots them again from this checkout, and diffs the two.
// Needs the dev Postgres on 127.0.0.1:4250 with the readfine_e2e database; the app runs
// on 127.0.0.1:4251 and the fixture server on 4252, one side after the other.
// Both phases use head-side tooling (seed.py, alembic) against the head schema; only the
// served app tree differs. Before the base phase the database is migrated and seeded
// once, so the base server (which reads app_settings at startup) sees the seeded state.
// Do not run it in parallel with `npm run test:e2e`: they share ports 4251/4252, the
// readfine_e2e database and tests/e2e/.work.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatReport } from './diff.mjs';
import { APP_ENV, BACKEND, WORK } from '../e2e/env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG = 'playwright.visual.config.mjs';
const REPORT_DIR = path.join(ROOT, 'test-results/visual-report');

let interrupted = false;

function phase(side, tree, env) {
  const r = spawnSync(path.join(ROOT, 'node_modules/.bin/playwright'), ['test', '-c', CONFIG], {
    cwd: ROOT, stdio: 'inherit',
    env: { ...process.env, ...env, RF_VISUAL_SIDE: side, RF_VISUAL_TREE: tree },
  });
  // A child killed by a signal ends the run: clean up, then exit 130. A process-group signal
  // (Ctrl-C) reaches Playwright too and stops the run promptly; a parent-only `kill <pid>`
  // is only noticed once the running Playwright phase has finished.
  if (r.signal) { interrupted = true; throw new Error(`${side} phase killed by ${r.signal}`); }
  return r.status === 0;
}

const base = execFileSync('git', ['rev-parse', '--verify', process.env.RF_VISUAL_BASE || '94a9385'], {
  cwd: ROOT, encoding: 'utf8',
}).trim();
const env = { E2E_SEED_NOW: new Date().toISOString() };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-visual-'));
let code = 1;
// No exit inside: Ctrl-C hits the whole process group, and a listener keeps this process
// alive through the blocking child call so `finally` removes the temp tree.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { interrupted = true; });
try {
  const tree = path.join(tmp, 'tree');
  fs.mkdirSync(tree);
  execFileSync('sh', ['-c', 'git archive "$1" | tar -x -C "$2"', 'sh', base, tree], { cwd: ROOT });
  env.RF_VISUAL_SHOTS = path.join(tmp, 'shots');
  console.log(`visual: base ${base.slice(0, 7)} exported, seed instant ${env.E2E_SEED_NOW}`);

  // Migrate and seed first, so both servers start against the seeded database.
  const dbEnv = { ...process.env, ...APP_ENV, ...env };
  fs.mkdirSync(WORK, { recursive: true });
  execFileSync('uv', ['run', 'alembic', 'upgrade', 'head'], { cwd: BACKEND, env: dbEnv, stdio: 'inherit' });
  execFileSync('uv', ['run', 'python', '../tests/e2e/fixtures/seed.py', 'seed', '--out', path.join(tmp, 'seed.json')], {
    cwd: BACKEND, env: dbEnv, stdio: 'inherit',
  });

  if (!phase('base', tree, env)) throw new Error('base phase failed');
  fs.rmSync(path.join(REPORT_DIR, 'results.json'), { force: true }); // never print a stale report
  const headOk = phase('head', ROOT, env);
  if (!headOk) console.error('visual: head phase failed');

  const resultsFile = path.join(REPORT_DIR, 'results.json');
  if (!fs.existsSync(resultsFile)) throw new Error('head phase produced no results');
  const results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  const { lines, failed } = formatReport(results);
  const diffs = results.filter((r) => r.pixels > 0 || r.sizeMismatch)
    .map((r) => `- ${r.screen}: ${r.diff ?? '(size mismatch)'}`);
  fs.writeFileSync(path.join(REPORT_DIR, 'report.md'),
    ['# Visual diff', '', `base ${base}`, '', '```', ...lines, '```', '',
      ...(diffs.length ? ['Diff images (red = differing pixels):', ...diffs, ''] : [])].join('\n'));
  console.log(lines.join('\n'));
  console.log(`visual: report ${path.relative(ROOT, path.join(REPORT_DIR, 'report.md'))}`);
  code = failed > 0 || !headOk ? 1 : 0;
} catch (err) {
  console.error(`visual: ${err.message}`);
  if (err.signal) interrupted = true; // alembic / seed child killed by a signal
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
// The listener runs on the event loop, which the blocking child calls above never yield to;
// one timer turn lets a signal that arrived meanwhile be delivered.
await new Promise((resolve) => setTimeout(resolve, 20));
if (interrupted) code = 130;
process.exit(code);

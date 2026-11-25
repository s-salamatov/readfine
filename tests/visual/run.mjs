// Base-vs-head visual harness: `RF_VISUAL_BASE=<rev> node tests/visual/run.mjs`
// (npm run test:visual). Exports the base revision (default 1d7f2f4, selfhost with s1)
// to a temp tree and runs tests/visual/key-screens.spec.mjs once per side.
// RF_VISUAL_MODE:
// - pixel (default): screenshots of the key screens from both sides, diffed;
//   report test-results/visual-report/report.md.
// - layout: element boxes of the key screens from both sides, pass A (fonts blocked,
//   strict) and pass B (fonts loaded, KEY_STRUCTURE only), exemptions from
//   tests/visual/layout-allow/*.json; report layout.md.
// - gallery: head-only screenshots of GALLERY_PAGES x themes x schemes x widths plus the
//   dark-patch probe; RF_VISUAL_GALLERY_BASE=1 adds base shots (one per scheme and width),
//   RF_VISUAL_LANDING=1 adds the landing (a temporary landing.html copied from
//   landing.example.html), RF_VISUAL_DEBUG=1 adds /dev/ui (DEBUG on in the head app);
//   report gallery.html and gallery.md.
// E2E_DATABASE_URL is required: a throwaway loopback PostgreSQL database named
// readfine_e2e on an explicit port other than 4250. The app runs on 127.0.0.1:4251
// and the fixture server on 4252, one side after the other.
// Both phases use head-side tooling (seed.py, alembic) against the head schema; only the
// served app tree differs. Before the first phase the database is migrated and seeded
// once, so the first server (which reads app_settings at startup) sees the seeded state.
// Do not run it in parallel with `npm run test:e2e`: they share ports 4251/4252, the
// readfine_e2e database and tests/e2e/.work.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatReport } from './diff.mjs';
import { formatLayoutReport, loadAllow } from './layout.mjs';
import { APP_ENV, BACKEND, WORK } from '../e2e/env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG = 'playwright.visual.config.mjs';
const REPORT_DIR = path.join(ROOT, 'test-results/visual-report');
const ALLOW_DIR = path.join(ROOT, 'tests/visual/layout-allow');
const LANDING = path.join(ROOT, 'backend/app/templates/landing.html');
const MODE = process.env.RF_VISUAL_MODE || 'pixel';
const LANDING_ON = MODE === 'gallery' && process.env.RF_VISUAL_LANDING === '1';
const GALLERY_BASE = process.env.RF_VISUAL_GALLERY_BASE === '1';

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

// Copies `<tree>/backend/app/templates/landing.example.html` to landing.html. Never
// overwrites an operator's landing.html. Returns the path to remove afterwards.
function copyLanding(tree) {
  const dir = path.join(tree, 'backend/app/templates');
  const target = path.join(dir, 'landing.html');
  if (fs.existsSync(target)) throw new Error(`${path.relative(ROOT, target) || target} exists; refusing to overwrite it`);
  fs.copyFileSync(path.join(dir, 'landing.example.html'), target);
  return target;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Contact sheet: one section per page, base shots (when captured) beside the head ones,
// relative links. Then the dark-patch findings.
function galleryHtml(head, base) {
  const parts = [
    '<!doctype html><meta charset="utf-8"><title>Visual gallery</title>',
    '<style>body{font:14px system-ui;margin:1rem}section{margin:2rem 0}figure{display:inline-block;margin:0 .5rem .5rem 0;vertical-align:top}'
      + 'img{border:1px solid #888;max-height:360px}figcaption{font-size:12px}.row{white-space:nowrap;overflow-x:auto}</style>',
    `<h1>Visual gallery</h1><p>${head.shots.length} head shots${base ? `, ${base.shots.length} base shots` : ''}; `
      + `dark-patch probe: ${head.patches.length} patches.</p>`,
  ];
  const fig = (s) => `<figure><a href="${esc(s.file)}"><img loading="lazy" src="${esc(s.file)}"></a>`
    + `<figcaption>${esc(`${s.side} ${s.theme} ${s.scheme} ${s.width}`)}</figcaption></figure>`;
  for (const page of head.pages) {
    parts.push(`<section id="${esc(page)}"><h2>${esc(page)}</h2>`);
    for (const width of [1280, 390]) {
      const own = head.shots.filter((s) => s.page === page && s.width === width);
      if (!own.length) continue;
      const theirs = base ? base.shots.filter((s) => s.page === page && s.width === width) : [];
      parts.push(`<h3>${width}</h3><div class="row">${[...theirs, ...own].map(fig).join('')}</div>`);
    }
    parts.push('</section>');
  }
  parts.push('<h2>Dark-patch probe</h2>');
  parts.push(head.patches.length
    ? `<ul>${head.patches.map((p) => `<li>${esc(`${p.screen} ${p.theme} ${p.selector} ${p.colour} (L=${p.luminance})`)}</li>`).join('')}</ul>`
    : '<p>No patches.</p>');
  parts.push(`<h3>Allowlist</h3><ul>${head.patchAllow.map((a) => `<li><code>${esc(a.selector)}</code>: ${esc(a.reason)}</li>`).join('')}</ul>`);
  return parts.join('\n');
}

function reportPixel(base) {
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
  return failed;
}

function reportLayout(base) {
  const resultsFile = path.join(REPORT_DIR, 'layout-results.json');
  if (!fs.existsSync(resultsFile)) throw new Error('head phase produced no layout results');
  const allow = loadAllow(ALLOW_DIR);
  const { lines, failed } = formatLayoutReport(JSON.parse(fs.readFileSync(resultsFile, 'utf8')), allow);
  const allowLines = allow.length
    ? allow.map((a) => `- ${a.file}: ${a.screen} ${a.key} — ${a.reason}`) : ['- (none)'];
  fs.writeFileSync(path.join(REPORT_DIR, 'layout.md'),
    ['# Visual layout', '', `base ${base}`, '', 'Exemptions loaded:', ...allowLines, '',
      '```', ...lines, '```', ''].join('\n'));
  // The console gets failures and the summary; layout.md has every job.
  console.log(lines.filter((l) => !/ ok$/.test(l) && !l.startsWith('  reflow')).join('\n'));
  console.log(`visual: report ${path.relative(ROOT, path.join(REPORT_DIR, 'layout.md'))}`);
  return failed;
}

function reportGallery() {
  const read = (side) => {
    const f = path.join(REPORT_DIR, 'gallery', `${side}.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  };
  const head = read('head');
  if (!head) throw new Error('head phase produced no gallery results');
  const base = GALLERY_BASE ? read('base') : null;
  fs.writeFileSync(path.join(REPORT_DIR, 'gallery.html'), galleryHtml(head, base));
  const lines = head.patches.map((p) => `patch  ${p.screen}  ${p.theme}  ${p.selector}  ${p.colour}  L=${p.luminance}`);
  lines.push(`gallery: ${head.pages.length} pages, ${head.shots.length} head shots${base ? `, ${base.shots.length} base shots` : ''}, `
    + `dark-patch probe ${head.patches.length} patches`);
  fs.writeFileSync(path.join(REPORT_DIR, 'gallery.md'), ['# Visual gallery', '', '```', ...lines, '```', ''].join('\n'));
  console.log(lines.join('\n'));
  console.log(`visual: report ${path.relative(ROOT, path.join(REPORT_DIR, 'gallery.html'))}`);
  return head.patches.length + head.failures.length;
}

if (!['pixel', 'layout', 'gallery'].includes(MODE)) {
  console.error(`visual: unknown RF_VISUAL_MODE ${MODE} (pixel, layout or gallery)`);
  process.exit(2);
}
const needBase = MODE !== 'gallery' || GALLERY_BASE;
const base = execFileSync('git', ['rev-parse', '--verify', process.env.RF_VISUAL_BASE || '1d7f2f4'], {
  cwd: ROOT, encoding: 'utf8',
}).trim();
const env = { E2E_SEED_NOW: new Date().toISOString(), RF_VISUAL_MODE: MODE };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-visual-'));
const cleanup = [];
let code = 1;
// No exit inside: Ctrl-C hits the whole process group, and a listener keeps this process
// alive through the blocking child call so `finally` removes the temp tree.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { interrupted = true; });
try {
  env.RF_VISUAL_SHOTS = path.join(tmp, 'shots');
  const tree = path.join(tmp, 'tree');
  if (needBase) {
    fs.mkdirSync(tree);
    execFileSync('sh', ['-c', 'git archive "$1" | tar -x -C "$2"', 'sh', base, tree], { cwd: ROOT });
    console.log(`visual: ${MODE}, base ${base.slice(0, 7)} exported, seed instant ${env.E2E_SEED_NOW}`);
  } else {
    console.log(`visual: ${MODE}, head only, seed instant ${env.E2E_SEED_NOW}`);
  }
  if (LANDING_ON) {
    cleanup.push(copyLanding(ROOT));
    if (needBase) copyLanding(tree); // inside the temp tree, removed with it
  }
  if (MODE !== 'pixel') fs.rmSync(REPORT_DIR, { recursive: true, force: true }); // pixel: the head spec clears it

  // Migrate and seed first, so both servers start against the seeded database.
  const dbEnv = { ...process.env, ...APP_ENV, ...env };
  fs.mkdirSync(WORK, { recursive: true });
  execFileSync('uv', ['run', 'alembic', 'upgrade', 'head'], { cwd: BACKEND, env: dbEnv, stdio: 'inherit' });
  execFileSync('uv', ['run', 'python', '../tests/e2e/fixtures/seed.py', 'seed', '--out', path.join(tmp, 'seed.json')], {
    cwd: BACKEND, env: dbEnv, stdio: 'inherit',
  });

  if (needBase && !phase('base', tree, env)) throw new Error('base phase failed');
  for (const f of ['results.json', 'layout-results.json', 'gallery/head.json']) {
    fs.rmSync(path.join(REPORT_DIR, f), { force: true }); // never print a stale report
  }
  const headOk = phase('head', ROOT, env);
  if (!headOk) console.error('visual: head phase failed');

  const failed = MODE === 'pixel' ? reportPixel(base) : MODE === 'layout' ? reportLayout(base) : reportGallery();
  code = failed > 0 || !headOk ? 1 : 0;
} catch (err) {
  console.error(`visual: ${err.message}`);
  if (err.signal) interrupted = true; // alembic / seed child killed by a signal
} finally {
  for (const f of cleanup) fs.rmSync(f, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}
// The listener runs on the event loop, which the blocking child calls above never yield to;
// one timer turn lets a signal that arrived meanwhile be delivered.
await new Promise((resolve) => setTimeout(resolve, 20));
if (interrupted) code = 130;
process.exit(code);

// Builds the repo's input.css with the Tailwind 4 CLI into a scratch dir and checks
// the sources, the v3 compatibility layer and the layering. Nothing here touches the
// committed backend/app/static/css/tailwind.css.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(REPO, 'node_modules', '.bin', 'tailwindcss');
const scratch = [];

const squash = (s) => s.replace(/\s+/g, '');
const build = (cwd, out) => {
  execFileSync(BIN, ['-i', 'input.css', '-o', out, '--minify'], { cwd, stdio: 'pipe' });
  return squash(readFileSync(out, 'utf8'));
};

let repoCss;
before(() => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-repo-'));
  scratch.push(dir);
  repoCss = build(REPO, join(dir, 'tw.css'));
});
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

test('sources: only templates, static/js and routers/services *.py are scanned', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-src-'));
  scratch.push(root);
  copyFileSync(join(REPO, 'input.css'), join(root, 'input.css'));
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'));
  const probes = {
    'backend/app/templates/p.html': 13,
    'backend/app/templates/landing.html': 17,
    'backend/app/static/js/p.js': 19,
    'backend/app/routers/web/p.py': 23,
    'backend/app/services/p.py': 29,
    'docs/p.md': 31,
    'specs/p.md': 37,
    'backend/app/routers/p.txt': 41,
  };
  for (const [path, n] of Object.entries(probes)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), `<div class="skew-x-[${n}deg]"></div>\n`);
  }
  const css = build(root, join(root, 'tw.css'));
  for (const n of [13, 19, 23, 29]) assert.ok(css.includes(`${n}deg`), `${n} should be present`);
  for (const n of [17, 31, 37, 41]) assert.ok(!css.includes(`${n}deg`), `${n} should be absent`);
});

test('compat: palette, dark, hover, ring, keyframes', () => {
  for (const needle of ['--color-gray-100:#f3f4f6', '--color-gray-800:#1f2937', '--color-blue-500:#3b82f6', '--color-red-600:#dc2626']) {
    assert.ok(repoCss.includes(needle), needle);
  }
  assert.ok(repoCss.includes('.dark\\:bg-gray-800:is(.dark*)'), 'dark variant selector');
  assert.ok(!repoCss.includes('@media(hover:hover){'), 'no hover media wrapper');
  assert.ok(repoCss.includes('.hover\\:bg-gray-100:hover{'), 'plain hover');
  const ring = repoCss.slice(repoCss.indexOf('.focus\\:ring-2:focus'));
  const ringRule = ring.slice(0, ring.indexOf('}') + 1);
  assert.ok(ringRule.includes('calc(2px'), ringRule);
  assert.ok(repoCss.includes('var(--color-blue-500)50%'), 'ring default colour');
  assert.ok(repoCss.includes('@keyframeschat-bounce'));
  assert.ok(repoCss.includes('.animate-chat-bounce{animation:var(--animate-chat-bounce)}'));
});

test('compat: preflight, prose colours and layering', () => {
  assert.ok(repoCss.includes('border-color:var(--color-gray-200,currentcolor)'));
  assert.match(repoCss, /::placeholder\{[^}]*color:var\(--color-gray-400\)/);
  assert.match(repoCss, /button:not\(:disabled\)[^{]*\{cursor:pointer/);
  const proseRules = [...repoCss.matchAll(/\.prose\{[^}]*\}/g)].map((m) => m[0]);
  const idx = proseRules.findIndex((r) => r.includes('--tw-prose-body:var(--color-gray-700)'));
  assert.ok(idx > 0, "our .prose rule exists and comes after typography's own");
  const lastUtility = repoCss.lastIndexOf('.focus\\:ring-2');
  assert.ok(repoCss.indexOf('.story-chip{') > lastUtility, '.story-chip after generated utilities');
});

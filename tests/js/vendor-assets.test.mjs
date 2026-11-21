import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATIC = join(REPO, 'backend', 'app', 'static');
const FONTS = [
  'geist-latin-wght-normal.woff2',
  'geist-latin-wght-italic.woff2',
  'source-serif-4-latin-wght-normal.woff2',
  'source-serif-4-latin-wght-italic.woff2',
];

// Imported per test, so a missing script fails each test on its own.
const load = () => import('../../scripts/vendor-assets.mjs');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('vendor: copies are byte-identical to node_modules', async () => {
  const { VENDOR } = await load();
  assert.ok(VENDOR.length >= 16, `expected at least 16 entries, got ${VENDOR.length}`);
  for (const { from, to } of VENDOR) {
    const src = join(REPO, 'node_modules', from);
    const dst = join(STATIC, to);
    assert.ok(existsSync(dst), `missing vendored file ${to}`);
    assert.equal(sha256(dst), sha256(src), `${to} differs from node_modules/${from}`);
  }
});

test('vendor: fonts are latin woff2 under 200 KB with their OFL text', async () => {
  const { VENDOR } = await load();
  let total = 0;
  for (const name of FONTS) {
    assert.ok(VENDOR.some((e) => e.to === `fonts/${name}`), `${name} is not in VENDOR`);
    const path = join(STATIC, 'fonts', name);
    total += statSync(path).size;
    assert.equal(readFileSync(path).subarray(0, 4).toString('latin1'), 'wOF2', `${name} is not woff2`);
  }
  assert.ok(total < 204800, `fonts total ${total} B, budget 204800 B`);
  for (const ofl of ['OFL-geist.txt', 'OFL-source-serif-4.txt']) {
    assert.match(readFileSync(join(STATIC, 'fonts', ofl), 'utf8'), /SIL OPEN FONT LICENSE/i, ofl);
  }
});

test('vendor: stale files are removed, minisearch kept', async () => {
  const { vendor, VENDOR } = await load();
  const root = mkdtempSync(join(tmpdir(), 'rf-vendor-'));
  try {
    const staticCopy = join(root, 'backend', 'app', 'static');
    cpSync(STATIC, staticCopy, { recursive: true });
    symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'), 'dir');
    mkdirSync(join(staticCopy, 'js', 'vendor', 'basecoat'), { recursive: true });
    writeFileSync(join(staticCopy, 'js', 'vendor', 'basecoat', 'old.js'), '// stale\n');
    const result = vendor(root);
    assert.equal(result.copied, VENDOR.length);
    assert.ok(result.bytes > 0);
    assert.ok(!existsSync(join(staticCopy, 'js', 'vendor', 'basecoat', 'old.js')), 'old.js survived');
    assert.ok(existsSync(join(staticCopy, 'js', 'vendor', 'minisearch.js')), 'minisearch.js was removed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grayLiterals } from '../../scripts/check-css-vars.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('css-vars: literal fails, var and @supports fallback pass', () => {
  assert.deepEqual(grayLiterals('.text-gray-500{color:#6b7280}').failures, [{ selector: '.text-gray-500', value: '#6b7280' }]);
  const plain = grayLiterals('.bg-gray-100{background-color:var(--color-gray-100)}');
  assert.deepEqual(plain.failures, []);
  assert.equal(plain.checked, 1);
  const op = grayLiterals('.bg-gray-50\\/50{background-color:#f9fafb80}@supports (color:color-mix(in lab, red, red)){.bg-gray-50\\/50{background-color:color-mix(in oklab,var(--color-gray-50) 50%,transparent)}}');
  assert.deepEqual(op.failures, []);
  assert.equal(op.fallbacks, 1);
});

test('css-vars: a scratch build of input.css passes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-vars-'));
  try {
    const out = join(dir, 'tw.css');
    execFileSync(join(REPO, 'node_modules', '.bin', 'tailwindcss'), ['-i', 'input.css', '-o', out, '--minify'], { cwd: REPO, stdio: 'pipe' });
    const r = grayLiterals(readFileSync(out, 'utf8'));
    assert.equal(r.failures.length, 0, JSON.stringify(r.failures.slice(0, 5)));
    assert.ok(r.checked > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

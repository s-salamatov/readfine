// check-tw4-classes: guards the Tailwind 3 -> 4 class renames in templates, JS and Python strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyHits, renameMismatches } from '../../scripts/check-tw4-classes.mjs';

test('tw4-classes: legacy class in a JS selector is reported', () => {
  const hits = legacyHits([{ path: 'a.js', text: "x.querySelector('.flex-shrink-0.pt-2')" }]);
  assert.deepEqual(hits, [{ path: 'a.js', line: 1, token: 'flex-shrink-0' }]);
});

test('tw4-classes: legacy class in a Python string is reported, English prose is not', () => {
  const text = [
    `f'<svg class="w-5 animate-spin flex-shrink-0">'`,
    '"""a score rounded to a whole number"""',
    'class="rounded-full" style="flex-shrink:0"',
  ].join('\n');
  const hits = legacyHits([{ path: 'a.py', text }]);
  assert.deepEqual(hits, [{ path: 'a.py', line: 1, token: 'flex-shrink-0' }]);
});

test('tw4-classes: base-relative rename counts', () => {
  const base = 'class="rounded rounded-sm shadow focus:outline-none"';
  const ok = renameMismatches([{ path: 'a.html', base, head: 'class="rounded-sm rounded-xs shadow-sm focus:outline-hidden"' }]);
  assert.deepEqual(ok, []);
  const bad = renameMismatches([{ path: 'a.html', base, head: 'class="rounded-sm rounded-sm shadow-sm focus:outline-hidden"' }]);
  assert.ok(bad.some((m) => m.token === 'rounded-xs' && m.expected === 1 && m.found === 0), JSON.stringify(bad));
});

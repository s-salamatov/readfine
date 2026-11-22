// check-tw4-classes: guards the Tailwind 3 -> 4 class renames in templates, JS and Python strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
  legacyHits, renameMismatches, hiddenDisplayHits, HIDDEN_LOSES_TO, displayAfterHidden, displayAll,
} from '../../scripts/check-tw4-classes.mjs';

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

test('tw4-classes: an unknown --base revision exits non-zero', () => {
  const script = fileURLToPath(new URL('../../scripts/check-tw4-classes.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, '--base', 'nosuchrev-t7', '--roots', 'js'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /unknown base revision nosuchrev-t7/);
});

test('tw4-classes: base-relative rename counts', () => {
  const base = 'class="rounded rounded-sm shadow focus:outline-none"';
  const ok = renameMismatches([{ path: 'a.html', base, head: 'class="rounded-sm rounded-xs shadow-sm focus:outline-hidden"' }]);
  assert.deepEqual(ok, []);
  const bad = renameMismatches([{ path: 'a.html', base, head: 'class="rounded-sm rounded-sm shadow-sm focus:outline-hidden"' }]);
  assert.ok(bad.some((m) => m.token === 'rounded-xs' && m.expected === 1 && m.found === 0), JSON.stringify(bad));
});

test('tw4-classes: hidden with a display utility fails', () => {
  // v4 emits .hidden after .block/.contents/.flex/.grid but before .inline, .inline-block,
  // .inline-flex and .table, so only the latter win over `hidden` on one element.
  const css = fs.readFileSync(new URL('../../backend/app/static/css/tailwind.css', import.meta.url), 'utf8');
  const at = (c) => css.indexOf(`.${c}{display:`);
  for (const c of HIDDEN_LOSES_TO) assert.ok(at(c) > at('hidden'), `.${c} must come after .hidden`);
  for (const c of ['block', 'contents', 'flex', 'grid']) assert.ok(at(c) >= 0 && at(c) < at('hidden'), `.${c} must come before .hidden`);

  const bad = [
    { path: 'a.html', text: '<span data-x\n      class="shrink-0 {% if not m.read %}hidden {% endif %}inline-flex gap-1">' },
    { path: 'b.js', text: `var a = '<span class="shrink-0 hidden inline-flex">';\nvar b = 'inline-block hidden';` },
    { path: 'c.py', text: `x = 1\nhtml = f'<p class="{cls} hidden table">{body}</p>'` },
  ];
  assert.deepEqual(hiddenDisplayHits(bad).map((h) => `${h.path}:${h.line}`), ['a.html:2', 'b.js:1', 'b.js:2', 'c.py:2']);

  const good = [
    { path: 'a.html', text: [
      '<span class="shrink-0 {% if m.read %}inline-flex{% else %}hidden{% endif %} gap-1">',
      '<div class="hidden sm:flex md:inline-flex" aria-hidden="true">',
      '<div class="hidden flex overflow-hidden">',
    ].join('\n') },
    { path: 'b.js', text: [
      "el.className = 'a ' + (c ? 'hidden' : 'inline-flex');",
      "mark.classList.toggle('hidden', !r); mark.classList.toggle('inline-flex', r);",
      "// a hidden 'inline-flex' note in a comment",
      "msg('the inline element stays hidden until the list is unfolded');",
    ].join('\n') },
    { path: 'c.py', text: `"""An inline note, hidden from the reader."""\nhtml = f'<p class="{"hidden" if x else "inline"} block">'` },
  ];
  assert.deepEqual(hiddenDisplayHits(good), []);
});

test('tw4-classes: display utilities after .hidden come from the built CSS', () => {
  // Derived from the build, so a utility v4 emits after .hidden is caught without a list edit.
  const css = '.block{display:block}.hidden{display:none}.inline-grid{display:inline-grid}'
    + '.table-cell{display:table-cell}@media (min-width:640px){.sm\\:flex{display:flex}}';
  const after = displayAfterHidden(css);
  assert.deepEqual(after, ['inline-grid', 'table-cell']);
  assert.deepEqual(displayAll(css), ['block', 'inline-grid', 'table-cell']);
  const hits = hiddenDisplayHits([{ path: 'a.html', text: '<span class="hidden inline-grid">' }], after);
  assert.equal(hits.length, 1);
});

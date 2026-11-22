// Box comparison, allow-list merge and report of the visual layout mode
// (tests/visual/layout.mjs). The module is imported per test, so a missing export
// fails each test on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const layout = () => import('../visual/layout.mjs');

const BOXES = [
  { key: '#sidebar', x: 0, y: 0, w: 256, h: 800 },
  { key: '#article-list', x: 256, y: 0, w: 400, h: 800 },
  { key: '.article-row[0]', x: 256, y: 48, w: 400, h: 72 },
];

test('layout: equal boxes pass, a 1 px move fails strict and passes structural tolerance', async () => {
  const { compareBoxes } = await layout();
  const same = compareBoxes(BOXES, structuredClone(BOXES), { tolerance: 0.5 });
  assert.deepEqual(same, { missing: [], extra: [], moved: [] });

  const head = structuredClone(BOXES);
  head[1].x += 1; // the list pane slides 1 px right
  const strict = compareBoxes(BOXES, head, { tolerance: 0.5 });
  assert.deepEqual(strict.moved, [{ key: '#article-list', dx: 1, dy: 0, dw: 0, dh: 0 }]);

  const structural = compareBoxes(BOXES, head, { tolerance: 1, keys: ['#sidebar', '#article-list'] });
  assert.deepEqual(structural.moved, []);
  // Pass B checks x and width only (bar heights opt in): a 5 px height change is reflow.
  head[0].h += 5;
  const xw = compareBoxes(BOXES, head, { tolerance: 1, keys: [{ key: '#sidebar', fields: ['x', 'w'] }] });
  assert.deepEqual(xw.moved, []);
  const bar = compareBoxes(BOXES, head, { tolerance: 1, keys: [{ key: '#sidebar', fields: ['x', 'w', 'h'] }] });
  assert.deepEqual(bar.moved.map((m) => m.key), ['#sidebar']);
});

test('layout: missing and extra keys are reported', async () => {
  const { compareBoxes, formatLayoutReport } = await layout();
  const head = [BOXES[0], { key: '#new-panel', x: 0, y: 0, w: 10, h: 10 }, BOXES[2]];
  const r = compareBoxes(BOXES, head, { tolerance: 0.5 });
  assert.deepEqual(r.missing, ['#article-list']);
  assert.deepEqual(r.extra, ['#new-panel']);
  assert.deepEqual(r.moved, []);
  // Restricted to structural keys, a key outside the list is neither missing nor extra.
  const s = compareBoxes(BOXES, head, { tolerance: 1, keys: ['#sidebar'] });
  assert.deepEqual(s, { missing: [], extra: [], moved: [] });

  const { lines, failed } = formatLayoutReport([
    { pass: 'A', screen: 'list', job: 'list@1280-light', ...r },
  ], []);
  assert.equal(failed, 1);
  assert.ok(lines.some((l) => /missing.*#article-list/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /extra.*#new-panel/.test(l)), lines.join('\n'));
  assert.equal(lines.at(-1), 'layout: A 0/1 strict, B 0/0 structural');
});

test('layout: allow-list entries from several files merge; "*" exempts a screen; each is named in the report', async () => {
  const { loadAllow, formatLayoutReport } = await layout();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-layout-allow-'));
  try {
    fs.writeFileSync(path.join(dir, 's2-T10.json'), JSON.stringify([
      { screen: 'settings-preferences', key: '#offline-section', reason: 'below the theme radios' },
    ]));
    fs.writeFileSync(path.join(dir, 's2-T19.json'), JSON.stringify([
      { screen: 'login', key: '*', reason: 'login restyled through the macros' },
    ]));
    fs.writeFileSync(path.join(dir, 'README.md'), 'not an allow file');
    const allow = loadAllow(dir);
    assert.deepEqual(allow.map((a) => `${a.file}:${a.screen}:${a.key}`).sort(),
      ['s2-T10.json:settings-preferences:#offline-section', 's2-T19.json:login:*']);

    const moved = (key) => ({ missing: [], extra: [], moved: [{ key, dx: 0, dy: 12, dw: 0, dh: 0 }] });
    const results = [
      { pass: 'A', screen: 'settings-preferences', job: 'settings-preferences@1280-light', ...moved('#offline-section') },
      { pass: 'A', screen: 'login', job: 'login@1280-light', missing: ['#email'], extra: [], moved: [] },
      { pass: 'B', screen: 'login', job: 'login@1280-light', ...moved('#login-card') },
      { pass: 'A', screen: 'list', job: 'list@1280-light', ...moved('#sidebar') },
      { pass: 'B', screen: 'list', job: 'list@1280-light', missing: [], extra: [], moved: [], reflow: [{ key: '#x', dx: 0, dy: 3, dw: 0, dh: 0 }] },
    ];
    const { lines, failed } = formatLayoutReport(results, allow);
    const text = lines.join('\n');
    assert.equal(failed, 1, text); // only list pass A
    assert.match(text, /exempt.*#offline-section.*s2-T10\.json.*below the theme radios/);
    assert.match(text, /exempt.*login.*\*.*s2-T19\.json.*login restyled through the macros/);
    assert.match(text, /reflow.*#x/);
    assert.equal(lines.at(-1), 'layout: A 2/3 strict, B 2/2 structural');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The pixel diff and the report of the base-vs-head key-screen harness (tests/visual).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffRgba, formatReport } from '../visual/diff.mjs';

test('diff: identical and within-tolerance pixels do not count', () => {
  const a = new Uint8ClampedArray(16).fill(100);
  const b = new Uint8ClampedArray(a);
  assert.deepEqual(diffRgba(a, b, 2, 2), { pixels: 0, ratio: 0 });
  b[5] = 103; // one channel of one pixel, off by exactly the tolerance
  assert.deepEqual(diffRgba(a, b, 2, 2), { pixels: 0, ratio: 0 });
  b[5] = 104;
  assert.deepEqual(diffRgba(a, b, 2, 2), { pixels: 1, ratio: 0.25 });
});

test('report: threshold, size mismatch and summary line', () => {
  const { lines, failed } = formatReport([
    { screen: 'list@1280-dark', pixels: 0, ratio: 0 },
    { screen: 'article@390-light', pixels: 900, ratio: 0.002 },
    { screen: 'help@1280-light', sizeMismatch: true },
  ]);
  assert.equal(failed, 2);
  assert.equal(lines[0], 'visual  list@1280-dark  0.0000%  (0 px)  ok');
  assert.match(lines[1], /^visual {2}article@390-light {2}0\.2000% {2}\(900 px\) {2}FAIL$/);
  assert.match(lines[2], / FAIL$/);
  assert.equal(lines.at(-1), 'visual: 1/3 screens within 0.1% (max 100.0000%)');
});

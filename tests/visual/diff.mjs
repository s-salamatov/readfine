// Pixel diff and report for the base-vs-head key-screen harness (tests/visual/run.mjs).

// A pixel differs when any RGBA channel differs by more than `tolerance`.
// Self-contained (no outer references): the spec evaluates it in the page through
// diffRgba.toString().
export function diffRgba(a, b, width, height, tolerance = 3) {
  const total = width * height;
  let pixels = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    if (Math.abs(a[o] - b[o]) > tolerance || Math.abs(a[o + 1] - b[o + 1]) > tolerance
      || Math.abs(a[o + 2] - b[o + 2]) > tolerance || Math.abs(a[o + 3] - b[o + 3]) > tolerance) pixels++;
  }
  return { pixels, ratio: total ? pixels / total : 0 };
}

const pct = (ratio) => `${(ratio * 100).toFixed(4)}%`;

// results: [{ screen, width, height, pixels, ratio, sizeMismatch? }]. A size mismatch
// counts as ratio 1. The last line is the summary.
export function formatReport(results, threshold = 0.001) {
  let failed = 0;
  let max = 0;
  const lines = results.map((r) => {
    const ratio = r.sizeMismatch ? 1 : r.ratio;
    const ok = ratio <= threshold;
    if (!ok) failed++;
    max = Math.max(max, ratio);
    return `visual  ${r.screen}  ${pct(ratio)}  (${r.pixels ?? 0} px)  ${ok ? 'ok' : 'FAIL'}`;
  });
  lines.push(`visual: ${results.length - failed}/${results.length} screens within ${threshold * 100}% (max ${pct(max)})`);
  return { lines, failed };
}

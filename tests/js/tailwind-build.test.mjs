// Builds the repo's input.css with the Tailwind 4 CLI (through scripts/build-css.mjs, as
// `npm run build` does) into a scratch dir and checks the sources, the v3 compatibility
// layer and the layering. Nothing here touches the committed
// backend/app/static/css/tailwind.css.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCss } from '../../scripts/build-css.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch = [];

const squash = (s) => s.replace(/\s+/g, '');
const build = (cwd, out) => {
  buildCss({ cwd, out });
  return squash(readFileSync(out, 'utf8'));
};

// input.css imports ./styles/*.css (tokens, motion), so a scratch root needs both.
const copyInput = (root) => {
  copyFileSync(join(REPO, 'input.css'), join(root, 'input.css'));
  cpSync(join(REPO, 'styles'), join(root, 'styles'), { recursive: true });
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'));
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
  copyInput(root);
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
  // The v3 palette lives in styles/tokens.css now; the build still emits its values.
  assert.ok(!readFileSync(join(REPO, 'input.css'), 'utf8').includes('--color-gray-100:'), 'palette moved out of input.css');
  assert.ok(readFileSync(join(REPO, 'styles/tokens.css'), 'utf8').includes('--color-gray-100: #f3f4f6;'), 'palette in tokens.css');
  for (const needle of ['--color-gray-100:#f3f4f6', '--color-gray-800:#1f2937', '--color-blue-500:#3b82f6', '--color-red-600:#dc2626']) {
    assert.ok(repoCss.includes(needle), needle);
  }
  assert.ok(repoCss.includes('.dark\\:bg-gray-800:is(.dark*)'), 'dark variant selector');
  // No hover media wrapper on our utilities. Basecoat's vega.css writes one literal
  // @media (hover: hover) block, for its range-slider thumb; that one is allowed.
  const hoverMedia = [...repoCss.matchAll(/@media\(hover:hover\)\{/g)].map((m) => repoCss.slice(m.index + m[0].length, m.index + m[0].length + 30));
  assert.deepEqual(hoverMedia.filter((s) => !s.startsWith(':is(.field>input[type=range]')), [], 'no hover media wrapper');
  assert.ok(repoCss.includes('.hover\\:bg-gray-100:hover{'), 'plain hover');
  const ring = repoCss.slice(repoCss.indexOf('.focus\\:ring-2:focus'));
  const ringRule = ring.slice(0, ring.indexOf('}') + 1);
  assert.ok(ringRule.includes('calc(2px'), ringRule);
  assert.ok(repoCss.includes('var(--color-blue-500)50%'), 'ring default colour');
  assert.ok(repoCss.includes('@keyframeschat-bounce'));
  assert.ok(repoCss.includes('.animate-chat-bounce{animation:var(--animate-chat-bounce)}'));
});

test('compat: v3 line heights, form backgrounds and space margins', () => {
  // text-xs keeps its v3 absolute line height: a ratio would move rows when only the font size changes.
  assert.ok(repoCss.includes('--text-xs--line-height:1rem'), 'text-xs line height is 1rem');
  assert.ok(repoCss.includes('--text-sm--line-height:1.25rem'), 'text-sm line height is 1.25rem');
  assert.ok(repoCss.includes('--text-2xl--line-height:2rem'), 'text-2xl line height is 2rem');
  // Preflight makes form controls transparent; the compat layer hands inputs, selects and
  // textareas back to the browser background (the minifier writes transparent as #0000).
  assert.match(repoCss, /(^|[}\s])input:not\([^)]*\),select,textarea\{background-color:revert-layer\}/);
  // peer-checked / group-open count the .peer / .group class in their specificity, as in v3.
  assert.ok(repoCss.includes('.peer-checked\\:border-primary:is(.peer:checked~*){'), 'peer-checked v3 specificity');
  assert.ok(repoCss.includes(':is(.group[open]*){'), 'group-open v3 specificity');
  // Table cells keep the browser's 1px padding that v3 preflight left alone.
  assert.match(repoCss, /(^|[}\s])td,th\{padding:1px\}/);
  // space-y-2 is the v3 rule: top margin on every later sibling, same selector.
  const m = repoCss.match(/\.space-y-2>:not\(\[hidden\]\)~:not\(\[hidden\]\)\{([^}]*)\}/);
  assert.ok(m, 'v3 selector for space-y-2');
  assert.match(m[1], /margin-top:calc\(var\(--spacing\)\*2\*\(1-var\(--tw-space-y-reverse,0\)\)\)/);
  assert.match(m[1], /margin-bottom:calc\(var\(--spacing\)\*2\*var\(--tw-space-y-reverse,0\)\)/);
  // divide-y is the v3 rule too.
  assert.match(repoCss, /\.divide-y>:not\(\[hidden\]\)~:not\(\[hidden\]\)\{[^}]*border-top-width:calc\(1px\*\(1-var\(--tw-divide-y-reverse,0\)\)\)/);
});

test('compat: every space-* / divide-* variant has a v3-form rule', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-space-'));
  scratch.push(root);
  copyInput(root);
  mkdirSync(join(root, 'backend/app/templates'), { recursive: true });
  const classes = ['-space-y-1', 'space-y-px', '-space-x-2', 'space-x-px', 'space-y-reverse',
    'divide-y-2', 'divide-y-4', 'divide-x', 'divide-x-2', 'divide-x-reverse', 'divide-gray-200'];
  writeFileSync(join(root, 'backend/app/templates/p.html'), `<div class="${classes.join(' ')}"></div>\n`);
  const css = build(root, join(root, 'tw.css'));
  // Tailwind's own rule for each class: :where(.cls>:not(:last-child)){...}. The reset at the
  // end of the utilities layer cancels it, so the v3-form rule must carry the value instead.
  const v4 = [...css.matchAll(/:where\(\.(-?(?:space|divide)-[^>{]+)>:not\(:last-child\)\)\{/g)].map((m) => m[1]);
  for (const cls of classes.filter((c) => !c.endsWith('reverse'))) assert.ok(v4.includes(cls), `probe emits v4 rule for ${cls}`);
  for (const cls of classes) {
    assert.ok(css.includes(`.${cls}>:not([hidden])~:not([hidden]){`), `v3-form rule for ${cls}`);
  }
  // Widths: the emitted v3 rule for each width utility carries a width (not only a colour).
  for (const cls of classes.filter((c) => /space-|divide-[xy]/.test(c) && !c.endsWith('reverse'))) {
    const rule = css.match(new RegExp(`\\.${cls}>:not\\(\\[hidden\\]\\)~:not\\(\\[hidden\\]\\)\\{([^}]*)\\}`))[1];
    assert.match(rule, /(margin|border)-(top|bottom|left|right)(-width)?:/, `${cls}: ${rule}`);
  }
  // The reset also takes v4's divide colour off the first child, which v3 never coloured.
  assert.match(css, /:where\(\[class\*="?divide-"?\]\)>\*\{[^}]*border-color:revert-layer/);
  assert.match(css, /:where\(\[class\*="?divide-x"?\]\)>\*\{border-inline-width:0\}/);
});

test('compat: file selector button keeps the user-agent background', () => {
  assert.match(repoCss, /::file-selector-button\{background-color:revert-layer\}/);
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

test('compat: hand-written rules use tokens', () => {
  // WR2-F5: the hand-written rules read their colours from styles/tokens.css, so the
  // theme remap reaches them.
  const rule = (sel) => {
    const i = repoCss.indexOf(sel);
    assert.ok(i >= 0, `${sel} is in the build`);
    return repoCss.slice(i, repoCss.indexOf('}', i) + 1);
  };
  for (const sel of ['.story-chip{', '.article-row:hover{', '.feature-desccode{']) {
    assert.ok(rule(sel).includes('var(--'), rule(sel));
  }
  const src = readFileSync(join(REPO, 'input.css'), 'utf8');
  const custom = src.slice(src.indexOf('@layer utilities {')).replace(/\/\*[\s\S]*?\*\//g, '');
  const literals = custom.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/g) ?? [];
  assert.deepEqual(literals, [], 'no colour literal in the custom rules of input.css');
});

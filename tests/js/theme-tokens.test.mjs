// Checks styles/tokens.css (the six theme blocks and the legacy literal table) and a
// scratch build of input.css with Basecoat's selective import and the fonts, against a
// second scratch build without the Basecoat imports. Nothing here touches the committed
// backend/app/static/css/tailwind.css; it is only read, as the reference for the
// utilities that must survive the import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { colourHits, sourceFiles } from '../../scripts/check-colours.mjs';
import { buildCss } from '../../scripts/build-css.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKENS = join(REPO, 'styles', 'tokens.css');
const COMMITTED = join(REPO, 'backend', 'app', 'static', 'css', 'tailwind.css');

// Built through scripts/build-css.mjs, as `npm run build` does: the raw --minify output
// differs in a few percent of processes (plan amendment 27).
let built;
function scratchBuild() {
  if (built === undefined) built = buildCss({ cwd: REPO });
  return built;
}

// Any @import line that names basecoat-css: quoted or url(...), with leading whitespace.
const BASECOAT_IMPORT = /^\s*@import\s[^;]*\bbasecoat-css\b/;

// The same build with the Basecoat @import lines removed: the selectors that are not
// Basecoat's (Tailwind's preflight, Readfine's own CSS). Fed on stdin with cwd at the
// repo, so the relative @import / @source / @plugin paths resolve as for input.css.
// The fragile-rule check is off: those rules are Basecoat's.
let baseline;
function baselineBuild() {
  if (baseline === undefined) {
    const lines = readFileSync(join(REPO, 'input.css'), 'utf8').split('\n');
    const kept = lines.filter((l) => !BASECOAT_IMPORT.test(l));
    assert.ok(lines.length > kept.length, 'no Basecoat @import was removed from input.css');
    assert.ok(lines.length - kept.length >= 20, `input.css imports Basecoat line by line (${lines.length - kept.length} lines)`);
    baseline = buildCss({ cwd: REPO, input: '-', stdin: kept.join('\n'), check: false });
    assert.doesNotMatch(baseline, /\.btn[:{,]/, 'the baseline build has no Basecoat component CSS');
  }
  return baseline;
}

test('basecoat: the baseline strips every @import form that names basecoat-css (T38-R1)', () => {
  for (const l of ['@import "basecoat-css/components/tabs.css";', "  @import 'basecoat-css/styles/vega.css';",
    '@import url("basecoat-css/components/card.css");', '\t@import url(basecoat-css/components/kbd.css) layer(components);']) {
    assert.ok(BASECOAT_IMPORT.test(l), l);
  }
  for (const l of ['@import "tailwindcss";', '@import "./styles/tokens.css";', '/* basecoat-css */', '@plugin "@tailwindcss/typography";']) {
    assert.ok(!BASECOAT_IMPORT.test(l), l);
  }
});

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

// Top-level rules of minified CSS as { selectors: [...], decls: [...] }, descending into
// at-rules that wrap other rules (@layer, @media, @supports).
function rules(css) {
  const out = [];
  const stack = [];
  let start = 0;
  let quote = null;
  const text = stripComments(css);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') { stack.push({ prelude: text.slice(start, i).trim(), child: false }); start = i + 1; }
    else if (ch === '}') {
      const node = stack.pop();
      if (node && !node.child && node.prelude && !node.prelude.startsWith('@')) {
        out.push({ selectors: splitTop(node.prelude), decls: text.slice(start, i).split(';').map((d) => d.trim()).filter(Boolean) });
      }
      if (stack.length) stack[stack.length - 1].child = true;
      start = i + 1;
    } else if (ch === ';' && !stack.length) start = i + 1;
  }
  return out;
}

// Splits a selector list on commas outside brackets and parentheses.
function splitTop(list) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Custom-property blocks of tokens.css keyed by their normalised selector list.
function tokenBlocks(text) {
  const blocks = new Map();
  for (const m of stripComments(text).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    const decls = blocks.get(selector) ?? new Map();
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0 && d.trim().startsWith('--')) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
    blocks.set(selector, decls);
  }
  return blocks;
}

const SHADCN = ['--background', '--foreground', '--card', '--card-foreground', '--popover', '--popover-foreground',
  '--primary', '--primary-foreground', '--secondary', '--secondary-foreground', '--muted', '--muted-foreground',
  '--accent', '--accent-foreground', '--destructive', '--border', '--input', '--ring', '--sidebar',
  '--sidebar-foreground', '--sidebar-primary', '--sidebar-primary-foreground', '--sidebar-accent',
  '--sidebar-accent-foreground', '--sidebar-border', '--sidebar-ring'];
const RF = ['--rf-unread', '--rf-star', '--rf-ok', '--rf-warn'];
const GRAY = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'].map((n) => `--color-gray-${n}`);
const LIGHT = [':root, html[data-rf-theme="neutral"]', 'html[data-rf-theme="paper"]', 'html[data-rf-theme="graphite"]'];
const DARK = ['html.dark, html.dark[data-rf-theme="neutral"]', 'html.dark[data-rf-theme="paper"]', 'html.dark[data-rf-theme="graphite"]'];
const HEX = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;

test('tokens: six theme blocks define the full set; --background is hex', () => {
  const blocks = tokenBlocks(readFileSync(TOKENS, 'utf8'));
  for (const sel of [...LIGHT, ...DARK]) {
    const decls = blocks.get(sel);
    assert.ok(decls, `block ${sel}`);
    for (const name of [...SHADCN, ...RF, ...GRAY]) assert.ok(decls.has(name), `${sel} defines ${name}`);
    assert.match(decls.get('--background'), /^#[0-9a-f]{6}$/i, `${sel} --background`);
    for (const name of GRAY) assert.match(decls.get(name), /^#[0-9a-f]{6}$/i, `${sel} ${name} is hex`);
  }
  // A token set in a Paper or Graphite light block also applies under .dark (same
  // specificity as html.dark, declared later), so every block carries the same names;
  // the legacy dark family lives in the dark blocks only, as hex.
  // (--radius is the one exception: Graphite sets it once, for both schemes.)
  const names = (sel) => [...blocks.get(sel).keys()].filter((n) => !n.startsWith('--rf-legacy-dark-') && n !== '--radius').sort();
  for (const sel of [...LIGHT, ...DARK]) assert.deepEqual(names(sel), names(LIGHT[0]), `${sel} has the same token names`);
  const legacy = (sel) => [...blocks.get(sel).keys()].filter((n) => n.startsWith('--rf-legacy-dark-')).sort();
  assert.ok(legacy(DARK[0]).length > 20, 'legacy dark family present');
  for (const sel of DARK) {
    assert.deepEqual(legacy(sel), legacy(DARK[0]), `${sel} legacy dark set`);
    for (const n of legacy(sel)) assert.match(blocks.get(sel).get(n), HEX, `${sel} ${n} is hex`);
  }
  for (const sel of LIGHT) assert.deepEqual(legacy(sel), [], `${sel} has no legacy dark tokens`);
  // Q1: one gray scale per theme, in light and dark alike.
  for (let i = 0; i < 3; i++) {
    for (const g of GRAY) assert.equal(blocks.get(DARK[i]).get(g), blocks.get(LIGHT[i]).get(g), `${DARK[i]} ${g}`);
  }
});

// WCAG relative luminance of a #rrggbb colour.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// The legacy dark greys, darkest first (today's Neutral literals in this order).
const LADDER = ['bg', 'panel', 'tint', 'raised', 'active', 'edge-soft', 'edge', 'edge-mid', 'fill-1', 'fill-2',
  'edge-strong', 'fill-3', 'text-faint', 'text-muted', 'text-soft', 'text-2', 'text-active', 'text-1', 'text']
  .map((n) => `--rf-legacy-dark-${n}`);

test('tokens: one dark page colour; --rf-legacy-dark-bg is --background (decision-76d1d898)', () => {
  const blocks = tokenBlocks(readFileSync(TOKENS, 'utf8'));
  assert.equal(blocks.get(DARK[0]).get('--background'), '#141414', 'Neutral dark --background is today\'s page');
  for (const sel of DARK) {
    const d = blocks.get(sel);
    const bg = d.get('--rf-legacy-dark-bg');
    assert.ok(bg === 'var(--background)' || bg.toLowerCase() === d.get('--background').toLowerCase(),
      `${sel} --rf-legacy-dark-bg (${bg}) equals --background (${d.get('--background')})`);
  }
  // base.html's page literal maps to --background, not to a legacy token.
  const table = literalMap(readFileSync(TOKENS, 'utf8'));
  const page = table.find((r) => r.literal === '#141414' && r.files.includes('base.html'));
  assert.equal(page?.token, '--background', 'base.html #141414 → --background');
  const bar = table.find((r) => r.literal === '#f9fafb' && r.files.includes('base.html'));
  assert.equal(bar?.token, '--background', 'base.html #f9fafb (mobile bars, theme-color) → --background');
});

test('tokens: dark legacy greys keep surfaces apart and stay monotonic (decision-76d1d898)', () => {
  const blocks = tokenBlocks(readFileSync(TOKENS, 'utf8'));
  for (const sel of DARK) {
    const d = blocks.get(sel);
    const v = (n) => (n === '--rf-legacy-dark-bg' && d.get(n) === 'var(--background)' ? d.get('--background') : d.get(n)).toLowerCase();
    const [bg, panel, tint, raised] = ['bg', 'panel', 'tint', 'raised'].map((n) => v(`--rf-legacy-dark-${n}`));
    for (const [a, b, what] of [[bg, panel, 'bg/panel'], [bg, raised, 'bg/raised'], [panel, raised, 'panel/raised'],
      [bg, tint, 'bg/tint'], [panel, tint, 'panel/tint']]) assert.notEqual(a, b, `${sel} ${what} differ`);
    assert.notEqual(d.get('--rf-row-hover'), d.get('--rf-row-open'), `${sel} --rf-row-hover ≠ --rf-row-open`);
    // The chip outline and the story band are drawn on rows, open or hovered ones included.
    for (const line of ['--rf-chip-border', '--rf-chip-hover-border', '--rf-story-top']) {
      for (const row of ['--rf-row-hover', '--rf-row-open']) assert.notEqual(d.get(line), d.get(row), `${sel} ${line} ≠ ${row}`);
    }
    assert.notEqual(d.get('--rf-chip-border'), d.get('--rf-chip-hover-border'), `${sel} chip border changes on hover`);
    const lum = LADDER.map((n) => [n, luminance(v(n))]);
    for (let i = 1; i < lum.length; i++) {
      assert.ok(lum[i][1] >= lum[i - 1][1], `${sel} ${lum[i][0]} is not darker than ${lum[i - 1][0]}`);
    }
    // bg < panel < raised strictly, so the page, panels and raised surfaces read as layers.
    assert.ok(luminance(bg) < luminance(panel) && luminance(panel) < luminance(raised), `${sel} bg < panel < raised`);
  }
});

// A token's value within one block, with var() references to the block's own tokens
// resolved; a light Paper/Graphite block falls back to the Neutral light block (:root),
// a dark one to the Neutral dark block and then :root, as in the cascade.
function resolveIn(blocks, sel, value) {
  const chain = [sel];
  if (DARK.includes(sel) && sel !== DARK[0]) chain.push(DARK[0]);
  if (DARK.includes(sel)) chain.push(LIGHT[0]);
  else if (sel !== LIGHT[0]) chain.push(LIGHT[0]);
  for (let i = 0; i < 10; i++) {
    const m = value.match(/^var\((--[\w-]+)\)$/);
    if (!m) return value.toLowerCase();
    const owner = chain.find((s) => blocks.get(s).has(m[1]));
    if (!owner) return value;
    value = blocks.get(owner).get(m[1]);
  }
  return value;
}

test('tokens: the story band differs from the row fills in every theme and scheme (T28-9)', () => {
  const blocks = tokenBlocks(readFileSync(TOKENS, 'utf8'));
  for (const sel of [...LIGHT, ...DARK]) {
    const v = (n) => resolveIn(blocks, sel, blocks.get(sel).get(n));
    for (const row of ['--rf-row-hover', '--rf-row-open']) {
      assert.notEqual(v('--rf-story-top'), v(row), `${sel} --rf-story-top (${v('--rf-story-top')}) ≠ ${row} (${v(row)})`);
    }
  }
  // Light rows are white at rest and --rf-row-hover under the pointer: the band is a step
  // darker than the hover fill, as Neutral's #eef0f3 is against #f5f5f5.
  for (const sel of LIGHT) {
    const v = (n) => resolveIn(blocks, sel, blocks.get(sel).get(n));
    assert.ok(luminance(v('--rf-story-top')) < luminance(v('--rf-row-hover')), `${sel} band darker than hover`);
  }
  assert.equal(blocks.get(LIGHT[0]).get('--rf-story-top'), '#eef0f3', 'Neutral light band unchanged');
});

test('tokens: story divide differs from row open/hover/top in every theme and scheme', () => {
  const blocks = tokenBlocks(readFileSync(TOKENS, 'utf8'));
  // The divide lines the members of an unfolded story, rows that can be hovered or open
  // and sit under the story band: a divide equal to any of them disappears there.
  for (const sel of [...LIGHT, ...DARK]) {
    const v = (n) => resolveIn(blocks, sel, blocks.get(sel).get(n));
    for (const other of ['--rf-row-open', '--rf-row-hover', '--rf-story-top']) {
      assert.notEqual(v('--rf-story-divide'), v(other), `${sel} --rf-story-divide (${v('--rf-story-divide')}) ≠ ${other} (${v(other)})`);
    }
  }
  // Dark keeps Neutral's ordering: hover < open < divide < top.
  for (const sel of DARK) {
    const lum = (n) => luminance(resolveIn(blocks, sel, blocks.get(sel).get(n)));
    const order = ['--rf-row-hover', '--rf-row-open', '--rf-story-divide', '--rf-story-top'];
    for (let i = 1; i < order.length; i++) {
      assert.ok(lum(order[i - 1]) < lum(order[i]), `${sel} ${order[i - 1]} darker than ${order[i]}`);
    }
  }
  assert.equal(blocks.get(LIGHT[0]).get('--rf-story-divide'), '#ecedf1', 'Neutral light divide unchanged');
  assert.equal(blocks.get(DARK[0]).get('--rf-story-divide'), '#353535', 'Neutral dark divide unchanged');
});

test('compat: the default border is scheme-aware; light keeps gray-200 (T28-3)', () => {
  // Light keeps the Tailwind 3 compat default, the theme's --color-gray-200, so its computed
  // colour does not move (Paper and Graphite light --border are other colours). Dark reads
  // the scheme-aware --border instead of the bright gray-200, through a zero-specificity
  // rule right after the default one, in the same base layer.
  const all = rules(scratchBuild());
  const idx = (pred) => all.map((r, i) => (pred(r) ? i : -1)).filter((i) => i >= 0);
  const light = idx((r) => r.decls.includes('border-color:var(--color-gray-200,currentcolor)'));
  assert.ok(light.length > 0 && light.some((i) => all[i].selectors.includes('*')), 'built * default border rule');
  for (const i of light) assert.deepEqual(all[i].decls, ['border-color:var(--color-gray-200,currentcolor)'], 'light default border unchanged');
  const dark = idx((r) => r.selectors.every((s) => s.startsWith(':where(html.dark)')) && r.decls.includes('border-color:var(--border)'));
  assert.ok(dark.length > 0, 'dark default border rule reads --border');
  assert.ok(Math.min(...dark) > Math.max(...light), 'dark default border follows the light one');
  const darkSel = new Set(dark.flatMap((i) => all[i].selectors.map((s) => s.replace(':where(html.dark)', '').trim())));
  for (const sel of light.flatMap((i) => all[i].selectors)) assert.ok(darkSel.has(sel), `dark default border covers ${sel}`);
});

test('basecoat: selective import leaves old markup alone', () => {
  const css = scratchBuild();
  const all = rules(css);
  // Selectors of the build without Basecoat (Tailwind's preflight: summary{display:list-item}) are not Basecoat's.
  const before = new Set(rules(baselineBuild()).flatMap((r) => r.selectors));
  assert.ok(before.has('summary'), 'the baseline carries the preflight summary rule');
  const bare = (re) => all.flatMap((r) => r.selectors).filter((s) => !before.has(s) && re.test(s.replace(/^:(?:is|where)\(/, '')));
  assert.deepEqual(bare(/^(?:details|summary)\b/), [], 'no bare details/summary rule (collapsible.css)');
  // tooltip.css and radio.css are not imported. styles/vega.css still carries the skin
  // of both: two [data-tooltip] pseudo-element rules that set colours and padding but no
  // content (so nothing renders without tooltip.css), and [role=radiogroup]{display:grid}.
  // Old markup uses neither attribute. Anything beyond these three is a leak.
  const attr = bare(/^\[(?:data-tooltip|role=["']?radiogroup)/);
  // Built from pieces so scripts/check-dom-contract.mjs does not read them as consumers.
  const TIP = '[' + 'data-tooltip]';
  const ARROW = '[' + 'data-arrow]';
  assert.deepEqual([...new Set(attr)].sort(), [TIP + ':before', TIP + ARROW + ':after', '[role=radiogroup]']);
  for (const r of all.filter((x) => x.selectors.some((s) => s.startsWith(TIP)))) {
    assert.ok(!r.decls.some((d) => /^(content|--tw-content):/.test(d)), `inert tooltip skin (no content): ${r.decls}`);
  }
  assert.ok(!css.includes('scroll-behavior:smooth'), 'no scroll-behavior:smooth');
  assert.ok(!css.includes('overscroll-behavior:none'), 'no overscroll-behavior:none');
  for (const r of all.filter((x) => x.selectors.includes('*'))) {
    assert.ok(!r.decls.includes('border-color:var(--color-border)'), `* border: ${r.decls}`);
    assert.ok(!r.decls.some((d) => d.startsWith('outline-color')), `* outline: ${r.decls}`);
  }
  // --radius-md = calc(var(--radius) - 2px) with --radius: .5rem, i.e. calc(.5rem - 2px):
  // Tailwind's own .375rem, so no box changes.
  assert.ok(css.includes('--radius-md:calc(var(--radius) - 2px)'), '--radius-md maps onto --radius');
  const root = all.find((r) => r.selectors.length === 1 && r.selectors[0] === ':root' && r.decls.some((d) => d.startsWith('--radius:')));
  assert.ok(root, ':root defines --radius');
  assert.ok(root.decls.includes('--radius:.5rem'), '--radius is .5rem');
});

test('basecoat: filtered menu and select items stay hidden without the bundle @apply (s2-T38)', () => {
  // Tailwind 4.3.5 drops Basecoat's `@apply aria-hidden:hidden` in about one build in
  // twenty, so input.css repeats the three rules as plain CSS in the components layer.
  // The build without Basecoat proves they come from input.css, not only from the bundle.
  // Built from pieces so scripts/check-dom-contract.mjs does not read them as consumers.
  const HID = '[' + 'aria-hidden=true]';
  const ITEM = '[' + 'role=menuitem]';
  const want = [
    '.command ' + ITEM + HID,
    '.dropdown-menu :is(' + [ITEM, '[' + 'role=menuitemcheckbox]', '[' + 'role=menuitemradio]'].join(',') + ')' + HID,
    '.select:not(select) [' + 'role=option]' + HID,
  ];
  for (const [name, css] of [['scratch build', scratchBuild()], ['build without Basecoat', baselineBuild()]]) {
    const hiding = new Set(rules(css).filter((r) => r.decls.length === 1 && r.decls[0] === 'display:none').flatMap((r) => r.selectors));
    for (const sel of want) assert.ok(hiding.has(sel), `${name}: ${sel}{display:none}`);
  }
});

// The files Tailwind scans for candidates: the @source lines of input.css (a glob is
// reduced to its base directory plus its file suffix; `@source not` paths are excluded).
const BINARY = /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|gz|zip|br|map|wasm|pdf)$/i;
let sourceText;
function tailwindSources() {
  if (sourceText !== undefined) return sourceText;
  const input = stripComments(readFileSync(join(REPO, 'input.css'), 'utf8'));
  const entries = [...input.matchAll(/@source\s+(not\s+)?["']([^"']+)["']/g)].map((m) => ({ not: !!m[1], path: m[2] }));
  const excluded = new Set(entries.filter((e) => e.not).map((e) => resolve(REPO, e.path)));
  const files = new Set();
  const walk = (dir, suffix) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, suffix);
      else if (!BINARY.test(e.name) && e.name.endsWith(suffix) && !excluded.has(full)) files.add(full);
    }
  };
  for (const { not, path } of entries) {
    if (not) continue;
    const star = path.indexOf('*');
    const base = resolve(REPO, star < 0 ? path : path.slice(0, path.lastIndexOf('/', star)));
    const suffix = star < 0 ? '' : path.slice(path.lastIndexOf('*') + 1);
    if (!existsSync(base)) continue;
    if (statSync(base).isFile()) { if (!excluded.has(base)) files.add(base); } else walk(base, suffix);
  }
  assert.ok(files.size > 0, 'input.css @source lines resolve to files');
  sourceText = [...files].map((f) => readFileSync(f, 'utf8')).join('\n');
  return sourceText;
}

// A class selector as written in the stylesheet back to the class name used in markup:
// hex escapes (\32 xl) and character escapes (dark\:hover\:x, bg-white\/90).
const unescapeClass = (c) => c
  .replace(/\\([0-9a-fA-F]{1,6}) ?/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/\\(.)/g, '$1');

// Whether a class name occurs in text as a whole token: not followed, and not preceded,
// by a character that could continue a class name (so bg-white/90 does not match inside
// hover:bg-white/90 or bg-white/905). A leading "." is a boundary: Tailwind also picks
// up candidates from CSS selectors such as base.html's inline `html.dark .bg-blue-300`.
const CLASS_CHAR = String.raw`[^\s"'` + '`' + String.raw`<>{},;=\\]`;
const LEFT_CHAR = String.raw`[^\s"'` + '`' + String.raw`<>{},;=\\.]`;
function hasToken(text, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`(?<!${LEFT_CHAR})${esc}(?!${CLASS_CHAR})`).test(text);
}
const usedInSources = (name) => hasToken(tailwindSources(), name);

test('tailwind sources: the class filter finds used classes, whole tokens only', () => {
  assert.equal(unescapeClass('dark\\:hover\\:bg-gray-900'), 'dark:hover:bg-gray-900');
  assert.equal(unescapeClass('bg-white\\/90'), 'bg-white/90');
  assert.equal(unescapeClass('divide-\\[\\#ecedf1\\]'), 'divide-[#ecedf1]');
  assert.equal(unescapeClass('\\32 xl\\:p-4'), '2xl:p-4');
  assert.ok(hasToken('<b class="p-2 bg-white/90">', 'bg-white/90'), 'whole token in class=""');
  assert.ok(hasToken(":class=\"{'bg-white/90': on}\"", 'bg-white/90'), 'whole token in a quoted key');
  assert.ok(hasToken('html.dark .bg-white/90 {', 'bg-white/90'), 'whole token after a selector dot');
  assert.ok(!hasToken('class="hover:bg-white/90"', 'bg-white/90'), 'not the tail of a variant');
  assert.ok(!hasToken('class="bg-white/905"', 'bg-white/90'), 'not a prefix of a longer class');
  assert.ok(!hasToken('class="xbg-white/90"', 'bg-white/90'), 'not a suffix of a longer class');
  // Live sources: base.html's first class="" token (whatever a restyle makes it) is found;
  // a made-up class is not.
  const base = readFileSync(join(REPO, 'backend/app/templates/base.html'), 'utf8');
  const first = base.match(/class="\s*([\w:/[\]#.-]+)/)?.[1];
  assert.ok(first, 'base.html has a class attribute');
  assert.ok(usedInSources(first), `${first} (base.html) is found in the Tailwind sources`);
  assert.ok(!usedInSources('rf-no-such-class-x9'), 'a made-up class is not found');
});

test('basecoat: old utility selectors are kept', () => {
  const css = scratchBuild();
  // The committed tailwind.css is regenerated only in s2-T21, so restyle tasks before it
  // legitimately remove the last user of some committed classes. A committed class counts
  // as missing only if the fresh build lacks it AND a Tailwind source still uses it: a
  // still-used utility that the Basecoat import (or the build config) dropped.
  const committed = readFileSync(COMMITTED, 'utf8');
  assert.match(css, /\.btn[:{,]/, 'Basecoat component CSS is in the build');
  const classes = (s) => new Set([...stripComments(s).matchAll(/\.((?:\\[0-9a-fA-F]{1,6} ?|\\.|[\w-])+)/g)].map((m) => m[1]));
  const have = classes(css);
  const missing = [...classes(committed)]
    .filter((c) => !have.has(c) && !/^\d/.test(c))
    .filter((c) => usedInSources(unescapeClass(c)));
  assert.deepEqual(missing, [], 'every committed class selector still used by a source survives');
  // T7-N1: no Basecoat rule uses the v3 sibling form; every such selector is ours.
  const sib = (s) => new Set(rules(s).flatMap((r) => r.selectors).filter((x) => x.includes('>:not([hidden])~:not([hidden])')));
  const ours = sib(committed);
  assert.deepEqual([...sib(css)].filter((x) => !ours.has(x)), [], 'no new >:not([hidden])~:not([hidden]) selector');
  const rule = (s) => s.match(/\.space-y-2>:not\(\[hidden\]\)~:not\(\[hidden\]\)\{[^}]*\}/)?.[0];
  assert.ok(rule(committed), 'committed .space-y-2');
  assert.equal(rule(css), rule(committed), '.space-y-2 byte-equal');
});

test('fonts: four @font-face with swap and ../fonts urls that exist', () => {
  const css = scratchBuild();
  const faces = [...css.matchAll(/@font-face\{([^}]*)\}/g)].map((m) => m[1]);
  assert.equal(faces.length, 4, '@font-face count');
  const seen = [];
  for (const f of faces) {
    assert.match(f, /font-display:swap/, f);
    const family = f.match(/font-family:("?)([^;"]+)\1/)[2];
    const style = f.match(/font-style:(\w+)/)[1];
    const weight = f.match(/font-weight:([\d ]+)/)[1].trim();
    assert.equal(weight, family === 'Geist' ? '100 900' : '200 900', `${family} weight`);
    const url = f.match(/url\(("?)([^)"]+)\1\)/)[2];
    assert.match(url, /^\.\.\/fonts\/[\w-]+\.woff2$/, url);
    assert.match(f, /format\(["']?woff2["']?\)/, `${url} format`);
    assert.ok(existsSync(resolve(REPO, 'backend/app/static/css', url)), `${url} exists`);
    seen.push(`${family}/${style}`);
  }
  assert.deepEqual(seen.sort(), ['Geist/italic', 'Geist/normal', 'Source Serif 4/italic', 'Source Serif 4/normal']);
});

// The comment table between @literal-map and @end in tokens.css:
//   <literal> | <file basename>[, <file basename>...] | <token>
const norm = (s) => s.toLowerCase().replace(/\s+/g, '');
function literalMap(text) {
  const body = text.slice(text.indexOf('@literal-map'), text.indexOf('@end'));
  const rows = [];
  for (const line of body.split('\n').slice(1)) {
    const cols = line.split('|').map((c) => c.trim());
    if (cols.length !== 3 || !cols[2].startsWith('--')) continue;
    rows.push({ literal: norm(cols[0]), files: cols[1].split(',').map((f) => f.trim()), token: cols[2] });
  }
  return rows;
}

// The full literal at a hit: the colour hit for a function is only "rgba(", so the call
// is read up to its closing parenthesis.
function fullLiteral(text, hit) {
  if (hit.literal.startsWith('#')) return hit.literal;
  const line = text.split('\n')[hit.line - 1];
  const i = line.indexOf(hit.literal);
  return line.slice(i, line.indexOf(')', i) + 1);
}

// #rgb / #rrggbb / rgb()/rgba() as 8-digit lowercase hex (alpha ff when absent).
function hex8(lit) {
  let m = lit.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (m) {
    let h = m[1].toLowerCase();
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    return h.length === 6 ? `#${h}ff` : `#${h}`;
  }
  m = lit.replace(/\s+/g, ' ').match(/^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)(?:\s*[,/]\s*([\d.]+)(%?))?\)$/i);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}${Math.round(a * 255).toString(16).padStart(2, '0')}`;
}

test('tokens: every inventoried literal has a token', () => {
  const tokens = readFileSync(TOKENS, 'utf8');
  const table = literalMap(tokens);
  assert.ok(table.length > 50, 'legacy literal table present');
  const files = sourceFiles(REPO);
  const text = new Map(files.map((f) => [f.path, f.text]));
  const defined = new Set([...stripComments(tokens).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const neutralDark = tokenBlocks(tokens).get(DARK[0]);
  const unmapped = [];
  for (const hit of colourHits(files)) {
    const src = text.get(hit.path);
    // The v3 palette moved to tokens.css; before that move it is not part of the inventory.
    if (hit.path === 'input.css' && /^\s*--color-\w+-\d+:/.test(src.split('\n')[hit.line - 1])) continue;
    const lit = fullLiteral(src, hit);
    const base = hit.path.split('/').pop();
    const row = table.find((r) => r.literal === norm(lit) && r.files.includes(base));
    if (!row) { unmapped.push(`${hit.path}:${hit.line} ${lit}`); continue; }
    assert.ok(defined.has(row.token), `${row.token} (for ${lit}) is defined in tokens.css`);
    // Q1: Neutral dark keeps today's colours.
    if (row.token.startsWith('--rf-legacy-dark-')) {
      assert.equal(hex8(neutralDark.get(row.token)), hex8(lit), `Neutral dark ${row.token} equals ${lit}`);
    }
  }
  assert.deepEqual(unmapped, [], 'literals without a token');
});

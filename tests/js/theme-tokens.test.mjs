// Checks styles/tokens.css (the six theme blocks and the legacy literal table) and a
// scratch build of input.css with Basecoat's selective import and the fonts. Nothing here
// touches the committed backend/app/static/css/tailwind.css; it is only read, as the
// reference for the utilities that must survive the import.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { colourHits, sourceFiles } from '../../scripts/check-colours.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKENS = join(REPO, 'styles', 'tokens.css');
const COMMITTED = join(REPO, 'backend', 'app', 'static', 'css', 'tailwind.css');
const scratch = [];
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

let built;
function scratchBuild() {
  if (built === undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'tw-theme-'));
    scratch.push(dir);
    const out = join(dir, 'tw.css');
    execFileSync(join(REPO, 'node_modules', '.bin', 'tailwindcss'), ['-i', 'input.css', '-o', out, '--minify'], { cwd: REPO, stdio: 'pipe' });
    built = readFileSync(out, 'utf8');
  }
  return built;
}

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

test('basecoat: selective import leaves old markup alone', () => {
  const css = scratchBuild();
  const all = rules(css);
  // Selectors already in the committed build (Tailwind's preflight: summary{display:list-item}) are not Basecoat's.
  const before = new Set(rules(readFileSync(COMMITTED, 'utf8')).flatMap((r) => r.selectors));
  const bare = (re) => all.flatMap((r) => r.selectors).filter((s) => !before.has(s) && re.test(s.replace(/^:(?:is|where)\(/, '')));
  assert.deepEqual(bare(/^(?:details|summary)\b/), [], 'no bare details/summary rule (collapsible.css)');
  // tooltip.css and radio.css are not imported. styles/vega.css still carries the skin
  // of both: two [data-tooltip] pseudo-element rules that set colours and padding but no
  // content (so nothing renders without tooltip.css), and [role=radiogroup]{display:grid}.
  // Old markup uses neither attribute. Anything beyond these three is a leak.
  const attr = bare(/^\[(?:data-tooltip|role=["']?radiogroup)/);
  assert.deepEqual([...new Set(attr)].sort(), ['[data-tooltip]:before', '[data-tooltip][data-arrow]:after', '[role=radiogroup]']);
  for (const r of all.filter((x) => x.selectors.some((s) => s.startsWith('[data-tooltip]')))) {
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

test('basecoat: old utility selectors are kept', () => {
  const css = scratchBuild();
  const committed = readFileSync(COMMITTED, 'utf8');
  assert.match(css, /\.btn[:{,]/, 'Basecoat component CSS is in the build');
  const classes = (s) => new Set([...stripComments(s).matchAll(/\.((?:\\.|[\w-])+)/g)].map((m) => m[1]));
  const have = classes(css);
  const missing = [...classes(committed)].filter((c) => !have.has(c) && !/^\d/.test(c));
  assert.deepEqual(missing, [], 'every committed class selector survives');
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

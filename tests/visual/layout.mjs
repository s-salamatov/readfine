// Layout mode of the visual harness (RF_VISUAL_MODE=layout, tests/visual/run.mjs):
// box collection in the page, base-vs-head box comparison, the structural key list,
// the allow-list loader and the report.
//
// Pass A (fonts blocked): every tracked box, tolerance 0.5 px on x, y, w and h.
// Pass B (fonts loaded): only KEY_STRUCTURE, tolerance 1 px on x and w (and h for
// fixed bars); every other moved box is listed as reflow, never failed.
import fs from 'node:fs';
import path from 'node:path';

// Evaluated in the page through page.evaluate(collectBoxes): self-contained, no outer
// references. Tracks every visible element with an id (`#id`, digit runs as `*`; a
// repeated key gets `[2]`, `[3]`, ... in document order), the first 10 `.article-row` (`.article-row[i]`) and the first
// 20 `.nav-item` (`.nav-item[i]`). Boxes are in document coordinates, rounded to 0.01 px.
export function collectBoxes() {
  const r2 = (n) => Math.round(n * 100) / 100;
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return null;
    return rect;
  };
  const box = (key, rect) => ({
    key, x: r2(rect.left + window.scrollX), y: r2(rect.top + window.scrollY), w: r2(rect.width), h: r2(rect.height),
  });
  const out = [];
  const seen = new Map();
  for (const el of document.querySelectorAll('[id]')) {
    const rect = visible(el);
    if (!rect) continue;
    // Runtime-built ids carry database ids (`article-row-123`), which differ between the
    // two phases (each reseeds): digit runs become `*` and the document order tells
    // the elements apart (`#article-row-*`, `#article-row-*[2]`, ...).
    const id = el.id.replace(/\d+/g, '*');
    const n = (seen.get(id) || 0) + 1;
    seen.set(id, n);
    out.push(box(n === 1 ? `#${id}` : `#${id}[${n}]`, rect));
  }
  for (const [selector, limit] of [['.article-row', 10], ['.nav-item', 20]]) {
    let i = 0;
    for (const el of document.querySelectorAll(selector)) {
      if (i >= limit) break;
      const rect = visible(el);
      if (!rect) continue;
      out.push(box(`${selector}[${i}]`, rect));
      i++;
    }
  }
  return out;
}

const FIELDS = { x: 'dx', y: 'dy', w: 'dw', h: 'dh' };
const r2 = (n) => Math.round(n * 100) / 100;

// base, head: collectBoxes() output. `keys` restricts the comparison to those keys;
// an entry is a key or `{ key, fields }` (fields among x, y, w, h; default all four).
// Restricted keys absent on both sides are ignored here (the spec reports them).
// Returns the keys only in base (missing), only in head (extra) and the boxes whose
// checked fields differ by more than `tolerance` (moved, with all four deltas).
export function compareBoxes(base, head, { tolerance, keys } = {}) {
  const B = new Map(base.map((b) => [b.key, b]));
  const H = new Map(head.map((b) => [b.key, b]));
  const wanted = keys
    ? keys.map((k) => (typeof k === 'string' ? { key: k, fields: ['x', 'y', 'w', 'h'] } : k))
    : [...new Set([...B.keys(), ...H.keys()])].map((key) => ({ key, fields: ['x', 'y', 'w', 'h'] }));
  const missing = [];
  const extra = [];
  const moved = [];
  for (const { key, fields } of wanted) {
    const b = B.get(key);
    const h = H.get(key);
    if (b && !h) { missing.push(key); continue; }
    if (!b && h) { extra.push(key); continue; }
    if (!b) continue;
    const d = { dx: r2(h.x - b.x), dy: r2(h.y - b.y), dw: r2(h.w - b.w), dh: r2(h.h - b.h) };
    if (fields.some((f) => Math.abs(d[FIELDS[f]]) > tolerance)) moved.push({ key, ...d });
  }
  return { missing, extra, moved };
}

// Structural keys per `<screen>@<viewport width>`, checked in pass B on x and width
// (`fields` adds the height of fixed bars). Each entry says what box it stands for.
// Content columns (settings, help, admin, catch-me-up) and the login card carry no id of
// their own; a full-width block or field inside stands in for them (it shares the
// column's content x and width).
const shell1280 = [
  { key: '#sidebar', fields: ['x', 'w'], why: 'shell: sidebar pane' },
  { key: '#article-list', fields: ['x', 'w'], why: 'shell: list pane' },
  { key: '#article-detail', fields: ['x', 'w'], why: 'shell: detail pane' },
];
const shell390 = [
  { key: '#mobile-title-bar', fields: ['x', 'w', 'h'], why: 'mobile: fixed title bar (height counts)' },
];
// The tab bar hides over a full-screen article, so only the list screen has it.
const tabBar390 = { key: '#tab-bar', fields: ['x', 'w', 'h'], why: 'mobile: fixed tab bar, Feed · Search · Add · Assistant · Folders (s3-T8; height counts)' };
export const KEY_STRUCTURE = {
  'list@1280': shell1280,
  'list@390': [...shell390, tabBar390, { key: '#article-list', fields: ['x', 'w'], why: 'mobile: list pane' }],
  'article@1280': shell1280,
  'article@390': [...shell390, { key: '#article-detail', fields: ['x', 'w'], why: 'mobile: detail pane' }],
  'catch-me-up@1280': [{ key: '#catchup-form', fields: ['x', 'w'], why: 'catch-me-up: settings column' }],
  'catch-me-up@390': [{ key: '#catchup-form', fields: ['x', 'w'], why: 'catch-me-up: settings column' }],
  'settings-preferences@1280': [{ key: '#offline-diagnostics', fields: ['x', 'w'], why: 'settings column (full-width block)' }],
  'settings-preferences@390': [{ key: '#offline-diagnostics', fields: ['x', 'w'], why: 'settings column (full-width block)' }],
  'settings-feeds@1280': [{ key: '@sources-main', fields: ['x', 'w'], why: 'side-aware Sources main column (base subscribe form, head Sources main)' }, { key: '#feeds-list', fields: ['x', 'w'], why: 'Sources table column on both sides' }],
  'settings-feeds@390': [{ key: '@sources-main', fields: ['x', 'w'], why: 'side-aware Sources main column (base subscribe form, head Sources main)' }, { key: '#feeds-list', fields: ['x', 'w'], why: 'Sources table column on both sides' }],
  'login@1280': [
    { key: '#email', fields: ['x', 'w'], why: 'login card (full-width email field)' },
    { key: '#password', fields: ['x', 'w'], why: 'login card (full-width password field)' },
  ],
  'login@390': [
    { key: '#email', fields: ['x', 'w'], why: 'login card (full-width email field)' },
    { key: '#password', fields: ['x', 'w'], why: 'login card (full-width password field)' },
  ],
  'help@1280': [{ key: '#shortcuts', fields: ['x', 'w'], why: 'help column (shortcuts section)' }],
  'help@390': [{ key: '#shortcuts', fields: ['x', 'w'], why: 'help column (shortcuts section)' }],
  // No visible id-bearing box spans the admin settings column (the form and its sections
  // have no id); pass A still checks every box there, and s2-T23 restyles the screen.
  'admin-settings@1280': [],
  'admin-settings@390': [],
};

// Merges every `*.json` in `dir` (one file per task: an array of { screen, key, reason }).
// Each entry keeps its file name. A malformed entry throws, naming the file.
export function loadAllow(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const entries = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (!Array.isArray(entries)) throw new Error(`${file}: expected an array of { screen, key, reason }`);
    for (const e of entries) {
      if (!e || typeof e.screen !== 'string' || typeof e.key !== 'string' || !e.reason) {
        throw new Error(`${file}: every entry needs screen, key and reason: ${JSON.stringify(e)}`);
      }
      if (e.structural !== undefined && typeof e.structural !== 'boolean') {
        throw new Error(`${file}: structural must be a boolean`);
      }
      out.push({ file, screen: e.screen, key: e.key, reason: e.reason, structural: e.structural === true });
    }
  }
  return out;
}

// An allow key matches exactly, or as a prefix when it ends in `*` (`#theme-*`).
// `*` alone is the whole-screen exemption.
const keyMatches = (pattern, key) => (pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : pattern === key);

const fmt = (m) => `${m.key} dx=${m.dx} dy=${m.dy} dw=${m.dw} dh=${m.dh}`;

// results: [{ pass: 'A'|'B', screen, job, missing, extra, moved, reflow?, absent? }]
// (absent: structural keys found on neither side). allow: loadAllow() output.
// A `*` entry exempts the screen in both passes; a key entry exempts that key in pass A.
// In pass B an exact key entry (no `*`) exempts only that structural key being extra:
// a new key that replaces an old box (s3-T8's #tab-bar for #mobile-bottom-bar) has no
// base box. A moved structural key additionally requires `structural: true`.
// A structural key missing from head is never exempted by a key entry.
// Returns the report lines (the last one is the summary) and the failed job count.
export function formatLayoutReport(results, allow = []) {
  const lines = [];
  const count = { A: { ok: 0, n: 0 }, B: { ok: 0, n: 0 } };
  let failed = 0;
  for (const r of results) {
    const c = count[r.pass];
    c.n++;
    const whole = allow.find((a) => a.screen === r.screen && a.key === '*');
    const exemptKey = (kind, key) => {
      if (r.pass === 'A') return allow.find((a) => a.screen === r.screen && a.key !== '*' && keyMatches(a.key, key));
      // Explicit opt-in for a deliberately resized structural anchor. Missing
      // anchors and absent screens still fail; existing allow entries keep their
      // extra-only semantics and cannot hide regressions on other screens.
      if (kind === 'moved') return allow.find((a) => a.screen === r.screen && a.key === key && a.structural);
      if (kind !== 'extra') return undefined;
      return allow.find((a) => a.screen === r.screen && a.key === key);
    };
    const problems = [];
    const exempted = [];
    const check = (kind, key, text) => {
      const a = exemptKey(kind, key);
      if (a) exempted.push(`  exempt ${kind} ${text} (${a.file}: ${a.reason})`);
      else problems.push(`  ${kind} ${text}`);
    };
    for (const k of r.missing) check('missing', k, k);
    for (const k of r.extra) check('extra', k, k);
    for (const m of r.moved) check('moved', m.key, fmt(m));
    for (const k of r.absent || []) problems.push(`  absent ${k} (structural key on neither side)`);
    const label = `${r.pass} ${r.job}`;
    if (problems.length && whole) {
      c.ok++;
      lines.push(`layout ${label}  exempt (screen ${r.screen} key * — ${whole.file}: ${whole.reason})`);
      lines.push(...problems.map((p) => `  (exempt)${p}`));
    } else if (problems.length) {
      failed++;
      lines.push(`layout ${label}  FAIL`, ...problems, ...exempted);
    } else {
      c.ok++;
      lines.push(`layout ${label}  ok`, ...exempted);
    }
    for (const m of r.reflow || []) lines.push(`  reflow ${fmt(m)}`);
  }
  lines.push(`layout: A ${count.A.ok}/${count.A.n} strict, B ${count.B.ok}/${count.B.n} structural`);
  return { lines, failed };
}

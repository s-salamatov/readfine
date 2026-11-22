#!/usr/bin/env node
// Guards the Tailwind 3 -> 4 class renames.
//   legacyHits:        names v4 removed or deprecated, anywhere in templates, JS or Python.
//   renameMismatches:  per template, the renamed-class multiset must match base after RENAME.
//   hiddenDisplayHits: a static class list with `hidden` and a display utility v4 emits after it.
// CLI: node scripts/check-tw4-classes.mjs [--base <rev>] [--roots templates,js,routers,services]
//      [--css <file>]   (the build the display order is read from, default the committed tailwind.css)
//      [--display-all]  (report hidden next to every display utility, an audit only)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LEGACY = /(?<![\w-])(?:[\w-]+:)*!?(flex-shrink(?:-\d+)?|flex-grow(?:-\d+)?|overflow-ellipsis|decoration-(?:slice|clone)|break-words|(?:bg|text|border|divide|ring|placeholder)-opacity-\d+)!?(?![\w-])(?!\s*:)/u;

export function legacyHits(files) {
  const hits = [];
  for (const { path: p, text } of files) {
    text.split('\n').forEach((line, i) => {
      const re = new RegExp(LEGACY.source, 'gu');
      let m;
      while ((m = re.exec(line))) hits.push({ path: p, line: i + 1, token: m[1] });
    });
  }
  return hits;
}

// ---- hidden next to a display utility ----
// v4 emits display utilities in its own order (v3 emitted hidden last), so one element
// carrying `hidden` and a utility emitted after it is shown. The order is read from the
// built CSS. Variant forms (`sm:flex`) are separate rules and fine.

// Top-level display utilities of a built CSS, in emit order: a rule `.<name>{display:<name>}`
// (or `.hidden{display:none}`) nested in nothing but @layer blocks. Rules under @media,
// @supports or @container, nested rules and variant selectors (`sm\:flex`) are ignored.
function displayRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const stack = []; // preludes of the open blocks
  let start = 0; // where the current prelude or declaration run begins
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      i = j;
    } else if (c === '{') {
      stack.push(src.slice(start, i).trim());
      start = i + 1;
    } else if (c === '}') {
      const prelude = stack.pop();
      const body = src.slice(start, i);
      start = i + 1;
      const m = /^\.([a-z][a-z0-9-]*)$/.exec(prelude ?? '');
      if (!m || !stack.every((p) => /^@layer\b/.test(p))) continue;
      const d = /(?:^|;)\s*display\s*:\s*([a-z-]+)\s*(?:;|$)/.exec(body);
      if (d && d[1] === (m[1] === 'hidden' ? 'none' : m[1])) out.push(m[1]);
    } else if (c === ';' && !stack.length) start = i + 1; // top-level @import / @charset
  }
  return out;
}

// The unprefixed display utilities whose rule comes after `.hidden{display:none}`.
export function displayAfterHidden(css) {
  const rules = displayRules(css);
  const at = rules.indexOf('hidden');
  return at < 0 ? [] : [...new Set(rules.slice(at + 1).filter((n) => n !== 'hidden'))];
}

// Every unprefixed display utility in the build, `hidden` itself excluded.
export function displayAll(css) {
  return [...new Set(displayRules(css).filter((n) => n !== 'hidden'))];
}

const DEFAULT_CSS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backend/app/static/css/tailwind.css');
const FALLBACK_LOSES_TO = ['inline', 'inline-block', 'inline-flex', 'table'];
const defaultCss = fs.existsSync(DEFAULT_CSS) ? fs.readFileSync(DEFAULT_CSS, 'utf8') : null;
// Kept for compatibility: computed from the committed build, the v4.3 list without one.
export const HIDDEN_LOSES_TO = defaultCss === null ? FALLBACK_LOSES_TO : displayAfterHidden(defaultCss);
// The full set, for an on-demand audit of pairs that only work because of the emit order.
export const DISPLAY_ALL = defaultCss === null ? ['block', 'contents', 'flex', 'grid', ...FALLBACK_LOSES_TO] : displayAll(defaultCss);

const CLASS_TOKEN = /^[\w!:[\]/.%#&>*@,=()'-]+$/;
const lineAt = (text, i) => text.slice(0, i).split('\n').length;

// A Jinja class value -> every class string it can render: each {% if %} contributes one
// of its branches (or nothing without an else); other tags and {{ }} expressions are dropped.
function jinjaVariants(src, cap = 256) {
  const re = /\{%-?\s*(if|elif|else|endif)\b[\s\S]*?-?%\}|\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}|\{#[\s\S]*?#\}/g;
  const toks = [];
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    toks.push({ text: src.slice(last, m.index) });
    if (m[1]) toks.push({ tag: m[1] });
    else toks.push({ text: ' ' });
    last = re.lastIndex;
  }
  toks.push({ text: src.slice(last) });
  let i = 0;
  const product = (a, b) => {
    const out = [];
    for (const x of a) for (const y of b) if (out.length < cap) out.push(`${x}${y}`);
    return out;
  };
  function seq() {
    let acc = [''];
    while (i < toks.length) {
      const t = toks[i];
      if (t.tag === 'elif' || t.tag === 'else' || t.tag === 'endif') return acc;
      i++;
      if (t.tag === 'if') {
        const opts = [];
        let hasElse = false;
        for (;;) {
          opts.push(...seq());
          const end = toks[i++];
          if (!end || end.tag === 'endif') break;
          if (end.tag === 'else') hasElse = true;
        }
        if (!hasElse) opts.push('');
        acc = product(acc, opts.map((o) => ` ${o} `));
      } else acc = product(acc, [t.text]);
    }
    return acc;
  }
  return seq();
}

// The value of every class="…" attribute in `text`, skipping over Jinja tags inside it.
function classAttrs(text) {
  const out = [];
  const re = /\bclass\s*=\s*(["'])/g;
  let m;
  while ((m = re.exec(text))) {
    const q = m[1];
    let i = re.lastIndex;
    while (i < text.length && text[i] !== q) {
      const two = text.slice(i, i + 2);
      if (two === '{%' || two === '{{' || two === '{#') {
        const close = text.indexOf({ '{%': '%}', '{{': '}}', '{#': '#}' }[two], i + 2);
        i = close < 0 ? text.length : close + 2;
      } else i++;
    }
    out.push({ index: m.index, value: text.slice(re.lastIndex, i) });
    re.lastIndex = i;
  }
  return out;
}

// String literals of a JS or Python source, comments skipped. Literal content is returned
// raw (escapes kept); a unit never spans a quote boundary.
function stringLiterals(text, lang) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const two = text.slice(i, i + 2);
    if (lang === 'js' && two === '//') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
    if (lang === 'js' && two === '/*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (lang === 'py' && c === '#') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '"' || c === "'" || (lang === 'js' && c === '`')) {
      const triple = lang === 'py' && text.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      const start = i + q.length;
      let j = start;
      while (j < n && !text.startsWith(q, j)) {
        if (text[j] === '\\') j++;
        else if (!triple && c !== '`' && text[j] === '\n') break;
        j++;
      }
      out.push({ index: i, value: text.slice(start, j) });
      i = j + q.length;
      continue;
    }
    i++;
  }
  return out;
}

function offending(list, utilities) {
  const toks = list.split(/\s+/).filter(Boolean).map((t) => parts(t)).filter((t) => !t.variants);
  return toks.some((t) => t.name === 'hidden') && toks.some((t) => utilities.includes(t.name));
}

// A static class list carrying `hidden` together with an unprefixed display utility.
//   files: [{ path, text }]; .html is read as Jinja markup, .js / .py by their string literals.
export function hiddenDisplayHits(files, utilities = HIDDEN_LOSES_TO) {
  const hits = [];
  for (const { path: p, text } of files) {
    const lists = [];
    if (/\.html$/.test(p)) {
      for (const a of classAttrs(text)) for (const v of jinjaVariants(a.value)) lists.push({ index: a.index, value: v });
    } else {
      const lang = /\.py$/.test(p) ? 'py' : 'js';
      for (const lit of stringLiterals(text, lang)) {
        // Interpolations (${…} in JS, {…} in Python f-strings) are not static classes.
        const value = lit.value.replace(lang === 'js' ? /\$\{[^}]*\}/g : /\{[^{}]*\}/g, ' ');
        const attrs = classAttrs(value);
        if (attrs.length) {
          for (const a of attrs) lists.push({ index: lit.index, value: a.value });
        } else {
          // A bare literal counts as a class list when every word looks like a class, and it
          // reads like one (a dash or variant somewhere, or three words at most), not prose.
          const words = value.split(/\s+/).filter(Boolean);
          if (words.length && words.every((w) => CLASS_TOKEN.test(w))
              && (words.length <= 3 || words.some((w) => /[-:]/.test(w)))) {
            lists.push({ index: lit.index, value });
          }
        }
      }
    }
    const seen = new Set();
    for (const l of lists) {
      if (!offending(l.value, utilities)) continue;
      const line = lineAt(text, l.index);
      if (seen.has(line)) continue;
      seen.add(line);
      hits.push({ path: p, line, classes: l.value.replace(/\s+/g, ' ').trim() });
    }
  }
  return hits;
}

const SIDES = ['', '-t', '-r', '-b', '-l', '-tl', '-tr', '-br', '-bl', '-s', '-e', '-ss', '-se', '-es', '-ee'];
const RENAME = new Map([
  ['shadow-sm', 'shadow-xs'], ['shadow', 'shadow-sm'],
  ['drop-shadow-sm', 'drop-shadow-xs'], ['drop-shadow', 'drop-shadow-sm'],
  ['blur-sm', 'blur-xs'], ['blur', 'blur-sm'],
  ['backdrop-blur-sm', 'backdrop-blur-xs'], ['backdrop-blur', 'backdrop-blur-sm'],
  ['outline-none', 'outline-hidden'], ['ring', 'ring-3'],
  ['overflow-ellipsis', 'text-ellipsis'],
  ['decoration-slice', 'box-decoration-slice'], ['decoration-clone', 'box-decoration-clone'],
  ['break-words', 'wrap-break-word'],
]);
for (const s of SIDES) {
  RENAME.set(`rounded${s}-sm`, `rounded${s}-xs`);
  RENAME.set(`rounded${s}`, `rounded${s}-sm`);
}
// flex-shrink / flex-grow, bare or with a numeric suffix.
const NUM = /^(flex-shrink|flex-grow)(-\d+)?$/;
const renamed = (name) => {
  if (RENAME.has(name)) return RENAME.get(name);
  const m = NUM.exec(name);
  return m ? `${m[1] === 'flex-shrink' ? 'shrink' : 'grow'}${m[2] || ''}` : name;
};
const RENAME_RANGE = new Set(RENAME.values());
const inFamily = (name) => RENAME.has(name) || RENAME_RANGE.has(name) || NUM.test(name) || /^(shrink|grow)(-\d+)?$/.test(name);

function parts(token) {
  const i = token.lastIndexOf(':');
  const variants = token.slice(0, i + 1);
  let rest = token.slice(i + 1);
  let bang = false;
  if (rest.startsWith('!')) { bang = true; rest = rest.slice(1); }
  if (rest.endsWith('!')) { bang = true; rest = rest.slice(0, -1); }
  return { variants, name: rest, bang };
}

function familyTokens(text) {
  const out = [];
  const re = /\bclass="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    for (const tok of m[1].split(/\s+/).filter(Boolean)) {
      const t = parts(tok);
      if (inFamily(t.name)) out.push(t);
    }
  }
  return out;
}
const key = (t) => `${t.variants}${t.name}${t.bang ? '!' : ''}`;
function counts(list) {
  const m = new Map();
  for (const k of list) m.set(k, (m.get(k) || 0) + 1);
  return m;
}

export function renameMismatches(pairs) {
  const out = [];
  for (const { path: p, base, head } of pairs) {
    const expected = counts(familyTokens(base).map((t) => key({ ...t, name: renamed(t.name) })));
    const found = counts(familyTokens(head).map(key));
    for (const k of new Set([...expected.keys(), ...found.keys()])) {
      const e = expected.get(k) || 0;
      const f = found.get(k) || 0;
      if (e !== f) out.push({ path: p, token: k, expected: e, found: f });
    }
  }
  return out;
}

// ---- CLI ----
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = {
  templates: ['backend/app/templates', /\.html$/],
  js: ['backend/app/static/js', /\.js$/],
  routers: ['backend/app/routers', /\.py$/],
  services: ['backend/app/services', /\.py$/],
};
const SKIP = (rel) => /(^|\/)vendor\//.test(rel) || /(^|\/)htmx\.min\.js$/.test(rel) || /(^|\/)landing\.html$/.test(rel);

function walk(dir, re, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, re, acc);
    else if (re.test(e.name)) acc.push(full);
  }
  return acc;
}

function main(argv) {
  let base = null;
  let roots = Object.keys(ROOTS);
  let all = false;
  let cssFile = DEFAULT_CSS;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') base = argv[++i];
    else if (argv[i] === '--roots') roots = argv[++i].split(',');
    else if (argv[i] === '--display-all') all = true;
    else if (argv[i] === '--css') cssFile = path.resolve(argv[++i] ?? '');
  }
  let css;
  try {
    css = fs.readFileSync(cssFile, 'utf8');
  } catch {
    console.log(`tw4-classes: FAIL\ncannot read CSS ${path.relative(process.cwd(), cssFile) || cssFile}`);
    return 1;
  }
  if (!displayRules(css).includes('hidden')) {
    console.log(`tw4-classes: FAIL\nno top-level .hidden{display:none} in ${cssFile}`);
    return 1;
  }
  const display = all ? displayAll(css) : displayAfterHidden(css);
  if (base) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
    } catch {
      console.log(`tw4-classes: FAIL\nunknown base revision ${base}`);
      return 1;
    }
  }
  const files = [];
  for (const r of roots) {
    const [dir, re] = ROOTS[r] ?? [];
    if (!dir) { console.log(`tw4-classes: FAIL\nunknown root ${r}`); return 1; }
    for (const f of walk(path.join(ROOT, dir), re)) {
      const rel = path.relative(ROOT, f);
      if (!SKIP(rel)) files.push({ path: rel, text: fs.readFileSync(f, 'utf8') });
    }
  }
  const lines = legacyHits(files).map((h) => `${h.path}:${h.line} ${h.token}`);
  for (const h of hiddenDisplayHits(files, display)) lines.push(`${h.path}:${h.line} hidden with a display utility: "${h.classes}"`);
  if (base) {
    const pairs = [];
    for (const f of files.filter((x) => x.path.startsWith('backend/app/templates/'))) {
      let b;
      try {
        b = execFileSync('git', ['show', `${base}:${f.path}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch { continue; }
      pairs.push({ path: f.path, base: b, head: f.text });
    }
    for (const m of renameMismatches(pairs)) lines.push(`${m.path} ${m.token} expected ${m.expected} found ${m.found}`);
  }
  if (lines.length) { console.log(`tw4-classes: FAIL\n${lines.join('\n')}`); return 1; }
  console.log(`tw4-classes: OK (${files.length} files)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

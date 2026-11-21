#!/usr/bin/env node
// Guards the Tailwind 3 -> 4 class renames.
//   legacyHits:        names v4 removed or deprecated, anywhere in templates, JS or Python.
//   renameMismatches:  per template, the renamed-class multiset must match base after RENAME.
// CLI: node scripts/check-tw4-classes.mjs [--base <rev>] [--roots templates,js,routers,services]
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
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') base = argv[++i];
    else if (argv[i] === '--roots') roots = argv[++i].split(',');
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

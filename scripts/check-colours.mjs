// Fails when a colour literal appears outside the token file.
//
// styles/tokens.css is the only place for #hex, rgb(), rgba(), hsl(), hsla(), oklch()
// and oklab() in CSS, templates and static/js, so that a theme can change every colour.
// ALLOW lists the owner's exceptions (s2 plan, owner decision Q2) and nothing else.
// Stored label colours reach the page as {{ label.color }}; they are data, not
// literals, and need no exception.
//
// Not colours, never reported: HTML entities (&#39;), id references in href, for and
// hx-target/-select/-include/-indicator values, selector strings passed to
// querySelector(All), closest, matches and getElementById, strings compared with
// location.hash, and Jinja comments.
//
// Usage: node scripts/check-colours.mjs [--list]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOW = Object.freeze([
  { path: 'styles/tokens.css', reason: 'the token file: the one place colour literals live' },
  { path: 'backend/app/templates/email/**', reason: 'mail clients get no stylesheet and no custom properties' },
  { path: 'backend/app/static/js/offline/launch.js', reason: 'self-contained worker launch page, rendered before any CSS loads' },
  {
    path: 'backend/app/static/js/offline/templates.js',
    fn: 'offlinePage',
    reason: 'self-contained worker offline page (design §5.5): no external resources, so no tokens',
  },
]);

export const ROOTS = ['input.css', 'styles', 'backend/app/templates', 'backend/app/static/js'];
const EXTENSIONS = /\.(css|html|js|mjs)$/;
const SKIP = (rel) => rel.split('/').includes('vendor') || rel.endsWith('/htmx.min.js');

const HEX = /(?<![&\w])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])/g;
const FUNC = /\b(?:rgba?|hsla?|oklch|oklab)\(/g;

// Regions that are not colours. Each is blanked (newlines kept) before matching.
const MASKS = [
  /\{#[\s\S]*?#\}/g,
  /(?<![\w-])(?:href|for|hx-target|hx-select|hx-include|hx-indicator)\s*=\s*(?:"[^"]*"|'[^']*')/g,
  /\b(?:querySelector(?:All)?|closest|matches|getElementById)\(\s*(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)/g,
  /\blocation\.hash\s*[!=]==?\s*(?:'[^']*'|"[^"]*")/g,
  /(?:'[^']*'|"[^"]*")\s*[!=]==?\s*location\.hash\b/g,
];

const blank = (s) => s.replace(/[^\n]/g, ' ');

function normalise(path) {
  return path.split(sep).join('/').replace(/^\.\//, '');
}

function pathMatches(path, pattern) {
  if (pattern.endsWith('/**')) return path.startsWith(pattern.slice(0, -2));
  return path === pattern;
}

// [start, end) of the body of `function <name>(` in JS text, found by brace matching
// that skips strings, template literals and comments. null when absent.
export function functionSpan(text, name) {
  const m = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(text);
  if (!m) return null;
  let i = text.indexOf('{', m.index + m[0].length);
  if (i < 0) return null;
  let depth = 0;
  const tpl = []; // brace depth at which each open ${ ... } of a template literal began
  for (; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') { i = text.indexOf('\n', i); if (i < 0) return null; continue; }
    if (ch === '/' && next === '*') { i = text.indexOf('*/', i + 2) + 1; if (i <= 0) return null; continue; }
    if (ch === "'" || ch === '"') {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (ch === '`' || (ch === '}' && tpl.length && tpl[tpl.length - 1] === depth)) {
      if (ch === '}') tpl.pop();
      for (i++; i < text.length && text[i] !== '`'; i++) {
        if (text[i] === '\\') { i++; continue; }
        if (text[i] === '$' && text[i + 1] === '{') { tpl.push(depth); i++; break; }
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return [m.index, i + 1];
    }
  }
  return null;
}

export function colourHits(files, allow = ALLOW) {
  const hits = [];
  for (const file of files) {
    const path = normalise(file.path);
    const rules = allow.filter((a) => pathMatches(path, a.path));
    if (rules.some((a) => !a.fn)) continue;
    let text = file.text;
    for (const mask of MASKS) text = text.replace(mask, blank);
    for (const rule of rules) {
      const span = functionSpan(text, rule.fn);
      if (span) text = text.slice(0, span[0]) + blank(text.slice(span[0], span[1])) + text.slice(span[1]);
    }
    const found = [];
    for (const re of [HEX, FUNC]) {
      for (const m of text.matchAll(re)) found.push({ index: m.index, literal: m[0] });
    }
    found.sort((a, b) => a.index - b.index);
    for (const f of found) {
      const line = text.slice(0, f.index).split('\n').length;
      hits.push({ path, line, literal: f.literal });
    }
  }
  return hits;
}

function walk(abs, rel, out) {
  const st = statSync(abs, { throwIfNoEntry: false });
  if (!st || SKIP(rel)) return;
  if (st.isDirectory()) {
    for (const name of readdirSync(abs).sort()) walk(join(abs, name), `${rel}/${name}`, out);
  } else if (EXTENSIONS.test(rel)) {
    out.push({ path: rel, text: readFileSync(abs, 'utf8') });
  }
}

export function sourceFiles(repo) {
  const out = [];
  for (const root of ROOTS) walk(join(repo, root), root, out);
  return out;
}

function main(argv) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const files = sourceFiles(repo);
  const hits = colourHits(files);
  if (argv.includes('--list')) {
    const counts = new Map();
    for (const h of hits) counts.set(h.path, (counts.get(h.path) || 0) + 1);
    for (const [path, n] of counts) console.log(`${String(n).padStart(5)}  ${path}`);
  }
  if (!hits.length) {
    console.log(`colours: OK (${files.length} files)`);
    return 0;
  }
  console.log(`colours: FAIL — ${hits.length} literals`);
  for (const h of hits) console.log(`${h.path}:${h.line} ${h.literal}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

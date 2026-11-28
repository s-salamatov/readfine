// Fails when an animation call appears outside static/js/ui/motion.js, or when
// motion.js breaks its own engine rules (motion design §6.14 invariant 9, §9 item 17).
//
// Scope: backend/app/static/js/**/*.js and backend/app/templates/**/*.html, minus the
// vendored code (static/js/vendor/**: anime, Basecoat) and static/js/htmx.min.js, which
// calls document.startViewTransition itself. JS comments, {# #} and <!-- --> are blanked
// (newlines kept) before matching; in templates JS comments are blanked only inside
// <script> bodies, so prose and URLs are left alone.
//
// Outside motion.js these are reported: anime.<name>(, window.anime, .animate(,
// startViewTransition, RFMotion.animate(, and RFMotion.play/enter/transition( anywhere
// but in their ALLOW home; data-rf-vt in templates. Reading RFMotion (reduced(), tokens)
// is not an animation call. Here and below a call is also seen when written with ?.
// (el?.animate(, enter?.() or with whitespace or line breaks around the dot or the paren;
// it is reported at the line where the match starts.
//
// Inside motion.js: a persist key, commitStyles, transform keys (x, y, z, translateX…,
// scaleX…, rotate*, skew*) and .animate( other than waapi.animate(. The legacy
// RFMotion.animate code between `// rf-motion:legacy-animate start` and `… end`
// (deleted in s4) is exempt from the key and .animate( rules, with at most one .animate(.
//
// Calls through an alias (var m = window.RFMotion; m.play(…)) are not seen.
//
// Usage: node scripts/check-motion-calls.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { functionSpan } from './check-colours.mjs';

const JS = 'backend/app/static/js';
const T = 'backend/app/templates';
export const MOTION = `${JS}/ui/motion.js`;
export const APP = `${JS}/app.js`;

export const SHELL_KEYS = Object.freeze([
  'mobile-detail-open:on',
  'mobile-detail-open:off',
  'story-detail-open:on',
  'story-detail-open:off',
  'deeplink-detail-open:off',
]);

// Every animation call allowed outside motion.js, with its upper bound.
export const ALLOW = Object.freeze([
  { path: APP, rule: 'rfmotion-transition', max: 1, within: '_shellTransition', reason: 'inv. 9: the one View Transition call, inside the shell helper' },
  { path: APP, rule: 'shell-transition', max: 6, keys: SHELL_KEYS, reason: 'inv. 9: six helper calls from the §6.6.1 table, keyed by a listed literal or a two-literal ternary' },
  { path: `${JS}/ui/read.js`, rule: 'rfmotion-play', names: ['swipe-snap'], reason: 'inv. 9: the swipe snap-back (s2)' },
  { path: `${JS}/feeds-settings.js`, rule: 'rfmotion-play', names: ['flash'], reason: 'inv. 9: the moved-folder flash (s4)' },
  { path: `${T}/dev/ui.html`, rule: 'rfmotion-play', reason: 'inv. 9: the /dev/ui gallery Replay buttons' },
  { path: `${T}/dev/ui.html`, rule: 'rfmotion-enter', reason: 'inv. 9: the /dev/ui gallery' },
  { path: `${JS}/ui/read.js`, rule: 'animate-call', max: 1, until: 's2', reason: 'transitional: snapBack still uses RFMotion.animate through an alias' },
  { path: `${JS}/feeds-settings.js`, rule: 'rfmotion-animate', max: 1, until: 's4', reason: 'transitional: the folder flash still uses RFMotion.animate' },
]);

// A member access (. or ?.) and a call paren (( or ?.(), with any whitespace around them.
const DOT = String.raw`\s*\??\.\s*`;
const CALL = String.raw`\s*(?:\?\.\s*)?\(`;
const re = (source) => new RegExp(source, 'g');
const rfMotion = (name) => re(String.raw`\bRFMotion${DOT}${name}${CALL}`);

const OUTSIDE = [
  ['anime-call', re(String.raw`(?<![\w$]|\.\s*)anime${DOT}[\w$]+${CALL}`)],
  ['window-anime', re(String.raw`\bwindow${DOT}anime\b`)],
  // Matched from the plain dot, so the lookbehind also has to step over the ? of ?.
  ['animate-call', re(String.raw`(?<!\b(?:RFMotion|anime)\s*\??)\.\s*animate${CALL}`)],
  ['view-transition', /\bstartViewTransition\b/g],
  ['rfmotion-animate', rfMotion('animate')],
  ['rfmotion-play', rfMotion('play')],
  ['rfmotion-enter', rfMotion('enter')],
  ['rfmotion-transition', rfMotion('transition')],
];
const SHELL_CALL = re(String.raw`(?<![\w$.])(function\s+)?_shellTransition${CALL}`);
const VT_ATTR = /\bdata-rf-vt\b/g;

const PERSIST = /(?<![\w$])['"]?persist['"]?\s*:/g;
const COMMIT = /\bcommitStyles\b/g;
const TRANSFORM_KEY = /(?<=[{,]\s*)['"]?(?:x|y|z|translate[XYZ]|scale[XYZ]|rotate[\w$]*|skew[\w$]*)['"]?\s*:/g;
const ENGINE_ANIMATE = re(String.raw`(?<!\bwaapi\s*\??)\.\s*animate${CALL}`);
const FENCE_START = 'rf-motion:legacy-animate start';
const FENCE_END = 'rf-motion:legacy-animate end';

const blank = (s) => s.replace(/[^\n]/g, ' ');
const normalise = (path) => path.split(sep).join('/').replace(/^\.\//, '');
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// JS text with // and /* */ comments blanked; strings, template literals and regex
// literals are kept and skipped over, so '//' or '*/' inside them is not a comment.
// A / starts a regex at the start, after an operator or after one of these keywords.
const BEFORE_REGEX = new Set(['await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return', 'throw', 'typeof', 'void', 'yield']);
const WORD = /[\w$]+/y;

export function blankJsComments(text) {
  let out = '';
  let i = 0;
  let prev = ''; // last significant code character ('' also after a keyword), to tell a regex from a division
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && (next === '/' || next === '*')) {
      let end = next === '/' ? text.indexOf('\n', i) : text.indexOf('*/', i + 2);
      end = end < 0 ? text.length : next === '/' ? end : end + 2;
      out += blank(text.slice(i, end));
      i = end;
      continue;
    }
    let end = -1;
    if (ch === "'" || ch === '"' || ch === '`') {
      end = i + 1;
      while (end < text.length && text[end] !== ch && (ch === '`' || text[end] !== '\n')) end += text[end] === '\\' ? 2 : 1;
      end += 1;
    } else if (ch === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev))) {
      end = i + 1;
      let cls = false;
      while (end < text.length && text[end] !== '\n' && (cls || text[end] !== '/')) {
        if (text[end] === '\\') end += 1;
        else if (text[end] === '[') cls = true;
        else if (text[end] === ']') cls = false;
        end += 1;
      }
      end += 1;
    }
    if (end > i) {
      end = Math.min(end, text.length);
      out += text.slice(i, end);
      prev = 'x';
      i = end;
      continue;
    }
    WORD.lastIndex = i;
    const word = WORD.exec(text)?.[0];
    if (word) {
      prev = prev !== '.' && BEFORE_REGEX.has(word) ? '' : 'x'; // o.return is a property
      out += word;
      i += word.length;
      continue;
    }
    if (!/\s/.test(ch)) prev = ch;
    out += ch;
    i += 1;
  }
  return out;
}

export function blankComments(path, text) {
  if (!path.endsWith('.html')) return blankJsComments(text);
  const masked = text.replace(/\{#[\s\S]*?#\}/g, blank).replace(/<!--[\s\S]*?-->/g, blank);
  return masked.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_, open, body, close) => open + blankJsComments(body) + close);
}

// The first argument of the call whose '(' is at text[open], up to the top-level ',' or ')'.
function firstArgument(text, open) {
  let depth = 0;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
    } else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) {
      if (depth === 0) return text.slice(open + 1, i);
      depth--;
    } else if (ch === ',' && depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

const literal = (s) => /^\s*(['"])([^'"\\]*)\1\s*$/.exec(s)?.[2] ?? null;

function shellKeyOk(arg, keys) {
  if (keys.includes(literal(arg))) return true;
  const m = /^((?:[^?'"`]|'[^'\n]*'|"[^"\n]*")+)\?\s*('[^'\n]*'|"[^"\n]*")\s*:(.*)$/s.exec(arg);
  return Boolean(m && keys.includes(literal(m[2])) && keys.includes(literal(m[3])));
}

function outsideHits(path, text, allow, push) {
  const entries = allow.filter((a) => a.path === path);
  const seen = new Map();
  const found = [];
  for (const [rule, re] of OUTSIDE) for (const m of text.matchAll(re)) found.push({ rule, index: m.index, end: m.index + m[0].length });
  found.sort((a, b) => a.index - b.index);
  for (const f of found) {
    const homes = entries.filter((a) => a.rule === f.rule);
    if (!homes.length) { push(f.index, f.rule); continue; }
    const n = (seen.get(f.rule) || 0) + 1;
    seen.set(f.rule, n);
    const ok = homes.some((a) => {
      if (a.max && n > a.max) return false;
      if (a.within) {
        const span = functionSpan(text, a.within);
        if (!span || f.index < span[0] || f.index >= span[1]) return false;
      }
      return !a.names || a.names.includes(literal(firstArgument(text, f.end - 1)));
    });
    if (!ok) push(f.index, f.rule);
  }
  const shell = entries.find((a) => a.rule === 'shell-transition');
  if (shell) {
    let n = 0;
    for (const m of text.matchAll(SHELL_CALL)) {
      if (m[1]) continue; // the definition
      n += 1;
      if (n === shell.max + 1) push(m.index, 'shell-transition-count');
      if (!shellKeyOk(firstArgument(text, m.index + m[0].length - 1), shell.keys)) push(m.index, 'shell-transition-key');
    }
  }
  if (path.startsWith(`${T}/`)) for (const m of text.matchAll(VT_ATTR)) push(m.index, 'data-rf-vt');
}

function engineHits(raw, text, push) {
  const start = raw.indexOf(FENCE_START);
  const end = start < 0 ? -1 : raw.indexOf(FENCE_END, start);
  if (start >= 0 && end < 0) push(start, 'legacy-fence-unterminated');
  const fenced = (i) => end >= 0 && i > start && i < end;
  for (const m of text.matchAll(PERSIST)) push(m.index, 'persist');
  for (const m of text.matchAll(COMMIT)) push(m.index, 'commit-styles');
  for (const m of text.matchAll(TRANSFORM_KEY)) if (!fenced(m.index)) push(m.index, 'transform-key');
  let inFence = 0;
  for (const m of text.matchAll(ENGINE_ANIMATE)) {
    if (fenced(m.index) && ++inFence <= 1) continue;
    push(m.index, 'animate-call');
  }
}

export function motionCallHits(files, allow = ALLOW) {
  const hits = [];
  for (const file of files) {
    const path = normalise(file.path);
    const text = blankComments(path, file.text);
    const found = [];
    const push = (index, rule) => found.push({ index, rule });
    if (path === MOTION) engineHits(file.text, text, push);
    else outsideHits(path, text, allow, push);
    found.sort((a, b) => a.index - b.index);
    for (const f of found) hits.push({ path, line: lineOf(text, f.index), rule: f.rule });
  }
  return hits;
}

const ROOTS = [
  { root: JS, ext: /\.js$/ },
  { root: T, ext: /\.html$/ },
];
const SKIP = (rel) => rel.startsWith(`${JS}/vendor/`) || rel === `${JS}/vendor` || rel === `${JS}/htmx.min.js`;

function walk(abs, rel, ext, out) {
  const st = statSync(abs, { throwIfNoEntry: false });
  if (!st || SKIP(rel)) return;
  if (st.isDirectory()) {
    for (const name of readdirSync(abs).sort()) walk(join(abs, name), `${rel}/${name}`, ext, out);
  } else if (ext.test(rel)) {
    out.push({ path: rel, text: readFileSync(abs, 'utf8') });
  }
}

export function sourceFiles(repo) {
  const out = [];
  for (const { root, ext } of ROOTS) walk(join(repo, root), root, ext, out);
  return out;
}

function main() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const files = sourceFiles(repo);
  const hits = motionCallHits(files);
  if (!hits.length) {
    console.log(`motion-calls: OK (${files.length} files)`);
    return 0;
  }
  console.log('motion-calls: FAIL');
  for (const h of hits) console.log(`${h.path}:${h.line} ${h.rule}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

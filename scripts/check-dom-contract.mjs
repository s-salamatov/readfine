// DOM contract check (design §5.5).
//
// docs/ui-dom-contract.md lists every id, data-* attribute and class that the app's JS,
// tests/js, Playwright and the backend tests select by. This script extracts those
// selectors from the code and checks the file against them:
//   missing     used in code, not in the contract;
//   unused      in the contract, not used by any consumer;
//   unrendered  in the contract, but neither in the rendered HTML of the fixed page set
//               (backend/tests/fixtures/dom_contract, .../offline_drift) nor as a literal
//               or prefix in a template, a JS string or a Python string.
//
// Extraction is regex based on a copy of the source with comments removed and string
// contents masked, so a selector call is only found in code, never inside a string.
// A value built at runtime keeps its literal head as a prefix pattern:
// getElementById('article-row-' + id) and `#article-row-${id}` give `article-row-*`;
// an id ending in -<digits> (a test's 'id="ai-summary-10"') is the same pattern.
// A value whose head is unknown (sid + '-value') gives nothing.
//
// Usage: node scripts/check-dom-contract.mjs [--write] [--why]
//   --write  regenerate docs/ui-dom-contract.md from the code, then check it
//   --why    print how each item is verified (rendered page, template, js, py)
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KINDS = ['id', 'data', 'class'];
const PH = '\u0000'; // stands for a value only known at runtime

// ---------------------------------------------------------------- source masking

// Returns { code, masked }: `code` is the text with comments blanked, `masked` also has
// the contents of string and template literals blanked. Offsets are kept.
function scanJs(text) {
  const code = text.split('');
  const masked = text.split('');
  const blank = (arr, a, b) => { for (let k = a; k < b; k++) if (arr[k] !== '\n') arr[k] = ' '; };
  let i = 0;
  let prevSignificant = '';
  const regexAllowedAfter = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(code, i, stop); blank(masked, i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(code, i, stop); blank(masked, i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(text, i);
      blank(masked, i + 1, end - 1);
      i = end;
      prevSignificant = 'a';
      continue;
    }
    if (ch === '/' && regexAllowedAfter.has(prevSignificant)) {
      // regex literal
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j++;
      }
      blank(masked, i + 1, j);
      i = j + 1;
      prevSignificant = 'a';
      continue;
    }
    if (!/\s/.test(ch)) prevSignificant = /[\w$)\].]/.test(ch) ? 'a' : ch;
    i++;
  }
  return { code: code.join(''), masked: masked.join('') };
}

// Index just past the string or template literal that starts at `start`.
function skipString(text, start) {
  const q = text[start];
  let j = start + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') { j += 2; continue; }
    if (c === q) return j + 1;
    if (q !== '`' && c === '\n') return j;
    if (q === '`' && c === '$' && text[j + 1] === '{') {
      j = skipBraces(text, j + 1);
      continue;
    }
    j++;
  }
  return j;
}

// Index just past the brace group that opens at `open` (text[open] === '{').
function skipBraces(text, open) {
  let depth = 0;
  let j = open;
  while (j < text.length) {
    const c = text[j];
    if (c === '"' || c === "'" || c === '`') { j = skipString(text, j); continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return j + 1; }
    j++;
  }
  return j;
}

function scanPy(text) {
  const masked = text.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (masked[k] !== '\n') masked[k] = ' '; };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '#') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const triple = text.startsWith(ch.repeat(3), i);
      const q = triple ? ch.repeat(3) : ch;
      let j = i + q.length;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text.startsWith(q, j)) break;
        if (!triple && text[j] === '\n') break;
        j++;
      }
      blank(i + q.length, j);
      i = j + q.length;
      continue;
    }
    i++;
  }
  return { code: text, masked: masked.join('') };
}

// Index of the parenthesis that closes the one at `open`, or -1.
function closeParen(text, open) {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    const c = text[j];
    if (c === '"' || c === "'" || c === '`') { j = skipString(text, j) - 1; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return j; }
  }
  return -1;
}

// ---------------------------------------------------------------- JS expressions

// Splits a call's argument text at top-level commas.
function splitArgs(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let j = 0; j < text.length; j++) {
    const c = text[j];
    if (c === '"' || c === "'" || c === '`') { j = skipString(text, j) - 1; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { out.push(text.slice(start, j)); start = j + 1; }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim());
}

function unescapeJs(s) {
  return s.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' }[c] ?? c));
}

// Value of a template literal body, `${...}` parts replaced by PH.
function templateValue(body) {
  let out = '';
  for (let j = 0; j < body.length; j++) {
    if (body[j] === '\\') { out += body[j + 1] ?? ''; j++; continue; }
    if (body[j] === '$' && body[j + 1] === '{') {
      j = skipBraces(body, j + 1) - 1;
      out += PH;
      continue;
    }
    out += body[j];
  }
  return out;
}

function tokenizeExpr(expr) {
  const toks = [];
  let cur = '';
  const flush = () => { if (cur.trim()) toks.push({ other: cur.trim() }); cur = ''; };
  for (let j = 0; j < expr.length; j++) {
    const c = expr[j];
    if ((c === '"' || c === "'" || c === '`') && !cur.trim()) {
      const end = skipString(expr, j);
      const body = expr.slice(j + 1, end - 1);
      toks.push({ lit: c === '`' ? templateValue(body) : unescapeJs(body) });
      cur = '';
      j = end - 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(expr, j);
      cur += expr.slice(j, end);
      j = end - 1;
      continue;
    }
    if (c === '(' && !cur.trim()) {
      const end = closeParen(expr, j);
      const stop = end === -1 ? expr.length : end;
      toks.push({ group: expr.slice(j + 1, stop) });
      j = stop;
      continue;
    }
    if (c === '(' || c === '[') {
      const end = closeParen(expr, j);
      const stop = end === -1 ? expr.length : end;
      cur += expr.slice(j, stop + 1);
      j = stop;
      continue;
    }
    if (c === '+' && expr[j + 1] !== '+' && expr[j + 1] !== '=' && expr[j - 1] !== '+') { flush(); toks.push({ op: '+' }); continue; }
    if (c === '?' && expr[j + 1] !== '.' && expr[j + 1] !== '?') { flush(); toks.push({ sep: true }); continue; }
    if (c === '?' && expr[j + 1] === '?') { flush(); toks.push({ sep: true }); j++; continue; }
    if (c === ':') { flush(); toks.push({ sep: true }); continue; }
    if ((c === '|' || c === '&') && expr[j + 1] === c) { flush(); toks.push({ sep: true }); j++; continue; }
    cur += c;
  }
  flush();
  return toks;
}

// Possible string values of a JS expression: each ternary / || branch that is a
// concatenation of operands with at least one known string. Unknown operands are PH.
function exprValues(expr, consts) {
  const branches = [[]];
  for (const t of tokenizeExpr(expr)) {
    if (t.sep) branches.push([]);
    else branches[branches.length - 1].push(t);
  }
  const out = [];
  for (const b of branches) {
    if (!b.length || b.length % 2 === 0) continue;
    let ok = true;
    let known = false;
    let value = '';
    for (let k = 0; k < b.length; k++) {
      const t = b[k];
      if (k % 2 === 1) { if (!t.op) ok = false; continue; }
      if (t.op) { ok = false; continue; }
      if (t.lit !== undefined) { value += t.lit; known = true; }
      else if (t.group !== undefined) {
        const inner = exprValues(t.group, consts);
        if (inner.length === 1) { value += inner[0]; known = true; } else value += PH;
      } else if (/^[A-Za-z_$][\w$]*$/.test(t.other) && consts.has(t.other)) {
        value += consts.get(t.other);
        known = true;
      } else value += PH;
    }
    if (ok && known) out.push(value);
  }
  return out;
}

// const NAME = '<literal>' declarations in a file, for selectors kept in constants; the
// value may concatenate earlier constants (CONTENT_ID = INLINE_ID + '-content').
// A name declared twice with different values is dropped.
function jsConsts(code) {
  const seen = new Map();
  const known = () => new Map([...seen].filter(([, v]) => v !== null));
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*((?:'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`[^`$\n]*`|[A-Za-z_$][\w$]*)(?:\s*\+\s*(?:'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|[A-Za-z_$][\w$]*))*)\s*[;,\n]/g;
  for (const m of code.matchAll(re)) {
    const values = exprValues(m[2], known());
    const v = values.length === 1 && !values[0].includes(PH) ? values[0] : null;
    if (v === null) continue;
    if (seen.has(m[1]) && seen.get(m[1]) !== v) seen.set(m[1], null);
    else seen.set(m[1], v);
  }
  return known();
}

// ---------------------------------------------------------------- value normalisation

// An id value -> contract item, or null when its head is unknown.
function idItem(value) {
  const v = value.trim();
  const at = v.indexOf(PH);
  if (at === 0) return null;
  if (at > 0) return v.slice(0, at) + '*';
  if (!v || /\s/.test(v)) return null;
  const n = /^(.+-)\d+$/.exec(v);
  return n ? n[1] + '*' : v;
}

// A class or data-* name -> item; a runtime tail makes a prefix pattern.
function nameItem(value) {
  const at = value.indexOf(PH);
  if (at === 0) return null;
  if (at > 0) return value.slice(0, at) + '*';
  return value || null;
}

// A CSS identifier, escapes included ('.sm\\:hidden' is the class `sm:hidden`).
const IDENT = /^-?(?:[A-Za-z_]|\\[^\n])(?:[\w-]|\\[^\n])*/;

// Items named by a CSS selector string (PH marks runtime parts).
export function selectorItems(sel) {
  const out = [];
  const readIdent = (j) => {
    const m = IDENT.exec(sel.slice(j));
    if (!m) return null;
    const tail = sel[j + m[0].length] === PH ? PH : '';
    return { name: m[0].replace(/\\(.)/g, '$1') + tail, end: j + m[0].length };
  };
  for (let j = 0; j < sel.length; j++) {
    const c = sel[j];
    if (c === '"' || c === "'") {
      const end = sel.indexOf(c, j + 1);
      j = end === -1 ? sel.length : end;
      continue;
    }
    if (c === '#' || c === '.') {
      const r = readIdent(j + 1);
      if (!r) continue;
      const item = c === '#' ? idItem(r.name) : nameItem(r.name);
      if (item) out.push({ item, kind: c === '#' ? 'id' : 'class' });
      j = r.end - 1;
      continue;
    }
    if (c === '[') {
      const end = sel.indexOf(']', j);
      const body = sel.slice(j + 1, end === -1 ? sel.length : end);
      const m = /^\s*([\w-]+(?:\u0000)?)\s*(?:([~^$*|]?=)\s*(["']?)(.*?)\3\s*(?:[is])?\s*)?$/.exec(body);
      if (m) {
        const [, name, op, , value] = m;
        if (name.startsWith('data-')) {
          const item = nameItem(name);
          if (item) out.push({ item, kind: 'data' });
        } else if (name === 'id' && (op === '=' || op === '^=') && value) {
          const item = op === '^=' ? nameItem(value + PH) : idItem(value);
          if (item) out.push({ item, kind: 'id' });
        } else if (name === 'class' && op === '~=' && value) {
          const item = nameItem(value);
          if (item) out.push({ item, kind: 'class' });
        }
      }
      j = end === -1 ? sel.length : end;
    }
  }
  return out;
}

function kebab(camel) {
  return 'data-' + camel.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

// ---------------------------------------------------------------- extraction

const JS_CALLS = {
  getElementById: 'id',
  getElementsByClassName: 'classes',
  querySelector: 'selector',
  querySelectorAll: 'selector',
  closest: 'selector',
  matches: 'selector',
  locator: 'selector',
  waitForSelector: 'selector',
  $: 'selector',
  $$: 'selector',
  $eval: 'selector',
  $$eval: 'selector',
};
// Playwright page methods that take a selector first (page.fill('#email', …)). On other
// receivers the first argument is a key or text ('Enter'), which names no item.
for (const name of ['click', 'dblclick', 'fill', 'check', 'uncheck', 'hover', 'tap', 'press', 'type', 'focus',
  'selectOption', 'setInputFiles', 'isVisible', 'isHidden', 'isChecked', 'isEnabled', 'textContent',
  'innerText', 'innerHTML', 'inputValue']) JS_CALLS[name] = 'selector';
const CALL_RE = new RegExp(`\\.(${Object.keys(JS_CALLS).sort((a, b) => b.length - a.length).map((n) => n.replace(/\$/g, '\\$')).join('|')})\\s*\\(`, 'g');

// String and template literals of comment-free code: [{ at, value }].
function jsLiterals(code, masked) {
  const out = [];
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c !== '"' && c !== "'" && c !== '`') continue;
    const end = skipString(code, i);
    const body = code.slice(i + 1, end - 1);
    out.push({ at: i, value: c === '`' ? templateValue(body) : unescapeJs(body) });
    i = end - 1;
  }
  return out;
}

function extractJs(text) {
  const { code, masked } = scanJs(text);
  const consts = jsConsts(code);
  const hits = [];
  // Selectors that reach the DOM through a helper, a constant or a map:
  // _kbArticleControl('[data-header-read]'), _detailMenuControl(id, 'data-header-read'),
  // getAttribute('data-x'), toHaveAttribute('data-x'). A literal holding an attribute
  // selector is parsed whole; a literal that is exactly a data-* name is that attribute.
  for (const lit of jsLiterals(code, masked)) {
    const v = lit.value.trim();
    if (/^data-[a-z0-9][a-z0-9-]*$/.test(v)) hits.push({ at: lit.at, item: v, kind: 'data' });
    else if (/\[data-[a-z0-9]/.test(v) && /^[\w\s#.[\]="'^$*~|:(),>+\-\\\u0000]+$/.test(v)) {
      for (const s of selectorItems(v)) hits.push({ at: lit.at, ...s });
    }
  }
  // htmx.ajax(..., { target: '#catchup-estimate' }): htmx resolves the selector.
  for (const m of masked.matchAll(/\b(?:target|select|source)\s*:\s*(?=["'`])/g)) {
    const at = m.index + m[0].length;
    let end = at;
    for (let depth = 0; end < code.length; end++) {
      const c = code[end];
      if (c === '"' || c === "'" || c === '`') { end = skipString(code, end) - 1; continue; }
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
      else if ((c === ',' || c === ';' || c === '\n') && depth === 0) break;
    }
    for (const value of exprValues(code.slice(at, end), consts)) {
      if (/^\s*[#.[]/.test(value)) for (const s of selectorItems(value)) hits.push({ at, ...s });
    }
  }
  // A test's own $('#settings') / $$('.row') helper around querySelector(All).
  for (const m of masked.matchAll(/(?<![\w$.])\$\$?\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = closeParen(code, open);
    if (close === -1) continue;
    const first = splitArgs(code.slice(open + 1, close))[0];
    for (const value of first ? exprValues(first, consts) : []) {
      for (const s of selectorItems(value)) hits.push({ at: m.index, ...s });
    }
  }
  for (const m of masked.matchAll(CALL_RE)) {
    const open = m.index + m[0].length - 1;
    const close = closeParen(code, open);
    if (close === -1) continue;
    const first = splitArgs(code.slice(open + 1, close))[0];
    if (!first) continue;
    const how = JS_CALLS[m[1]];
    for (const value of exprValues(first, consts)) {
      if (how === 'id') {
        const item = idItem(value);
        if (item) hits.push({ at: m.index, item, kind: 'id' });
      } else if (how === 'classes') {
        for (const name of value.split(/\s+/).filter(Boolean)) {
          const item = nameItem(name);
          if (item) hits.push({ at: m.index, item, kind: 'class' });
        }
      } else {
        for (const s of selectorItems(value)) hits.push({ at: m.index, ...s });
      }
    }
  }
  for (const m of masked.matchAll(/\.dataset\.([A-Za-z_$][\w$]*)/g)) {
    hits.push({ at: m.index, item: kebab(m[1]), kind: 'data' });
  }
  return hits;
}

// Python string literals: { at, end, value } with f-string fields replaced by PH.
function pyStrings(text) {
  const out = [];
  const re = /(?<![\w])([rRbBfF]{0,2})("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/g;
  for (const m of text.matchAll(re)) {
    const prefix = m[1].toLowerCase();
    const q = m[2].startsWith('"""') || m[2].startsWith("'''") ? 3 : 1;
    let v = m[2].slice(q, -q);
    if (!prefix.includes('r')) v = v.replace(/\\(.)/g, '$1');
    if (prefix.includes('f')) v = v.replace(/\{\{/g, '\u0001').replace(/\}\}/g, '\u0002').replace(/\{[^{}]*\}/g, PH).replace(/\u0001/g, '{').replace(/\u0002/g, '}');
    out.push({ at: m.index, end: m.index + m[0].length, value: v });
  }
  return out;
}

function extractPy(text) {
  const { masked } = scanPy(text);
  const strings = pyStrings(text);
  const stringAt = (pos) => strings.find((s) => s.at >= pos && /^\s*$/.test(text.slice(pos, s.at)));
  const hits = [];
  for (const m of masked.matchAll(/\.(select|select_one)\s*\(/g)) {
    const s = stringAt(m.index + m[0].length);
    if (s) for (const it of selectorItems(s.value)) hits.push({ at: m.index, ...it });
  }
  for (const m of masked.matchAll(/\.(find|find_all)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = closeParen(text, open);
    if (close === -1) continue;
    const inside = strings.filter((s) => s.at > open && s.end <= close);
    for (const s of inside) {
      const before = text.slice(open + 1, s.at);
      if (/\bid_?\s*=\s*[rRbBfF]{0,2}$/.test(before) || /["']id["']\s*:\s*[rRbBfF]{0,2}$/.test(before)) {
        const item = idItem(s.value);
        if (item) hits.push({ at: s.at, item, kind: 'id' });
      } else if (/\bclass_\s*=\s*[rRbBfF]{0,2}$/.test(before)) {
        for (const name of s.value.split(/\s+/).filter(Boolean)) {
          const item = nameItem(name);
          if (item) hits.push({ at: s.at, item, kind: 'class' });
        }
      } else if (/^data-[\w-]+$/.test(s.value) && /^\s*:/.test(text.slice(s.end))) {
        hits.push({ at: s.at, item: s.value, kind: 'data' });
      }
    }
  }
  // 'id="..."' in resp.text  /  'data-x="..."' not in body
  for (const s of strings) {
    if (!/^\s+(?:not\s+)?in\b/.test(text.slice(s.end))) continue;
    for (const m of s.value.matchAll(/(?:^|[\s<])id=["']?([\w:.\-\u0000]*)(["']?)/g)) {
      const value = m[2] ? m[1] : m[1] + PH;
      const item = idItem(value);
      if (item) hits.push({ at: s.at + m.index, item, kind: 'id' });
    }
    for (const m of s.value.matchAll(/(?:^|[\s<])(data-[a-z0-9][a-z0-9-]*)(?=[\s=>"'/]|$)/g)) {
      hits.push({ at: s.at + m.index, item: m[1], kind: 'data' });
    }
  }
  return hits;
}

// [{ path, text }] -> [{ item, kind, path }], in source order, one per item and file.
export function extract(files) {
  const out = [];
  for (const { path, text } of files) {
    const hits = path.endsWith('.py') ? extractPy(text) : extractJs(text);
    hits.sort((a, b) => a.at - b.at);
    const seen = new Set();
    for (const h of hits) {
      const key = h.kind + PH + h.item;
      // data-hx-* is htmx's spelling of its own hx-* attributes (app.js reads
      // getAttribute('data-hx-trigger') as a fallback); htmx's API, not the app's DOM.
      if (h.kind === 'data' && h.item.startsWith('data-hx-')) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ item: h.item, kind: h.kind, path });
    }
  }
  return out;
}

// ---------------------------------------------------------------- markup facts

// Ids, classes and data-* names a text renders, as literals and prefixes ('p*').
function emptyFacts() {
  return { id: new Set(), class: new Set(), data: new Set() };
}

// Values that template variables can take, for ids composed in a template
// (id="{{ selector_id }}-value", id="folder-move-{{ dir }}-{{ uf.folder.id }}"):
// keyword arguments and assignments name="lit" (a trailing `~` / `+` makes the value a
// prefix), `| default("lit")`, `{% for a, ... in [("lit", ...), ...] %}` and positional
// string arguments of `{% macro %}` calls. Values are literals or prefixes ('p*').
export function templateVars(files) {
  const vars = new Map();
  const add = (name, value) => {
    if (!value) return;
    if (!vars.has(name)) vars.set(name, new Set());
    vars.get(name).add(value);
  };
  const macros = new Map();
  for (const { text } of files) {
    for (const m of text.matchAll(/\{%-?\s*macro\s+(\w+)\s*\(([^)]*)\)/g)) {
      macros.set(m[1], splitArgs(m[2]).map((p) => p.split('=')[0].trim()));
    }
  }
  for (const { text } of files) {
    for (const m of text.matchAll(/\b(\w+)\s*=\s*(["'])([^"'{}<>\n]*)\2(\s*[~+])?/g)) add(m[1], m[3] + (m[4] ? '*' : ''));
    for (const m of text.matchAll(/\b(\w+)\s*\|\s*default\(\s*(["'])([^"'\n]*)\2/g)) add(m[1], m[3]);
    for (const m of text.matchAll(/\{%-?\s*for\s+(\w+)(?:\s*,\s*\w+)*\s+in\s+\[([\s\S]*?)\]\s*-?%\}/g)) {
      const tuples = [...m[2].matchAll(/\(\s*(["'])([^"'\n]*)\1/g)];
      const items = tuples.length ? tuples : [...m[2].matchAll(/(["'])([^"'\n]*)\1/g)];
      for (const t of items) add(m[1], t[2]);
    }
    for (const [name, params] of macros) {
      for (const m of text.matchAll(new RegExp(`(?<![\\w.])${name}\\s*\\(`, 'g'))) {
        const open = m.index + m[0].length - 1;
        const close = closeParen(text, open);
        if (close === -1) continue;
        splitArgs(text.slice(open + 1, close)).forEach((arg, k) => {
          const lit = /^(["'])([^"'{}<>\n]*)\1(\s*[~+])?/.exec(arg);
          if (lit && params[k] && !arg.includes('=')) add(params[k], lit[2] + (lit[3] ? '*' : ''));
        });
      }
    }
  }
  return vars;
}

// The id values that start at `j` and end at `quote`: literals when the value is fully
// known, else prefixes. `{{ name }}` expands to the known values of `name`.
function idValuesAt(text, j, quote, vars) {
  let partials = [''];
  let k = j;
  const done = [];
  for (;;) {
    const m = /^[\w:.\-]*/.exec(text.slice(k));
    partials = partials.map((p) => p + m[0]);
    k += m[0].length;
    if (text.startsWith(quote, k)) { done.push(...partials); break; }
    const tag = /^\{\{-?\s*([\w.]+)\s*-?\}\}/.exec(text.slice(k));
    const values = tag && vars?.get(tag[1]);
    if (!values) { done.push(...partials.filter(Boolean).map((p) => p + '*')); break; }
    const next = [];
    for (const p of partials) {
      for (const v of values) {
        if (v.endsWith('*')) done.push(p + v);
        else next.push(p + v);
      }
    }
    partials = next.slice(0, 64);
    if (!partials.length) break;
    k += tag[0].length;
  }
  return done.filter((v) => v && v !== '*');
}

// The class attribute value that starts at `j` and ends at `quote`; template tags and
// `${}` become PH, quoted strings inside them are kept as extra tokens.
function classTokensAt(text, j, quote) {
  let value = '';
  const extra = [];
  let k = j;
  while (k < text.length) {
    if (text.startsWith('{{', k) || text.startsWith('{%', k) || text.startsWith('${', k)) {
      const closeTok = text.startsWith('{{', k) ? '}}' : text.startsWith('{%', k) ? '%}' : '}';
      const end = closeTok === '}' ? skipBraces(text, k + 1) : text.indexOf(closeTok, k + 2) + closeTok.length;
      if (end <= k) break;
      const inner = text.slice(k + 2, end - closeTok.length);
      for (const s of inner.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)) extra.push(...(s[1] ?? s[2]).split(/\s+/));
      value += text.startsWith('{%', k) ? ' ' : PH;
      k = end;
      continue;
    }
    if (text.startsWith(quote, k) && text[k - 1] !== '\\') break;
    if (text[k] === '\n' && quote !== '"' && quote !== '`') break;
    value += text[k];
    k++;
  }
  const out = [];
  for (const raw of [...value.split(/\s+/), ...extra]) {
    const t = raw.replace(/^[('"`]+|[)'"`,;]+$/g, '');
    // {{ cond_off }}search-score-cond: the variable is a class list of its own, the
    // rest is a class.
    const u = t.replace(/^\u0000+/, '');
    if (!u) continue;
    const at = u.indexOf(PH);
    out.push(at > 0 ? u.slice(0, at) + '*' : u);
  }
  return out;
}

function addFacts(facts, text, { loose = false, vars = null, path = '' } = {}) {
  for (const m of text.matchAll(/(?<![\w-])id\s*=\s*\\?(["'`])/g)) {
    for (const v of idValuesAt(text, m.index + m[0].length, m[1], vars)) facts.id.add(v);
  }
  for (const m of text.matchAll(/\.id\s*=\s*(["'`])|setAttribute\(\s*["']id["']\s*,\s*(["'`])/g)) {
    for (const v of idValuesAt(text, m.index + m[0].length, m[1] ?? m[2], null)) facts.id.add(v);
  }
  if (/\.(?:m?js)$/.test(path)) {
    // el.id = INLINE_ID, with const INLINE_ID = 'inline-article-detail'
    const consts = jsConsts(scanJs(text).code);
    for (const m of text.matchAll(/\.id\s*=\s*([A-Za-z_$][\w$]*)\s*[;\n]/g)) {
      if (consts.has(m[1])) facts.id.add(consts.get(m[1]));
    }
  }
  for (const m of text.matchAll(/(?<![\w-])(?:class|className|class_)\s*\+?=\s*\\?(["'`])/g)) {
    for (const t of classTokensAt(text, m.index + m[0].length, m[1])) facts.class.add(t);
  }
  for (const m of text.matchAll(/classList\.(?:add|toggle|replace)\(([^)]*)\)/g)) {
    for (const s of m[1].matchAll(/'([^']*)'|"([^"]*)"/g)) facts.class.add(s[1] ?? s[2]);
  }
  for (const m of text.matchAll(/(?<![\w\-[])(data-[a-z0-9][a-z0-9-]*)(?=\s*=|[\s>"'/{]|$)/gm)) {
    const before = text.slice(Math.max(0, m.index - 20), m.index);
    if (/(?:get|has|remove)Attribute\(\s*["']$/.test(before)) continue;
    facts.data.add(m[1]);
  }
  for (const m of text.matchAll(/(?<![\w\-[])(data-[a-z0-9][a-z0-9-]*-)(?:\{\{|\$\{|\{|["']\s*\+)/g)) facts.data.add(m[1] + '*');
  for (const m of text.matchAll(/\.dataset\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) facts.data.add(kebab(m[1]));
  if (loose) {
    // A class named as a whole word inside any quoted string (a macro argument, a JS or
    // Python class string): "a literal in a template".
    for (const m of text.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)) {
      for (const t of (m[1] ?? m[2] ?? m[3]).split(/[\s]+/)) if (/^-?[A-Za-z_][\w-]*$/.test(t)) facts.class.add(t);
    }
  }
  return facts;
}

function satisfies(set, item) {
  if (set.has(item)) return true;
  const isPrefix = item.endsWith('*');
  const head = isPrefix ? item.slice(0, -1) : item;
  for (const v of set) {
    if (v.endsWith('*')) {
      const p = v.slice(0, -1);
      if (!p) continue;
      if (isPrefix ? p.startsWith(head) : head.startsWith(p)) return true;
    } else if (isPrefix && v.startsWith(head)) return true;
  }
  return false;
}

function factsOf(files, opts = {}) {
  const facts = emptyFacts();
  const vars = templateVars(files);
  for (const f of files) addFacts(facts, f.text, { ...opts, vars, path: f.path });
  return facts;
}

// How an entry is verified: 'rendered', 'code' or null.
function verifiedBy(entry, renderedFacts, codeFacts) {
  if (satisfies(renderedFacts[entry.kind], entry.item)) return 'rendered';
  if (satisfies(codeFacts[entry.kind], entry.item)) return 'code';
  return null;
}

// contract: [{ item, kind }]; extracted: [{ item, kind, path }];
// sources: { rendered: [{ path, text }], code: [{ path, text }] }.
export function verify(contract, extracted, sources) {
  const key = (e) => e.kind + PH + e.item;
  const listed = new Set(contract.map(key));
  const used = new Set(extracted.map(key));
  const missing = [];
  const seenMissing = new Set();
  for (const e of extracted) {
    const k = key(e) + PH + e.path;
    if (listed.has(key(e)) || seenMissing.has(k)) continue;
    seenMissing.add(k);
    missing.push({ item: e.item, kind: e.kind, path: e.path });
  }
  const unused = contract.filter((e) => !used.has(key(e))).map(({ item, kind }) => ({ item, kind }));
  const renderedFacts = factsOf(sources.rendered ?? []);
  const codeFacts = factsOf(sources.code ?? [], { loose: true });
  const unrendered = contract
    .filter((e) => !verifiedBy(e, renderedFacts, codeFacts))
    .map(({ item, kind }) => ({ item, kind }));
  return { missing, unused, unrendered };
}

// A test that selects an element its own fixture markup creates (keyboard-shortcuts'
// `<input id="x">`, a readability test's `<a id="footnote-1">`) depends on itself, not on
// the app, unless the app renders the same item too. Such items are dropped. An item the
// app stops rendering (a rename) is then dropped as well, and its entry fails as unused.
export function dropTestLocal(extracted, consumers, producers) {
  const producerFacts = factsOf(producers, { loose: true });
  const own = new Map();
  for (const f of consumers) {
    if (!/^(tests|backend\/tests)\//.test(f.path)) continue;
    const text = f.path.endsWith('.py') ? pyStrings(f.text).map((s) => s.value).join('\n') : f.text;
    own.set(f.path, factsOf([{ path: '', text }]));
  }
  return extracted.filter((e) => {
    const facts = own.get(e.path);
    if (!facts || !satisfies(facts[e.kind], e.item)) return true;
    return satisfies(producerFacts[e.kind], e.item);
  });
}

// ---------------------------------------------------------------- contract file

export function parseContract(markdown) {
  const out = [];
  // kind is `id`, `data` (also written `data-*`) or `class`.
  const row = /^\|\s*`([^`]+)`\s*\|\s*(id|data|data-\*|class)\s*\|\s*(.*?)\s*\|\s*$/;
  for (const line of markdown.split('\n')) {
    const m = row.exec(line);
    if (m) out.push({ item: m[1], kind: m[2] === 'data-*' ? 'data' : m[2], consumers: m[3].split(',').map((s) => s.trim()).filter(Boolean) });
    else if (/^\|\s*`/.test(line)) throw new Error(`unreadable contract row: ${line}`);
  }
  return out;
}

const HEADER = `# UI DOM contract

Status: as-built, generated by \`node scripts/check-dom-contract.mjs --write\` and checked
by \`node scripts/check-dom-contract.mjs\` (design §5.5,
\`docs/arh-w-dev/designs/2026-11-19-ui-redesign-design.md\`).

Every id, \`data-*\` attribute and class that the app's JS (\`static/js\`), \`tests/js\`,
Playwright (\`tests/e2e\`, \`tests/visual\`) or the backend tests select by is listed here
with its consumers.

Rules:

- **Rename an item only together with every consumer and its entry here.** A selector
  that code uses but this file does not list fails the check (\`missing\`); an entry no
  consumer uses fails it too (\`unused\`).
- Every entry must be rendered: present in a page under
  \`backend/tests/fixtures/dom_contract/\` or \`backend/tests/fixtures/offline_drift/\`, or,
  for entries not on those pages, a literal or prefix in a template, a JS string or a
  Python string (\`unrendered\` otherwise).
- \`item\` is a literal, a prefix pattern ending in \`*\` for a value built at runtime
  (\`'article-row-' + id\` is \`article-row-*\`), or a \`data-*\` attribute name.
- Do not edit entries by hand to hide a finding: a false positive is fixed in the
  extractor, a real one in the code. Regenerate with \`--write\` after a change and review
  the diff.
`;

const TITLES = { id: 'Ids', data: 'Data attributes (`data-*`)', class: 'Classes' };

function shortPath(p) {
  return p.startsWith('backend/app/') ? p.slice('backend/app/'.length) : p;
}

export function renderContract(extracted) {
  const byKey = new Map();
  for (const e of extracted) {
    const k = e.kind + PH + e.item;
    if (!byKey.has(k)) byKey.set(k, { item: e.item, kind: e.kind, consumers: new Set() });
    byKey.get(k).consumers.add(shortPath(e.path));
  }
  let md = HEADER;
  for (const kind of KINDS) {
    const rows = [...byKey.values()].filter((e) => e.kind === kind).sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
    md += `\n## ${TITLES[kind]} (${rows.length})\n\n| item | kind | consumers |\n|---|---|---|\n`;
    for (const r of rows) md += `| \`${r.item}\` | ${kind} | ${[...r.consumers].sort().join(', ')} |\n`;
  }
  return md;
}

// ---------------------------------------------------------------- CLI

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = 'docs/ui-dom-contract.md';

function walk(dir, accept, { vendor = false } = {}) {
  const abs = join(REPO, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const ent of readdirSync(abs, { withFileTypes: true, recursive: true })) {
    if (!ent.isFile()) continue;
    const full = join(ent.parentPath ?? ent.path, ent.name);
    const rel = relative(REPO, full).split(sep).join('/');
    if (rel.includes('/node_modules/') || rel.includes('/__pycache__/')) continue;
    if (!vendor && rel.includes('/vendor/')) continue;
    if (accept(rel)) out.push(rel);
  }
  return out.sort();
}

const read = (paths) => paths.map((path) => ({ path, text: readFileSync(join(REPO, path), 'utf8') }));

export function consumerPaths() {
  return [
    ...walk('backend/app/static/js', (p) => p.endsWith('.js') && !p.endsWith('htmx.min.js')),
    ...walk('tests/js', (p) => p.endsWith('.mjs')),
    ...walk('tests/e2e', (p) => p.endsWith('.mjs')),
    ...walk('tests/visual', (p) => p.endsWith('.mjs')),
    ...walk('backend/tests', (p) => p.endsWith('.py')),
  ];
}

function main(argv) {
  const write = argv.includes('--write');
  const why = argv.includes('--why');
  const rendered = read([
    ...walk('backend/tests/fixtures/dom_contract', (p) => p.endsWith('.html')),
    ...walk('backend/tests/fixtures/offline_drift', (p) => p.endsWith('.html')),
  ]);
  // Everything that can put an id, class or data-* into the page: templates, app JS
  // (vendored libraries and htmx included, they set classes such as htmx-request), app
  // Python, and the e2e seed, whose article bodies the e2e suite renders.
  const code = read([
    ...walk('backend/app/templates', (p) => p.endsWith('.html')),
    ...walk('backend/app/static/js', (p) => p.endsWith('.js'), { vendor: true }),
    ...walk('backend/app', (p) => p.endsWith('.py')),
    ...walk('tests/e2e/fixtures', (p) => p.endsWith('.py')),
  ]);
  const consumers = read(consumerPaths());
  const extracted = dropTestLocal(extract(consumers), consumers, [...rendered, ...code]);
  if (write) writeFileSync(join(REPO, CONTRACT), renderContract(extracted));
  if (!existsSync(join(REPO, CONTRACT))) {
    console.log(`dom-contract: FAIL\n${CONTRACT} not found (generate it with --write)`);
    return 1;
  }
  let contract;
  try {
    contract = parseContract(readFileSync(join(REPO, CONTRACT), 'utf8'));
  } catch (err) {
    console.log(`dom-contract: FAIL\n${err.message}`);
    return 1;
  }
  const r = verify(contract, extracted, { rendered, code });
  if (why) {
    const rf = factsOf(rendered);
    const cf = factsOf(code, { loose: true });
    const strict = factsOf(code);
    for (const e of contract) {
      const by = verifiedBy(e, rf, cf);
      const how = by === 'code' && !satisfies(strict[e.kind], e.item) ? 'code-loose' : by ?? 'none';
      console.log(`${how}\t${e.kind}\t${e.item}`);
    }
  }
  if (!r.missing.length && !r.unused.length && !r.unrendered.length) {
    console.log(`dom-contract: OK (${contract.length} items, ${rendered.length} rendered pages)`);
    return 0;
  }
  console.log('dom-contract: FAIL');
  for (const m of r.missing) console.log(`missing ${m.item} (${m.path})`);
  for (const u of r.unused) console.log(`unused ${u.item}`);
  for (const u of r.unrendered) console.log(`unrendered ${u.item}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

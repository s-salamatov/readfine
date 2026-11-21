// Fails when a gray-* utility in the built CSS resolves to a literal colour.
//
// Every gray utility has to go through var(--color-gray-N) so that the theme remap of
// those variables reaches it. With an opacity (bg-gray-50/50) Tailwind 4 writes a
// literal first and the color-mix(... var(--color-gray-N) ...) form inside
// @supports (color:color-mix(in lab, red, red)); that literal is a fallback, not a
// failure.
//
// Usage: node scripts/check-css-vars.mjs [file]   (default: the committed tailwind.css)
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GRAY_UTILITY = /^-?[a-z-]+-gray-(50|[1-9]00|950)(\/\d+)?$/;
const GRAY_VAR = /var\(--color-gray-(50|[1-9]00|950)\)/;

// Walks minified CSS and calls onRule(selector, declarations, inSupports) for every
// rule that holds declarations. At-rules that only wrap other rules are descended into.
function walkRules(css, onRule) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const stack = [];
  let start = 0;
  let depthInStrings = null;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (depthInStrings) {
      if (ch === '\\') i++;
      else if (ch === depthInStrings) depthInStrings = null;
      continue;
    }
    if (ch === '"' || ch === "'") { depthInStrings = ch; continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === '{') {
      stack.push({ prelude: stripped.slice(start, i).trim(), body: '', hasChild: false });
      start = i + 1;
    } else if (ch === '}') {
      const node = stack.pop();
      if (!node) { start = i + 1; continue; }
      const tail = stripped.slice(start, i).trim();
      if (!node.hasChild && node.prelude && !node.prelude.startsWith('@')) {
        const decls = tail.split(';').map((d) => d.trim()).filter(Boolean);
        const inSupports = stack.some((n) => n.prelude.startsWith('@supports'));
        onRule(node.prelude, decls, inSupports);
      }
      if (stack.length) stack[stack.length - 1].hasChild = true;
      start = i + 1;
    } else if (ch === ';' && stack.length === 0) {
      start = i + 1;
    }
  }
}

// Gray utility class names mentioned in a selector, unescaped, variants stripped.
function grayClasses(selector) {
  const out = [];
  for (const m of selector.matchAll(/\.((?:\\.|[^\s.:,>+~[\]{}()#])+)/g)) {
    const name = m[1].replace(/\\(.)/g, '$1');
    const base = name.slice(name.lastIndexOf(':') + 1);
    if (GRAY_UTILITY.test(base)) out.push(base);
  }
  return out;
}

export function grayLiterals(css) {
  const bySelector = new Map();
  walkRules(css, (selector, decls, inSupports) => {
    if (!grayClasses(selector).length) return;
    const entry = bySelector.get(selector) ?? { viaVar: false, varOnlyInSupports: true, literal: null };
    bySelector.set(selector, entry);
    const joined = decls.join(';');
    if (GRAY_VAR.test(joined)) {
      entry.viaVar = true;
      if (!inSupports) entry.varOnlyInSupports = false;
    } else if (entry.literal === null) {
      const first = decls[0] ?? '';
      entry.literal = first.slice(first.indexOf(':') + 1);
    }
  });
  const failures = [];
  let fallbacks = 0;
  for (const [selector, e] of bySelector) {
    if (e.viaVar) {
      if (e.literal !== null && e.varOnlyInSupports) fallbacks++;
    } else {
      failures.push({ selector, value: e.literal ?? '' });
    }
  }
  return { checked: bySelector.size, fallbacks, failures };
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const file = process.argv[2] ?? join(root, 'backend/app/static/css/tailwind.css');
  const { checked, fallbacks, failures } = grayLiterals(readFileSync(file, 'utf8'));
  if (failures.length) {
    console.log(`css-vars: FAIL — ${failures.length} of ${checked} gray utilities resolve to a literal colour`);
    for (const f of failures) console.log(`  ${f.selector} → ${f.value}`);
    process.exit(1);
  }
  console.log(`css-vars: OK — ${checked} gray utilities use var(--color-gray-*) (${fallbacks} with a literal @supports fallback)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

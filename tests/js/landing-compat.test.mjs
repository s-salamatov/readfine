// Per-instance landing.html copies are gitignored and the CSS build never scans them
// (input.css, `@source not`), so a live copy is styled only by what the committed
// tailwind.css happens to hold. input.css therefore also scans a frozen copy of the
// last pre-s8 example; this checks the committed CSS still covers it (s8-T6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATES = join(REPO, 'backend/app/templates');
const FIXTURE = join(REPO, 'backend/tests/fixtures/landing/landing-b07f8b6.html');
const CSS = join(REPO, 'backend/app/static/css/tailwind.css');

// Tokens of every class="…" attribute and "class": "…" macro attribute. Comments are
// skipped; so are Jinja expressions inside HTML, but macro attributes are read from
// inside them (`{{ button(…) }}`, `{% call card(…) %}`).
function classTokens(html) {
  const source = html.replace(/\{#[\s\S]*?#\}/g, ' ');
  const markup = source.replace(/\{%[\s\S]*?%\}|\{\{(?:(?!\}\})[^"])*\}\}/g, ' ');
  const values = [
    ...markup.matchAll(/\bclass\s*=\s*"([^"]*)"/g),
    ...source.matchAll(/"class"\s*:\s*"([^"]*)"/g),
  ];
  return new Set(values.flatMap((m) => m[1].split(/\s+/).filter(Boolean)));
}

// Every word of the current templates: Tailwind scans their raw text, so a class that
// is still written in one of them is in the build whatever the fixture does.
function templateWords() {
  const words = new Set();
  for (const name of readdirSync(TEMPLATES, { recursive: true })) {
    // landing.html is the gitignored live copy, which the build does not scan.
    if (!name.endsWith('.html') || name === 'landing.html') continue;
    for (const word of readFileSync(join(TEMPLATES, name), 'utf8').split(/[\s"'`<>]+/)) words.add(word);
  }
  return words;
}

// `.name` as Tailwind writes it (`:`, `/`, `[`, `.`, `%`, `(` and so on escaped), not
// followed by more of a longer name (`.gap-2` is not found in `.gap-20` or `.gap-2\.5`).
function hasSelector(css, token) {
  const selector = '.' + token.replace(/[^\w-]/g, '\\$&');
  for (let at = css.indexOf(selector); at !== -1; at = css.indexOf(selector, at + 1)) {
    if (!/[\w\\-]/.test(css.charAt(at + selector.length))) return true;
  }
  return false;
}

test('landing compat: every class of the b07f8b6 landing is in the built CSS', () => {
  const used = classTokens(readFileSync(FIXTURE, 'utf8'));
  // One from an HTML attribute, one from an expression, one from a call block.
  for (const token of ['dark:block', 'text-base', 'gap-1.5']) assert.ok(used.has(token), `not read from the fixture: ${token}`);
  const current = templateWords();
  const css = readFileSync(CSS, 'utf8');
  const missing = [...used].filter((t) => !current.has(t) && !hasSelector(css, t)).sort();
  assert.deepEqual(missing, [], `classes a live landing.html uses are not in tailwind.css: ${missing.join(' ')}`);
});

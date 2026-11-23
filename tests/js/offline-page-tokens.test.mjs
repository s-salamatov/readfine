// The worker's offline page (offline/templates.js offlinePage) takes its colours from
// the Neutral theme of styles/tokens.css. The page loads no stylesheet (it has to render
// with nothing but itself), so it carries a copy of five tokens; this test is what keeps
// the copy equal to the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOffline } from './harness.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKENS = join(REPO, 'styles', 'tokens.css');
const NAMES = ['--background', '--foreground', '--muted-foreground', '--primary', '--border'];
// The Neutral blocks, picked by selector: every theme block declares the same names.
const NEUTRAL_LIGHT = ':root, html[data-rf-theme="neutral"]';
const NEUTRAL_DARK = 'html.dark, html.dark[data-rf-theme="neutral"]';

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

// selector (whitespace collapsed) -> Map(custom property -> value), top-level rules only.
function tokenBlocks(css) {
  const out = new Map();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const props = new Map();
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) props.set(d[1], collapse(d[2]));
    out.set(collapse(m[1]), props);
  }
  return out;
}

// The custom properties the page declares on :root, outside and inside its dark query.
function pageTokens(html) {
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const dark = /@media \(prefers-color-scheme: ?dark\)\{:root\{([^}]*)\}\}/.exec(style);
  assert.ok(dark, 'the page has a prefers-color-scheme: dark block');
  const light = /(?:^|\}):root\{([^}]*)\}/.exec(style.replace(dark[0], ''));
  assert.ok(light, 'the page declares its light tokens on :root');
  const props = (body) => new Map([...body.matchAll(/(--[\w-]+):([^;]+)/g)].map((d) => [d[1], collapse(d[2])]));
  return { light: props(light[1]), dark: props(dark[1]) };
}

function mismatches(page, blocks) {
  const out = [];
  for (const [scheme, selector] of [['light', NEUTRAL_LIGHT], ['dark', NEUTRAL_DARK]]) {
    const source = blocks.get(selector);
    assert.ok(source, `tokens.css has the block ${selector}`);
    for (const name of NAMES) {
      if (page[scheme].get(name) !== source.get(name)) out.push(`${scheme} ${name}: page ${page[scheme].get(name)}, tokens.css ${source.get(name)}`);
    }
  }
  return out;
}

test('offline page: colours equal the Neutral tokens in light and dark', async () => {
  const RF = await loadOffline();
  const html = RF.templates.offlinePage('/settings');
  const page = pageTokens(html);
  const blocks = tokenBlocks(readFileSync(TOKENS, 'utf8'));
  assert.deepEqual(mismatches(page, blocks), []);
  // The page uses them: no colour literal outside the two token blocks.
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const rest = style.replace(/:root\{[^}]*\}/g, '');
  assert.doesNotMatch(rest, /#[0-9a-f]{3,8}\b|oklch\(|rgb\(/i);
  for (const name of NAMES) assert.match(rest, new RegExp('var\\(' + name + '\\)'), `${name} is used`);
  // A token changed in tokens.css (as if the theme moved on) is caught.
  const moved = tokenBlocks(readFileSync(TOKENS, 'utf8').replace('--muted-foreground: oklch(0.556 0 0);', '--muted-foreground: oklch(0.5 0 0);'));
  assert.deepEqual(mismatches(page, moved), ['light --muted-foreground: page oklch(0.556 0 0), tokens.css oklch(0.5 0 0)']);
});

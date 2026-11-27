// The theme is applied by init.js, the first script in <head>, before <body> exists:
// the colour scheme (.dark) and the app theme (data-rf-theme) are both per-device
// localStorage choices, and anything set later would paint a frame of the wrong one.
//
// Each test parses a page whose <head> runs the real init.js inline, followed by a
// probe script that records what the document looked like at that moment. Inline
// scripts run during parsing, so the probe sees the state before <body> is created.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INIT_JS = fs.readFileSync(path.join(ROOT, 'backend', 'app', 'static', 'js', 'init.js'), 'utf8');

function page({ storage = {}, prefersDark = false, headExtra = '' } = {}) {
  const html = '<!doctype html><html><head>'
    + headExtra
    + '<meta name="theme-color" content="#f9fafb">'
    + '<script>' + INIT_JS + '<\/script>'
    + '<script>window.__probe = { body: document.body,'
    + ' theme: document.documentElement.getAttribute("data-rf-theme"),'
    + ' dark: document.documentElement.classList.contains("dark") };<\/script>'
    + '</head><body></body></html>';
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://readfine.test/settings/preferences',
    beforeParse(w) {
      for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
      w.matchMedia = (q) => ({
        matches: q === '(prefers-color-scheme: dark)' ? prefersDark : false,
        media: q, addEventListener() {}, removeEventListener() {},
      });
    },
  });
  return dom.window;
}

test('theme: stored appTheme sets data-rf-theme before body; unknown falls back to neutral', () => {
  const paper = page({ storage: { appTheme: 'paper' } });
  assert.equal(paper.__probe.body, null, 'the probe runs before <body> exists');
  assert.equal(paper.__probe.theme, 'paper');
  assert.equal(paper.document.documentElement.dataset.rfTheme, 'paper');

  for (const storage of [{ appTheme: 'solarized' }, { appTheme: '' }, {}]) {
    const w = page({ storage });
    assert.equal(w.__probe.theme, 'neutral', 'appTheme ' + JSON.stringify(storage.appTheme));
  }
});

test('theme: colorScheme dark plus paper sets both', () => {
  const w = page({ storage: { colorScheme: 'dark', appTheme: 'paper' } });
  assert.equal(w.__probe.body, null);
  assert.equal(w.__probe.dark, true);
  assert.equal(w.__probe.theme, 'paper');

  // setAppTheme stores the choice and switches the attribute; the scheme is untouched.
  w.setAppTheme('graphite');
  assert.equal(w.localStorage.getItem('appTheme'), 'graphite');
  assert.equal(w.document.documentElement.dataset.rfTheme, 'graphite');
  assert.equal(w.document.documentElement.classList.contains('dark'), true);
  w.setAppTheme('bogus');
  assert.equal(w.document.documentElement.dataset.rfTheme, 'neutral');
});

test('theme: theme-color follows --background as hex', () => {
  const style = '<style>html[data-rf-theme=paper]{--background:#f5f5f4}'
    + 'html[data-rf-theme=graphite]{--background:#f8fafc}</style>';
  const w = page({ storage: { appTheme: 'paper' }, headExtra: style });
  const meta = () => w.document.querySelector('meta[name="theme-color"]').getAttribute('content');
  assert.equal(meta(), '#f5f5f4');
  w.setAppTheme('graphite');
  assert.equal(meta(), '#f8fafc');

  // Without the token (today's committed CSS) the body background is used, and a
  // missing meta is created rather than skipped.
  const bare = page({ headExtra: '<style>body{background-color:#141414}</style>' });
  bare.document.querySelector('meta[name="theme-color"]').remove();
  bare.syncThemeColor();
  assert.equal(
    bare.document.querySelector('meta[name="theme-color"]').getAttribute('content'),
    'rgb(20, 20, 20)',
  );
});

test('theme: RFTheme.setColorScheme persists and toggles .dark', () => {
  const w = page({ prefersDark: true });
  assert.equal(w.document.documentElement.classList.contains('dark'), true, 'system follows the OS');
  assert.deepEqual(Array.from(w.RFTheme.APP_THEMES), ['neutral', 'paper', 'graphite']);
  assert.equal(w.RFTheme.colorScheme(), 'system');
  assert.equal(w.RFTheme.appTheme(), 'neutral');

  w.RFTheme.setColorScheme('light');
  assert.equal(w.localStorage.getItem('colorScheme'), 'light');
  assert.equal(w.RFTheme.colorScheme(), 'light');
  assert.equal(w.document.documentElement.classList.contains('dark'), false);
  w.RFTheme.setColorScheme('dark');
  assert.equal(w.document.documentElement.classList.contains('dark'), true);
  w.RFTheme.setColorScheme('system');
  assert.equal(w.localStorage.getItem('colorScheme'), 'system');
  assert.equal(w.document.documentElement.classList.contains('dark'), true);
  // An unknown value is stored as system, never as itself.
  w.RFTheme.setColorScheme('bogus');
  assert.equal(w.RFTheme.colorScheme(), 'system');

  w.RFTheme.setAppTheme('paper');
  assert.equal(w.RFTheme.appTheme(), 'paper');
  assert.equal(w.setAppTheme, w.RFTheme.setAppTheme, 'window.setAppTheme stays as an alias');
});

test('init: a stored collapsible sidebar mode boots as hideable-up', () => {
  // The phone "Collapsible" sidebar mode is retired (s7-T1, s3 owner answer): a stored
  // value boots as the default and storage is rewritten, so app.js agrees later.
  const html = '<!doctype html><html><head><script>' + INIT_JS + '<\/script></head><body></body></html>';
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://readfine.test/app',
    beforeParse(w) {
      Object.defineProperty(w, 'innerWidth', { configurable: true, value: 390 });
      w.localStorage.setItem('sidebar_mode_small', 'collapsible');
      w.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
    },
  });
  const root = dom.window.document.documentElement;
  assert.equal(root.dataset.bucket, 'small');
  assert.equal(root.dataset.sidebarMode, 'hideable-up');
  assert.equal(dom.window.localStorage.getItem('sidebar_mode_small'), 'hideable-up');
});

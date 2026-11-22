// static/js/ui/shell.js (window.RFShell): the account menu of the sidebar. Its theme
// items set the colour scheme and the app theme through window.RFTheme (init.js), its
// "Offline reading" item switches offline mode through the page controller
// (offline/page.js), and a sidebar refresh is held back while the menu is open.
//
// Own small loader, like theme-bootstrap.test.mjs: the real init.js runs in <head>,
// the body holds the account menu as sidebar.html draws it (the parts shell.js reads),
// then the real shell.js runs. Basecoat and htmx are not loaded: the events they would
// send are dispatched by hand.
//
// The phone tests (tab bar, sidebar sheet) add the tab bar and the title bar button as
// mobile_bars.html draws them, the panes and the sidebar's nav rows. shell.js opens the
// sheet itself from Folders or the title bar button; other tests set the
// mobile-sidebar-open class by hand, the way any other opener would.
//
// The tests of what moved out of app.js in s3-T10 (pin, collapsible sections, the sheet
// next to app.js's own handlers, the palette's "Toggle sidebar") load app.js with
// shell.js through harness.mjs's browser(…, { scripts: ['ui/shell.js'] }).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { browser, until } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const JS = path.join(ROOT, 'backend', 'app', 'static', 'js');
const INIT_JS = fs.readFileSync(path.join(JS, 'init.js'), 'utf8');
const SHELL_JS = fs.readFileSync(path.join(JS, 'ui', 'shell.js'), 'utf8');
const COMMAND_JS = fs.readFileSync(path.join(JS, 'vendor', 'basecoat', 'command.min.js'), 'utf8');

const radio = (attr, v) => '<button type="button" role="menuitemradio" ' + attr + '="' + v + '" aria-checked="false">' + v + '</button>';

// The nav rows as sidebar.html draws them: <a hx-get> without href (not focusable).
const NAV_ROWS = '<nav><div class="mark-read-row"><a class="nav-item" hx-get="/htmx/articles" hx-target="#article-list" hx-push-url="false"><span class="flex-1">All articles</span></a></div>'
  + '<div class="mark-read-row"><a class="nav-item" hx-get="/htmx/articles?starred_only=true" hx-target="#article-list" hx-push-url="false"><span class="flex-1">Starred</span></a></div></nav>';
const RAIL = '<div id="sidebar-rail"><a class="nav-item" hx-get="/htmx/articles" hx-target="#article-list">A</a></div>';
const FOOTER = '<button type="button" data-action="reload-list" aria-label="Refresh">R</button>';

// The tab bar as mobile_bars.html draws it (chat_available: the Assistant button).
const TAB_BAR = '<nav id="tab-bar" aria-label="Main">'
  + '<button type="button" data-rf-tab="feed" aria-current="page">Feed</button>'
  + '<button type="button" data-rf-tab="search" data-action="open-search">Search</button>'
  + '<a href="/settings/feeds#feed-url-input" data-rf-tab="add" data-rf-online-only>Add</a>'
  + '<button type="button" id="mobile-bottom-chat-btn" data-rf-tab="assistant">Assistant</button>'
  + '<button type="button" data-rf-tab="folders" data-action="toggle-sidebar-pin">Folders</button>'
  + '</nav>';

const TITLE_BTN = '<button id="mobile-titlebar-open-btn" aria-label="Open feeds">=</button>';

function phoneBody() {
  return TITLE_BTN + TAB_BAR
    + '<aside id="sidebar">' + RAIL + '<div id="sidebar-full">' + NAV_ROWS + FOOTER + '</div></aside>'
    + '<section id="article-list"><div class="article-row">a</div></section>'
    + '<main id="article-detail"><button id="mobile-detail-back-btn" aria-label="Back">B</button></main>';
}

function sidebarHtml() {
  return '<div id="sidebar-full"><div id="full-menu-container">'
    + '<div id="account-menu" class="dropdown-menu">'
    + '<button type="button" id="account-menu-trigger" aria-haspopup="menu" aria-expanded="false">A</button>'
    + '<div id="account-menu-popover" data-popover aria-hidden="true"><div role="menu" id="account-menu-menu">'
    + '<div role="group">' + ['light', 'dark', 'system'].map((v) => radio('data-rf-scheme', v)).join('') + '</div>'
    + '<div role="group">' + ['neutral', 'paper', 'graphite'].map((v) => radio('data-rf-app-theme', v)).join('') + '</div>'
    + '<button type="button" role="menuitemcheckbox" data-rf-offline-menu aria-checked="false" hidden>Offline reading</button>'
    + '</div></div></div></div></div>';
}

// The palette's copies of the menu items as palette.html draws them (command_items:
// plain role="menuitem"), inside the command_palette markup command.min.js runs on.
function paletteHtml() {
  const item = (n, attrs, label) => '<div id="rf-palette-item-' + n + '" role="menuitem" ' + attrs + '>' + label + '</div>';
  return '<dialog id="rf-palette" class="command-dialog"><div class="command">'
    + '<header><input type="text" id="rf-palette-input"></header>'
    + '<div role="menu" id="rf-palette-menu"><div role="group">'
    + item(1, 'data-rf-scheme="dark"', 'Theme: Dark')
    + item(2, 'data-rf-app-theme="paper"', 'App theme: Paper')
    + item(3, 'data-rf-offline-menu hidden data-keywords="offline download"', 'Offline reading')
    + '</div></div></div></dialog>';
}

// ctl: the offline page controller RFOffline.page.current() returns (null: none); a
// test may swap it later through w.rfCtl.
// phone: the small bucket, with the title bar button, the tab bar and the panes.
// palette: the palette's items, with the vendored command.min.js run on them before
// shell.js (base.html loads it first) behind a minimal basecoat.register shim.
function page({ storage = {}, ctl = null, supported = true, phone = false, palette = false } = {}) {
  const shim = '<script>window.basecoat = { register: function (n, o) {'
    + ' document.querySelectorAll(o.selector).forEach(o.init); } };<\/script>';
  const html = '<!doctype html><html><head><script>' + INIT_JS + '<\/script></head><body>'
    + (phone ? phoneBody() : '<aside id="sidebar">' + sidebarHtml() + '</aside>')
    + (palette ? paletteHtml() + shim + '<script>' + COMMAND_JS + '<\/script>' : '')
    + '<script>' + SHELL_JS + '<\/script></body></html>';
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://readfine.test/app',
    beforeParse(w) {
      for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
      w.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
      if (supported) {
        Object.defineProperty(w.navigator, 'serviceWorker', { value: {}, configurable: true });
        Object.defineProperty(w.navigator, 'locks', { value: { request() {} }, configurable: true });
        w.indexedDB = {};
      }
      w.toasts = [];
      w.showToast = (msg, type) => w.toasts.push([msg, type]);
      w.rfCtl = ctl;
      w.RFOffline = { page: { current: () => w.rfCtl } };
      // command.js closes the palette's <dialog> after an item.
      if (palette) asyncDialog(w);
    },
  });
  // init.js picks the bucket from jsdom's 1024 px window.
  if (phone) dom.window.document.documentElement.dataset.bucket = 'small';
  return dom.window;
}

const $ = (w, sel) => w.document.querySelector(sel);
const checked = (w, attr) => Array.from(w.document.querySelectorAll('[' + attr + ']'))
  .filter((el) => el.getAttribute('aria-checked') === 'true').map((el) => el.getAttribute(attr));
const tick = () => new Promise((r) => setTimeout(r, 0));

test('shell: theme items set scheme and app theme and mark aria-checked', () => {
  const w = page({ storage: { appTheme: 'graphite' } });
  // On load: the stored choices (scheme unset = system).
  assert.deepEqual(checked(w, 'data-rf-scheme'), ['system']);
  assert.deepEqual(checked(w, 'data-rf-app-theme'), ['graphite']);

  $(w, '[data-rf-scheme="dark"]').click();
  assert.equal(w.localStorage.getItem('colorScheme'), 'dark');
  assert.equal(w.document.documentElement.classList.contains('dark'), true);
  assert.deepEqual(checked(w, 'data-rf-scheme'), ['dark']);

  $(w, '[data-rf-app-theme="paper"]').click();
  assert.equal(w.localStorage.getItem('appTheme'), 'paper');
  assert.equal(w.document.documentElement.dataset.rfTheme, 'paper');
  assert.deepEqual(checked(w, 'data-rf-app-theme'), ['paper']);

  // A fresh sidebar (htmx swap) arrives unchecked and is synced after the swap.
  const sb = $(w, '#sidebar');
  sb.innerHTML = sidebarHtml();
  sb.dispatchEvent(new w.CustomEvent('htmx:afterSwap', { bubbles: true, detail: { target: sb, elt: sb } }));
  assert.deepEqual(checked(w, 'data-rf-scheme'), ['dark']);
  assert.deepEqual(checked(w, 'data-rf-app-theme'), ['paper']);
});

test('shell: offline item calls enable/disable on the page controller', async () => {
  const calls = [];
  const ctl = {
    state: { enabled: false },
    enable: async () => { calls.push('enable'); ctl.state.enabled = true; return { persisted: true }; },
    disable: async () => { calls.push('disable'); ctl.state.enabled = false; },
  };
  const w = page({ ctl });
  const item = $(w, '[data-rf-offline-menu]');
  assert.equal(item.hidden, false);
  assert.equal(item.getAttribute('aria-checked'), 'false');

  // Basecoat flips aria-checked on a menuitemcheckbox before our handler runs; the
  // controller's state decides, not the attribute.
  item.setAttribute('aria-checked', 'true');
  item.click();
  await tick();
  assert.deepEqual(calls, ['enable']);
  assert.equal(item.getAttribute('aria-checked'), 'true');
  assert.equal(w.toasts.length, 1);

  item.setAttribute('aria-checked', 'false');
  item.click();
  await tick();
  assert.deepEqual(calls, ['enable', 'disable']);
  assert.equal(item.getAttribute('aria-checked'), 'false');
  assert.equal(w.toasts.length, 2);

  // No controller (or a browser without offline support): the item is hidden.
  assert.equal($(page({ ctl: null }), '[data-rf-offline-menu]').hidden, true);
  assert.equal($(page({ ctl, supported: false }), '[data-rf-offline-menu]').hidden, true);
});

test('shell: a sidebar refresh while the account menu is open is dropped and fired once on close', async () => {
  const w = page();
  const sb = $(w, '#sidebar');
  let fired = 0;
  w.document.body.addEventListener('sidebarRefresh', () => { fired += 1; });
  const request = (elt) => {
    const e = new w.CustomEvent('htmx:beforeRequest', { bubbles: true, cancelable: true, detail: { elt } });
    elt.dispatchEvent(e);
    return e.defaultPrevented;
  };

  // Menu closed: the refresh goes through.
  assert.equal(request(sb), false);

  $(w, '#account-menu-trigger').setAttribute('aria-expanded', 'true');
  await tick();
  assert.equal(request(sb), true, 'the poll is dropped while the menu is open');
  assert.equal(request(sb), true, 'and so is a sidebarRefresh');
  // Requests of elements inside the sidebar only bubble through it: never dropped.
  assert.equal(request($(w, '[data-rf-scheme="light"]')), false);

  $(w, '#account-menu-trigger').setAttribute('aria-expanded', 'false');
  await tick();
  assert.equal(fired, 1, 'one refresh for everything that was dropped');

  // Opened and closed again with nothing dropped: no refresh.
  $(w, '#account-menu-trigger').setAttribute('aria-expanded', 'true');
  await tick();
  $(w, '#account-menu-trigger').setAttribute('aria-expanded', 'false');
  await tick();
  assert.equal(fired, 1);
});

// Records the clicks that reach each element the Feed tab may click.
function clicks(w) {
  const seen = [];
  const watch = (sel, name) => $(w, sel).addEventListener('click', () => seen.push(name));
  watch('#mobile-detail-back-btn', 'back');
  watch('#sidebar-full [data-action="reload-list"]', 'reload');
  watch('#sidebar-full .nav-item[hx-get="/htmx/articles"]', 'all');
  watch('#sidebar-rail .nav-item', 'rail');
  return seen;
}
const root = (w) => w.document.documentElement;
const current = (w) => Array.from(w.document.querySelectorAll('#tab-bar [aria-current]'))
  .map((el) => el.getAttribute('data-rf-tab'));

test('shell: Feed tab closes a full-screen article, reloads when already active, else opens All articles', async () => {
  const w = page({ phone: true });
  const seen = clicks(w);
  const feed = $(w, '[data-rf-tab="feed"]');

  // A full-screen article is open: Feed closes it through its Back button, nothing else.
  for (const cls of ['mobile-detail-open', 'story-detail-open', 'deeplink-detail-open']) {
    root(w).classList.add(cls);
    feed.click();
    root(w).classList.remove(cls);
  }
  assert.deepEqual(seen, ['back', 'back', 'back']);

  // The list shows and Feed is the active tab: one tap reloads the current view.
  seen.length = 0;
  feed.click();
  assert.deepEqual(seen, ['reload']);

  // The sidebar sheet is open (Folders is active): Feed opens All articles, the row of
  // the full sidebar, not the rail's.
  seen.length = 0;
  root(w).classList.add('mobile-sidebar-open');
  await tick();
  feed.click();
  assert.deepEqual(seen, ['all']);
});

test('shell: opening the sidebar sheet moves focus in and makes the panes inert, closing restores both', async () => {
  const w = page({ phone: true });
  const folders = $(w, '[data-rf-tab="folders"]');
  const first = $(w, '#sidebar-full .nav-item');
  const inert = () => ['#article-list', '#article-detail'].map((sel) => $(w, sel).hasAttribute('inert'));

  // Opened by the Folders tab: shell.js stops the click and opens the sheet.
  folders.click();
  assert.equal(root(w).classList.contains('mobile-sidebar-open'), true);
  await tick();
  assert.equal(w.document.activeElement, first, 'focus moves to the first nav row of the full sidebar');
  assert.deepEqual(inert(), [true, true]);

  // Another class change while it is open (a theme flip) moves nothing.
  root(w).classList.add('dark');
  await tick();
  assert.equal(w.document.activeElement, first);

  root(w).classList.remove('mobile-sidebar-open');
  await tick();
  assert.deepEqual(inert(), [false, false]);
  assert.equal(w.document.activeElement, $(w, '[data-rf-tab="folders"]'), 'focus returns to the Folders tab');

  // Opened by other code (the class alone, no opener clicked): closing leaves focus alone.
  root(w).classList.add('mobile-sidebar-open');
  await tick();
  assert.equal(w.document.activeElement, first);
  $(w, '#sidebar-full [data-action="reload-list"]').focus();
  root(w).classList.remove('mobile-sidebar-open');
  await tick();
  assert.deepEqual(inert(), [false, false]);
  assert.notEqual(w.document.activeElement, folders);

  // Outside the small bucket the class makes nothing inert.
  root(w).dataset.bucket = 'large';
  root(w).classList.add('mobile-sidebar-open');
  await tick();
  assert.deepEqual(inert(), [false, false]);
});

test('shell: tab bar marks the active tab', async () => {
  const w = page({ phone: true });
  assert.deepEqual(current(w), ['feed']);
  assert.equal($(w, '[data-rf-tab="feed"]').getAttribute('aria-current'), 'page');

  root(w).classList.add('mobile-sidebar-open');
  await tick();
  assert.deepEqual(current(w), ['folders']);

  root(w).classList.remove('mobile-sidebar-open');
  await tick();
  assert.deepEqual(current(w), ['feed']);
});

const key = (w, el, k) => {
  const e = new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

test('shell: sheet rows take Enter, Space and the arrows; the title bar button gets focus back', async () => {
  const w = page({ phone: true });
  const rows = Array.from(w.document.querySelectorAll('#sidebar-full .nav-item'));
  const ran = [];
  rows.forEach((r, i) => r.addEventListener('click', () => ran.push(i)));

  $(w, '#mobile-titlebar-open-btn').click();
  assert.equal(root(w).classList.contains('mobile-sidebar-open'), true, 'the title bar button opens the sheet');
  await tick();
  assert.equal(w.document.activeElement, rows[0]);
  assert.equal(rows[0].getAttribute('tabindex'), '0', 'the focused row is the one Tab comes back to');

  // Roving focus: the arrows move it and the tabindex with it.
  assert.equal(key(w, rows[0], 'ArrowDown').defaultPrevented, true);
  assert.equal(w.document.activeElement, rows[1]);
  assert.deepEqual(rows.map((r) => r.getAttribute('tabindex')), ['-1', '0']);
  key(w, rows[1], 'ArrowDown');
  assert.equal(w.document.activeElement, rows[1], 'it stops at the last row');
  key(w, rows[1], 'Home');
  assert.equal(w.document.activeElement, rows[0]);
  key(w, rows[0], 'End');
  assert.equal(w.document.activeElement, rows[1]);

  // <a hx-get> without href: Enter and Space click the row, as a mouse would.
  assert.equal(key(w, rows[1], 'Enter').defaultPrevented, true);
  assert.equal(key(w, rows[1], ' ').defaultPrevented, true);
  assert.deepEqual(ran, [1, 1]);
  // Any other key is left alone.
  assert.equal(key(w, rows[1], 'x').defaultPrevented, false);

  // Closed (here by the backdrop's owner, the class): focus goes back to the title bar
  // button that opened it, not to the body.
  root(w).classList.remove('mobile-sidebar-open');
  await tick();
  assert.equal(w.document.activeElement, $(w, '#mobile-titlebar-open-btn'));
});

test('shell: palette items get no aria-checked; a hidden offline item stays out of the filter and joins it when shown', async () => {
  const calls = [];
  const ctl = { state: { enabled: false }, enable: async () => { calls.push('enable'); ctl.state.enabled = true; return {}; }, disable: async () => {} };
  const w = page({ palette: true, ctl: null });
  const input = $(w, '#rf-palette-input');
  const offline = $(w, '#rf-palette [data-rf-offline-menu]');
  const visible = () => Array.from(w.document.querySelectorAll('#rf-palette [role="menuitem"]'))
    .filter((el) => el.getAttribute('aria-hidden') !== 'true').map((el) => el.textContent);
  const type = async (v) => {
    input.value = v;
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    await tick();
  };

  // role="menuitem" is neither a radio nor a checkbox: no aria-checked, even after a click.
  $(w, '#rf-palette [data-rf-scheme="dark"]').click();
  assert.equal(w.localStorage.getItem('colorScheme'), 'dark');
  for (const el of w.document.querySelectorAll('#rf-palette [role="menuitem"]')) {
    assert.equal(el.hasAttribute('aria-checked'), false, el.textContent);
  }

  // No offline mode: hidden, disabled and aria-hidden, through every filter pass.
  assert.equal(offline.hidden, true);
  assert.equal(offline.getAttribute('aria-disabled'), 'true');
  assert.equal(offline.getAttribute('aria-hidden'), 'true');
  await type('');
  assert.deepEqual(visible(), ['Theme: Dark', 'App theme: Paper']);
  await type('offline');
  assert.deepEqual(visible(), [], 'nothing matches, so the empty state shows');
  $(w, '.command').refresh();
  await tick();
  assert.equal(offline.getAttribute('aria-hidden'), 'true', 'a refresh() does not bring it back either');

  // Offline mode becomes usable: shown, enabled, and command.js takes it in, so the
  // filter matches it and Enter runs it.
  w.rfCtl = ctl;
  w.RFShell.sync();
  assert.equal(offline.hidden, false);
  assert.equal(offline.hasAttribute('aria-disabled'), false);
  assert.deepEqual(visible(), ['Offline reading']);
  key(w, input, 'Enter');
  await tick();
  assert.deepEqual(calls, ['enable']);
});

// jsdom has <dialog> but neither showModal() nor close(). close() here sends its close
// event as a task of its own, as a browser does: an observer microtask runs before it.
function asyncDialog(w) {
  const proto = w.HTMLDialogElement.prototype;
  proto.showModal = function () { this.setAttribute('open', ''); };
  proto.close = function () {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    setTimeout(() => this.dispatchEvent(new w.Event('close')), 0);
  };
  if (!('open' in proto)) Object.defineProperty(proto, 'open', { get() { return this.hasAttribute('open'); } });
}

const SIDEBAR = '<aside id="sidebar" class="w-60">'
  + '<button type="button" id="pin" data-action="toggle-sidebar-pin">P</button>'
  + '<div id="sidebar-full"><span class="collapse-toggle" data-collapse="labels">v</span>'
  + '<div class="collapsible" id="collapse-labels">'
  + '<div class="mark-read-row"><a class="nav-item" hx-get="/htmx/articles" hx-target="#article-list" hx-push-url="false"><span class="flex-1">All articles</span></a></div>'
  + '</div></div></aside>';

test('shell: the sidebar code moved from app.js still runs next to it (pin, sections, phone sheet)', async () => {
  const w = browser(SIDEBAR + TITLE_BTN + '<div id="mobile-sidebar-backdrop"></div>'
    + '<section id="article-list"></section><main id="article-detail"></main>', {
    before(win) { win._sidebarPinned = true; },
    scripts: ['ui/shell.js'],
  });
  const html = w.document.documentElement;
  const sb = $(w, '#sidebar');
  html.dataset.bucket = 'large';

  // Pin: client-side, remembered.
  $(w, '#pin').click();
  assert.deepEqual([sb.classList.contains('w-12'), html.classList.contains('sidebar-unpinned')], [true, true]);
  assert.equal(w.localStorage.getItem('sidebarPinned'), 'false');
  $(w, '#pin').click();
  assert.equal(sb.classList.contains('w-60'), true);

  // Sections fold, are remembered, and come back folded after a sidebar swap.
  $(w, '.collapse-toggle').click();
  assert.equal($(w, '#collapse-labels').classList.contains('collapsed'), true);
  assert.equal(w.localStorage.getItem('sidebar_col_labels'), '1');
  sb.innerHTML = SIDEBAR.replace(/^<aside[^>]*>|<\/aside>$/g, '');
  sb.dispatchEvent(new w.CustomEvent('htmx:afterSwap', { bubbles: true, detail: { target: sb } }));
  assert.equal($(w, '#collapse-labels').classList.contains('collapsed'), true);
  $(w, '.collapse-toggle').click();
  assert.equal(w.localStorage.getItem('sidebar_col_labels'), null);
  // A long press on a row must not open the browser's menu.
  const menu = new w.Event('contextmenu', { bubbles: true, cancelable: true });
  $(w, '.mark-read-row .nav-item').dispatchEvent(menu);
  assert.equal(menu.defaultPrevented, true);

  // Phone: the toggle opens the sheet instead of pinning; the backdrop closes it, and
  // so does a row (app.js's handler, through window._closeMobileSidebarOverlay).
  html.dataset.bucket = 'small';
  $(w, '#pin').click();
  assert.equal(html.classList.contains('mobile-sidebar-open'), true);
  assert.equal(sb.classList.contains('w-60'), true, 'the pin is left alone');
  $(w, '#mobile-sidebar-backdrop').click();
  assert.equal(html.classList.contains('mobile-sidebar-open'), false);
  $(w, '#mobile-titlebar-open-btn').click();
  assert.equal(html.classList.contains('mobile-sidebar-open'), true);
  $(w, '#sidebar .nav-item').click();
  assert.equal(html.classList.contains('mobile-sidebar-open'), false);
  assert.equal(w.localStorage.getItem('mobile_title_text'), 'All articles');
});

test('shell: the palette\'s "Toggle sidebar" on a phone closes the palette, then opens the sheet', async () => {
  const w = browser(SIDEBAR + '<button type="button" id="search-tab" data-action="open-search">S</button>'
    + '<section id="article-list"></section><main id="article-detail"></main>'
    + '<dialog id="rf-palette" class="command-dialog"><div class="command"><header><input id="rf-palette-input"></header>'
    + '<div role="menu"><div role="menuitem" id="toggle" data-action="toggle-sidebar-pin">Toggle sidebar</div></div></div></dialog>', {
    // A phone: app.js sets the bucket again on DOMContentLoaded, from the width.
    before(win) { win._sidebarPinned = true; asyncDialog(win); Object.defineProperty(win, 'innerWidth', { value: 390, configurable: true }); },
    scripts: ['ui/shell.js', 'ui/palette.js'],
  });
  const html = w.document.documentElement;
  html.dataset.bucket = 'small';
  const dlg = $(w, '#rf-palette');

  // Opened from the Search tab, so palette.js gives focus back to it on close.
  $(w, '#search-tab').focus();
  $(w, '#search-tab').click();
  assert.equal(dlg.open, true);
  $(w, '#toggle').click();
  assert.equal(dlg.open, false, 'the palette closes');
  await until(() => html.classList.contains('mobile-sidebar-open'));
  await tick();
  assert.equal(w.document.activeElement, $(w, '#sidebar .nav-item'), 'focus is in the sheet, not back on Search');
  assert.equal($(w, '#article-list').hasAttribute('inert'), true);
  assert.equal($(w, '#sidebar').classList.contains('w-60'), true, 'the pin is left alone');
});

test('label colour swatches: aria-pressed follows the chosen swatch', () => {
  const swatch = (c, on) => '<button type="button" class="color-swatch" data-color="' + c + '" aria-pressed="' + on + '"></button>';
  const w = browser('<form><input type="hidden" name="color" value="#111111"><div class="color-swatch-group">'
    + swatch('#111111', true) + swatch('#222222', false) + swatch('#333333', false)
    + '</div><input type="text" class="color-custom-input"><span class="color-custom-preview"></span></form>');
  const all = () => Array.from(w.document.querySelectorAll('.color-swatch')).map((s) => s.getAttribute('aria-pressed'));
  w.document.querySelectorAll('.color-swatch')[2].click();
  assert.deepEqual(all(), ['false', 'false', 'true']);
  assert.equal($(w, 'input[name="color"]').value, '#333333');
  // A valid custom colour leaves no swatch pressed.
  const custom = $(w, '.color-custom-input');
  custom.value = '#abcdef';
  custom.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.deepEqual(all(), ['false', 'false', 'false']);
});

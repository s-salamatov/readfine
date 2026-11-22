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
// The phone tests (tab bar, sidebar sheet) add the tab bar as mobile_bars.html draws it,
// the panes and the sidebar's nav rows. app.js is not loaded, so opening and closing the
// sheet is the mobile-sidebar-open class set by hand, and a Folders click stops in a
// document capture listener the way app.js's handler stops it (stopImmediatePropagation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const JS = path.join(ROOT, 'backend', 'app', 'static', 'js');
const INIT_JS = fs.readFileSync(path.join(JS, 'init.js'), 'utf8');
const SHELL_JS = fs.readFileSync(path.join(JS, 'ui', 'shell.js'), 'utf8');

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

// What app.js does with a toggle-sidebar-pin click before anything else sees it.
const PIN_STUB = '<script>document.addEventListener("click", function (e) {'
  + ' if (e.target.closest("[data-action=toggle-sidebar-pin]")) e.stopImmediatePropagation(); }, true);<\/script>';

function phoneBody() {
  return TAB_BAR
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

// ctl: the offline page controller RFOffline.page.current() returns (null: none).
// phone: the small bucket, with the tab bar, the panes and the app.js stub above.
function page({ storage = {}, ctl = null, supported = true, phone = false } = {}) {
  const html = '<!doctype html><html><head><script>' + INIT_JS + '<\/script></head><body>'
    + (phone ? PIN_STUB + phoneBody() : '<aside id="sidebar">' + sidebarHtml() + '</aside>')
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
      w.RFOffline = { page: { current: () => ctl } };
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

  // Opened by the Folders tab: app.js swallows the click and sets the class.
  folders.click();
  root(w).classList.add('mobile-sidebar-open');
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

  // Opened another way (the title bar's menu button): closing leaves focus alone.
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

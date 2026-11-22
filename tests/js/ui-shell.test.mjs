// static/js/ui/shell.js (window.RFShell): the account menu of the sidebar. Its theme
// items set the colour scheme and the app theme through window.RFTheme (init.js), its
// "Offline reading" item switches offline mode through the page controller
// (offline/page.js), and a sidebar refresh is held back while the menu is open.
//
// Own small loader, like theme-bootstrap.test.mjs: the real init.js runs in <head>,
// the body holds the account menu as sidebar.html draws it (the parts shell.js reads),
// then the real shell.js runs. Basecoat and htmx are not loaded: the events they would
// send are dispatched by hand.
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
function page({ storage = {}, ctl = null, supported = true } = {}) {
  const html = '<!doctype html><html><head><script>' + INIT_JS + '<\/script></head><body>'
    + '<aside id="sidebar">' + sidebarHtml() + '</aside>'
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

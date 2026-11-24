import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { chromium } from '@playwright/test';
import { browser as appBrowser } from './harness.mjs';

const root = 'backend/app/static/js/';
const host = '<h1 id="sources-heading" tabindex="-1">Sources</h1><a id="add" href="/settings/feeds/add" data-rf-source-sheet>Add</a><dialog id="rf-source-sheet"><h2 id="rf-source-sheet-title">Source</h2><div id="rf-source-sheet-body"></div><button data-rf-close>Close</button></dialog>';
const form = '<form id="feed-subscribe-form" data-rf-source-form="add" hx-post="/settings/feeds" hx-target="#rf-source-sheet-body" hx-swap="innerHTML"><input id="feed-url-input" name="url"><input id="feed-custom-title" name="custom_title" data-default-placeholder="Custom title (optional)"><input name="fetch_auth_user"><input name="fetch_auth_pass" type="password"><button type="button" data-rf-source-test>Test</button><button type="submit">Subscribe</button><div id="feed-test-result"></div></form>';
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function setup(body = host, url = 'https://readfine.test/settings/feeds', beforeSources = []) {
  const dom = new JSDOM('<!doctype html><html><body>' + body + '</body></html>', { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new w.Event('close')); };
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  const requests = [], toasts = [], timers = new Map();
  let now = 0, next = 0;
  w.setTimeout = (fn, ms = 0) => { timers.set(++next, { fn, at: now + ms }); return next; };
  w.clearTimeout = id => timers.delete(id);
  function tick(ms) {
    now += ms;
    for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
  }
  function event(name, detail = {}, target = d) {
    const e = new w.CustomEvent(name, { detail, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  }
  w.RFToast = { show: (...args) => toasts.push(args) };
  // HTMX is the transport boundary. Deliver its documented request/swap events;
  // dialog/controller/form state stays real DOM and real production code.
  w.htmx = {
    ajax(method, url, options) {
      const req = { method, url, options, xhr: { status: 200, responseURL: new URL(url, w.location).href, getResponseHeader: () => null } };
      requests.push(req);
      event('htmx:beforeRequest', { elt: options.source, target: d.querySelector(options.target), xhr: req.xhr, requestConfig: options });
      return Promise.resolve();
    },
    trigger: (el, name, detail) => event(name, detail, el),
  };
  function reply(req, html, status = 200, responseURL = req.xhr.responseURL) {
    Object.assign(req.xhr, { status, responseURL, responseText: html });
    const target = typeof req.options.target === 'string' ? d.querySelector(req.options.target) : req.options.target;
    const detail = { elt: req.options.source, target, xhr: req.xhr, requestConfig: req.options, shouldSwap: status < 400, serverResponse: html };
    if (!event('htmx:beforeOnLoad', detail).defaultPrevented && !event('htmx:beforeSwap', detail).defaultPrevented && detail.shouldSwap) {
      target.innerHTML = html;
      event('htmx:afterSwap', detail);
    }
    event('htmx:afterRequest', { ...detail, failed: status >= 400, successful: status < 400 });
  }
  w.eval(fs.readFileSync(root + 'ui/dialog.js', 'utf8'));
  for (const file of beforeSources) w.eval(fs.readFileSync(root + file, 'utf8'));
  if (fs.existsSync(root + 'ui/sources.js')) w.eval(fs.readFileSync(root + 'ui/sources.js', 'utf8'));
  const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  return { dom, w, d, requests, toasts, event, reply, click, tick };
}

function pendingSources() {
  const rows = [7, 8].map(id => `<div id="row-${id}" data-rf-delete-key="feed:${id}"><button data-rf-delete="feed:${id}" data-rf-delete-label="Feed ${id}" data-rf-online-only><span>Remove</span></button></div>`).join('');
  const env = setup(host + rows + '<div id="hidden-copy" data-rf-delete-key="feed:7" hidden></div>',
    'https://readfine.test/sources', ['ui/pending.js', 'offline/overlay.js']);
  const { w, toasts } = env;
  let forced = false, network = true;
  w.RFOffline.page = { current: () => ({ isOffline: () => forced }) };
  Object.defineProperty(w.navigator, 'onLine', { configurable: true, get: () => network });
  const sent = [], handles = [];
  w.fetch = (url, options) => {
    sent.push({ url, body: JSON.parse(options.body) });
    return Promise.resolve({ ok: true, json: async () => ({ results: sent.at(-1).body.map(item => ({ ...item, status: 'done' })) }) });
  };
  w.RFToast.show = (...args) => {
    toasts.push(args);
    const handle = { closed: false, close() { this.closed = true; }, update() {} };
    handles.push(handle);
    return handle;
  };
  return { ...env, sent, handles, setOffline(mode, value) {
    if (mode === 'force') forced = value;
    else network = !value;
  } };
}

for (const mode of ['force', 'network']) {
  test(`sources: pending Remove cannot be queued while ${mode} offline`, async () => {
    // Without the capture guard, pending.js schedules before any HTMX gate runs.
    const { dom, w, d, click, tick, sent, toasts, setOffline } = pendingSources();
    try {
      setOffline(mode, true);
      const button = d.querySelector('[data-rf-delete="feed:7"]');
      click(button.firstElementChild); // before the overlay has disabled the button
      assert.equal(w.RFPending.state('feed:7'), undefined);
      assert.equal(d.getElementById('row-7').hidden, false);
      assert.match(toasts.at(-1)[0], /Connect to the internet to manage sources/);
      w.RFOffline.overlay.disableOnlineOnly(d);
      assert.equal(button.disabled, true);
      click(button.firstElementChild); // synthetic/keyboard dispatch cannot bypass the gate
      assert.equal(w.RFPending.state('feed:7'), undefined);
      setOffline(mode, false);
      w.RFOffline.overlay.restoreOnlineOnly(d);
      tick(10000);
      w.dispatchEvent(new w.Event('pagehide'));
      await flush();
      assert.deepEqual(sent, [], 'reconnection must not replay the rejected Remove');
    } finally { dom.window.close(); }
  });

  test(`sources: pending feed deletes are restored on ${mode} offline without replay`, async () => {
    // Merely disabling Remove leaves the real pending.js timer able to POST.
    const { dom, w, d, click, tick, sent, handles, setOffline, event } = pendingSources();
    try {
      click(d.querySelector('[data-rf-delete="feed:7"] span'));
      click(d.querySelector('[data-rf-delete="feed:8"] span'));
      w.RFPending.schedule({ kind: 'label', id: 9, label: 'Unrelated label' });
      assert.equal(w.RFPending.state('feed:7'), 'pending');
      assert.equal(d.getElementById('row-7').hidden, true);
      // A swapped-out row must not make its pending key impossible to cancel.
      d.getElementById('row-8').remove();
      setOffline(mode, true);
      if (mode === 'network') w.dispatchEvent(new w.Event('offline'));
      w.RFOffline.overlay.disableOnlineOnly(d);
      await flush(); // allow the DOM observer to see the force-offline overlay
      for (const id of [7, 8]) assert.equal(w.RFPending.state(`feed:${id}`), undefined);
      assert.equal(w.RFPending.state('label:9'), 'pending', 'Sources cancels only feeds');
      w.RFPending.undo('label:9');
      assert.equal(d.getElementById('row-7').hidden, false);
      assert.equal(d.getElementById('hidden-copy').hidden, true, 'pre-hidden rows stay hidden');
      assert.equal(d.querySelector('[data-rf-pending-delete]'), null);
      assert.ok(handles.every(handle => handle.closed), 'Undo toasts close with cancellation');
      tick(10000);
      event('htmx:beforeHistorySave');
      w.dispatchEvent(new w.Event('pagehide'));
      assert.deepEqual(sent, [], 'neither timer nor lifecycle flush may send offline');
      assert.equal(w.sessionStorage.getItem('rf.deletedKeys'), null);
      setOffline(mode, false);
      w.RFOffline.overlay.restoreOnlineOnly(d);
      w.dispatchEvent(new w.Event('online'));
      tick(20000);
      assert.deepEqual(sent, [], 'cancelled deletes never replay after reconnect');
      click(d.querySelector('[data-rf-delete="feed:7"] span'));
      tick(10000);
      await flush();
      assert.deepEqual(sent, [{ url: '/settings/deletes', body: [{ kind: 'feed', id: 7 }] }], 'a fresh online Remove still works');
    } finally { dom.window.close(); }
  });
}

test('sources: pending feed cancellation precedes a lifecycle flush in the offline transition', async () => {
  const { dom, w, d, click, sent, setOffline, event } = pendingSources();
  try {
    for (const trigger of [
      () => event('htmx:beforeRequest', { boosted: true }),
      () => event('htmx:beforeHistorySave'),
      () => {
        Object.defineProperty(d, 'visibilityState', { configurable: true, value: 'hidden' });
        event('visibilitychange');
      },
      () => w.dispatchEvent(new w.Event('pagehide')),
      () => w.dispatchEvent(new w.Event('beforeunload')),
    ]) {
      setOffline('force', false);
      w.RFOffline.overlay.restoreOnlineOnly(d);
      click(d.querySelector('[data-rf-delete="feed:7"] span'));
      setOffline('force', true);
      w.RFOffline.overlay.disableOnlineOnly(d);
      trigger(); // same task: no MutationObserver checkpoint yet
      assert.equal(w.RFPending.state('feed:7'), undefined);
      assert.equal(d.getElementById('row-7').hidden, false);
      assert.deepEqual(sent, []);
    }
    await flush();
  } finally { dom.window.close(); }
});

test('sources: sheet lifecycle survives boosted swaps', async () => {
  // Breaks: duplicate listeners, stacked modals, stale host references, unsafe GET
  // representation, missing focus/offline gate, unclamped detached menu observers.
  const { dom, w, d, requests, toasts, event, reply, click } = setup(host + '<main><form action="/settings/profile" data-rf-online-only></form></main>');
  try {
    assert.equal(typeof w.RFSources?.open, 'function', 'shared Sources API exists');
    assert.equal(typeof w.RFDialog?.open, 'function');
    for (let i = 0; i < 2; i++) {
      if (i) { d.body.innerHTML = host; event('htmx:afterSwap', { target: d.body }); w.eval(fs.readFileSync(root + 'ui/sources.js', 'utf8')); }
      const opener = d.getElementById('add');
      opener.focus(); click(opener); await flush();
      assert.equal(requests.length, i + 1);
      assert.equal(requests[i].options.headers['HX-Target'], 'rf-source-sheet-body');
      reply(requests[i], form);
      assert.equal(d.querySelectorAll('#feed-subscribe-form').length, 1);
      assert.equal(d.activeElement, d.getElementById('feed-url-input'), 'loaded form receives focus');
      assert.equal(d.querySelectorAll('dialog[open]').length, 1);
      if (i === 0) {
        const edit = d.getElementById('feed-subscribe-form');
        edit.querySelector('#feed-url-input').value = 'https://example.com/keep';
        await w.htmx.ajax('POST', '/settings/feeds', { source: edit, target: '#rf-source-sheet-body', headers: {} });
        reply(requests.at(-1), 'Unavailable', 500);
        assert.equal(edit.isConnected, true, 'failed save retains the form');
        assert.equal(edit.querySelector('#feed-url-input').value, 'https://example.com/keep');
        assert.match(d.getElementById('rf-source-sheet-body').textContent, /500|retry/i);
        requests.pop(); // keep the two GET-count assertions independent of this POST
      }
      d.getElementById('rf-source-sheet').close(); // native Escape close event
      assert.equal(d.activeElement, opener);
    }
    const palette = d.createElement('dialog'); palette.id = 'command-palette'; d.body.append(palette);
    palette.showModal();
    let closePalette;
    palette.close = () => { closePalette = () => { palette.removeAttribute('open'); palette.dispatchEvent(new w.Event('close')); }; };
    w.RFSources.open('/settings/feeds/add', d.getElementById('add'));
    assert.equal(d.getElementById('rf-source-sheet').open, false, 'wait for palette close event');
    closePalette(); await flush();
    assert.equal(d.getElementById('rf-source-sheet').open, true);
    reply(requests.at(-1), '<!doctype html><html><body>Login</body></html>');
    assert.equal(d.querySelector('#rf-source-sheet-body form'), null);
    assert.match(d.getElementById('rf-source-sheet-body').textContent, /sign in|session|retry/i);
    d.getElementById('add').remove(); d.getElementById('rf-source-sheet').close(); await flush();
    assert.equal(d.activeElement, d.getElementById('sources-heading'));
    d.documentElement.classList.add('mobile-sidebar-open');
    w._closeMobileSidebarOverlay = () => { d.documentElement.classList.remove('mobile-sidebar-open'); };
    w.RFSources.open('/settings/feeds/add', null);
    assert.equal(d.getElementById('rf-source-sheet').open, false, 'wait for phone history close');
    w.dispatchEvent(new w.PopStateEvent('popstate')); await flush();
    assert.equal(d.getElementById('rf-source-sheet').open, true);
    d.getElementById('rf-source-sheet').close();
    const count = requests.length;
    Object.defineProperty(w.navigator, 'onLine', { configurable: true, value: false });
    w.RFSources.open('/settings/feeds/add', null);
    Object.defineProperty(w.navigator, 'onLine', { configurable: true, value: true });
    w.RFOffline = { page: { current: () => ({ isOffline: () => true }) } };
    w.RFSources.open('/settings/feeds/add', null);
    assert.equal(requests.length, count);
    assert.match(JSON.stringify(toasts), /connect|online/i);
    w.RFOffline = null;
    for (const bad of ['https://evil.test/settings/feeds/add', '/settings/profile', '/settings/feeds/test']) w.RFSources.open(bad, null);
    assert.equal(requests.length, count);
    d.body.insertAdjacentHTML('beforeend', '<div class="rf-sources-table-scroll"><div data-rf-source-menu><button aria-expanded="true">Menu</button><div data-popover aria-hidden="false">Menu content</div></div></div>');
    const menu = d.querySelector('[data-rf-source-menu]'), trigger = menu.querySelector('button'), panel = menu.querySelector('[data-popover]');
    w.innerWidth = 390; w.innerHeight = 600;
    trigger.getBoundingClientRect = () => ({ left: 370, right: 390, top: 570, bottom: 590 });
    panel.getBoundingClientRect = () => ({ width: 180, height: 120 });
    w.RFSources.positionMenus();
    assert.ok(parseFloat(panel.style.left) <= 202);
    assert.ok(parseFloat(panel.style.top) <= 472);
    trigger.getBoundingClientRect = () => ({ left: 20, right: 40, top: 20, bottom: 40 });
    d.querySelector('.rf-sources-table-scroll').dispatchEvent(new w.Event('scroll'));
    assert.ok(parseFloat(panel.style.top) < 100);
    w.innerWidth = 160; w.dispatchEvent(new w.Event('resize'));
    assert.ok(parseFloat(panel.style.left) <= 8);
    menu.remove(); await flush();
    panel.style.left = '99px'; trigger.setAttribute('aria-expanded', 'false'); await flush();
    assert.equal(panel.style.left, '99px', 'removed menu is no longer repositioned');
    d.body.innerHTML = host + form;
    w.RFSources.open('/settings/feeds/add', null); await flush();
    assert.equal(d.querySelectorAll('#feed-subscribe-form').length, 1);
    assert.equal(requests.length, count);
    d.body.innerHTML = host;
    w.history.replaceState({}, '', '/settings/feeds#feed-url-input');
    event('htmx:afterSwap', { target: d.body }); await flush();
    assert.equal(requests.length, count + 1);
    assert.equal(w.location.hash, '');
    event('htmx:afterSwap', { target: d.body }); await flush();
    assert.equal(requests.length, count + 1);
    reply(requests.at(-1), form);
    d.body.insertAdjacentHTML('beforeend', '<button id="tab-feeds" hx-get="/settings/feeds-list">Feeds</button><div id="feeds-list">List</div>');
    const beforeSave = requests.length;
    event('rf:sourceschanged', { kind: 'opml' });
    assert.equal(d.getElementById('rf-source-sheet').open, true, 'OPML report stays open');
    assert.equal(requests.length, beforeSave + 1);
    assert.equal(requests.at(-1).url, '/settings/feeds-list');
    assert.equal(requests.at(-1).options.swap, 'outerHTML');
    event('rf:sourceschanged', { kind: 'edit' });
    assert.equal(d.getElementById('rf-source-sheet').open, false, 'edit success closes sheet');
    assert.equal(requests.length, beforeSave + 2);
  } finally { dom.window.close(); }
});

test('sources: discovery ignores stale results and surfaces transport failures', async () => {
  // Breaks: eager request, un-cancelled timer, stale response/title, candidate re-fetch,
  // silent network/rate/login failure or credential persistence.
  const { dom, w, d, requests, event, reply, click, tick } = setup(host + form);
  try {
    assert.equal(typeof w.RFSources?.open, 'function', 'shared Sources API exists');
    const url = d.getElementById('feed-url-input'), title = d.getElementById('feed-custom-title');
    const change = value => { url.value = value; url.dispatchEvent(new w.Event('input', { bubbles: true })); };
    change('https://example.com/old'); tick(799); assert.equal(requests.length, 0);
    tick(1); assert.equal(requests.length, 1);
    change('https://example.com/new'); tick(800); assert.equal(requests.length, 2);
    reply(requests[1], '<p data-feed-title="Current">Current</p>');
    reply(requests[0], '<p data-feed-title="Stale">Stale</p>');
    assert.equal(title.placeholder, 'Current');
    assert.doesNotMatch(d.getElementById('feed-test-result').textContent, /Stale/);
    change('https://example.com/manual'); tick(400); click(d.querySelector('[data-rf-source-test]'));
    tick(800); assert.equal(requests.length, 3);
    change('https://example.com/enter');
    url.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    tick(800); assert.equal(requests.length, 4);
    reply(requests.at(-1), '<button type="button" data-select-detected-feed data-url="https://example.com/chosen" data-title="Chosen">Select</button>');
    click(d.querySelector('[data-select-detected-feed]')); tick(800);
    assert.equal(url.value, 'https://example.com/chosen'); assert.equal(title.placeholder, 'Chosen');
    assert.equal(requests.length, 4);
    const limited = renderTemplate('errors/429.html');
    assert.match(limited, /<!DOCTYPE html>/i);
    assert.match(limited, /Too many requests/);
    change('https://example.com/limit'); tick(800); reply(requests.at(-1), limited, 429);
    assert.match(d.getElementById('feed-test-result').textContent, /Wait a minute/);
    assert.doesNotMatch(d.getElementById('feed-test-result').textContent, /session|sign in/i);
    change('https://example.com/network'); tick(800);
    event('htmx:sendError', { xhr: requests.at(-1).xhr, requestConfig: requests.at(-1).options });
    assert.match(d.getElementById('feed-test-result').textContent, /connect|network|retry/i);
    change('https://example.com/login'); tick(800); reply(requests.at(-1), '<html><body>Login</body></html>', 200, 'https://readfine.test/login');
    assert.match(d.getElementById('feed-test-result').textContent, /sign in|session/i);
    reply(requests.at(-1), '<!doctype html><html><body>Offline fallback</body></html>', 200, 'https://readfine.test/settings/feeds/test');
    assert.match(d.getElementById('feed-test-result').textContent, /sign in|session/i);
    assert.equal(d.querySelector('#feed-test-result body'), null);
    d.querySelector('[name="fetch_auth_user"]').value = 'private-user';
    d.querySelector('[name="fetch_auth_pass"]').value = 'private-password';
    change('https://example.com/subscribe');
    d.getElementById('feed-subscribe-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    tick(800); assert.equal(requests.length, 7, 'submit cancels scheduled discovery');
    assert.equal(w.localStorage.length, 0); assert.equal(w.sessionStorage.length, 0);
    // During wave 1 the old form remains owned by T2: no double listeners there.
    d.getElementById('feed-subscribe-form').removeAttribute('data-rf-source-form');
    change('https://example.com/legacy'); tick(800); assert.equal(requests.length, 7);
  } finally { dom.window.close(); }
});

test('sources: automatic discovery needs changed inputs and a visible form', () => {
  const { dom, w, d, requests, tick, click } = setup(host + form);
  try {
    const source = d.getElementById('feed-subscribe-form'), url = d.getElementById('feed-url-input');
    const input = el => el.dispatchEvent(new w.Event('input', { bubbles: true }));
    url.value = 'https://example.com/feed'; input(url); tick(800);
    assert.equal(requests.length, 1);
    input(url); tick(800);
    assert.equal(requests.length, 1, 'unchanged URL must not repeat discovery');
    const auth = source.querySelector('[name="fetch_auth_pass"]');
    auth.value = 'changed'; input(auth); tick(800);
    assert.equal(requests.length, 2, 'changed auth retries the same address');
    input(auth); tick(800); assert.equal(requests.length, 2);
    for (const hide of [() => { source.hidden = true; }, () => { source.style.display = 'none'; }]) {
      url.value += '/new'; input(url); hide(); tick(800);
      assert.equal(requests.length, 2, 'hidden connected form cannot discover');
      source.hidden = false; source.style.display = '';
    }
    input(url); tick(800); assert.equal(requests.length, 3, 'hidden work was not recorded as discovered');
    click(source.querySelector('[data-rf-source-test]'));
    assert.equal(requests.length, 4, 'explicit Test may retry unchanged inputs');
  } finally { dom.window.close(); }
});

test('sources: real HTMX replaces overlapping discovery, Test and Subscribe', async () => {
  const attrs = fs.readFileSync('backend/app/templates/sources/add.html', 'utf8').match(/hx-sync="[^"]+"/)?.[0] || '';
  const dom = new JSDOM('<!doctype html><body>' + host + form.replace('<form ', '<form ' + attrs + ' '), {
    url: 'https://readfine.test/settings/feeds', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, d = w.document, sent = [];
  // Only the wire is fake: HTMX owns sync, request events, aborts and swaps.
  class Wire extends w.EventTarget {
    constructor() { super(); this.upload = new w.EventTarget(); this.headers = {}; }
    open(method, path) { this.method = method; this.path = path; }
    setRequestHeader(key, value) { this.headers[key] = value; }
    overrideMimeType() {}
    getAllResponseHeaders() { return ''; }
    getResponseHeader() { return null; }
    send(body) { this.body = body; sent.push(this); }
    abort() { this.aborted = true; this.onabort?.(); }
    reply(html) {
      this.status = 200; this.response = this.responseText = html;
      this.responseURL = new URL(this.path, w.location).href; this.onload();
    }
  }
  w.XMLHttpRequest = Wire;
  // jsdom requires the optional XPath result type; browsers default it to ANY_TYPE.
  const evaluate = w.XPathExpression.prototype.evaluate;
  w.XPathExpression.prototype.evaluate = function (node, type = 0, result = null) { return evaluate.call(this, node, type, result); };
  try {
    await new Promise(resolve => w.setTimeout(resolve, 0));
    w.eval(fs.readFileSync(root + 'htmx.min.js', 'utf8'));
    w.eval(fs.readFileSync(root + 'ui/sources.js', 'utf8'));
    w.htmx.process(d.body);
    const source = d.getElementById('feed-subscribe-form'), url = d.getElementById('feed-url-input');
    url.value = 'https://example.com/feed';
    url.dispatchEvent(new w.Event('input', { bubbles: true }));
    await new Promise(resolve => w.setTimeout(resolve, 850));
    assert.equal(sent.length, 1);
    source.querySelector('[data-rf-source-test]').click();
    assert.equal(sent.length, 2, 'Test immediately replaces automatic discovery');
    assert.equal(sent[0].aborted, true);
    await flush();
    assert.doesNotMatch(d.getElementById('feed-test-result').textContent, /Network error/);
    source.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(sent.length, 3, 'Subscribe immediately replaces Test');
    assert.equal(sent[1].aborted, true);
    assert.equal(sent[2].path, '/settings/feeds');
    sent[2].reply('<p>Subscribed</p>');
    await new Promise(resolve => w.setTimeout(resolve, 30));
    assert.equal(d.getElementById('rf-source-sheet-body').textContent, 'Subscribed');
    assert.equal(sent.length, 3, 'no discovery remains queued after Subscribe');
    w.RFOffline = { page: { current: () => ({ isOffline: () => true }) } };
    source.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(sent.length, 3, 'real HTMX must not send an already-open form while force-offline');
    assert.equal(d.getElementById('rf-source-sheet-body').textContent, 'Subscribed');
  } finally { dom.window.close(); }
});

// Read the shipped form attributes, including T3's forms when checking integration.
// Only resolve the template values needed for these request-boundary fixtures.
const templateRoot = process.env.RF_SOURCES_TEMPLATE_ROOT || 'backend/app/templates';
// Render real template inheritance/macros without importing the app or opening a DB.
function renderTemplate(path, context = {}) {
  const result = spawnSync(process.env.PYTHON || 'backend/.venv/bin/python', ['-c', `
import json, sys
from jinja2 import Environment, FileSystemLoader, select_autoescape
root, path, context = json.loads(sys.stdin.read())
env = Environment(loader=FileSystemLoader(root), autoescape=select_autoescape())
env.filters.update(num=str, numg=str)
env.globals.update(static_url=lambda p: '/static/' + p, web_viewer=lambda: (1, 'Reader'),
    app_ai_enabled=lambda: False, viewer_is_admin=lambda: False, ai_error_fresh=lambda: False)
defaults = dict(request=dict(headers={}, state=dict(csp_nonce='test'),
    url=dict(path='/settings/feeds'), query_params={}), folders=[],
    default_fetch_interval_min=60, auto_interval_min=60, block_badge_threshold=3,
    uf=dict(id=42, feed=dict(id=7, title='Old scrape feed', feed_type='scrape',
        status='active', block_count=0, feed_url='https://old.example/',
        subscriber_count=1, type_config=dict(article_links_selector='.old a'))),
    is_sole_subscriber=True, url='https://new.example/', page_title='New scrape feed')
defaults.update(context)
print(env.get_template(path).render(**defaults))
`], { input: JSON.stringify([templateRoot, path, context]), encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout;
}
function shippedForm(path) {
  const template = fs.readFileSync(`${templateRoot}/${path}`, 'utf8');
  const tag = template.match(/<form\b[\s\S]*?>/g)?.find(tag => /method="post"/i.test(tag));
  assert.ok(tag, `POST form exists in ${path}`);
  const resolved = tag.replace(/{{\s*uf.id\s*}}/g, '42')
    .replace(/{{\s*'#rf-source-sheet-body'[^}]*}}/g, '#rf-source-sheet-body');
  assert.doesNotMatch(resolved, /{{|{%/, 'fixture must resolve every form attribute');
  return resolved + '<button type="submit">Save</button></form>';
}
async function realSources(body) {
  const dom = new JSDOM('<!doctype html><body>' + body + '</body>', {
    url: 'https://readfine.test/settings/feeds', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, d = w.document, sent = [], toasts = [];
  class Wire extends w.EventTarget {
    constructor() { super(); this.upload = new w.EventTarget(); }
    open(method, path) { this.method = method; this.path = path; }
    setRequestHeader() {}
    overrideMimeType() {}
    send() { sent.push(this); }
    abort() { this.onabort?.(); }
  }
  w.XMLHttpRequest = Wire;
  const evaluate = w.XPathExpression.prototype.evaluate;
  w.XPathExpression.prototype.evaluate = function (node, type = 0, result = null) { return evaluate.call(this, node, type, result); };
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new w.Event('close')); };
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.RFToast = { show: message => toasts.push(message) };
  await new Promise(resolve => w.setTimeout(resolve, 0));
  w.eval(fs.readFileSync(root + 'htmx.min.js', 'utf8'));
  w.eval(fs.readFileSync(root + 'ui/dialog.js', 'utf8'));
  w.eval(fs.readFileSync(root + 'ui/sources.js', 'utf8'));
  w.htmx.process(d.body);
  return { dom, w, d, sent, toasts };
}

test('sources: real HTMX gates shipped add, edit, OPML and scrape forms offline', async () => {
  for (const path of ['sources/add.html', 'settings/feed_edit.html', 'settings/opml.html', 'settings/scrape_setup.html']) {
    for (const scope of ['id="rf-source-sheet"', 'data-rf-source-sheet', 'standalone']) {
      const markup = shippedForm(path);
      // Legacy standalone forms have no Sources marker; T3 adds online-only.
      if (scope === 'standalone' && !/data-rf-(online-only|source-form)/.test(markup)) continue;
      const { dom, w, d, sent, toasts } = await realSources(
        `<section ${scope === 'standalone' ? '' : scope}>${markup}</section>` +
        '<div id="rf-source-sheet-body"></div><div id="feed-test-result"></div>' +
        '<div id="opml-busy"></div><button id="opml-submit-btn"></button><div id="subscribe-spinner"></div>');
      try {
        const source = d.querySelector('form');
        const submit = () => source.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
        w.RFOffline = { page: { current: () => ({ isOffline: () => true }) } };
        submit();
        assert.equal(sent.length, 0, `${path} in ${scope}: force-offline blocks the real request`);
        assert.match(toasts.at(-1), /Connect to the internet/);
        w.RFOffline = null;
        Object.defineProperty(w.navigator, 'onLine', { configurable: true, value: false });
        submit();
        assert.equal(sent.length, 0, `${path} in ${scope}: browser offline also blocks`);
        assert.equal(toasts.length, 2);
        Object.defineProperty(w.navigator, 'onLine', { configurable: true, value: true });
        submit();
        assert.equal(sent.length, 1, `${path} in ${scope}: online submission reaches the wire`);
        assert.equal(sent[0].method.toUpperCase(), 'POST');
        assert.equal(sent[0].path, source.getAttribute('action'));
      } finally { dom.window.close(); }
    }
  }
});

test('sources: real HTMX gates descendant requests in every Sources scope', async () => {
  for (const scope of ['id="rf-source-sheet"', 'data-rf-source-sheet', 'data-rf-online-only', 'data-rf-source-form']) {
    const { dom, w, d, sent, toasts } = await realSources(`<section ${scope}><button hx-get="/settings/feeds-list">Load</button></section>`);
    try {
      w.RFOffline = { page: { current: () => ({ isOffline: () => true }) } };
      d.querySelector('button').click();
      assert.equal(sent.length, 0, scope);
      assert.match(toasts.at(-1), /Connect to the internet/);
      w.RFOffline = null;
      d.querySelector('button').click();
      assert.equal(sent.length, 1, `${scope}: online request still works`);
    } finally { dom.window.close(); }
  }
});

test('sources: real HTMX respects aria-disabled on the shipped online-only opener', async () => {
  const template = fs.readFileSync(`${templateRoot}/sources/base.html`, 'utf8');
  const button = template.split('\n').find(line => line.includes('button("Add source"'));
  assert.ok(button, 'shipped Add source opener exists');
  const attrs = JSON.parse(button.match(/attrs=({.*?})/)[1]);
  const href = button.match(/href="([^"]+)"/)[1];
  const { dom, w, d, sent } = await realSources(host);
  try {
    const opener = d.getElementById('add');
    opener.setAttribute('href', href);
    for (const [name, value] of Object.entries(attrs)) opener.setAttribute(name, value);
    opener.setAttribute('aria-disabled', 'true');
    w.htmx.process(opener);
    opener.click();
    await flush();
    assert.equal(d.getElementById('rf-source-sheet').open, false, 'disabled click cannot open sheet');
    assert.equal(sent.length, 0, 'disabled click cannot GET');
    w.RFSources.open(href, opener);
    await flush();
    assert.equal(d.getElementById('rf-source-sheet').open, false, 'public API respects disabled opener');
    assert.equal(sent.length, 0);
    opener.setAttribute('aria-disabled', 'false');
    opener.click();
    await flush();
    assert.equal(d.getElementById('rf-source-sheet').open, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].path, href);
  } finally { dom.window.close(); }
});

test('sources: shipped standalone forms navigate through Add and scraping with real HTMX', async () => {
  const add = renderTemplate('sources/add.html');
  const addDOM = new JSDOM(add);
  const header = addDOM.window.document.querySelector('main header').outerHTML;
  addDOM.window.close();
  const pages = new Map([['/sources/add', add]]);
  for (const [url, template] of [
    ['/sources/feeds/42/edit', 'settings/feed_edit.html'],
    ['/sources/opml', 'settings/opml.html'],
    ['/sources/scrape', 'settings/scrape_setup.html'],
  ]) {
    const dom = new JSDOM(renderTemplate(template));
    // T1's seed still has legacy settings pages; use the shipped Sources header
    // there too, as T3's sources/base inheritance does in the integrated tree.
    if (!dom.window.document.querySelector('a[data-rf-source-sheet][href="/sources/add"]')) {
      dom.window.document.querySelector('main').insertAdjacentHTML('afterbegin', header);
    }
    pages.set(url, dom.serialize());
    dom.window.close();
  }
  const discoveryHTML = renderTemplate('settings/partials/feed_test_result.html', {
    detected_feeds: [], test_url: 'https://new.example/', scrape_available: true,
  });
  const limitedHTML = renderTemplate('errors/429.html');
  let rateLimited = false;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable', headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const scripts = new Set(['htmx.min.js', 'ui/dialog.js', 'ui/sources.js', 'app.js']);
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/static/')) {
        const file = url.pathname.slice('/static/js/'.length);
        return route.fulfill({ contentType: 'text/javascript', body: scripts.has(file) ? fs.readFileSync(root + file, 'utf8') : '' });
      }
      if (url.pathname === '/sources/test' && rateLimited) {
        rateLimited = false;
        return route.fulfill({ status: 429, contentType: 'text/html', body: limitedHTML });
      }
      const body = pages.get(url.pathname) || (url.pathname === '/sources/test' ? discoveryHTML : '<p>Preview</p>');
      await route.fulfill({ contentType: 'text/html', body });
    });
    const opener = 'a[data-rf-source-sheet][href="/sources/add"]';
    for (const url of ['/sources/feeds/42/edit', '/sources/opml', '/sources/scrape']) {
      await page.goto('https://readfine.test' + url);
      const request = page.waitForRequest(req => new URL(req.url()).pathname === '/sources/add');
      await page.locator(opener).click();
      assert.equal((await request).isNavigationRequest(), true, `${url}: Add must replace the standalone page`);
      await page.waitForURL('**/sources/add');
      assert.equal(await page.locator('#rf-source-sheet[open]').count(), 0);
      assert.equal(await page.locator('#feed-subscribe-form').count(), 1);
      assert.equal(await page.locator('#selector-input').count(), 0, 'old selector form was unmounted');
      // Clicking Add on the standalone Add page retains and focuses its input.
      await page.locator(opener).click();
      assert.equal(await page.locator('#feed-url-input').evaluate(el => el === document.activeElement), true);
      assert.equal(await page.locator('#rf-source-sheet[open]').count(), 0);
      if (url !== '/sources/feeds/42/edit') continue;
      rateLimited = true;
      await page.locator('#feed-url-input').fill('https://new.example/');
      await page.locator('[data-rf-source-test]').click();
      await page.getByText('Too many requests (429). Wait a minute, then use Test to retry.').waitFor();
      await page.locator('[data-rf-source-test]').click();
      const scraping = page.waitForRequest(req => new URL(req.url()).pathname === '/sources/scrape');
      await page.getByRole('link', { name: 'Try web scraping' }).click();
      assert.equal((await scraping).isNavigationRequest(), true, 'scraping replaces standalone Add');
      await page.waitForURL(url => url.pathname === '/sources/scrape');
      assert.equal(await page.locator('#selector-input').count(), 1);
      assert.equal(await page.locator('#preview-btn').count(), 1);
      assert.equal(await page.locator('#rf-source-sheet form').count(), 0);
      const preview = page.waitForRequest(req => new URL(req.url()).pathname === '/sources/scrape-preview');
      await page.evaluate(() => document.body.dispatchEvent(new CustomEvent('selectorGenerated', { detail: { selector: '.new a' } })));
      const values = new URLSearchParams((await preview).postData());
      assert.equal(await page.locator('#selector-input').inputValue(), '.new a');
      assert.equal(values.get('selector'), '.new a');
      assert.equal(values.get('url'), 'https://new.example/');
      assert.equal(values.has('feed_id'), false, 'preview belongs to the new form, not the old edit');
    }
  } finally { await browser.close(); }
});

test('sources: canonical forms and legacy hooks survive migration and consume added once', async () => {
  const { dom, w, d, requests, event, click } = setup(host + '<p id="feed-added-banner">Added</p>', 'https://readfine.test/sources?added=Feed&keep=a%2Bb#position');
  try {
    w.history.replaceState({ preserved: true }, '', w.location.href);
    event('DOMContentLoaded');
    assert.equal(w.location.search, '?keep=a%2Bb');
    assert.equal(w.location.hash, '#position');
    assert.equal(w.history.state.preserved, true);
    assert.equal(w.history.length, 1);
    assert.ok(d.getElementById('feed-added-banner'), 'current success feedback remains visible');
    w.history.replaceState(null, '', '/sources?added=Again&keep=2');
    event('htmx:afterSwap', { target: d.body });
    assert.equal(w.location.search, '?keep=2', 'boosted navigation consumes added again');
    for (const path of ['/sources/scrape?url=https%3A%2F%2Fexample.com', '/settings/feeds/scrape-setup?url=https%3A%2F%2Fexample.com']) {
      w.RFSources.open(path, null); await flush();
      assert.equal(requests.at(-1).url, path);
      d.getElementById('rf-source-sheet').close();
    }
    for (const action of ['/sources', '/settings/feeds']) {
      d.getElementById('rf-source-sheet-body').innerHTML = form.replace('hx-post="/settings/feeds"', 'hx-post="' + action + '"');
      d.getElementById('feed-url-input').value = 'https://example.com/feed';
      d.getElementById('rf-source-sheet').showModal();
      click(d.querySelector('[data-rf-source-test]')); await flush();
      assert.equal(requests.at(-1).url, action + '/test');
      d.getElementById('rf-source-sheet').close();
    }
  } finally { dom.window.close(); }
});


test('sources: auth inputs inserted into a sheet opt the feed into privacy', () => {
  const w = appBrowser('<div id="rf-source-sheet-body"></div>');
  try {
    const d = w.document;
    for (const field of ['feed-auth-user', 'feed-auth-pass']) {
      d.getElementById('rf-source-sheet-body').innerHTML = '<form><input id="feed-auth-user"><input id="feed-auth-pass" type="password"><input id="feed-is-private" name="is_private" type="checkbox"></form>';
      const input = d.getElementById(field);
      const checkbox = d.getElementById('feed-is-private');
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      assert.equal(checkbox.checked, false, 'empty auth does not change privacy');
      input.value = 'fixture-credential';
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      assert.equal(checkbox.checked, true, `${field} works after a sheet swap`);
      input.value = '';
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      assert.equal(checkbox.checked, true, 'clearing auth never silently makes a feed public');
      checkbox.remove();
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
    }
  } finally { w.close(); }
});

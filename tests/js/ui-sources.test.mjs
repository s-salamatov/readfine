import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const root = 'backend/app/static/js/';
const host = '<h1 id="sources-heading" tabindex="-1">Sources</h1><a id="add" href="/settings/feeds/add" data-rf-source-sheet>Add</a><dialog id="rf-source-sheet"><h2 id="rf-source-sheet-title">Source</h2><div id="rf-source-sheet-body"></div><button data-rf-close>Close</button></dialog>';
const form = '<form id="feed-subscribe-form" data-rf-source-form="add" hx-post="/settings/feeds" hx-target="#rf-source-sheet-body" hx-swap="innerHTML"><input id="feed-url-input" name="url"><input id="feed-custom-title" name="custom_title" data-default-placeholder="Custom title (optional)"><input name="fetch_auth_user"><input name="fetch_auth_pass" type="password"><button type="button" data-rf-source-test>Test</button><button type="submit">Subscribe</button><div id="feed-test-result"></div></form>';
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function setup(body = host, url = 'https://readfine.test/settings/feeds') {
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
  if (fs.existsSync(root + 'ui/sources.js')) w.eval(fs.readFileSync(root + 'ui/sources.js', 'utf8'));
  const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  return { dom, w, d, requests, toasts, event, reply, click, tick };
}

test('sources: sheet lifecycle survives boosted swaps', async () => {
  // Breaks: duplicate listeners, stacked modals, stale host references, unsafe GET
  // representation, missing focus/offline gate, unclamped detached menu observers.
  const { dom, w, d, requests, toasts, event, reply, click } = setup();
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
    change('https://example.com/limit'); tick(800); reply(requests.at(-1), '', 429);
    assert.match(d.getElementById('feed-test-result').textContent, /429|too many|wait/i);
    change('https://example.com/network'); tick(800);
    event('htmx:sendError', { xhr: requests.at(-1).xhr, requestConfig: requests.at(-1).options });
    assert.match(d.getElementById('feed-test-result').textContent, /connect|network|retry/i);
    change('https://example.com/login'); tick(800); reply(requests.at(-1), '<html><body>Login</body></html>', 200, 'https://readfine.test/login');
    assert.match(d.getElementById('feed-test-result').textContent, /sign in|session/i);
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

test('sources: already-open forms cancel requests after force-offline changes', () => {
  const { dom, w, d, event, toasts } = setup(host + form);
  try {
    const source = d.getElementById('feed-subscribe-form');
    w.RFOffline = { page: { current: () => ({ isOffline: () => true }) } };
    for (const kind of ['add', 'edit', 'opml']) {
      source.dataset.rfSourceForm = kind;
      assert.equal(event('htmx:beforeRequest', { elt: source, requestConfig: {}, xhr: {} }, source).defaultPrevented, true);
    }
    assert.equal(toasts.length, 3);
    w.RFOffline = null;
    assert.equal(event('htmx:beforeRequest', { elt: source, requestConfig: {}, xhr: {} }, source).defaultPrevented, false);
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

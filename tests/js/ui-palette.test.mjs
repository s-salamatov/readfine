// static/js/ui/palette.js: window.RFPalette, the reader's command palette (s3-T7).
//
// Each test loads the vendored Basecoat command.min.js (behind a minimal
// basecoat.register shim, so data-force and refresh() run for real) and the real
// palette.js into jsdom, over markup shaped like app/partials/palette.html. jsdom has
// no modal dialogs, so showModal() / close() are polyfilled as in ui-dialog.test.mjs,
// and fetch is a stub whose answers each test resolves by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { worker } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const JS = path.join(ROOT, 'backend', 'app', 'static', 'js');
const PALETTE_JS = path.join(JS, 'ui', 'palette.js');
const COMMAND_JS = path.join(JS, 'vendor', 'basecoat', 'command.min.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEBOUNCE_WAIT = 260; // palette.js debounces 200 ms

function polyfillDialog(w) {
  const proto = w.HTMLDialogElement.prototype;
  proto.showModal = function () {
    if (this.hasAttribute('open')) throw new w.DOMException('already open', 'InvalidStateError');
    this.setAttribute('open', '');
    this.showModalCalls = (this.showModalCalls || 0) + 1;
  };
  proto.close = function () {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new w.Event('close'));
  };
  if (!('open' in proto)) {
    Object.defineProperty(proto, 'open', { get() { return this.hasAttribute('open'); } });
  }
}

const PAGE = ''
  + '<aside id="sidebar">'
  + '<div id="sidebar-rail"><a id="rail-starred" class="nav-item" hx-get="/htmx/articles?starred_only=true">*</a></div>'
  + '<div id="sidebar-full"><a id="full-starred" class="nav-item" hx-get="/htmx/articles?starred_only=true"><span class="flex-1">Starred</span></a></div>'
  + '</aside>'
  + '<div id="article-list"></div>'
  + '<button id="opener" type="button">Search</button>'
  + '<dialog id="rf-palette" class="command-dialog" aria-label="Command palette"><div class="command">'
  + '<header><input type="text" id="rf-palette-input" role="combobox" aria-controls="rf-palette-menu"></header>'
  + '<div role="menu" id="rf-palette-menu" data-empty="No results found.">'
  + '<div role="group" id="rf-palette-results" aria-live="polite"></div>'
  + '<div role="group" aria-labelledby="g-label"><span role="heading" id="g-label">Actions</span>'
  + '<div id="rf-palette-item-1" role="menuitem" data-rf-palette-advanced data-force><span>Advanced search…</span></div>'
  + '<div id="rf-palette-item-2" role="menuitem" data-rf-nav="/htmx/articles?starred_only=true"><span>Starred</span></div>'
  + '<div id="rf-palette-item-3" role="menuitem" data-rf-nav="/htmx/articles?folder_id=5"><span>Some folder</span></div>'
  + '</div></div></div></dialog>';

// Read inside each test, so a missing palette.js fails every test, not the file.
function load() {
  const dom = new JSDOM('<!doctype html><html><head></head><body>' + PAGE + '</body></html>', {
    runScripts: 'dangerously',
    url: 'https://readfine.test/app',
    beforeParse: polyfillDialog,
  });
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.error || e.message));
  const logged = [];
  for (const level of ['error', 'warn']) w.console[level] = (...a) => logged.push([level, ...a]);

  // fetch: every call stays pending until the test answers it. Aborts reject the way
  // a browser does unless the test asks the stub to ignore them (a server answer
  // racing the abort).
  const calls = [];
  w.fetch = (url, opts) => {
    let resolve, reject;
    const p = new Promise((res, rej) => { resolve = res; reject = rej; });
    const call = {
      url, opts, ignoreAbort: false,
      answer: (body, init) => resolve(new Response(body, init)),
      fail: (err) => reject(err),
    };
    if (opts && opts.signal) {
      opts.signal.addEventListener('abort', () => {
        if (!call.ignoreAbort) reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    }
    calls.push(call);
    return p;
  };

  const htmxCalls = { process: [], ajax: [] };
  w.htmx = {
    process: (el) => htmxCalls.process.push(el),
    ajax: (...args) => { htmxCalls.ajax.push(args); return Promise.resolve(); },
  };

  // Basecoat's registry, reduced to "init every match now".
  w.basecoat = {
    register(name, { selector, init }) { w.document.querySelectorAll(selector).forEach(init); },
  };
  for (const file of [COMMAND_JS, PALETTE_JS]) {
    const s = w.document.createElement('script');
    s.textContent = fs.readFileSync(file, 'utf8');
    w.document.head.appendChild(s);
  }
  const d = w.document;
  return {
    w, d, calls, htmxCalls, errors, logged,
    dialog: d.getElementById('rf-palette'),
    input: d.getElementById('rf-palette-input'),
    results: d.getElementById('rf-palette-results'),
  };
}

function type(env, value) {
  env.input.value = value;
  env.input.dispatchEvent(new env.w.Event('input', { bubbles: true }));
}

function click(w, el) {
  const ev = new w.MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

const state = (env) => env.results.querySelector('[data-rf-palette-state]');

test('palette: typing quickly sends one request and drops stale answers', async () => {
  const env = load();
  assert.equal(typeof env.w.RFPalette, 'object', 'RFPalette is global');
  // A second copy of the script (re-run by a swap) adds no second set of listeners.
  const again = env.d.createElement('script');
  again.textContent = fs.readFileSync(PALETTE_JS, 'utf8');
  env.d.head.appendChild(again);
  env.w.RFPalette.open();
  type(env, 'r');
  type(env, 'ru');
  await sleep(50);
  type(env, 'rus');
  await sleep(50);
  type(env, 'rust');
  await sleep(DEBOUNCE_WAIT);
  assert.equal(env.calls.length, 1, 'one request for a burst of keys');
  assert.equal(env.calls[0].url, '/htmx/palette?q=rust');
  const headers = env.calls[0].opts.headers;
  assert.equal(headers['HX-Request'], 'true');

  // A newer query aborts the one in flight; the old answer, arriving anyway, is dropped.
  env.calls[0].ignoreAbort = true;
  type(env, 'rust news');
  await sleep(DEBOUNCE_WAIT);
  assert.equal(env.calls.length, 2);
  assert.equal(env.calls[1].url, '/htmx/palette?q=rust%20news');
  assert.equal(env.calls[0].opts.signal.aborted, true, 'the stale request is aborted');
  env.calls[1].answer('<div role="group"><a id="rf-palette-result-1" role="menuitem" href="/app?open_article_id=2" data-force><span>New</span></a></div>', { status: 200 });
  await sleep(10);
  env.calls[0].answer('<div role="group"><a id="rf-palette-result-1" role="menuitem" href="/app?open_article_id=1" data-force><span>Old</span></a></div>', { status: 200 });
  await sleep(10);
  assert.match(env.results.innerHTML, /New/);
  assert.doesNotMatch(env.results.innerHTML, /Old/);

  // An abort the browser reports as an error is not "Search failed".
  type(env, 'rust newer');
  await sleep(DEBOUNCE_WAIT);
  type(env, 'rust newest');
  await sleep(10);
  assert.equal(state(env), null, 'no error state from an aborted request');

  // Below two characters: no request, results cleared, the pending one cancelled.
  const before = env.calls.length;
  type(env, 'r');
  await sleep(DEBOUNCE_WAIT);
  assert.equal(env.calls.length, before);
  assert.equal(env.results.innerHTML, '');
  assert.deepEqual(env.errors, []);
});

test('palette: error and offline answers show their state', async () => {
  const env = load();
  env.w.RFPalette.open();

  type(env, 'boom');
  await sleep(DEBOUNCE_WAIT);
  env.calls[0].answer('Internal Server Error', { status: 500 });
  await sleep(10);
  assert.equal(state(env).getAttribute('data-rf-palette-state'), 'error');
  assert.equal(state(env).textContent, 'Search failed. Try again.');

  // The service worker's own offline answer (the real router): a 200 with its header
  // and body, naming the feature (featureOf maps /htmx/palette to Search).
  const sw = worker({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  const offline = await sw.ctx.RFOffline.router.handle(new Request('https://readfine.test/htmx/palette?q=offline'), null);
  const offlineBody = await offline.text();
  assert.equal(offline.headers.get('X-Readfine-Offline'), '1');
  assert.match(offlineBody, /data-rf-needs-connection/);
  assert.match(offlineBody, /Search: needs a connection/);
  type(env, 'offline');
  await sleep(DEBOUNCE_WAIT);
  env.calls[1].answer(offlineBody, { status: offline.status, headers: { 'X-Readfine-Offline': '1' } });
  await sleep(10);
  assert.equal(state(env).getAttribute('data-rf-palette-state'), 'offline');
  assert.equal(state(env).textContent, 'Search needs a connection. Advanced search works offline.');

  // The body alone is enough (a cached copy without the header).
  type(env, 'offline body');
  await sleep(DEBOUNCE_WAIT);
  env.calls[2].answer('<div data-rf-needs-connection>x</div>', { status: 200 });
  await sleep(10);
  assert.equal(state(env).getAttribute('data-rf-palette-state'), 'offline');

  // A network failure while the browser is online is a failed search.
  type(env, 'network');
  await sleep(DEBOUNCE_WAIT);
  env.calls[3].fail(new TypeError('Failed to fetch'));
  await sleep(10);
  assert.equal(state(env).getAttribute('data-rf-palette-state'), 'error');

  // The server's own empty state is shown as it came; a blank body at q >= 2 gets one.
  type(env, 'nothing');
  await sleep(DEBOUNCE_WAIT);
  env.calls[4].answer('', { status: 200 });
  await sleep(10);
  assert.equal(state(env).getAttribute('data-rf-palette-state'), 'empty');
  // Advanced search stays visible whatever the filter (data-force).
  assert.equal(env.d.getElementById('rf-palette-item-1').getAttribute('aria-hidden'), 'false');
  assert.deepEqual(env.errors, []);
});

test('palette: results refresh the command list', async () => {
  const env = load();
  env.w.RFPalette.open();
  type(env, 'qq');
  await sleep(DEBOUNCE_WAIT);
  // Server matches whose text does not contain the query: data-force keeps them.
  env.calls[0].answer(
    '<div role="group" aria-labelledby="rf-palette-result-1-label"><span role="heading" id="rf-palette-result-1-label">Articles</span>'
    + '<a id="rf-palette-result-1-1" role="menuitem" href="/app?open_article_id=7" data-force><span>Zeta</span></a></div>',
    { status: 200 },
  );
  await sleep(10);
  const hit = env.d.getElementById('rf-palette-result-1-1');
  assert.ok(hit, 'the answer is swapped into #rf-palette-results');
  assert.equal(hit.getAttribute('aria-hidden'), 'false', 'command.js knows the new item');
  assert.equal(hit.classList.contains('active'), true, 'the first server match is active');
  assert.equal(env.input.getAttribute('aria-activedescendant'), 'rf-palette-result-1-1');
  assert.equal(env.d.getElementById('rf-palette-item-2').getAttribute('aria-hidden'), 'true',
    'a static item that does not match stays filtered');
  assert.deepEqual(env.htmxCalls.process, [env.results], 'htmx processes the new markup');

  // Enter runs the active item: command.js clicks it.
  let clicked = null;
  hit.addEventListener('click', (e) => { clicked = e.currentTarget.id; e.preventDefault(); });
  env.input.dispatchEvent(new env.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(clicked, 'rf-palette-result-1-1');
  assert.deepEqual(env.errors, []);
});

test('palette: Advanced search opens the search modal with the query', async () => {
  const env = load();
  const { w, d } = env;
  const content = d.createElement('div');
  content.id = 'search-modal-content';
  d.body.appendChild(content);
  const opened = [];
  // app.js's openSearchModal(prefill, savedId): prefill is the "reopen the last
  // search" flag, so a fresh search passes false and the query goes in afterwards.
  w.openSearchModal = (...args) => {
    opened.push(args);
    content.innerHTML = '<input id="search-input" name="q">';
  };

  w.RFPalette.open();
  type(env, 'rust news');
  click(w, d.getElementById('rf-palette-item-1'));
  assert.equal(env.dialog.open, false, 'the palette closes');
  assert.deepEqual(opened, [[false]]);

  // The modal's content arrives through htmx; the query goes into its input then.
  d.body.dispatchEvent(new w.CustomEvent('htmx:afterSettle', { bubbles: true, detail: { target: content } }));
  assert.equal(d.getElementById('search-input').value, 'rust news');
  assert.equal(d.activeElement, d.getElementById('search-input'));

  // Only once: a later load of the modal is not overwritten.
  d.getElementById('search-input').value = 'mine';
  d.body.dispatchEvent(new w.CustomEvent('htmx:afterSettle', { bubbles: true, detail: { target: content } }));
  assert.equal(d.getElementById('search-input').value, 'mine');

  // With an empty query the modal opens fresh and nothing is written into it.
  w.RFPalette.open();
  click(w, d.getElementById('rf-palette-item-1'));
  assert.deepEqual(opened, [[false], [false]]);
  d.getElementById('search-input').value = 'kept';
  d.body.dispatchEvent(new w.CustomEvent('htmx:afterSettle', { bubbles: true, detail: { target: content } }));
  assert.equal(d.getElementById('search-input').value, 'kept');
  assert.deepEqual(env.errors, []);
});

test('palette: nav items click the sidebar entry', () => {
  const env = load();
  const { w, d } = env;
  const hits = [];
  for (const id of ['rail-starred', 'full-starred']) {
    d.getElementById(id).addEventListener('click', () => hits.push(id));
  }
  w.RFPalette.open();
  click(w, d.getElementById('rf-palette-item-2'));
  assert.deepEqual(hits, ['full-starred'], 'the full sidebar copy, not the rail one');
  assert.equal(env.dialog.open, false, 'command.js closes the palette');
  assert.deepEqual(env.htmxCalls.ajax, []);

  // No sidebar entry for the URL: the list is loaded directly.
  w.RFPalette.open();
  click(w, d.getElementById('rf-palette-item-3'));
  // JSON: the options object comes from the jsdom realm.
  assert.equal(JSON.stringify(env.htmxCalls.ajax),
    JSON.stringify([['GET', '/htmx/articles?folder_id=5', { target: '#article-list', swap: 'innerHTML' }]]));

  // With only the rail drawn, the rail entry is used.
  d.getElementById('sidebar-full').remove();
  w.RFPalette.open();
  click(w, d.getElementById('rf-palette-item-2'));
  assert.deepEqual(hits, ['full-starred', 'rail-starred']);
  assert.deepEqual(env.errors, []);
});

test('palette: focus returns to the opener on close', async () => {
  const env = load();
  const { w, d, dialog, input } = env;
  const source = fs.readFileSync(PALETTE_JS, 'utf8');
  // CSP: no eval, no Function constructor, no inline handler strings.
  assert.doesNotMatch(source, /\beval\s*\(|new\s+Function\b|\bon[a-z]+\s*=\s*["']/);

  let synced = 0;
  w.RFShell = { sync: () => { synced++; } };
  const opener = d.getElementById('opener');
  opener.focus();
  assert.equal(w.RFPalette.isOpen(), false);
  w.RFPalette.open();
  assert.equal(w.RFPalette.isOpen(), true);
  assert.equal(synced, 1, 'theme and offline items are synced on open (ui/shell.js)');
  assert.equal(dialog.showModalCalls, 1);
  assert.equal(d.activeElement, input, 'the input has focus');
  // Opening again while open does not call showModal() again (it would throw).
  w.RFPalette.open();
  assert.equal(dialog.showModalCalls, 1);

  dialog.close(); // Escape, a click outside, command.js after an item
  assert.equal(w.RFPalette.isOpen(), false);
  assert.equal(d.activeElement, opener, 'focus returns to the opener');

  // A prefill fills the input and searches; each opening starts from it.
  type(env, 'leftover');
  w.RFPalette.open('go');
  assert.equal(input.value, 'go');
  await sleep(DEBOUNCE_WAIT);
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].url, '/htmx/palette?q=go');
  dialog.close();
  w.RFPalette.open();
  assert.equal(input.value, '', 'a plain open starts empty');
  assert.equal(env.results.innerHTML, '');
  assert.deepEqual(env.errors, []);
});

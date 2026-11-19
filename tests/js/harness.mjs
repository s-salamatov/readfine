// A browser to run app.js in.
//
// app.js is a plain script, not a module: it declares its functions at the top level
// and wires its listeners as it loads. Evaluated inside a jsdom window that makes it
// exactly what the page gets, and every top-level name becomes a property of that
// window, so a test can call the real function rather than a copy of it.
//
// htmx is stubbed rather than loaded. The tests here are about what app.js decides,
// not about what htmx does with it, and a stub is also the only way to see the request
// htmx would have sent: sendHtmx below fires the configRequest event the same way and
// hands back the parameters app.js put on it.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { MessageChannel } from 'node:worker_threads';
import { IDBFactory } from 'fake-indexeddb';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_JS = path.join(ROOT, 'backend', 'app', 'static', 'js', 'app.js');

// `before(window)` runs before app.js is evaluated (e.g. to seed localStorage).
export function browser(bodyHtml = '', { before = null } = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><body>' + bodyHtml + '</body></html>',
    // pretendToBeVisual gives requestAnimationFrame, which app.js uses as it loads.
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://readfine.test/' },
  );
  const w = dom.window;
  w.htmx = {
    onLoad() {}, process() {}, trigger() {}, config: {},
    ajax() { return Promise.resolve(); },
  };
  w.fetch = function () { return Promise.resolve({ ok: true }); };
  // jsdom lays nothing out, so it ships neither of these; app.js calls them on paths a
  // test can reach, some of them from a timer where the throw lands outside the test.
  w.Element.prototype.scrollIntoView = function () {};
  w.Element.prototype.scrollTo = function () {};
  if (before) before(w);
  w.eval(fs.readFileSync(APP_JS, 'utf8'));
  return w;
}

// One list row, as article_row.html draws it. `parent` is the id of the row a story
// member was unfolded from, and is what marks this row as part of a group.
export function row(id, { parent = null, scope = null, toggle = false } = {}) {
  return (
    '<div id="article-row-' + id + '" class="article-row" data-article-id="' + id + '"'
    + (parent === null ? '' : ' data-story-parent="' + parent + '"')
    // The list's filters, which article_row.html puts on the row so that unfolding
    // asks for the members this list folded rather than the whole group.
    + (scope === null ? '' : ' data-story-scope="' + scope + '"')
    + '>'
    + (toggle ? '<button data-story-toggle="' + id + '"></button>' : '')
    + '</div>'
  );
}

export function list(...rows) {
  return '<div id="article-list">' + rows.join('') + '</div>';
}

// The right panel, which every layout has in the DOM even where CSS hides it. `article`
// is the id of the article sitting in it, or null for the empty panel of a layout that
// reads inline.
export function detail(article = null) {
  return (
    '<main id="article-detail">'
    + (article === null ? '' : '<div id="article-detail-root" data-article-id="' + article
       + '"><article class="reading-area" data-article-id="' + article + '"></article></div>')
    + '</main>'
  );
}

// A title in the story footer, as story_members.html draws it.
export function memberLink(id) {
  return '<a href="#" data-open-story-member="' + id + '">covered elsewhere</a>';
}

// Records what app.js asked htmx to load, instead of loading it.
export function captureAjax(w) {
  const calls = [];
  w.htmx.ajax = function (verb, path, opts) {
    calls.push({ verb: verb, path: path, target: opts && opts.target });
    return Promise.resolve();
  };
  return calls;
}

// The request htmx would have made: fire configRequest the way htmx does and report
// what app.js added to it.
export function sendHtmx(w, verb, pathWithQuery, elt = null) {
  // `elt` is the element htmx issued the request from. Every listener on this event
  // reads it, so it has to be there even for the ones that do not care which it is.
  const detail = {
    verb: verb, path: pathWithQuery, parameters: {}, headers: {},
    elt: elt || w.document.body,
  };
  w.document.body.dispatchEvent(
    new w.CustomEvent('htmx:configRequest', { detail: detail, bubbles: true }),
  );
  return detail.parameters;
}

// ---- offline scripts (offline/db.js, sync.js, media.js, lists.js, templates.js,
// router.js; overlay.js loads too but installs nothing without a document) ----------
//
// These run in the page and in the service worker, so they must not need a DOM. They
// are loaded into this Node realm with `self` pointing at globalThis, which proves it,
// and keeps objects handed to fake-indexeddb in the realm it was loaded in. A test
// installs a fresh `globalThis.indexedDB` (new IDBFactory()) before each case; the
// scripts read it at call time.
const OFFLINE_DIR = path.join(ROOT, 'backend', 'app', 'static', 'js', 'offline');

export async function loadOffline() {
  if (!globalThis.RFOffline) {
    globalThis.self = globalThis;
    if (!globalThis.location) globalThis.location = new URL('https://readfine.test/');
    vm.runInThisContext(fs.readFileSync(path.join(OFFLINE_DIR, '..', 'vendor', 'minisearch.js'), 'utf8'), { filename: 'minisearch.js' });
    for (const f of ['db.js', 'decision.js', 'media.js', 'search.js', 'sync.js', 'lists.js', 'templates.js', 'router.js', 'policy.js', 'sw-register.js', 'overlay.js', 'page.js']) {
      vm.runInThisContext(fs.readFileSync(path.join(OFFLINE_DIR, f), 'utf8'), { filename: f });
    }
  }
  return globalThis.RFOffline;
}

// A minimal Cache Storage: caches keyed by name, entries keyed by absolute URL.
// `putHook(url, response, callIndex)` may throw/reject to simulate a quota error.
// `failOpen(name)` can also fail writes on a cache that was already opened.
export function fakeCaches({ putHook = null, failOpen = null } = {}) {
  const stores = new Map();
  let puts = 0;
  const norm = (r) => new URL(typeof r === 'string' ? r : r.url, 'https://readfine.test/').href;
  function withoutSearch(url) {
    const parsed = new URL(url);
    parsed.search = '';
    return parsed.href;
  }
  function checkAvailable(name) {
    if (failOpen?.(name)) throw new Error('Cache unavailable: ' + name);
  }
  function cache(name) {
    const entries = new Map();
    return {
      entries,
      async match(r, { ignoreSearch = false } = {}) {
        const url = norm(r);
        if (!ignoreSearch) return entries.get(url)?.clone();
        const target = withoutSearch(url);
        for (const [key, response] of entries) {
          if (withoutSearch(key) === target) return response.clone();
        }
      },
      async put(r, res) {
        checkAvailable(name);
        puts += 1;
        if (putHook) await putHook(norm(r), res, puts);
        entries.set(norm(r), res.clone());
      },
      async delete(r) { return entries.delete(norm(r)); },
      async keys() { return [...entries.keys()].map((url) => ({ url })); },
    };
  }
  return {
    stores,
    async open(name) {
      checkAvailable(name);
      if (!stores.has(name)) stores.set(name, cache(name));
      return stores.get(name);
    },
    async has(name) { return stores.has(name); },
    async delete(name) { return stores.delete(name); },
    async keys() { return [...stores.keys()]; },
  };
}

// A page with the offline overlay: templates.js + overlay.js evaluated in a jsdom
// window (they are what the page loads), so the overlay works on real DOM.
export function overlayPage(bodyHtml = '') {
  const dom = new JSDOM('<!doctype html><html><body>' + bodyHtml + '</body></html>',
    { runScripts: 'outside-only', url: 'https://readfine.test/' });
  const w = dom.window;
  for (const f of ['templates.js', 'overlay.js']) {
    w.eval(fs.readFileSync(path.join(OFFLINE_DIR, f), 'utf8'));
  }
  return w;
}

export const SW_JS = path.join(ROOT, 'backend', 'app', 'static', 'js', 'sw.js');
export const STATIC_DIR = path.join(ROOT, 'backend', 'app', 'static');

// Evaluates sw.js the way a browser does: importScripts reads the same-origin files.
// `script` is the URL it was registered with ("/sw.js" or "/sw.js?offline=1").
// `imports` overrides script bodies by URL, with null simulating a 404.
export function worker({ fetchImpl, current, script = '/sw.js?offline=1', registration, imports = {} } = {}) {
  const listeners = {};
  const imported = [];
  const cacheStorage = fakeCaches();
  const preload = { enabled: null };
  const ctx = {
    console, URL, URLSearchParams, Request, Response, Headers, Intl, JSON, Promise, Map, Set,
    Date, Math, Number, String, Array, Object, Error, TypeError, RegExp, setTimeout, clearTimeout,
    AbortController, crypto: globalThis.crypto, indexedDB: new IDBFactory(), caches: cacheStorage,
    location: new URL('https://readfine.test' + script),
    registration: {
      navigationPreload: {
        enable: async () => { preload.enabled = true; },
        disable: async () => { preload.enabled = false; },
      },
      ...registration,
    },
    clients: { claim: () => Promise.resolve() },
    skipWaiting() {},
    fetch: fetchImpl,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  ctx.self = ctx;
  ctx.importScripts = (...urls) => {
    imported.push(...urls);
    for (const url of urls) {
      const source = Object.hasOwn(imports, url)
        ? imports[url]
        : fs.readFileSync(path.join(STATIC_DIR, url.replace(/^\/static\//, '')), 'utf8');
      if (source === null) throw new TypeError('NetworkError: Failed to load ' + url);
      vm.runInContext(source, ctx, { filename: url });
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SW_JS, 'utf8'), ctx, { filename: 'sw.js' });
  let userReads = 0;
  if (current !== undefined && ctx.RFOffline?.db) {
    ctx.RFOffline.db.getCurrentUser = async () => { userReads += 1; return current; };
  }
  const calls = [];
  if (ctx.RFOffline?.router) {
    const realHandle = ctx.RFOffline.router.handle;
    ctx.RFOffline.router.handle = (...a) => { calls.push(a[0].url); return realHandle(...a); };
  }
  async function lifecycle(type) {
    const waits = [];
    for (const listener of listeners[type] || []) {
      listener({ waitUntil(p) { waits.push(p); } });
    }
    await Promise.all(waits);
  }
  return {
    ctx, listeners, calls, cacheStorage, preload, imported,
    userReads: () => userReads,
    async dispatch(request, extra = {}) {
      let responded = null;
      const event = Object.assign({ request, respondWith(p) { responded = Promise.resolve(p); } }, extra);
      listeners.fetch.forEach((fn) => fn(event));
      return responded;
    },
    activate() { return lifecycle('activate'); },
    install() { return lifecycle('install'); },
    async message(data) {
      const { port1, port2 } = new MessageChannel();
      let timeout;
      try {
        return await new Promise((resolve, reject) => {
          port1.once('message', resolve);
          timeout = setTimeout(() => reject(new Error('Worker did not reply to ' + data?.type)), 2000);
          const waits = [];
          const event = { data, ports: [port2], waitUntil(p) { waits.push(p); } };
          for (const listener of listeners.message || []) listener(event);
          Promise.all(waits).catch(reject);
        });
      } finally {
        clearTimeout(timeout);
        port1.close();
        port2.close();
      }
    },
  };
}

export async function seedWorkerDb(w, userId = 1) {
  const RFw = w.ctx.RFOffline;
  const db = await RFw.db.open(userId);
  await RFw.db.putRecords(db, [rec(1)]);
  await RFw.db.putSnapshots(db, [{ id: 1, row_html: rowHtml(1), detail_html: detailHtml(1), media: [] }]);
  await RFw.db.putMany(db, 'lists', Object.keys(LISTS).map((name) => ({ name, items: LISTS[name] })));
  return db;
}

export function rowHtml(id, density = 'comfortable') {
  return '<div id="article-row-' + id + '" class="article-row border-b border-gray-100 cursor-pointer  pl-2 pr-4"'
    + ' data-article-id="' + id + '" data-rf-article="' + id + '" data-rf-read-classes="opacity-75" data-rf-unread-classes=""'
    + ' data-density="' + density + '" data-is-read="false" hx-get="/htmx/articles/' + id + '">'
    + '<button data-star-btn data-rf-slot="star-button" title="Star article"><span class="text-lg text-gray-300 hover:text-gray-500">☆</span></button>'
    + '<a data-article-title data-rf-read-classes="font-medium text-gray-800" data-rf-unread-classes="font-bold text-gray-900" class="text-sm font-bold text-gray-900">Title ' + id + '</a>'
    + '<span data-archived-indicator data-rf-slot="archive-button" class="text-[10px] hidden">· archived</span>'
    + '<div id="article-labels-' + id + '" data-rf-slot="labels" class="flex items-center"><button data-label-trigger>o</button></div>'
    + '<span class="text-xs text-gray-500"><time datetime="2026-11-16T09:00:00+00:00" data-rf-time="2026-11-16T09:00:00+00:00">09:00</time></span>'
    + '<div data-rf-slot="related-count" data-rf-placeholder></div></div>';
}

export function detailHtml(id) {
  return '<div id="article-detail-root" data-article-id="' + id + '" data-rf-article="' + id + '">'
    + '<article class="reading-area" data-article-id="' + id + '" data-is-read="false">'
    + '<button data-header-star data-rf-slot="star-button"><svg fill="none"></svg><span data-label>Star</span></button>'
    + '<button data-show-chat-modal="' + id + '" data-rf-online-only>Chat</button>'
    + '<div class="hidden"><div id="star-btn-' + id + '" data-rf-slot="star-button"><button title="Star article"><span class="text-lg text-gray-300 hover:text-gray-500">☆</span></button></div>'
    + '<div id="read-btn-' + id + '" data-rf-slot="read-button"><button>○ Unread</button></div></div>'
    + '<div class="mb-5 space-y-3" data-rf-placeholder="ai"><div data-rf-slot="ai-summary"><div id="ai-summary-' + id + '" class="ai-loading-indicator"></div></div>'
    + '<div id="ai-context-area-' + id + '" data-rf-slot="ai-context"><div id="ai-context-' + id + '"></div></div></div>'
    + '<div data-rf-slot="related-count" data-rf-placeholder></div>'
    + '</article></div>';
}

export function rec(id, over = {}) {
  return Object.assign({
    id, feed_id: 10, title: 'Title ' + id, url: 'https://example.com/' + id, author: null,
    published_at: new Date(Date.parse('2026-11-16T00:00:00Z') + id * 60000).toISOString(),
    fetched_at: '2026-11-16T00:00:00+00:00', story_id: null, image_url: null, is_read: false,
    is_starred: false, is_archived: false, saved_at: null, hidden_at: null, share_token: null,
    ai_score: null, lexical_score: null, ai_summary: null, ai_summary_truncated: false, ai_context: null,
    ai_summary_html: null, ai_context_html: null, label_ids: [], version: 'v' + id, content_version: 1,
  }, over);
}

export const LISTS = {
  folders: [{ id: 1, name: 'Tech', position: 0 }, { id: 2, name: 'News', position: 1 }],
  feeds: [
    { user_feed_id: 100, feed_id: 10, title: 'Feed A', folder_id: 1, position: 0 },
    { user_feed_id: 101, feed_id: 11, title: 'Feed B', folder_id: 2, position: 0 },
    { user_feed_id: 102, feed_id: 12, title: 'Feed C', folder_id: null, position: 0 },
  ],
  labels: [{ id: 7, name: 'Keep', color: '#ff0000', position: 0 }],
  saved_searches: [],
  prefs: { timezone: 'UTC', default_sort_order: 'newest', articles_per_page: 50, story_dedup: 'collapse',
    label_display: 'indicator', format_profile: 'iso', mark_read_on_scroll: true },
};

// Polls until `cond` (sync or async) holds, for up to `ms` of wall time. Time, not a
// tick count: an IndexedDB / script-load chain takes a variable number of event-loop
// turns under load. The check that passed is the answer: `cond` is not evaluated once
// more afterwards, since a state that passes on the way (a record gone stale, then
// wiped) may not pass a second look.
export async function until(cond, ms = 2000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() >= end) break;
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.fail('condition never became true within ' + ms + ' ms');
}

// Offline mode, page side (offline/page.js): the per-device switch, sync triggers,
// "Ready for offline", the offline banner and the controls that need a connection.
//
// The device store is real (fake-indexeddb, in this realm); the document is jsdom. The
// worker registration and the browser's window/navigator are fakes. Tests can run with
// a stub sync engine or the real engine against a fake server.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { loadOffline, fakeCaches, until } from './harness.mjs';

const RF = await loadOffline();

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

const SIDEBAR = '<aside id="sidebar"><div id="sidebar-full"><div data-rf-slot="offline-status" hidden></div></div></aside>'
  + '<div data-rf-slot="offline-banner"></div>'
  + '<div id="article-detail"><div id="article-detail-root" data-rf-article="42"></div></div>';

const SETTINGS = '<div data-rf-offline-settings><input type="checkbox" data-rf-offline-toggle>'
  + '<p data-rf-offline-storage></p><p data-rf-offline-note></p><button type="button" data-rf-offline-remove hidden>Remove</button></div>';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// A page with a controller for reader `userId`. `run` answers sync.run (default: a
// clean report); every call is recorded in `runs`.
function page({
  userId = 1, body = SIDEBAR, run = null, media = null, onLine = true, channel = null,
  confirm = () => true, db = RF.db, fetchFn, syncEngine, navigate, probeMs,
} = {}) {
  const dom = new JSDOM('<!doctype html><html><body>' + body + '</body></html>', { url: 'https://readfine.test/app' });
  const doc = dom.window.document;
  doc.cookie = 'csrftoken=tok123';
  let visibility = 'visible';
  Object.defineProperty(doc, 'visibilityState', { get: () => visibility, configurable: true });
  const win = new dom.window.EventTarget();
  const timers = [];
  win.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  win.clearInterval = (id) => { if (timers[id - 1]) timers[id - 1].fn = null; };
  win.caches = fakeCaches();
  win.caches.match = async (request, { cacheName, ignoreSearch }) =>
    win.caches.stores.get(cacheName)?.match(request, { ignoreSearch });
  win.indexedDB = globalThis.indexedDB;
  win.localStorage = dom.window.localStorage;
  const persistCalls = [];
  const persistedCalls = [];
  const nav = {
    onLine,
    locks: { request: async (name, options, fn) => fn({ name }) },
    serviceWorker: Object.assign(new dom.window.EventTarget(), {
      controller: { scriptURL: 'https://readfine.test/sw.js?offline=1' },
    }),
    storage: {
      persist: async () => { persistCalls.push(1); return true; },
      persisted: async () => { persistedCalls.push(1); return false; },
      estimate: async () => ({ usage: 5 * 1024 * 1024, quota: 2 * 1024 * 1024 * 1024 }),
    },
  };
  const runs = [];
  const sync = {
    run: async (db, opts) => {
      runs.push({ db, opts });
      if (run) return run(db, opts, runs.length);
      return { error: null, finishedAt: '2026-11-16T10:00:00.000Z', shell: 'ok', media: null, mediaQueue: [] };
    },
    downloadMedia: async (db, urls, opts) => {
      downloads.push({ db, urls, opts });
      if (media) return media(db, urls, opts);
      return { stored: urls.length, skipped: 0, stoppedReason: null };
    },
  };
  const downloads = [];
  const swCalls = [];
  const sw = {
    ensure: async (flag) => { swCalls.push(['ensure', flag]); return {}; },
    register: async (o) => { swCalls.push(['register', o.offline]); return {}; },
  };
  const ctl = RF.page.create({
    userId, displayName: 'Ann', doc, win, nav, sync: syncEngine || sync, sw, confirm, channel, db, fetchFn, navigate, probeMs,
  });
  return {
    ctl, doc, win, nav, runs, downloads, swCalls, persistCalls, persistedCalls, timers,
    setVisibility(v) { visibility = v; doc.dispatchEvent(new dom.window.Event('visibilitychange')); },
    fire(type) { win.dispatchEvent(new dom.window.Event(type)); },
    afterRequest(header, status = 200) {
      const xhr = { status, getResponseHeader: (h) => (h === 'X-Readfine-Offline' ? header : null) };
      doc.dispatchEvent(new dom.window.CustomEvent('htmx:afterRequest', { detail: { xhr } }));
    },
    status() { return doc.querySelector('[data-rf-slot="offline-status"]'); },
    line() { const p = doc.querySelector('[data-rf-offline-line]'); return p ? p.textContent : null; },
    banner() { return doc.querySelector('[data-rf-slot="offline-banner"]').textContent; },
    click(sel) { doc.querySelector(sel).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); },
    Event: dom.window.Event,
  };
}

async function enabledPage(opts) {
  const p = page(opts);
  await p.ctl.ready;
  await p.ctl.enable();
  await p.ctl.idle();
  // Existing Ready assertions model a device where the shell was stored.
  await (await p.win.caches.open('readfine-pages-' + (opts?.userId || 1))).put('/app', new Response('shell'));
  await p.ctl.render();
  p.runs.length = 0;
  return p;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('a failed read on an online start does not demote the worker', async () => {
  let reads = 0;
  const mirrorRetries = [];
  const p = page({
    db: {
      ...RF.db,
      async getCurrentUser() { reads++; throw new Error('store unavailable'); },
      async syncMirror(caches) { mirrorRetries.push(caches); throw new Error('mirror unavailable'); },
    },
  });
  await p.ctl.ready;
  assert.equal(reads, 2);
  assert.deepEqual(mirrorRetries, [p.win.caches]);
  assert.equal(p.ctl.state.storeUnreadable, true);
  assert.deepEqual(p.swCalls, []);
  assert.equal(p.status().hidden, false);
  assert.match(p.status().querySelector('[data-rf-offline-warn]').textContent, /could not be read/);
});

test('a missing record is restored from own flags, while a v1 database stays off', async () => {
  for (const flags of [{ offlineEnabled: true, forceOffline: true }, null]) {
    globalThis.indexedDB = new IDBFactory();
    const db = await RF.db.open(7);
    if (flags) await RF.db.setMeta(db, RF.db.META.offlineFlags, flags);
    db.close();
    const p = page({ userId: 7 });
    await p.ctl.ready;
    await p.ctl.idle();
    assert.equal(p.ctl.state.enabled, !!flags);
    assert.deepEqual(await RF.db.getCurrentUser(), flags ? { userId: 7, ...flags } : null);
    assert.deepEqual(p.swCalls, flags ? [['ensure', true]] : []);
    p.ctl.stop();
  }
});

test('own database gone with the record on: the next online start re-syncs', async () => {
  await RF.db.setCurrentUser(7, { offlineEnabled: true, forceOffline: false });
  const urls = [];
  const p = page({
    userId: 7,
    syncEngine: RF.sync,
    fetchFn: async (url) => { urls.push(url); return new Response(null, { status: 401 }); },
  });
  await p.ctl.ready;
  await p.ctl.idle();
  assert.ok(urls.includes('/sync/v1/manifest'));
  assert.ok((await globalThis.indexedDB.databases()).some((db) => db.name === 'readfine-offline-7'));
  assert.equal(p.persistCalls.length, 1);
});

test('Ready only with all five; shell missing says Not ready', async () => {
  const navigations = [];
  let unreadable = false;
  const p = page({
    navigate: (url) => navigations.push(url),
    db: {
      ...RF.db,
      async getCurrentUser() {
        if (unreadable) throw new Error('store unavailable');
        return RF.db.getCurrentUser();
      },
    },
    run: async (db, { caches }, count) => {
      if (count >= 2) await (await caches.open('readfine-pages-1')).put('/app?from=sync', new Response('shell'));
      return {
        finishedAt: '2026-11-16T10:00:00.000Z', shell: count === 1 ? 'failed' : 'ok',
        shellError: count === 1 ? 'shell: /static/css/site.css 500' : null,
      };
    },
  });
  p.nav.serviceWorker.controller = { scriptURL: 'https://readfine.test/sw.js?offline=1' };
  await p.ctl.ready;
  await p.ctl.enable();
  await p.ctl.idle();
  assert.equal(p.line(), 'Not ready: app page not stored on this device');
  assert.deepEqual(JSON.parse(p.win.localStorage.getItem('rf-last-sync')), {
    finishedAt: '2026-11-16T10:00:00.000Z', error: null, shell: 'failed', shellError: 'app asset returned HTTP 500',
    articles: 0, snapshots: 0, media: { done: 0, failed: 0 }, pendingOps: 0,
  });
  p.nav.serviceWorker.controller = { scriptURL: 'https://readfine.test/sw.js' };
  await p.ctl.syncNow();
  assert.equal(p.line(), 'Not ready: this page is not under the offline worker');
  p.nav.serviceWorker.controller = { scriptURL: 'https://readfine.test/sw.js?offline=1' };
  p.nav.serviceWorker.dispatchEvent(new p.Event('controllerchange'));
  await until(() => /^Ready for offline/.test(p.line()));

  // Ready must reflect local changes even when no sync or BroadcastChannel runs.
  const settleSidebar = () => p.doc.dispatchEvent(new p.Event('htmx:afterSettle'));
  const missingShell = 'Not ready: app page not stored on this device';
  const missingSettings = 'Not ready: offline settings could not be read';
  await p.win.caches.delete('readfine-pages-1');
  await (await p.win.caches.open('readfine-pages-2')).put('/app', new Response('other reader'));
  settleSidebar();
  await until(() => p.line() === missingShell);
  assert.equal(await p.win.caches.has('readfine-pages-1'), false);
  assert.equal(p.runs.length, 2);

  p.setVisibility('visible');
  await p.ctl.idle();
  assert.match(p.line(), /^Ready for offline/);
  unreadable = true;
  settleSidebar();
  await until(() => p.line() === missingSettings);
  assert.ok(p.status().querySelector('[data-rf-offline-warn]'));
  unreadable = false;
  await RF.db.setCurrentUser(1, { offlineEnabled: false });
  settleSidebar();
  await until(() => !p.status().querySelector('[data-rf-offline-warn]'));
  assert.equal(p.line(), missingSettings);
  await RF.db.setCurrentUser(1, { offlineEnabled: true });
  settleSidebar();
  await until(() => /^Ready for offline/.test(p.line()));
  await p.win.caches.delete('readfine-pages-1');
  p.nav.onLine = false;
  p.setVisibility('visible');
  await until(() => p.line() === missingShell);
  assert.equal(p.runs.length, 3);
  p.nav.onLine = true;
  await p.ctl.syncNow();
  assert.match(p.line(), /^Ready for offline/);
  assert.equal(p.persistCalls.length, 1);
  assert.equal(p.persistedCalls.length, 1);
  p.win.localStorage.setItem('rf-sw-error', JSON.stringify({ message: 'install failed' }));
  await p.ctl.render();
  assert.match(p.status().textContent, /update failed, previous version running/);

  let press;
  p.win.setTimeout = (fn, ms) => { press = { fn, ms }; return 1; };
  p.win.clearTimeout = () => { press = null; };
  function pointer(type) {
    p.status().dispatchEvent(new p.doc.defaultView.MouseEvent(type, { bubbles: true, button: 0 }));
  }
  pointer('pointerdown');
  assert.equal(press.ms, 600);
  pointer('pointermove');
  assert.equal(press, null);
  pointer('pointerdown');
  press.fn();
  assert.deepEqual(navigations, ['/settings/preferences#offline-diagnostics']);

  p.nav.onLine = false;
  pointer('pointerdown');
  press.fn();
  assert.deepEqual(navigations, ['/settings/preferences#offline-diagnostics', '/__rf/diagnostics']);

  delete p.nav.locks;
  assert.equal(await p.ctl.syncNow(), null);
  await assert.rejects(p.ctl.enable(), /requires Web Locks/);
});

test('disabled by default: no sync on load', async () => {
  const p = page();
  await p.ctl.ready;
  p.setVisibility('visible');
  p.fire('online');
  p.timers.forEach((t) => t.fn && t.fn());
  await p.ctl.idle();
  assert.equal(p.runs.length, 0);
  assert.equal(p.status().hidden, true);
  assert.equal(p.banner(), '');
  // Nothing is stored for a reader who never switched it on. An existing flag stays.
  assert.deepEqual(await globalThis.indexedDB.databases(), []);
  assert.deepEqual(p.swCalls, [['ensure', undefined]]);
});

test('enabling requests persistent storage and starts sync', async () => {
  const p = page({
    body: SIDEBAR + SETTINGS,
    run: async (db, { caches }) => {
      await (await caches.open('readfine-pages-1')).put('/app', new Response('shell'));
      return { finishedAt: '2026-11-16T10:00:00.000Z', shell: 'ok' };
    },
  });
  await p.ctl.bindSettings(p.doc);
  const box = p.doc.querySelector('[data-rf-offline-toggle]');
  assert.equal(box.checked, false);
  // Nothing on the device: nothing to remove either.
  assert.equal(p.doc.querySelector('[data-rf-offline-remove]').hidden, true);
  assert.match(p.doc.querySelector('[data-rf-offline-storage]').textContent, /5 MB used of 2\.0 GB available/);
  box.checked = true;
  box.dispatchEvent(new p.Event('change'));
  await until(() => p.runs.length === 1);
  await p.ctl.idle();
  await until(() => !box.disabled);
  assert.equal(p.persistCalls.length, 1);
  assert.deepEqual(p.swCalls.slice(1), [['register', true]]);
  assert.deepEqual(await RF.db.getCurrentUser(), { userId: 1, offlineEnabled: true, forceOffline: false });
  assert.equal(p.runs.length, 1);
  const o = p.runs[0].opts;
  assert.equal(o.csrfToken(), 'tok123');
  assert.deepEqual(o.keepIds, [42]);
  // Images are not part of the sync flight (see the detached download test).
  assert.equal(o.downloadMedia, false);
  assert.ok(o.caches);
  // The database exists and carries the name the offline sidebar shows.
  assert.equal(await RF.db.getMeta(p.runs[0].db, RF.db.META.displayName), 'Ann');
  assert.equal(p.status().hidden, false);
  assert.equal(p.line(), 'Ready for offline · 0 articles · 0 images · 0 pending');
  assert.equal(p.doc.querySelector('[data-rf-offline-remove]').hidden, true);
  // The next page load on this device starts on and syncs at once.
  const next = page();
  await next.ctl.ready;
  await next.ctl.idle();
  assert.equal(next.runs.length, 1);
  assert.deepEqual(next.swCalls, [['ensure', true]]);
});

test('visibilitychange visible triggers sync', async () => {
  const p = await enabledPage();
  p.setVisibility('hidden');
  await p.ctl.idle();
  assert.equal(p.runs.length, 0);
  // The detail expanded in the list (small screens) is on screen too.
  const inline = p.doc.createElement('div');
  inline.id = 'inline-article-detail-content';
  inline.innerHTML = '<div data-rf-article="7"></div>';
  p.doc.body.appendChild(inline);
  p.setVisibility('visible');
  await p.ctl.idle();
  assert.equal(p.runs.length, 1);
  assert.deepEqual(p.runs[0].opts.keepIds, [42, 7]);
  // The 5-minute timer syncs only while visible; `online` syncs; never two at once.
  assert.equal(p.timers.length, 1);
  assert.equal(p.timers[0].ms, 5 * 60 * 1000);
  p.setVisibility('hidden');
  p.timers[0].fn();
  await p.ctl.idle();
  assert.equal(p.runs.length, 1);
  p.setVisibility('visible');
  await p.ctl.idle();
  p.timers[0].fn();
  await p.ctl.idle();
  p.fire('online');
  await p.ctl.idle();
  assert.equal(p.runs.length, 4);
});

test('offline and visible: a probe every 30 s; success syncs even with navigator.onLine false', async () => {
  await RF.db.setCurrentUser(1, { offlineEnabled: true, forceOffline: false });
  const db = await RF.db.open(1);
  await RF.db.enqueueOp(db, { type: 'star', article_id: 42 });
  const probes = [];
  const syncRequests = [];
  const portal = () => new Response('<html>Connect to Wi-Fi</html>', { headers: { 'content-type': 'text/html' } });
  let healthResponse = () => new Response(null, { status: 503 });
  let syncStatus = 503;
  let syncPortal = false;
  const p = page({
    onLine: false,
    syncEngine: RF.sync,
    fetchFn: async (url, options) => {
      if (url === '/healthz') {
        probes.push({ url, method: options.method, cache: options.cache });
        return healthResponse();
      }
      syncRequests.push(url);
      if (syncPortal) return portal();
      if (syncStatus === 503) return new Response(null, { status: 503 });
      if (url === '/sync/v1/ops') {
        const { ops } = JSON.parse(options.body);
        return Response.json({ results: ops.map(({ op_id }) => ({ op_id, status: 'applied' })) });
      }
      if (url === '/sync/v1/manifest') return Response.json({ articles: [] });
      if (url === '/sync/v1/lists') return Response.json({});
      assert.fail('Unexpected sync request: ' + url);
    },
  });
  await p.ctl.ready;
  await p.ctl.idle();
  const probe = p.timers.find(({ ms }) => ms === 30_000);
  assert.ok(probe?.fn, 'offline startup schedules a 30 s probe');
  assert.equal(probes.length, 0);
  assert.match(p.banner(), /Offline/);
  const periodic = p.timers.find(({ ms }) => ms === 5 * 60 * 1000);
  const failures = [
    healthResponse,
    portal,
    () => new Response('{"status":"ok"}', { headers: { 'content-type': 'text/html' } }),
    () => Response.json({ status: 'degraded' }),
    () => new Response('{', { headers: { 'content-type': 'application/json' } }),
  ];
  for (const response of failures) {
    healthResponse = response;
    syncPortal = true;
    probe.fn();
    await tick();
    await p.ctl.idle();
    assert.deepEqual(syncRequests, [], 'an invalid health response does not start a sync');
    assert.equal(p.ctl.state.error, null);
    assert.ok(probe.fn && periodic.fn, 'both timers stay active');
    assert.match(p.banner(), /Offline/);
    assert.equal((await RF.db.outboxEntries(db)).length, 1);
  }
  assert.equal(probes.length, failures.length);

  healthResponse = () => Response.json({ status: 'ok' });
  syncStatus = 200;
  syncPortal = false;
  probe.fn();
  await tick();
  await p.ctl.idle();
  const request = { url: '/healthz', method: 'GET', cache: 'no-store' };
  assert.deepEqual(probes, Array(failures.length + 1).fill(request));
  assert.equal(p.nav.onLine, false);
  assert.deepEqual(syncRequests, ['/sync/v1/ops', '/sync/v1/manifest', '/sync/v1/lists']);
  assert.equal((await RF.db.outboxEntries(db)).length, 0, 'the next probe drains the outbox');
  assert.equal(p.banner(), '');
  assert.equal(probe.fn, null);

  // With fresh reachability evidence, even HTTP failures leave both auto triggers eligible.
  await RF.db.enqueueOp(db, { type: 'star', article_id: 42 });
  syncStatus = 503;
  syncRequests.length = 0;
  p.setVisibility('hidden');
  p.setVisibility('visible');
  await p.ctl.idle();
  assert.deepEqual(syncRequests, ['/sync/v1/ops', '/sync/v1/manifest']);
  assert.equal(p.ctl.state.error, 'http');
  assert.equal((await RF.db.outboxEntries(db)).length, 1);
  syncStatus = 200;
  periodic.fn();
  await p.ctl.idle();
  assert.equal((await RF.db.outboxEntries(db)).length, 0, 'periodic sync retries after HTTP failure');
  assert.equal(p.ctl.state.error, null);
  assert.equal(p.nav.onLine, false);

  // A portal can appear after a healthy probe and answer the next scheduled sync.
  await RF.db.enqueueOp(db, { type: 'star', article_id: 42 });
  syncPortal = true;
  healthResponse = portal;
  syncRequests.length = 0;
  periodic.fn();
  await p.ctl.idle();
  assert.deepEqual(syncRequests, ['/sync/v1/ops']);
  assert.equal(p.ctl.state.error, null);
  assert.equal(p.ctl.state.netDown, true);
  const retry = p.timers.find(({ fn, ms }) => fn && ms === 30_000);
  assert.ok(retry?.fn && periodic.fn, 'portal sync failure keeps both timers active');
  retry.fn();
  await tick();
  await p.ctl.idle();
  assert.deepEqual(syncRequests, ['/sync/v1/ops'], 'portal health does not retry sync');
  assert.equal((await RF.db.outboxEntries(db)).length, 1);

  healthResponse = () => Response.json({ status: 'ok' });
  syncPortal = false;
  retry.fn();
  await tick();
  await p.ctl.idle();
  assert.equal((await RF.db.outboxEntries(db)).length, 0, 'recovery drains the queue automatically');
  assert.equal(p.ctl.state.netDown, false);

  syncRequests.length = 0;
  p.fire('offline');
  p.setVisibility('visible');
  await p.ctl.idle();
  assert.deepEqual(syncRequests, [], 'an offline event clears reachability evidence');
  const offlineProbe = p.timers.find(({ fn, ms }) => fn && ms === 30_000);
  assert.ok(offlineProbe?.fn);
  offlineProbe.fn();
  await tick();
  await p.ctl.idle();
  assert.equal(p.banner(), '');

  syncRequests.length = 0;
  p.afterRequest(null, 0);
  p.afterRequest(null, 200); // A late response from another request.
  await tick();
  await p.ctl.idle();
  assert.equal(p.banner(), 'Offline', 'the late response leaves the page offline after a fresh failure');
  assert.ok(p.timers.some(({ fn, ms }) => fn && ms === 30_000), 'reconnect probing stays active');
  assert.deepEqual(syncRequests, [], 'the late response does not start a sync');
  p.ctl.stop();
});

test('no probe while hidden, forced offline, or online; a failed probe changes nothing', async () => {
  const probes = [];
  const p = await enabledPage({
    probeMs: 1000,
    fetchFn: async (url, { signal }) => {
      probes.push(signal);
      if (probes.length === 1) throw new Error('network unavailable');
      if (probes.length === 4) return new Response(null, { status: 503 });
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  let timeout;
  p.win.setTimeout = (fn, ms) => { timeout = { fn, ms }; return 1; };
  p.win.clearTimeout = () => { timeout = null; };
  function advanceProbeTicks(count) {
    let probe;
    for (let i = 0; i < count; i++) {
      const timer = p.timers.find(({ fn, ms }) => fn && ms === 1000);
      probe = timer?.fn();
    }
    return probe;
  }

  advanceProbeTicks(3); // Online.
  assert.equal(probes.length, 0);
  p.setVisibility('hidden');
  p.nav.onLine = false;
  p.fire('offline');
  advanceProbeTicks(3);
  assert.equal(probes.length, 0);
  await p.ctl.setForceOffline(true);
  p.setVisibility('visible');
  await p.ctl.idle();
  advanceProbeTicks(3);
  assert.equal(probes.length, 0);

  p.nav.onLine = true;
  p.fire('online');
  await p.ctl.setForceOffline(false);
  await p.ctl.idle();
  p.runs.length = 0;
  p.afterRequest(null, 0);
  await until(() => p.banner() === 'Offline');
  await advanceProbeTicks(1);
  assert.equal(probes.length, 1, 'a failed request starts probing even while the browser reports online');
  assert.equal(p.runs.length, 0);
  assert.equal(p.banner(), 'Offline');
  const timedOutProbe = advanceProbeTicks(1);
  advanceProbeTicks(2);
  assert.equal(probes.length, 2, 'retry on the next tick and keep only one request in flight');
  assert.equal(timeout.ms, 5000);
  timeout.fn();
  assert.equal(probes[1].aborted, true);
  await timedOutProbe;
  assert.equal(p.runs.length, 0);
  assert.equal(p.banner(), 'Offline');
  const hiddenProbe = advanceProbeTicks(1);
  assert.equal(probes.length, 3, 'retry after the timeout');
  p.setVisibility('hidden');
  advanceProbeTicks(3);
  assert.equal(probes.length, 3);
  assert.equal(probes[2].aborted, true);
  await hiddenProbe;
  p.setVisibility('visible');
  await advanceProbeTicks(1);
  await p.ctl.idle();
  assert.equal(probes.length, 4, 'visibility restarts the probe');
  assert.equal(p.runs.length, 0, 'a 503 leaves the page offline');
  assert.equal(p.banner(), 'Offline');
  const finalProbe = advanceProbeTicks(1);
  assert.equal(probes.length, 5, 'a 503 leaves the timer running');
  p.ctl.stop();
  await finalProbe;
});

test('only one sync at a time, with progress shown while it runs', async () => {
  const gate = deferred();
  let calls = 0;
  const p = await enabledPage({
    run: async (db, opts) => {
      calls += 1;
      if (calls === 1) return { error: null, finishedAt: '2026-11-16T10:00:00.000Z', mediaQueue: [] };
      opts.onProgress({ stage: 'articles', done: 3, total: 10 });
      await gate.promise;
      return { error: null, finishedAt: '2026-11-16T10:00:00.000Z', mediaQueue: [] };
    },
  });
  const a = p.ctl.syncNow();
  const b = p.ctl.syncNow();
  p.setVisibility('visible');
  p.fire('online');
  await until(() => p.line() === 'Syncing articles… 3/10');
  assert.equal(a, b);
  assert.equal(p.runs.length, 1);
  assert.equal(p.doc.querySelector('[data-rf-offline-action="sync"]').disabled, true);
  // Progress ticks change the line only; the buttons stay the same elements.
  const syncBtn = p.doc.querySelector('[data-rf-offline-action="sync"]');
  p.runs[0].opts.onProgress({ stage: 'snapshots', done: 5, total: 10 });
  assert.equal(p.line(), 'Syncing pages… 5/10');
  assert.ok(p.doc.querySelector('[data-rf-offline-action="sync"]') === syncBtn);
  // An htmx settle with nothing changed does not rebuild the block either.
  p.doc.dispatchEvent(new p.Event('htmx:afterSettle'));
  assert.ok(p.doc.querySelector('[data-rf-offline-action="sync"]') === syncBtn);
  gate.resolve();
  await p.ctl.idle();
  assert.match(p.line(), /^Ready for offline/);
  // "Last synced" is visible text, not a hover title.
  assert.match(p.doc.querySelector('[data-rf-offline-last]').textContent, /^Last synced \S/);
});

test('images download outside the sync flight', async () => {
  const gate = deferred();
  let mediaCalls = 0;
  const p = await enabledPage({
    run: async () => ({ error: null, finishedAt: '2026-11-16T10:00:00.000Z', mediaQueue: ['/m/a/1/A', '/m/b/2/B'] }),
    media: async (db, urls, opts) => {
      mediaCalls += 1;
      if (mediaCalls === 1) return { stored: urls.length, skipped: 0, stoppedReason: null };
      opts.onProgress({ stage: 'media', done: 1, total: urls.length });
      await gate.promise;
      return { stored: 1, skipped: 1, stoppedReason: 'quota' };
    },
  });
  // enabledPage waited for the first images too; this download is the next one.
  p.downloads.length = 0;
  const sync = p.ctl.syncNow();
  await sync;
  await until(() => p.downloads.length === 1);
  assert.deepEqual(p.downloads[0].urls, ['/m/a/1/A', '/m/b/2/B']);
  assert.ok(p.downloads[0].opts.caches);
  // Data synced: Ready shows while images still download, on their own line.
  assert.match(p.line(), /^Ready for offline/);
  await until(() => (p.doc.querySelector('[data-rf-offline-media]') || {}).textContent === 'Images 1/2');
  assert.equal(p.doc.querySelector('[data-rf-offline-action="sync"]').disabled, false);
  // Another sync runs while images download; a second download is not started.
  await p.ctl.syncNow();
  assert.equal(p.runs.length, 2);
  assert.equal(p.downloads.length, 1);
  gate.resolve();
  await p.ctl.idle();
  assert.equal(p.doc.querySelector('[data-rf-offline-media]'), null);
  assert.equal(p.doc.querySelector('[data-rf-offline-full]').textContent, 'Storage full: images partly saved');
  // A download stopped by a wipe (logout elsewhere) settles the page off.
  const w = await enabledPage({
    run: async () => ({ error: null, finishedAt: '2026-11-16T10:00:00.000Z', mediaQueue: ['/m/a/1/A'] }),
    media: async () => { await RF.db.wipeAll(); return { stored: 0, stoppedReason: 'wiped' }; },
  });
  assert.equal(w.ctl.state.enabled, false);
  assert.equal(w.status().hidden, true);
});

test('offline banner shows pending count', async () => {
  const p = await enabledPage();
  const db = p.ctl.state.db;
  await RF.db.enqueueOp(db, { type: 'star', article_id: 42 });
  await RF.db.enqueueOp(db, { type: 'read', article_id: 43 });
  assert.equal(p.banner(), '');
  // The worker answered a request: the page is offline now.
  p.afterRequest('1');
  await until(() => p.line() === 'Offline · 2 actions waiting');
  assert.equal(p.banner(), 'Offline · 2 actions waiting');
  // An answer from the server again: back online, banner gone, and it syncs.
  p.afterRequest(null);
  await p.ctl.idle();
  assert.equal(p.banner(), '');
  assert.equal(p.runs.length, 1);
  // A sync that hits the network error also means offline.
  globalThis.indexedDB = new IDBFactory();
  const q = await enabledPage({ run: async () => ({ error: 'network' }) });
  await q.ctl.syncNow();
  assert.equal(q.banner(), 'Offline');
});

test('online-only controls disabled while offline and restored online', async () => {
  const p = await enabledPage({
    body: SIDEBAR + '<a id="settings" href="/settings" title="Settings" data-rf-online-only>Settings</a>'
      + '<button id="chat" data-rf-online-only>Chat</button>'
      + '<button id="was-off" data-rf-online-only disabled>Off already</button>',
  });
  const $ = (s) => p.doc.querySelector(s);
  p.nav.onLine = false;
  p.fire('offline');
  assert.equal($('#settings').getAttribute('aria-disabled'), 'true');
  assert.ok($('#settings').classList.contains('pointer-events-none'));
  assert.equal($('#settings').getAttribute('title'), 'Needs a connection');
  assert.ok($('#chat').hasAttribute('disabled'));
  assert.equal(p.banner(), 'Offline');
  p.nav.onLine = true;
  p.fire('online');
  await p.ctl.idle();
  assert.equal($('#settings').getAttribute('aria-disabled'), null);
  assert.ok(!$('#settings').classList.contains('pointer-events-none'));
  assert.equal($('#settings').getAttribute('title'), 'Settings');
  assert.ok(!$('#chat').hasAttribute('disabled'));
  assert.equal($('#chat').getAttribute('title'), null);
  assert.ok($('#was-off').hasAttribute('disabled'));
  // Fragments the overlay disabled offline come back too.
  const frag = p.doc.createElement('div');
  frag.innerHTML = '<button id="snap-chat" data-rf-online-only title="Chat">Chat</button>';
  p.doc.body.appendChild(frag);
  RF.overlay.applyState(frag, { records: {} });
  assert.ok($('#snap-chat').hasAttribute('disabled'));
  p.ctl.render();
  assert.ok(!$('#snap-chat').hasAttribute('disabled'));
  assert.equal($('#snap-chat').getAttribute('title'), 'Chat');
  // Offline mode off: nothing is disabled, whatever the connection.
  await p.ctl.disable();
  p.nav.onLine = false;
  p.fire('offline');
  assert.ok(!$('#chat').hasAttribute('disabled'));
});

test('work offline: no automatic sync, the worker is told, cleared when switched off', async () => {
  const p = await enabledPage();
  p.click('[data-rf-offline-action="work-offline"]');
  await until(() => p.doc.querySelector('[data-rf-offline-action="work-offline"]').textContent === 'Back online');
  assert.deepEqual(await RF.db.getCurrentUser(), { userId: 1, offlineEnabled: true, forceOffline: true });
  assert.equal(p.banner(), 'Offline');
  p.setVisibility('visible');
  p.timers[0].fn();
  await p.ctl.idle();
  assert.equal(p.runs.length, 0);
  // "Sync now" still tries.
  await p.ctl.syncNow();
  assert.equal(p.runs.length, 1);
  // A reload keeps it.
  const next = page();
  await next.ctl.ready;
  assert.equal(next.ctl.isOffline(), true);
  assert.equal(next.runs.length, 0);
  await p.ctl.disable();
  assert.deepEqual(await RF.db.getCurrentUser(), { userId: 1, offlineEnabled: false, forceOffline: false });
});

test('switching off unflags the worker; removing the data deletes it from the device', async () => {
  const p = await enabledPage({ body: SIDEBAR + SETTINGS });
  await p.ctl.bindSettings(p.doc);
  const box = p.doc.querySelector('[data-rf-offline-toggle]');
  assert.equal(box.checked, true);
  box.checked = false;
  box.dispatchEvent(new p.Event('change'));
  await until(() => !box.disabled);
  assert.deepEqual(p.swCalls.slice(-1), [['register', false]]);
  assert.deepEqual(await RF.db.getCurrentUser(), { userId: 1, offlineEnabled: false, forceOffline: false });
  assert.equal(await p.win.caches.has('readfine-pages-1'), false);
  assert.equal(p.status().hidden, true);
  assert.equal(p.timers[0].fn, null);
  // The data stays until removed.
  assert.ok((await globalThis.indexedDB.databases()).some((d) => d.name === 'readfine-offline-1'));
  const remove = p.doc.querySelector('[data-rf-offline-remove]');
  assert.equal(remove.hidden, false);
  remove.dispatchEvent(new p.Event('click'));
  for (let i = 0; i < 20 && (await globalThis.indexedDB.databases()).length; i++) await tick();
  assert.deepEqual(await globalThis.indexedDB.databases(), []);
  assert.equal(await RF.db.getCurrentUser(), null);
  p.setVisibility('visible');
  await p.ctl.idle();
  assert.equal(p.runs.length, 0);
});

test('an expired session keeps the data and says so', async () => {
  // Before a completed sync, failures supplement the readiness line.
  const notice = '[data-rf-offline-sync-notice]';
  const p = await enabledPage({ run: async () => ({ error: 'auth' }) });
  await p.ctl.syncNow();
  assert.equal(p.line(), 'Not ready: not synced yet');
  assert.equal(p.doc.querySelector(notice).textContent, 'Session expired – log in to sync');
  assert.equal(p.doc.querySelector(notice + ' a').getAttribute('href'), '/login');
  assert.ok(RF.db.alive(p.ctl.state.db));
  const csrf = await enabledPage({ run: async () => ({ error: 'csrf' }) });
  await csrf.ctl.syncNow();
  assert.equal(csrf.doc.querySelector(notice).textContent, 'Sync stopped – reload the page');
  const http = await enabledPage({ run: async () => ({ error: 'http', errorDetail: 500 }) });
  await http.ctl.syncNow();
  assert.equal(http.doc.querySelector(notice).textContent, 'Sync failed – will try again');
});

test('a wipe during sync: off after a logout wipe, reopened while still on', async () => {
  // Logout elsewhere: everything wiped, the store gone too. The page stays off and
  // never recreates the database.
  const out = await enabledPage({ run: async () => { await RF.db.wipeAll(); return { error: 'wiped' }; } });
  await out.ctl.syncNow();
  assert.equal(out.ctl.state.enabled, false);
  assert.equal(out.status().hidden, true);
  await out.ctl.syncNow();
  assert.deepEqual(await globalThis.indexedDB.databases(), []);
  // A logout in another tab wiped everything while this one still thinks it is on:
  // even "Sync now" does not bring the database back.
  globalThis.indexedDB = new IDBFactory();
  const other = await enabledPage();
  await RF.db.wipeAll();
  assert.equal(other.ctl.state.enabled, true);
  await other.ctl.syncNow();
  assert.equal(other.runs.length, 0);
  assert.equal(other.ctl.state.enabled, false);
  assert.equal(other.status().hidden, true);
  assert.deepEqual(await globalThis.indexedDB.databases(), []);
  // Another tab only closed the handle: the database is still there, reopened.
  globalThis.indexedDB = new IDBFactory();
  const p = await enabledPage({ run: async (db, o, n) => { if (n === 1) db.close(); return { error: n === 1 ? 'wiped' : null, finishedAt: '2026-11-16T10:00:00.000Z' }; } });
  const first = p.ctl.state.db;
  await p.ctl.syncNow();
  assert.equal(p.ctl.state.enabled, true);
  assert.ok(RF.db.alive(p.ctl.state.db));
  assert.notEqual(p.ctl.state.db, first);
  // An online automatic trigger rebuilds an evicted database while the record says on.
  p.ctl.state.db.close();
  await new Promise((resolve, reject) => {
    const r = globalThis.indexedDB.deleteDatabase('readfine-offline-1');
    r.onsuccess = resolve; r.onerror = reject;
  });
  p.doc.dispatchEvent(new p.Event('htmx:afterSettle'));
  await until(() => p.line() === 'Not ready: not synced yet');
  p.runs.length = 0;
  p.setVisibility('visible');
  await p.ctl.idle();
  assert.equal(p.runs.length, 1);
  assert.equal(p.ctl.state.missing, false);
  assert.ok((await globalThis.indexedDB.databases()).some((d) => d.name === 'readfine-offline-1'));
});

test('actions that need attention can be retried or discarded', async () => {
  const p = await enabledPage();
  const db = p.ctl.state.db;
  const a = await RF.db.enqueueOp(db, { type: 'label_add', article_id: 42, value: { label_id: 7 } });
  const b = await RF.db.enqueueOp(db, { type: 'star', article_id: 43 });
  for (const e of await RF.db.outboxEntries(db)) {
    await RF.db.updateOutboxOp(db, e.key, (op) => Object.assign(op, { poison: true, last_error: 'http_422' }));
  }
  await p.ctl.refreshCounts();
  // Status and its actions render after the local readiness reads.
  await p.ctl.render();
  assert.equal(p.doc.querySelector('[data-rf-offline-action="stuck"]').textContent, '2 actions need attention');
  assert.equal(p.doc.querySelector('[data-rf-offline-stuck]'), null);
  p.click('[data-rf-offline-action="stuck"]');
  await until(() => p.doc.querySelector('[data-rf-offline-stuck]'));
  const items = [...p.doc.querySelectorAll('[data-rf-offline-stuck] li')].map((li) => li.textContent);
  assert.equal(items.length, 2);
  assert.match(items[0], /label_add · article 42 · refused \(http_422\)/);
  p.click('[data-rf-op="' + b.op_id + '"][data-rf-offline-action="discard"]');
  for (let i = 0; i < 10; i++) await tick();
  p.click('[data-rf-op="' + a.op_id + '"][data-rf-offline-action="retry"]');
  for (let i = 0; i < 10; i++) await tick();
  await p.ctl.idle();
  const left = (await RF.db.outboxEntries(db)).map((e) => e.op);
  assert.deepEqual(left.map((o) => [o.op_id, !!o.poison]), [[a.op_id, false]]);
  assert.equal(p.doc.querySelector('[data-rf-offline-action="stuck"]'), null);
  assert.equal(p.runs.length, 1); // a retry syncs at once
});

test("another reader's record: this reader starts off, the worker is unflagged", async () => {
  await RF.db.setCurrentUser(2, { offlineEnabled: true, forceOffline: true });
  const p = page({ userId: 1 });
  await p.ctl.ready;
  // Task 12: the other reader's data and record are wiped (offline-logout.test.mjs,
  // "user mismatch wipes before render"); nothing is written for this reader.
  assert.equal(await RF.db.getCurrentUser(), null);
  assert.deepEqual(await globalThis.indexedDB.databases(), []);
  assert.deepEqual(p.swCalls, [['ensure', false]]);
  assert.equal(p.runs.length, 0);
});

test('two tabs: the store decides, and a stale tab never turns offline mode back on', async () => {
  // Tab A and tab B of one reader, one device store. B hears nothing (no channel).
  const a = await enabledPage();
  const b = page();
  await b.ctl.ready;
  await b.ctl.idle();
  assert.equal(b.ctl.state.enabled, true);
  b.runs.length = 0;
  await a.ctl.disable();
  // B still thinks it is on: its next trigger checks the store first and goes off.
  b.setVisibility('visible');
  await b.ctl.idle();
  assert.equal(b.runs.length, 0);
  assert.equal(b.ctl.state.enabled, false);
  assert.equal(b.status().hidden, true);
  // Its "Work offline" from a stale block does not re-enable anything.
  b.ctl.state.enabled = true; // as if the block were still on screen
  await b.ctl.setForceOffline(true);
  assert.deepEqual(await RF.db.getCurrentUser(), { userId: 1, offlineEnabled: false, forceOffline: false });
  // A switched on again: B adopts it on its next look at the store.
  await a.ctl.enable();
  await a.ctl.idle();
  await b.ctl.reconcile();
  assert.equal(b.ctl.state.enabled, true);
  assert.ok(RF.db.alive(b.ctl.state.db));
  // "Remove" in a stale tab while the store says on is refused.
  b.ctl.state.enabled = false;
  await assert.rejects(b.ctl.removeData());
  assert.ok((await globalThis.indexedDB.databases()).some((d) => d.name === 'readfine-offline-1'));
});

test('a change in another tab arrives over the broadcast channel', async () => {
  const chA = new BroadcastChannel(RF.db.CHANNEL);
  const chB = new BroadcastChannel(RF.db.CHANNEL);
  const a = await enabledPage({ channel: chA });
  const b = page({ channel: chB });
  try {
    await b.ctl.ready;
    await b.ctl.idle();
    assert.equal(b.ctl.state.enabled, true);
    await a.ctl.setForceOffline(true);
    await until(() => b.ctl.state.force === true);
    assert.equal(b.banner(), 'Offline');
    await a.ctl.disable();
    await until(() => b.ctl.state.enabled === false);
    assert.equal(b.status().hidden, true);
  } finally {
    a.ctl.stop();
    b.ctl.stop();
  }
});

test('switching on rolls back when the worker cannot be registered; switching off writes the store first', async () => {
  const p = page();
  await p.ctl.ready;
  const order = [];
  const realRegister = RF.db.setCurrentUser;
  // Fail the flagged registration.
  const sw = { ensure: async () => ({}), register: async (o) => { order.push('register ' + o.offline); if (o.offline) throw new Error('no worker'); return {}; } };
  const q = RF.page.create({
    userId: 1, displayName: 'Ann', doc: p.doc, win: p.win, nav: p.nav, sw, channel: null,
    sync: { run: async () => ({ error: null, mediaQueue: [] }), downloadMedia: async () => ({}) },
  });
  await q.ready;
  await assert.rejects(q.enable());
  assert.equal(q.state.enabled, false);
  assert.deepEqual(await RF.db.getCurrentUser(), { userId: 1, offlineEnabled: false, forceOffline: false });
  // Off: the store says off before the plain worker is registered.
  await RF.db.setCurrentUser(1, { offlineEnabled: true, forceOffline: false });
  await q.reconcile();
  RF.db.setCurrentUser = async (...args) => { order.push('store ' + args[1].offlineEnabled); return realRegister(...args); };
  try {
    order.length = 0;
    await q.disable();
  } finally {
    RF.db.setCurrentUser = realRegister;
  }
  assert.deepEqual(order, ['store false', 'register false']);
});

test('discarding an action asks first', async () => {
  let answer = false;
  const asked = [];
  const p = await enabledPage({ confirm: (q) => { asked.push(q); return answer; } });
  const db = p.ctl.state.db;
  const op = await RF.db.enqueueOp(db, { type: 'star', article_id: 43 });
  const [entry] = await RF.db.outboxEntries(db);
  await RF.db.updateOutboxOp(db, entry.key, (o) => Object.assign(o, { poison: true }));
  await p.ctl.refreshCounts();
  // Status and its actions render after the local readiness reads.
  await p.ctl.render();
  p.click('[data-rf-offline-action="stuck"]');
  await until(() => p.doc.querySelector('[data-rf-offline-stuck]'));
  p.click('[data-rf-offline-action="discard"]');
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(asked, ['Discard this action? It will not be sent to the server.']);
  assert.equal((await RF.db.outboxEntries(db)).length, 1);
  answer = true;
  p.click('[data-rf-op="' + op.op_id + '"][data-rf-offline-action="discard"]');
  for (let i = 0; i < 10; i++) await tick();
  assert.equal((await RF.db.outboxEntries(db)).length, 0);
});

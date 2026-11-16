// Offline mode, page side (offline/page.js): the per-device switch, sync triggers,
// "Ready for offline", the offline banner and the controls that need a connection.
//
// The device store is real (fake-indexeddb, in this realm); the document is jsdom. The
// sync engine, the worker registration and the browser's window/navigator are fakes,
// so a test sees exactly which syncs ran and with what.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { loadOffline, fakeCaches } from './harness.mjs';

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
function page({ userId = 1, body = SIDEBAR, run = null, onLine = true } = {}) {
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
  win.indexedDB = globalThis.indexedDB;
  const persistCalls = [];
  const nav = {
    onLine,
    serviceWorker: {},
    storage: {
      persist: async () => { persistCalls.push(1); return true; },
      estimate: async () => ({ usage: 5 * 1024 * 1024, quota: 2 * 1024 * 1024 * 1024 }),
    },
  };
  const runs = [];
  const sync = {
    run: async (db, opts) => {
      runs.push({ db, opts });
      if (run) return run(db, opts, runs.length);
      return { error: null, finishedAt: '2026-11-16T10:00:00.000Z', media: null };
    },
  };
  const swCalls = [];
  const sw = {
    ensure: async (flag) => { swCalls.push(['ensure', flag]); return {}; },
    register: async (o) => { swCalls.push(['register', o.offline]); return {}; },
  };
  const ctl = RF.page.create({
    userId, displayName: 'Ann', doc, win, nav, sync, sw, confirm: () => true,
  });
  return {
    ctl, doc, win, nav, runs, swCalls, persistCalls, timers,
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
  p.runs.length = 0;
  return p;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(cond) {
  for (let i = 0; i < 200 && !(await cond()); i++) await tick();
  assert.ok(await cond(), 'condition never became true');
}

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
  // Nothing is stored for a reader who never switched it on, not even the current-user
  // record; the worker is kept (or made) plain.
  assert.deepEqual(await globalThis.indexedDB.databases(), []);
  assert.deepEqual(p.swCalls, [['ensure', false]]);
});

test('enabling requests persistent storage and starts sync', async () => {
  const p = page({ body: SIDEBAR + SETTINGS });
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
  assert.equal(o.downloadMedia, true);
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

test('only one sync at a time, with progress shown while it runs', async () => {
  const gate = deferred();
  let calls = 0;
  const p = await enabledPage({
    run: async (db, opts) => {
      calls += 1;
      if (calls === 1) return { error: null, finishedAt: '2026-11-16T10:00:00.000Z', media: null };
      opts.onProgress({ stage: 'media', done: 3, total: 10 });
      await gate.promise;
      return { error: null, finishedAt: '2026-11-16T10:00:00.000Z', media: { stoppedReason: 'quota' } };
    },
  });
  const a = p.ctl.syncNow();
  const b = p.ctl.syncNow();
  p.setVisibility('visible');
  p.fire('online');
  await tick(); await tick();
  assert.equal(a, b);
  assert.equal(p.runs.length, 1);
  assert.equal(p.line(), 'Syncing… 3/10');
  assert.equal(p.doc.querySelector('[data-rf-offline-action="sync"]').disabled, true);
  // Progress ticks change the line only; the buttons stay the same elements.
  const syncBtn = p.doc.querySelector('[data-rf-offline-action="sync"]');
  p.runs[0].opts.onProgress({ stage: 'media', done: 5, total: 10 });
  assert.equal(p.line(), 'Syncing… 5/10');
  assert.ok(p.doc.querySelector('[data-rf-offline-action="sync"]') === syncBtn);
  gate.resolve();
  await p.ctl.idle();
  assert.match(p.line(), /^Ready for offline/);
  assert.equal(p.doc.querySelector('[data-rf-offline-full]').textContent, 'Storage full: images partly saved');
});

test('offline banner shows pending count', async () => {
  const p = await enabledPage();
  const db = p.ctl.state.db;
  await RF.db.enqueueOp(db, { type: 'star', article_id: 42 });
  await RF.db.enqueueOp(db, { type: 'read', article_id: 43 });
  assert.equal(p.banner(), '');
  // The worker answered a request: the page is offline now.
  p.afterRequest('1');
  await tick(); await tick(); await tick();
  assert.equal(p.banner(), 'Offline · 2 actions waiting');
  assert.equal(p.line(), 'Offline · 2 actions waiting');
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
  await tick(); await tick();
  assert.deepEqual(await RF.db.getCurrentUser(), { userId: 1, offlineEnabled: true, forceOffline: true });
  assert.equal(p.banner(), 'Offline');
  assert.equal(p.doc.querySelector('[data-rf-offline-action="work-offline"]').textContent, 'Back online');
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
  const p = await enabledPage({ run: async () => ({ error: 'auth' }) });
  await p.ctl.syncNow();
  assert.equal(p.line(), 'Session expired – log in to sync');
  assert.equal(p.doc.querySelector('[data-rf-offline-line] a').getAttribute('href'), '/login');
  assert.ok(RF.db.alive(p.ctl.state.db));
  const csrf = await enabledPage({ run: async () => ({ error: 'csrf' }) });
  await csrf.ctl.syncNow();
  assert.equal(csrf.line(), 'Sync stopped – reload the page');
  const http = await enabledPage({ run: async () => ({ error: 'http', errorDetail: 500 }) });
  await http.ctl.syncNow();
  assert.equal(http.line(), 'Sync failed – will try again');
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
  // The database alone was deleted while the store still says on: only "Sync now"
  // recreates it, never an automatic trigger.
  p.ctl.state.db.close();
  await new Promise((resolve, reject) => {
    const r = globalThis.indexedDB.deleteDatabase('readfine-offline-1');
    r.onsuccess = resolve; r.onerror = reject;
  });
  p.runs.length = 0;
  p.setVisibility('visible');
  await p.ctl.idle();
  assert.equal(p.runs.length, 0);
  assert.equal(p.ctl.state.missing, true);
  assert.match(p.line(), /not on this device/);
  p.setVisibility('visible');
  await p.ctl.idle();
  assert.equal(p.runs.length, 0);
  await p.ctl.syncNow();
  assert.equal(p.runs.length, 1);
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
  p.ctl.render();
  assert.equal(p.doc.querySelector('[data-rf-offline-action="stuck"]').textContent, '2 actions need attention');
  assert.equal(p.doc.querySelector('[data-rf-offline-stuck]'), null);
  p.click('[data-rf-offline-action="stuck"]');
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
  assert.deepEqual(await RF.db.getCurrentUser(), { userId: 1, offlineEnabled: false, forceOffline: false });
  assert.deepEqual(p.swCalls, [['ensure', false]]);
  assert.equal(p.runs.length, 0);
});

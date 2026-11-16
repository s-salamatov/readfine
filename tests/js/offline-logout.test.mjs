// Offline mode: logout wipe and account safety (offline/page.js, design 5.7).
//
// Same set-up as offline-page.test.mjs: the device store is real (fake-indexeddb), the
// document is jsdom, the sync engine (unless a test uses the real one), the worker
// registration, localStorage, navigation and POST /logout are fakes that record.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { loadOffline, fakeCaches, browser } from './harness.mjs';

const RF = await loadOffline();

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  // wipeAll deletes the media/shell caches through the global (the page passes none).
  globalThis.caches = fakeCaches();
});

afterEach(() => {
  delete globalThis.caches;
});

const LOGOUT_FORM = '<form method="POST" action="/logout" data-rf-logout><button type="submit">Logout</button></form>';
const SIDEBAR = '<aside id="sidebar"><div id="sidebar-full"><div data-rf-slot="offline-status" hidden></div>'
  + LOGOUT_FORM + '</div></aside>'
  + '<div data-rf-slot="offline-banner"></div>'
  + '<div id="article-detail"><div id="article-detail-root" data-rf-article="42">Secret article</div></div>';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function memStorage() {
  const m = new Map();
  return {
    m,
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
  };
}

const okLogout = async () => ({ type: 'opaqueredirect', status: 0 });
const netDown = async () => { throw new TypeError('Failed to fetch'); };

function page({
  userId = 1, body = SIDEBAR, run = null, media = null, onLine = true, channel = null,
  storage = memStorage(), logoutFetch = okLogout, sync = null, db = null, sw = null,
  hasDataWaitMs = undefined, logoutWatchdogMs = undefined, htmlClass = '',
} = {}) {
  // htmlClass 'rf-hide': what logout-guard.js set before the page was parsed.
  const dom = new JSDOM('<!doctype html><html class="' + htmlClass + '"><body>' + body + '</body></html>', { url: 'https://readfine.test/app' });
  const doc = dom.window.document;
  let visibility = 'visible';
  Object.defineProperty(doc, 'visibilityState', { get: () => visibility, configurable: true });
  const win = new dom.window.EventTarget();
  const timers = [];
  win.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  win.clearInterval = (id) => { if (timers[id - 1]) timers[id - 1].fn = null; };
  win.caches = globalThis.caches;
  win.indexedDB = globalThis.indexedDB;
  const nav = { onLine, serviceWorker: {}, storage: { persist: async () => true } };
  const runs = [];
  const downloads = [];
  const fakeSync = {
    run: async (d, opts) => {
      runs.push({ db: d, opts });
      if (run) return run(d, opts, runs.length);
      return { error: null, finishedAt: '2026-11-16T10:00:00.000Z', mediaQueue: [] };
    },
    downloadMedia: async (d, urls, opts) => {
      downloads.push({ db: d, urls, opts });
      if (media) return media(d, urls, opts);
      return { stored: urls.length, skipped: 0, stoppedReason: null };
    },
  };
  const swCalls = [];
  const fakeSw = sw || {
    ensure: async (flag) => { swCalls.push(['ensure', flag]); return {}; },
    register: async (o) => { swCalls.push(['register', o.offline]); return {}; },
  };
  const fetches = [];
  // POST /logout goes here; the real sync engine (when a test uses it) too.
  const fetchFn = async (url, init = {}) => {
    fetches.push({ url: String(url), method: init.method || 'GET', init });
    return logoutFetch(url, init, fetches.length);
  };
  const navigations = [];
  const form = () => doc.querySelector('form[data-rf-logout]');
  // Native form submissions (a plain POST /logout navigation), recorded.
  const native = [];
  dom.window.HTMLFormElement.prototype.submit = function () { native.push(this); };
  const ctl = RF.page.create({
    userId, displayName: 'Ann', doc, win, nav, sync: sync || fakeSync, sw: fakeSw, channel,
    db: db || undefined, storage, fetchFn, navigate: (u) => navigations.push(u),
    hasDataWaitMs, logoutWatchdogMs,
  });
  return {
    ctl, doc, win, nav, runs, downloads, swCalls, timers, fetches, navigations, storage, native, dom,
    setVisibility(v) { visibility = v; doc.dispatchEvent(new dom.window.Event('visibilitychange')); },
    // The reader presses Logout: the submit event the browser fires.
    submitLogout() {
      const ev = new dom.window.Event('submit', { bubbles: true, cancelable: true });
      form().dispatchEvent(ev);
      assert.equal(ev.defaultPrevented, true, 'the page holds the submit');
      return ctl.state.loggingOut;
    },
    dialog() { return doc.querySelector('[data-rf-logout-dialog]'); },
    choose(c) {
      doc.querySelector('[data-rf-logout-choice="' + c + '"]')
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    },
    line() { const p = doc.querySelector('[data-rf-offline-line]'); return p ? p.textContent : null; },
    status() { return doc.querySelector('[data-rf-slot="offline-status"]'); },
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
  for (let i = 0; i < 300 && !(await cond()); i++) await tick();
  assert.ok(await cond(), 'condition never became true');
}

const dbNames = async () => (await globalThis.indexedDB.databases()).map((d) => d.name).sort();

async function addOps(userId, { pending = 0, stuck = 0 } = {}) {
  const db = await RF.db.open(userId);
  for (let i = 0; i < pending + stuck; i++) await RF.db.enqueueOp(db, { type: 'star', article_id: 100 + i });
  const entries = await RF.db.outboxEntries(db);
  for (const e of entries.slice(pending)) {
    await RF.db.updateOutboxOp(db, e.key, (op) => Object.assign(op, { stuck: true, attempts: 10 }));
  }
  db.close();
}

// ---- the brief's tests --------------------------------------------------------------

test('logout wipes databases and caches before posting', async () => {
  const p = await enabledPage();
  await (await globalThis.caches.open('readfine-media-1')).put('https://readfine.test/m/x', new Response('img'));
  await (await globalThis.caches.open('readfine-shell-1')).put('https://readfine.test/app', new Response('shell'));
  await globalThis.caches.open('other-app-cache');
  assert.deepEqual(await dbNames(), ['readfine-offline-1', 'readfine-offline-current']);
  let atPost = null;
  const storage = memStorage();
  let q = null;
  q = page({
    storage,
    logoutFetch: async () => {
      atPost = {
        dbs: await dbNames(), caches: await globalThis.caches.keys(), store: await RF.db.getCurrentUser(),
        // Crash-safe: the logout is owed until the server answers; the wipe is done.
        markers: [...storage.m.entries()],
        busy: !!q.doc.querySelector('[data-rf-logout-busy]'),
      };
      return { type: 'opaqueredirect', status: 0 };
    },
  });
  await q.ctl.ready;
  await q.ctl.idle();
  const r = await q.submitLogout();
  assert.equal(r, 'done');
  // POST /logout went out once, after the wipe: nothing offline was left by then.
  assert.deepEqual(q.fetches.map((f) => f.method + ' ' + f.url), ['POST /logout']);
  assert.equal(q.fetches[0].init.credentials, 'same-origin');
  assert.deepEqual(atPost, {
    dbs: [], caches: ['other-app-cache'], store: null,
    markers: [['rf-logout-pending', '1']], busy: true,
  });
  assert.deepEqual(q.navigations, ['/login']);
  // The worker was unflagged before the wipe; the switch and "Work offline" are gone.
  assert.deepEqual(q.swCalls, [['ensure', true], ['register', false]]);
  assert.equal(q.ctl.state.enabled, false);
  assert.equal(q.ctl.state.force, false);
  assert.equal(q.storage.m.size, 0);
  assert.equal(q.native.length, 0);
  // The other tab (p) has no channel here: its next trigger finds the store gone and
  // goes off without recreating anything.
  p.setVisibility('visible');
  await p.ctl.idle();
  assert.equal(p.ctl.state.enabled, false);
  assert.deepEqual(await dbNames(), []);
});

test('logout with pending ops shows dialog and discard works', async () => {
  const p = await enabledPage();
  await addOps(1, { pending: 2, stuck: 1 });
  let done = p.submitLogout();
  await until(() => p.dialog());
  const text = p.dialog().textContent;
  assert.match(text, /3 changes not synced yet/);
  assert.match(text, /1 action could not be sent and needs attention/);
  assert.ok(p.dialog().querySelector('[data-rf-logout-choice="sync"]'), 'online: Sync and log out offered');
  // Cancel: nothing happens, the reader stays.
  p.choose('cancel');
  assert.equal(await done, 'cancelled');
  assert.equal(p.dialog(), null);
  assert.equal(p.fetches.length, 0);
  assert.ok((await dbNames()).includes('readfine-offline-1'));
  assert.equal(p.ctl.state.enabled, true);
  // Again, and discard.
  done = p.submitLogout();
  await until(() => p.dialog());
  p.choose('discard');
  assert.equal(await done, 'done');
  assert.deepEqual(await dbNames(), []);
  assert.deepEqual(p.fetches.map((f) => f.method + ' ' + f.url), ['POST /logout']);
  assert.deepEqual(p.navigations, ['/login']);
});

test('sync and log out: sends first, comes back while actions are left, offline offers discard only', async () => {
  let call = 0;
  const p = await enabledPage({
    run: async (db) => {
      call += 1;
      if (call === 1) return { error: null, finishedAt: '2026-11-16T10:00:00.000Z', mediaQueue: [] }; // enabling
      if (call === 2) return { error: 'http' }; // the first sync fails, nothing sent
      // The second sends the pending ops; the stuck one stays.
      const left = (await RF.db.outboxEntries(db)).filter((e) => !RF.db.isBlocked(e.op));
      await RF.db.deleteOutboxKeys(db, left.map((e) => e.key));
      return { error: null, finishedAt: '2026-11-16T11:00:00.000Z', mediaQueue: [] };
    },
  });
  await addOps(1, { pending: 1, stuck: 1 });
  const done = p.submitLogout();
  await until(() => p.dialog());
  p.choose('sync');
  // The sync failed: the dialog is back, saying so.
  await until(() => p.dialog() && p.dialog().querySelector('[data-rf-logout-note]'));
  assert.match(p.dialog().textContent, /2 changes not synced yet/);
  assert.match(p.dialog().textContent, /Sync did not send everything/);
  p.choose('sync');
  // Sent; only the stuck action is left, which a sync never sends: no Sync button.
  await until(() => p.dialog() && /1 change not synced yet/.test(p.dialog().textContent));
  assert.equal(p.dialog().querySelector('[data-rf-logout-choice="sync"]'), null);
  assert.equal(p.runs.length, 2); // (enabledPage cleared the enabling run)
  p.choose('discard');
  assert.equal(await done, 'done');
  assert.deepEqual(await dbNames(), []);

  // Offline: discard only.
  const q = await enabledPage();
  await addOps(1, { pending: 1 });
  q.nav.onLine = false;
  const d2 = q.submitLogout();
  await until(() => q.dialog());
  assert.equal(q.dialog().querySelector('[data-rf-logout-choice="sync"]'), null);
  q.choose('cancel');
  assert.equal(await d2, 'cancelled');
});

test('offline logout sets pending flag and next online init posts logout', async () => {
  const storage = memStorage();
  const p = await enabledPage({ storage, logoutFetch: netDown });
  const r = await p.submitLogout();
  assert.equal(r, 'offline');
  // Wiped locally anyway; the marker holds no user data.
  assert.deepEqual(await dbNames(), []);
  assert.deepEqual([...storage.m.entries()], [['rf-logout-pending', '1']]);
  // The page no longer shows the reader's articles: "Logged out on this device".
  assert.equal(p.navigations.length, 0);
  assert.match(p.doc.body.textContent, /Logged out on this device/);
  assert.doesNotMatch(p.doc.body.textContent, /Secret article/);
  assert.equal(p.doc.body.getAttribute('data-rf-user'), null);
  assert.ok(p.doc.querySelector('a[href="/login"]'));

  // Next start, still offline: nothing is posted, the flag stays, and the app is never
  // shown as the logged-out reader: "Logged out on this device".
  const off = page({ storage, onLine: false });
  await off.ctl.ready;
  assert.equal(off.fetches.length, 0);
  assert.equal(storage.getItem('rf-logout-pending'), '1');
  assert.match(off.doc.body.textContent, /Logged out on this device/);
  assert.doesNotMatch(off.doc.body.textContent, /Secret article/);
  assert.deepEqual(off.swCalls, []);

  // Next start online (the server session is still valid): POST /logout before anything
  // else, the flag cleared, on to /login; no sync, nothing created.
  const next = page({ storage });
  await next.ctl.ready;
  await next.ctl.idle();
  assert.deepEqual(next.fetches.map((f) => f.method + ' ' + f.url), ['POST /logout']);
  assert.deepEqual(next.navigations, ['/login']);
  assert.equal(storage.getItem('rf-logout-pending'), null);
  assert.equal(next.runs.length, 0);
  assert.deepEqual(next.swCalls, []);
  assert.deepEqual(await dbNames(), []);

  // A failed replay keeps the flag and shows "Logged out", never the app.
  storage.setItem('rf-logout-pending', '1');
  const again = page({ storage, logoutFetch: netDown, htmlClass: 'rf-hide' });
  await again.ctl.ready;
  assert.equal(storage.getItem('rf-logout-pending'), '1');
  assert.match(again.doc.body.textContent, /Logged out on this device/);
  assert.doesNotMatch(again.doc.body.textContent, /Secret article/);
  assert.equal(again.doc.documentElement.classList.contains('rf-hide'), false);
  assert.equal(again.navigations.length, 0);
  assert.equal(again.runs.length, 0);
  // A successful replay leaves the page hidden while it goes to /login.
  const ok = page({ storage, htmlClass: 'rf-hide' });
  await ok.ctl.ready;
  assert.deepEqual(ok.navigations, ['/login']);
  assert.equal(ok.doc.documentElement.classList.contains('rf-hide'), true);
  // Without the flag a start removes a stale class.
  const plain = page({ storage, htmlClass: 'rf-hide' });
  await plain.ctl.ready;
  assert.equal(plain.doc.documentElement.classList.contains('rf-hide'), false);
});

test('logout-guard.js hides the page before it is parsed while a logout is pending', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../backend/app/static/js/offline/logout-guard.js', import.meta.url), 'utf8');
  for (const [flag, hidden] of [['1', true], [null, false]]) {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
      { runScripts: 'outside-only', url: 'https://readfine.test/app' });
    if (flag) dom.window.localStorage.setItem('rf-logout-pending', flag);
    dom.window.eval(src);
    assert.equal(dom.window.document.documentElement.classList.contains('rf-hide'), hidden);
  }
});

test('the sign-in and register pages clear a pending offline logout (app.js)', () => {
  const login = browser('<form method="post" action="/login" data-rf-login></form>', {
    before: (w) => w.localStorage.setItem('rf-logout-pending', '1'),
  });
  assert.equal(login.localStorage.getItem('rf-logout-pending'), null);
  // Any other page leaves it for page.js.
  const other = browser('<div id="x"></div>', {
    before: (w) => w.localStorage.setItem('rf-logout-pending', '1'),
  });
  assert.equal(other.localStorage.getItem('rf-logout-pending'), '1');
});

test('user mismatch wipes before render', async () => {
  // Reader 2 had offline mode on and data here; their session ended without a logout.
  await RF.db.setCurrentUser(2, { offlineEnabled: true, forceOffline: true });
  await addOps(2, { pending: 1 });
  const order = [];
  const db = {
    ...RF.db,
    wipeAll: async (o) => { order.push('wipe'); return RF.db.wipeAll(o); },
  };
  const sw = {
    ensure: async (flag) => { order.push('ensure ' + flag); return {}; },
    register: async () => ({}),
  };
  const p = page({ userId: 1, db, sw });
  await p.ctl.ready;
  await p.ctl.idle();
  assert.deepEqual(order, ['wipe', 'ensure false']);
  // Nothing of reader 2 left, nothing written for reader 1 (never switched on here).
  assert.deepEqual(await dbNames(), []);
  assert.equal(await RF.db.getCurrentUser(), null);
  assert.equal(p.runs.length, 0);
  assert.equal(p.status().hidden, true);

  // A leftover database without a record (an earlier wipe half done) is wiped too.
  const left = await RF.db.open(3);
  left.close();
  const q = page({ userId: 1 });
  await q.ctl.ready;
  assert.deepEqual(await dbNames(), []);

  // The reader's own record and database are not touched.
  const own = await enabledPage({ userId: 1 });
  const again = page({ userId: 1 });
  await again.ctl.ready;
  await again.ctl.idle();
  assert.equal(again.ctl.state.enabled, true);
  assert.deepEqual(await dbNames(), ['readfine-offline-1', 'readfine-offline-current']);
  own.ctl.stop();
});

test('a mismatch wipe that leaves a database: the record says off for the new reader, retried next start', async () => {
  await RF.db.setCurrentUser(2, { offlineEnabled: true, forceOffline: false });
  const storage = memStorage();
  let fail = true;
  const db = {
    ...RF.db,
    // The record survives (the store was blocked) and the wipe rejects.
    wipeAll: async () => {
      if (fail) throw new Error('offline database not deleted: readfine-offline-2 (x)');
      return RF.db.wipeAll();
    },
  };
  const p = page({ userId: 1, db, storage });
  await p.ctl.ready;
  await p.ctl.idle();
  assert.deepEqual(await RF.db.getCurrentUser(), { userId: 1, offlineEnabled: false, forceOffline: false });
  assert.equal(storage.getItem('rf-wipe-pending'), '1');
  assert.equal(p.runs.length, 0);
  assert.deepEqual(p.swCalls, [['ensure', false]]);
  // While the wipe is owed, switching on retries it first and refuses if it fails:
  // nothing is created that the owed wipe would later delete.
  await assert.rejects(p.ctl.enable(), /could not be removed/);
  assert.equal(p.ctl.state.enabled, false);
  assert.ok(!(await dbNames()).includes('readfine-offline-1'));
  fail = false;
  const q = page({ userId: 1, db, storage });
  await q.ctl.ready;
  assert.equal(storage.getItem('rf-wipe-pending'), null);
  assert.deepEqual(await dbNames(), []);
  // Owed again; this time the retry inside enable() works, and what it stores survives
  // the next start.
  storage.setItem('rf-wipe-pending', '1');
  await q.ctl.enable();
  await q.ctl.idle();
  assert.equal(storage.getItem('rf-wipe-pending'), null);
  const next = page({ userId: 1, db, storage });
  await next.ctl.ready;
  await next.ctl.idle();
  assert.equal(next.ctl.state.enabled, true);
  assert.ok((await dbNames()).includes('readfine-offline-1'));
});

// Review Focus 5. The real sync engine against a fake server.
test('test_expired_session_keeps_outbox_until_same_user_logs_in', async () => {
  const opsSent = [];
  let session = 'expired';
  const server = async (url, init = {}) => {
    const u = new URL(url, 'https://readfine.test/');
    if (u.pathname === '/logout') return { type: 'opaqueredirect', status: 0 };
    if (session === 'expired') return new Response('{"detail":"x"}', { status: 401, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/sync/v1/ops') {
      const body = JSON.parse(init.body);
      opsSent.push(...body.ops.map((o) => o.type + ' ' + o.article_id));
      return new Response(JSON.stringify({
        server_time: '2026-11-16T10:00:00.000Z',
        results: body.ops.map((o) => ({ op_id: o.op_id, status: 'applied', reason: null, retryable: false, article: null })),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // The rest of the run is not what this test is about.
    return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
  };
  const p = page({ sync: RF.sync, logoutFetch: server });
  await p.ctl.ready;
  await p.ctl.enable();
  await p.ctl.idle();
  await addOps(1, { pending: 2 });
  await p.ctl.syncNow();
  await p.ctl.idle();
  // 401: nothing sent, data and outbox kept, the reader told; no more automatic syncs.
  assert.equal(p.ctl.state.error, 'auth');
  assert.equal(p.line(), 'Session expired – log in to sync');
  assert.ok(p.status().querySelector('a[href="/login"]'));
  const tried = p.fetches.length;
  p.setVisibility('visible');
  p.win.dispatchEvent(new p.doc.defaultView.Event('online'));
  p.timers.forEach((t) => t.fn && t.fn());
  await p.ctl.idle();
  assert.equal(p.fetches.length, tried, 'no automatic sync after a 401');
  assert.ok(p.timers.every((t) => t.fn === null), 'the timer is stopped');
  const db = await RF.db.openExisting(1);
  assert.equal((await RF.db.outboxEntries(db)).length, 2);
  db.close();
  assert.deepEqual(opsSent, []);
  p.ctl.stop();

  // The same reader signs in again: the next page load sends the ops.
  session = 'ok';
  const same = page({ sync: RF.sync, logoutFetch: server });
  await same.ctl.ready;
  await same.ctl.idle();
  assert.deepEqual(opsSent, ['star 100', 'star 101']);
  const db2 = await RF.db.openExisting(1);
  assert.equal((await RF.db.outboxEntries(db2)).length, 0);
  db2.close();
  same.ctl.stop();

  // Expired again with ops left; a different reader signs in: wiped, nothing sent.
  session = 'expired';
  await addOps(1, { pending: 1 });
  opsSent.length = 0;
  session = 'ok';
  const other = page({ userId: 2, sync: RF.sync, logoutFetch: server });
  await other.ctl.ready;
  await other.ctl.idle();
  assert.deepEqual(opsSent, []);
  assert.deepEqual(await dbNames(), []);
  assert.equal(other.fetches.length, 0);
});

// ---- the other paths ----------------------------------------------------------------

test('a reader who never used offline mode: logout is the plain form submit', async () => {
  const p = page();
  await p.ctl.ready;
  await p.ctl.idle();
  const r = await p.submitLogout();
  assert.equal(r, 'native');
  // A fresh POST /logout form (the menu's own may be swapped away), not intercepted.
  assert.equal(p.native.length, 1);
  assert.notEqual(p.native[0], p.doc.querySelector('form[data-rf-logout]'));
  assert.equal(p.native[0].getAttribute('action'), '/logout');
  assert.equal(p.native[0].method.toUpperCase(), 'POST');
  assert.ok(p.native[0].isConnected);
  // Not stuck: a second press goes out again (e.g. the first navigation failed).
  assert.equal(p.ctl.state.loggingOut, null);
  assert.equal(await p.submitLogout(), 'native');
  assert.equal(p.native.length, 2);
  assert.equal(p.fetches.length, 0);
  assert.deepEqual(p.swCalls, [['ensure', false]]);
  assert.deepEqual(await dbNames(), []);
  assert.deepEqual(await globalThis.caches.keys(), []);
  assert.equal(p.storage.m.size, 0);
  // Through RFOffline.page.logout without a controller: the plain submit too.
  const dom = new JSDOM('<!doctype html><body>' + LOGOUT_FORM + '</body>');
  const form = dom.window.document.querySelector('form');
  let sent = 0;
  form.submit = () => { sent += 1; };
  assert.equal(await RF.page.logout(form), 'native');
  assert.equal(sent, 1);
});

test('switched off with data kept: logout still wipes it', async () => {
  const p = await enabledPage();
  await p.ctl.disable();
  assert.ok((await dbNames()).includes('readfine-offline-1'));
  const r = await p.submitLogout();
  assert.equal(r, 'done');
  assert.equal(p.native.length, 0);
  assert.deepEqual(await dbNames(), []);
});

test('a wipe that leaves a database still logs out, with a warning and a retry marker', async () => {
  const storage = memStorage();
  let fail = true;
  const db = {
    ...RF.db,
    wipeAll: async (o) => {
      await RF.db.wipeAll(o);
      if (fail) throw new Error('offline database not deleted: readfine-offline-1 (x)');
    },
  };
  const p = await enabledPage({ db, storage });
  const r = await p.submitLogout();
  assert.equal(r, 'done');
  assert.deepEqual(p.navigations, ['/login?offline_wipe=incomplete']);
  assert.deepEqual([...storage.m.entries()], [['rf-wipe-pending', '1']]);
  // The next start (whoever signs in) wipes first and forgets the marker.
  fail = false;
  let wiped = 0;
  const q = page({ storage, db: { ...RF.db, wipeAll: async (o) => { wiped += 1; return RF.db.wipeAll(o); } } });
  await q.ctl.ready;
  assert.equal(wiped, 1);
  assert.equal(storage.getItem('rf-wipe-pending'), null);
});

test('logout during a running sync and image download: both stop, nothing is recreated', async () => {
  const syncGate = deferred();
  const mediaGate = deferred();
  let gating = false;
  let call = 0;
  const p = await enabledPage({
    run: async (db) => {
      call += 1;
      if (call <= 2) return { error: null, finishedAt: '2026-11-16T10:00:00.000Z', mediaQueue: ['/m/a', '/m/b'] };
      await syncGate.promise;
      // A run that goes on after the wipe finds its handle closed.
      return { error: RF.db.alive(db) ? null : 'wiped', mediaQueue: ['/m/c'] };
    },
    media: async (db) => {
      if (gating) await mediaGate.promise;
      return { stored: 0, skipped: 0, stoppedReason: RF.db.alive(db) ? null : 'wiped' };
    },
  });
  gating = true;
  p.downloads.length = 0;
  await p.ctl.syncNow(); // its download waits at the gate
  await until(() => !!p.ctl.state.media);
  const flight = p.ctl.syncNow(); // a sync that waits at its gate
  await until(() => p.runs.length === 2);
  const done = p.submitLogout();
  await until(() => p.ctl.state.leaving === true);
  syncGate.resolve();
  mediaGate.resolve();
  assert.equal(await done, 'done');
  await flight;
  await p.ctl.idle();
  assert.deepEqual(await dbNames(), []);
  // One download only; neither the cut-short sync's queue nor a pending one starts.
  assert.equal(p.downloads.length, 1);
  // Nothing more from this tab: no sync, no switch-on.
  const runs = p.runs.length;
  await p.ctl.syncNow();
  await assert.rejects(p.ctl.enable());
  p.timers.forEach((t) => t.fn && t.fn());
  await p.ctl.idle();
  assert.equal(p.runs.length, runs);
  assert.deepEqual(await dbNames(), []);
});

test('another tab goes off on the wipe broadcast and recreates nothing', async () => {
  const chA = new BroadcastChannel(RF.db.CHANNEL);
  const chB = new BroadcastChannel(RF.db.CHANNEL);
  const a = await enabledPage({ channel: chA });
  const b = page({ channel: chB });
  try {
    await b.ctl.ready;
    await b.ctl.idle();
    assert.equal(b.ctl.state.enabled, true);
    assert.equal(await a.submitLogout(), 'done');
    await until(() => b.ctl.state.enabled === false);
    assert.equal(b.status().hidden, true);
    // Its triggers and buttons create nothing.
    b.runs.length = 0;
    b.setVisibility('visible');
    await b.ctl.syncNow();
    await b.ctl.setForceOffline(true);
    await b.ctl.idle();
    assert.equal(b.runs.length, 0);
    assert.deepEqual(await dbNames(), []);
    assert.equal(await RF.db.getCurrentUser(), null);
  } finally {
    a.ctl.stop();
    b.ctl.stop();
  }
});

// ---- Task 11 re-review fixes --------------------------------------------------------

test('an image queue that arrives during a download is downloaded after it', async () => {
  const gate = deferred();
  let gating = false;
  let call = 0;
  const p = await enabledPage({
    run: async () => {
      call += 1;
      return { error: null, finishedAt: '2026-11-16T10:00:00.000Z', mediaQueue: call < 3 ? ['/m/a'] : ['/m/a', '/m/b'] };
    },
    media: async () => {
      if (gating) await gate.promise;
      return { stored: 1, skipped: 0, stoppedReason: null };
    },
  });
  gating = true;
  p.downloads.length = 0;
  await p.ctl.syncNow(); // starts a download, which waits at the gate
  await until(() => !!p.ctl.state.media);
  await p.ctl.syncNow(); // brings a longer queue while it runs
  assert.equal(p.downloads.length, 1);
  gate.resolve();
  await p.ctl.idle();
  assert.deepEqual(p.downloads.map((d) => d.urls), [['/m/a'], ['/m/a', '/m/b']]);
});

test('a transient store read failure is not "off": retried, then the state is kept with a warning', async () => {
  let failures = 0;
  const db = {
    ...RF.db,
    getCurrentUser: async () => {
      if (failures > 0) { failures -= 1; throw new Error('transient'); }
      return RF.db.getCurrentUser();
    },
  };
  const p = await enabledPage({ db });
  // One failure: the retry reads it.
  failures = 1;
  assert.equal(await p.ctl.reconcile(), true);
  assert.equal(p.ctl.state.enabled, true);
  assert.equal(p.doc.querySelector('[data-rf-offline-warn]'), null);
  // Two: the tab stays on and says it could not read the setting.
  failures = 2;
  assert.equal(await p.ctl.reconcile(), true);
  assert.equal(p.ctl.state.enabled, true);
  assert.ok(p.ctl.state.timer);
  assert.match(p.doc.querySelector('[data-rf-offline-warn]').textContent, /could not be read/);
  // The next good read clears the warning.
  assert.equal(await p.ctl.reconcile(), true);
  assert.equal(p.doc.querySelector('[data-rf-offline-warn]'), null);
});

test('enable writes the store before the tab counts itself on', async () => {
  const seen = [];
  let ctlRef = null;
  const db = {
    ...RF.db,
    setCurrentUser: async (id, o) => {
      if (o && o.offlineEnabled) seen.push(ctlRef.state.enabled);
      return RF.db.setCurrentUser(id, o);
    },
  };
  const p = page({ db });
  ctlRef = p.ctl;
  await p.ctl.ready;
  await p.ctl.enable();
  await p.ctl.idle();
  assert.deepEqual(seen, [false]);
  assert.equal(p.ctl.state.enabled, true);
});

// ---- fix round 1: account check on every sync, crash-safe logout, account deletion ----

// A /sync/v1 server with one session at a time: it refuses (409) a request whose
// X-Readfine-User is not the signed-in reader, before doing anything.
function sessionServer() {
  const s = { user: 1, applied: [], seen: [] };
  s.fetch = async (url, init = {}) => {
    const u = new URL(url, 'https://readfine.test/');
    if (u.pathname === '/logout') return { type: 'opaqueredirect', status: 0 };
    const who = (init.headers || {})['x-readfine-user'];
    s.seen.push((init.method || 'GET') + ' ' + u.pathname + ' as ' + who);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (who !== String(s.user)) return json({ error: 'account_mismatch' }, 409);
    if (u.pathname === '/sync/v1/ops') {
      const body = JSON.parse(init.body);
      s.applied.push(...body.ops.map((o) => s.user + ':' + o.type + ' ' + o.article_id));
      return json({ server_time: '2026-11-16T10:00:00.000Z',
        results: body.ops.map((o) => ({ op_id: o.op_id, status: 'applied', reason: null, retryable: false, article: null })) });
    }
    return json({}, 503);
  };
  return s;
}

test('a tab whose reader is no longer signed in: Sync now sends no ops, writes nothing, wipes and reloads', async () => {
  const srv = sessionServer();
  const p = page({ sync: RF.sync, logoutFetch: srv.fetch });
  await p.ctl.ready;
  await p.ctl.enable();
  await p.ctl.idle();
  await addOps(1, { pending: 2 });
  // Reader 2 signs in elsewhere in this browser: the cookie is theirs now.
  srv.user = 2;
  srv.seen.length = 0;
  await p.ctl.syncNow();
  await p.ctl.idle();
  // Refused at the first request; reader 1's ops never reached reader 2's account.
  assert.deepEqual(srv.seen, ['POST /sync/v1/ops as 1']);
  assert.deepEqual(srv.applied, []);
  assert.deepEqual(await dbNames(), []);
  assert.deepEqual(p.navigations, ['https://readfine.test/app']);
  assert.equal(p.ctl.state.enabled, false);
  // Nothing more from this tab.
  await p.ctl.syncNow();
  p.timers.forEach((t) => t.fn && t.fn());
  await p.ctl.idle();
  assert.deepEqual(srv.seen, ['POST /sync/v1/ops as 1']);
  assert.deepEqual(await dbNames(), []);
});

test('the account signal stops a running image download too', async () => {
  const gate = deferred();
  let gating = false;
  let call = 0;
  const p = await enabledPage({
    run: async () => {
      call += 1;
      if (call === 3) return { error: 'account' };
      return { error: null, finishedAt: '2026-11-16T10:00:00.000Z', mediaQueue: ['/m/a'] };
    },
    media: async (db) => {
      if (gating) await gate.promise;
      return { stored: 0, skipped: 0, stoppedReason: RF.db.alive(db) ? null : 'wiped' };
    },
  });
  gating = true;
  p.downloads.length = 0;
  await p.ctl.syncNow();
  await until(() => !!p.ctl.state.media);
  await p.ctl.syncNow(); // answered "account"
  await until(() => p.navigations.length === 1);
  assert.equal(RF.db.alive(p.downloads[0].db), false, 'the download lost its handle');
  gate.resolve();
  await p.ctl.idle();
  assert.equal(p.downloads.length, 1);
  assert.deepEqual(await dbNames(), []);
});

test('a logout that never finishes: the watchdog keeps both markers and logs out the plain way; the next start completes it', async () => {
  const storage = memStorage();
  let hang = true;
  const db = { ...RF.db, wipeAll: (o) => (hang ? new Promise(() => {}) : RF.db.wipeAll(o)) };
  const p = await enabledPage({ db, storage, logoutWatchdogMs: 50 });
  assert.equal(await p.submitLogout(), 'watchdog');
  assert.ok(p.doc.querySelector('[data-rf-logout-busy]'), 'Logging out… shown meanwhile');
  assert.match(p.doc.querySelector('[data-rf-logout-busy]').textContent, /Logging out…/);
  assert.equal(p.native.length, 1);
  assert.equal(p.native[0].getAttribute('action'), '/logout');
  assert.equal(p.fetches.length, 0);
  assert.equal(storage.getItem('rf-wipe-pending'), '1');
  assert.equal(storage.getItem('rf-logout-pending'), '1');
  // The app was closed there (or crashed). The next start wipes, then ends the session.
  hang = false;
  const next = page({ db, storage });
  await next.ctl.ready;
  assert.deepEqual(await dbNames(), []);
  assert.deepEqual(next.fetches.map((f) => f.method + ' ' + f.url), ['POST /logout']);
  assert.deepEqual(next.navigations, ['/login']);
  assert.equal(storage.m.size, 0);
});

test('"anything offline here?" that cannot be answered in time counts as yes', async () => {
  let hang = false;
  const db = { ...RF.db, getCurrentUser: () => (hang ? new Promise(() => {}) : RF.db.getCurrentUser()) };
  const p = page({ db, hasDataWaitMs: 20 });
  await p.ctl.ready;
  await p.ctl.idle();
  hang = true;
  assert.equal(await p.submitLogout(), 'done');
  assert.equal(p.native.length, 0);
  assert.deepEqual(p.fetches.map((f) => f.method + ' ' + f.url), ['POST /logout']);
});

test('an outbox that cannot be read is asked about, not taken as empty', async () => {
  let broken = false;
  const db = { ...RF.db, outboxEntries: (d) => (broken ? Promise.reject(new Error('read failed')) : RF.db.outboxEntries(d)) };
  const p = await enabledPage({ db });
  broken = true;
  const done = p.submitLogout();
  await until(() => p.dialog());
  assert.match(p.dialog().textContent, /Unsent changes could not be counted/);
  p.choose('cancel');
  assert.equal(await done, 'cancelled');
  assert.ok((await dbNames()).includes('readfine-offline-1'));
  const again = p.submitLogout();
  await until(() => p.dialog());
  p.choose('discard');
  assert.equal(await again, 'done');
  assert.deepEqual(await dbNames(), []);
});

test('without indexedDB.databases() every wipe still names the databases it knows', async () => {
  const factory = globalThis.indexedDB;
  const hide = () => { factory.databases = undefined; };
  const show = () => { delete factory.databases; };
  // Logout.
  const p = await enabledPage();
  hide();
  try { assert.equal(await p.submitLogout(), 'done'); } finally { show(); }
  assert.deepEqual(await dbNames(), []);
  // Mismatch: the other reader's database is named from the record.
  await RF.db.setCurrentUser(2, { offlineEnabled: true, forceOffline: false });
  (await RF.db.open(2)).close();
  hide();
  try {
    const q = page({ userId: 1 });
    await q.ctl.ready;
  } finally { show(); }
  assert.deepEqual(await dbNames(), []);
});

test('deleting the account wipes the device before /login?deleted=1 is shown', async () => {
  const p = await enabledPage();
  await addOps(1, { pending: 1 });
  // Another boosted answer is left alone.
  const other = { xhr: { responseURL: 'https://readfine.test/settings/profile' }, shouldSwap: true };
  p.doc.dispatchEvent(new p.dom.window.CustomEvent('htmx:beforeSwap', { detail: other }));
  assert.equal(other.shouldSwap, true);
  // The delete form's redirect, followed by htmx.
  const detail = { xhr: { responseURL: 'https://readfine.test/login?deleted=1' }, shouldSwap: true };
  p.doc.dispatchEvent(new p.dom.window.CustomEvent('htmx:beforeSwap', { detail }));
  assert.equal(detail.shouldSwap, false);
  await until(() => p.navigations.length === 1);
  assert.deepEqual(p.navigations, ['/login?deleted=1']);
  assert.deepEqual(await dbNames(), []);
  assert.equal(p.ctl.state.enabled, false);
});

test('/login?deleted=1 wipes what the page did not (deleted-wipe.js), also without databases()', async () => {
  const vm = await import('node:vm');
  const fs = await import('node:fs');
  await RF.db.setCurrentUser(3, { offlineEnabled: true, forceOffline: false });
  (await RF.db.open(3)).close();
  await globalThis.caches.open('readfine-media-3');
  const factory = globalThis.indexedDB;
  factory.databases = undefined;
  try {
    vm.runInThisContext(fs.readFileSync(new URL('../../backend/app/static/js/offline/deleted-wipe.js', import.meta.url), 'utf8'));
    await RF.deletedWipe;
  } finally { delete factory.databases; }
  assert.deepEqual(await dbNames(), []);
  assert.deepEqual(await globalThis.caches.keys(), []);
});

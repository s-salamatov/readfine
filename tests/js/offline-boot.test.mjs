// Offline mode bootstrap (offline/boot.js): which pages load the full offline scripts.
//
// boot.js runs in a jsdom page as the browser runs it: parser-blocking, with its own
// <script> element as document.currentScript (faked: jsdom evaluates it outside the
// parser), document.write recorded, and scripts it appends "loaded" by evaluating the
// real file in that window. The store is fake-indexeddb, per test.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { loadOffline, STATIC_DIR } from './harness.mjs';

const RF = await loadOffline(); // the Node realm's copy, to seed the store

const FULL = ['/static/js/offline/db.js?v=1', '/static/js/offline/media.js?v=1', '/static/js/vendor/minisearch.js?v=1',
  '/static/js/offline/search.js?v=1', '/static/js/offline/sync.js?v=1', '/static/js/offline/templates.js?v=1',
  '/static/js/offline/overlay.js?v=1', '/static/js/offline/page.js?v=1'];
const BOOT = fs.readFileSync(path.join(STATIC_DIR, 'js', 'offline', 'boot.js'), 'utf8');

let factory;
let windows = [];
beforeEach(() => {
  factory = new IDBFactory();
  globalThis.indexedDB = factory;
});
afterEach(() => {
  // Stops page.js's timers with the window.
  windows.forEach((w) => {
    const ctl = w.RFOffline && w.RFOffline.page && w.RFOffline.page.current();
    if (ctl) ctl.stop();
    w.close();
  });
  windows = [];
});

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(cond) {
  for (let i = 0; i < 300 && !(await cond()); i++) await tick();
  assert.ok(await cond(), 'condition never became true');
}

// A page with boot.js. `user`: the signed-in reader (null on a signed-out page).
function bootPage({ user = 5, body = '', storage = {}, readyState = 'complete', databases = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body' + (user ? ' data-rf-user="' + user + '"' : '') + '>'
    + body + '</body></html>', { runScripts: 'outside-only', url: 'https://readfine.test/app' });
  const w = dom.window;
  windows.push(w);
  for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
  if (!databases) factory.databases = undefined;
  w.indexedDB = factory;
  const swCalls = [];
  Object.defineProperty(w.navigator, 'serviceWorker', { configurable: true, value: { controller: null } });
  w.RFOffline = { sw: {
    ensure: async (f) => { swCalls.push(['ensure', f]); return {}; },
    register: async (o) => { swCalls.push(['register', o.offline]); return {}; },
  } };
  const el = w.document.createElement('script');
  el.setAttribute('data-rf-db', FULL[0]);
  if (user) {
    el.setAttribute('data-rf-user', String(user));
    el.setAttribute('data-rf-scripts', FULL.join(' '));
  }
  Object.defineProperty(w.document, 'currentScript', { configurable: true, get: () => el });
  Object.defineProperty(w.document, 'readyState', { configurable: true, get: () => readyState });
  const written = [];
  w.document.write = (s) => written.push(s);
  // Appended scripts "load": the real file runs in this window, then onload.
  const appended = [];
  const head = w.document.head;
  const realAppend = head.appendChild.bind(head);
  head.appendChild = (node) => {
    if (node.tagName !== 'SCRIPT') return realAppend(node);
    const src = node.getAttribute('src');
    appended.push(src);
    setTimeout(() => {
      const file = path.join(STATIC_DIR, new URL(src, 'https://readfine.test').pathname.replace(/^\/static\//, ''));
      w.eval(fs.readFileSync(file, 'utf8'));
      node.onload();
    }, 0);
    return node;
  };
  const native = [];
  w.HTMLFormElement.prototype.submit = function () { native.push(this.getAttribute('action')); };
  w.eval(BOOT);
  return {
    w, written, appended, swCalls, native,
    parsed() { readyState = 'interactive'; w.document.dispatchEvent(new w.Event('DOMContentLoaded')); },
    submit(sel) {
      const ev = new w.Event('submit', { bubbles: true, cancelable: true });
      w.document.querySelector(sel).dispatchEvent(ev);
      return ev.defaultPrevented;
    },
  };
}

const srcsOf = (written) => [...written.join('').matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((m) => m[1]);

test('a reader with offline mode on here: the full set is written in, deferred, in order', () => {
  const p = bootPage({ storage: { 'rf-offline-user': '5' }, readyState: 'loading' });
  assert.deepEqual(srcsOf(p.written), FULL);
  assert.deepEqual(p.appended, []);
});

test('a logout or wipe still owed loads the full set too', () => {
  for (const k of ['rf-logout-pending', 'rf-wipe-pending']) {
    const p = bootPage({ storage: { [k]: '1' }, readyState: 'loading' });
    assert.deepEqual(srcsOf(p.written), FULL, k);
  }
});

test('nothing offline on this device: light page, plain worker made sure of, nothing loaded', async () => {
  // Another reader's hint does not count either.
  const p = bootPage({ storage: { 'rf-offline-user': '7' }, readyState: 'loading' });
  assert.deepEqual(p.written, []);
  p.parsed();
  await until(() => p.swCalls.length === 1);
  assert.deepEqual(p.swCalls, [['ensure', false]]);
  assert.deepEqual(p.appended, []);
  assert.equal(p.w.RFOffline.db, undefined);
});

test('a signed-out page writes nothing and probes nothing', async () => {
  const p = bootPage({ user: null, storage: { 'rf-offline-user': '5' }, readyState: 'loading' });
  p.parsed();
  await tick();
  assert.deepEqual(p.written, []);
  assert.deepEqual(p.swCalls, []);
  assert.deepEqual(p.appended, []);
});

test('offline data without the hint (another reader\'s, or cleared storage): the full set loads after the parse and takes over', async () => {
  // Reader 2's data and record are on the device; reader 5 signs in here.
  await RF.db.setCurrentUser(2, { offlineEnabled: true, forceOffline: false });
  (await RF.db.open(2)).close();
  const p = bootPage({ readyState: 'loading' });
  assert.deepEqual(p.written, []);
  p.parsed();
  await until(() => p.appended.length === FULL.length);
  assert.deepEqual(p.appended, FULL);
  await until(() => !!(p.w.RFOffline.page && p.w.RFOffline.page.current()));
  await p.w.RFOffline.page.current().ready;
  // page.js wiped reader 2's data before anything was shown.
  assert.deepEqual((await factory.databases()).map((d) => d.name), []);
});

test('without indexedDB.databases(): db.js is loaded to read the record', async () => {
  await RF.db.setCurrentUser(5, { offlineEnabled: true, forceOffline: false });
  const p = bootPage({ databases: false });
  try {
    await until(() => p.appended.length === FULL.length);
    assert.deepEqual(p.appended, FULL);
  } finally { delete factory.databases; }
});

test('light page logout: with nothing offline here, the plain POST /logout', async () => {
  const p = bootPage({ body: '<form method="POST" action="/logout" data-rf-logout><button>Logout</button></form>' });
  await until(() => p.swCalls.length === 1);
  assert.equal(p.submit('form'), true);
  await until(() => p.native.length === 1);
  assert.deepEqual(p.native, ['/logout']);
  assert.deepEqual(p.appended, []);
});

test('light page logout with offline data: the full set loads and wipes before logging out', async () => {
  const p = bootPage({ body: '<form method="POST" action="/logout" data-rf-logout><button>Logout</button></form>' });
  await until(() => p.swCalls.length === 1);
  // Data appears after the page's own probe (another tab switched on meanwhile).
  await RF.db.setCurrentUser(5, { offlineEnabled: false, forceOffline: false });
  (await RF.db.open(5)).close();
  assert.equal(p.submit('form'), true);
  await until(() => p.appended.length === FULL.length);
  await until(async () => (await factory.databases()).length === 0);
});

test('Preferences on a light page: the switch loads offline mode and hands the change over', async () => {
  const body = '<div data-rf-offline-settings><input type="checkbox" data-rf-offline-toggle>'
    + '<p data-rf-offline-note></p><button data-rf-offline-remove hidden></button></div>';
  const p = bootPage({ body });
  await until(() => p.swCalls.length === 1);
  p.w.RFOffline.boot.bindSettings(p.w.document);
  assert.deepEqual(p.appended, [], 'nothing loaded just for showing the switch');
  // jsdom has a navigator.serviceWorker stub here; page.js needs storage.persist too.
  const box = p.w.document.querySelector('[data-rf-offline-toggle]');
  box.checked = true;
  box.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await until(() => p.appended.length === FULL.length);
  await until(async () => {
    const cur = await RF.db.getCurrentUser().catch(() => null);
    return !!(cur && cur.userId === 5 && cur.offlineEnabled);
  });
  assert.equal(p.w.localStorage.getItem('rf-offline-user'), '5');
  await until(() => p.swCalls.some((c) => c[0] === 'register' && c[1] === true));
  p.w.RFOffline.page.current().stop();
});

test('db.js keeps the rf-offline-user hint next to the record; a wipe removes it', async () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    await RF.db.setCurrentUser(3, { offlineEnabled: true, forceOffline: false });
    assert.equal(store.get('rf-offline-user'), '3');
    await RF.db.setCurrentUser(3, { offlineEnabled: false, forceOffline: false });
    assert.equal(store.has('rf-offline-user'), false);
    await RF.db.setCurrentUser(3, { offlineEnabled: true, forceOffline: true });
    await RF.db.wipeAll();
    assert.equal(store.has('rf-offline-user'), false);
  } finally { delete globalThis.localStorage; }
});

test('this reader switched off with data kept: the page stays light; the logout loads it to wipe', async () => {
  await RF.db.setCurrentUser(5, { offlineEnabled: false, forceOffline: false });
  (await RF.db.open(5)).close();
  const p = bootPage({ body: '<form method="POST" action="/logout" data-rf-logout><button>Logout</button></form>' });
  await until(() => p.swCalls.length === 1);
  assert.deepEqual(p.swCalls, [['ensure', false]]);
  // Only db.js, to read the record.
  assert.deepEqual(p.appended, [FULL[0]]);
  assert.equal(p.submit('form'), true);
  await until(() => p.appended.length === FULL.length);
  await until(async () => (await factory.databases()).length === 0);
});

test('Preferences with data kept here: page.js binds the section (the Remove button)', async () => {
  await RF.db.setCurrentUser(5, { offlineEnabled: false, forceOffline: false });
  (await RF.db.open(5)).close();
  const body = '<div data-rf-offline-settings><input type="checkbox" data-rf-offline-toggle>'
    + '<p data-rf-offline-note></p><button data-rf-offline-remove hidden></button></div>';
  const p = bootPage({ body });
  p.w.RFOffline.boot.bindSettings(p.w.document);
  await until(() => p.appended.length === FULL.length);
  await until(() => p.w.document.querySelector('[data-rf-offline-remove]').hidden === false);
});

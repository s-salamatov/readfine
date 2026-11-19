import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import { fakeCaches } from './harness.mjs';

const META = 'readfine-meta';
const WIPE = 'readfine-meta-wipe';
const MIRROR = 'https://readfine.test/__rf/meta';
const CURRENT = 'readfine-offline-current';
const ON = { offlineEnabled: true, forceOffline: false };
const OFF = { offlineEnabled: false, forceOffline: false };
const FORCED = { ...ON, forceOffline: true };
const PENDING = { logoutPending: true, wipePending: true };
const STICKY = { uid: null, offlineEnabled: false, stale: true };
const dbSource = readFileSync(new URL('../../backend/app/static/js/offline/db.js', import.meta.url), 'utf8');

function lockQueue() {
  let tail = Promise.resolve();
  return {
    request(name, run) {
      assert.equal(name, 'readfine-mirror');
      const operation = tail.then(run);
      tail = operation.catch(() => {});
      return operation;
    },
  };
}

function context(idb, cs, locks, storage = new Map(), signedInUser) {
  const self = { indexedDB: idb, caches: cs, navigator: { locks }, location: new URL(MIRROR) };
  if (storage) {
    self.document = {};
    if (signedInUser !== undefined) {
      self.document.body = { getAttribute: (name) => name === 'data-rf-user' ? String(signedInUser) : null };
    }
    self.localStorage = {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    };
  }
  runInNewContext(dbSource, { self, URL, Response, setTimeout, clearTimeout });
  return self.RFOffline.db;
}

function device({ storage = new Map() } = {}) {
  const idb = new IDBFactory();
  const trace = [];
  const faults = { put: false, delete: false, mirrorReads: 0, recordOpens: 0, recordWrites: 0 };
  const cs = fakeCaches({
    putHook(url) {
      if (url !== MIRROR) return;
      trace.push(faults.put ? 'put failed' : 'mirror');
      if (faults.put) throw new Error('mirror put failed');
    },
  });
  cs.match = (url, { cacheName }) => {
    if (cacheName === META && faults.mirrorReads > 0) {
      faults.mirrorReads -= 1;
      throw new Error('mirror match failed');
    }
    return cs.stores.get(cacheName)?.match(url);
  };
  const remove = cs.delete.bind(cs);
  cs.delete = async (name) => {
    trace.push('delete ' + name);
    if (name === META && faults.delete) throw new Error('mirror delete failed');
    return remove(name);
  };
  const open = idb.open.bind(idb);
  idb.open = (name, ...args) => {
    if (name === CURRENT && faults.recordOpens > 0) {
      faults.recordOpens -= 1;
      trace.push('record open failed');
      throw new Error('current DB open failed');
    }
    const request = open(name, ...args);
    if (name === CURRENT) request.addEventListener('success', () => {
      const connection = request.result;
      const transaction = connection.transaction.bind(connection);
      connection.transaction = (store, mode) => {
        const tx = transaction(store, mode);
        if (mode === 'readwrite') {
          if (faults.recordWrites > 0) {
            faults.recordWrites -= 1;
            trace.push('record write failed');
            queueMicrotask(() => tx.abort());
          }
          tx.addEventListener('complete', () => trace.push('record'));
        }
        return tx;
      };
    });
    return request;
  };
  const removeDb = idb.deleteDatabase.bind(idb);
  idb.deleteDatabase = (name) => {
    trace.push(name);
    const request = removeDb(name);
    if (name === CURRENT) request.addEventListener('success', () => trace.push('record'));
    return request;
  };
  const locks = lockQueue();
  return { D: context(idb, cs, locks, storage), idb, cs, locks, trace, faults };
}

function row(userId, flags, stale = false) {
  return { userId, ...flags, ...(stale ? { stale } : {}) };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

async function assertSticky(D, cs) {
  const { state, value } = await D.readMirror(cs);
  assert.equal(state, 'ok');
  const { at, ...flags } = value;
  assert.deepEqual(flags, STICKY);
}

test('switching on writes the record before the mirror; switching off writes the mirror first', async () => {
  const { D, cs, idb, trace, faults } = device();
  await D.setCurrentUser(7, ON);
  assert.deepEqual(trace, ['record', 'mirror']);
  assert.deepEqual((await idb.databases()).map(({ name }) => name), [CURRENT]);
  const db = await D.open(7);
  try {
    trace.length = 0;
    await D.setCurrentUser(7, FORCED);
    assert.deepEqual(trace, ['record', 'mirror']);
    assert.deepEqual(await D.getMeta(db, D.META.offlineFlags), FORCED);
    assert.equal((await D.readMirror(cs)).value.forceOffline, true);
    trace.length = 0;
    await D.setCurrentUser(7, ON);
    assert.deepEqual(trace, ['mirror', 'record']);
    assert.deepEqual(await D.getMeta(db, D.META.offlineFlags), ON);
    assert.equal((await D.readMirror(cs)).value.forceOffline, false);
    trace.length = 0;
    await D.setCurrentUser(7, OFF);
    assert.deepEqual(trace, ['mirror', 'record']);
    assert.deepEqual(await D.getMeta(db, D.META.offlineFlags), OFF);
    const { state, value } = await D.readMirror(cs);
    assert.equal(state, 'ok');
    assert.equal(value.uid, 7);
    assert.equal(value.offlineEnabled, false);

    await D.setCurrentUser(7, ON);
    faults.put = true;
    await D.setCurrentUser(7, FORCED);
    assert.equal((await D.readMirror(cs)).state, 'missing');
    assert.deepEqual(plain(await D.getCurrentUser()), row(7, FORCED));
    faults.put = false;
    trace.length = 0;
    await D.setCurrentUser(7, ON);
    assert.deepEqual(trace, ['record']);
    assert.equal((await D.readMirror(cs)).state, 'missing');
    assert.deepEqual(plain(await D.getCurrentUser()), row(7, ON));
    assert.equal(await D.syncMirror(cs), true);
    assert.equal((await D.readMirror(cs)).value.forceOffline, false);

    await D.setCurrentUser(7, FORCED);
    await D.markMirror(cs, { stale: true });
    trace.length = 0;
    await D.setCurrentUser(7, ON);
    assert.deepEqual(trace, ['mirror', 'record']);
    const stale = (await D.readMirror(cs)).value;
    assert.equal(stale.stale, true);
    assert.equal(stale.forceOffline, false);
  } finally {
    db.close();
  }

  const transient = device();
  await transient.D.setCurrentUser(7, FORCED);
  transient.faults.mirrorReads = 1;
  transient.trace.length = 0;
  await transient.D.setCurrentUser(7, ON);
  assert.deepEqual(transient.trace, ['mirror', 'record']);
  await assertSticky(transient.D, transient.cs);
  assert.deepEqual(plain(await transient.D.getCurrentUser()), row(7, ON));
  await transient.D.syncMirror(transient.cs);
  await assertSticky(transient.D, transient.cs);

  for (const [uid, flags, first, grant] of [
    [7, OFF, 'mirror', 'offlineEnabled'],
    [7, ON, 'mirror', 'forceOffline'],
    [null, undefined, 'delete ' + META],
    [9, FORCED, 'delete ' + META],
  ]) {
    const { D, cs, trace, faults } = device();
    await D.setCurrentUser(7, FORCED);
    faults.recordOpens = Infinity;
    trace.length = 0;
    await assert.rejects(D.setCurrentUser(uid, flags), /current DB open failed/);
    assert.deepEqual(trace, [first, 'record open failed', 'record open failed']);
    const mirror = await D.readMirror(cs);
    if (grant) assert.equal(mirror.value[grant], false);
    else assert.equal(mirror.state, 'missing');
  }

  const failedDelete = device();
  await failedDelete.D.setCurrentUser(7, ON);
  Object.assign(failedDelete.faults, { delete: true, recordOpens: Infinity });
  failedDelete.trace.length = 0;
  await assert.rejects(failedDelete.D.setCurrentUser(null), /current DB open failed/);
  assert.deepEqual(failedDelete.trace, ['delete ' + META, 'mirror', 'record open failed', 'record open failed']);
  await assertSticky(failedDelete.D, failedDelete.cs);
});

test('a failed mirror write is deleted, or aborts the forget (d4m2)', async () => {
  const off = device();
  await off.D.setCurrentUser(7, OFF);
  const before = plain(await off.D.readMirror(off.cs));
  off.faults.put = true;
  off.trace.length = 0;
  await assert.rejects(off.D.markMirror(off.cs, PENDING), /mirror put failed/);
  assert.deepEqual(off.trace, ['put failed']);
  assert.deepEqual(plain(await off.D.readMirror(off.cs)), before);
  off.faults.put = false;
  assert.equal(await off.D.markMirror(off.cs, PENDING), 'written');
  assert.equal((await off.D.readMirror(off.cs)).value.wipePending, true);

  const { D, cs, trace, faults } = device();
  await D.setCurrentUser(7, ON);
  faults.put = true;
  faults.delete = true;
  trace.length = 0;
  assert.equal(await D.forgetCurrentUser(), false);
  assert.deepEqual(trace, ['put failed', 'delete ' + META]);
  assert.deepEqual(plain(await D.getCurrentUser()), row(7, ON));
  faults.delete = false;
  trace.length = 0;
  assert.equal(await D.forgetCurrentUser(), true);
  assert.deepEqual(trace, ['put failed', 'delete ' + META, 'record']);
  assert.deepEqual(plain(await D.getCurrentUser()), row(7, ON, true));
  assert.equal((await D.readMirror(cs)).state, 'missing');

  const serving = device();
  await serving.D.setCurrentUser(7, ON);
  serving.faults.put = true;
  assert.equal(await serving.D.markMirror(serving.cs, PENDING), 'deleted');
  assert.equal(await serving.cs.has(META), false);

  const stale = device();
  const staleMarker = { uid: 7, ...ON, stale: true };
  await (await stale.cs.open(META)).put(MIRROR, Response.json(staleMarker));
  stale.faults.put = true;
  await assert.rejects(stale.D.markMirror(stale.cs, { wipePending: true }), /mirror put failed/);
  assert.deepEqual(plain(await stale.D.readMirror(stale.cs)), { state: 'ok', value: staleMarker });

  for (const [recordOpens, recordWrites, result] of [[1, 0, true], [2, 0, false], [0, 1, true], [0, 2, false]]) {
    const { D, cs, trace, faults } = device();
    await D.setCurrentUser(7, ON);
    Object.assign(faults, { recordOpens, recordWrites });
    trace.length = 0;
    assert.equal(await D.forgetCurrentUser(), result);
    assert.deepEqual(trace, [
      'mirror', ...Array(recordOpens).fill('record open failed'),
      ...Array(recordWrites).fill('record write failed'), ...(result ? ['record'] : []),
    ]);
    assert.equal((await D.readMirror(cs)).value.stale, true);
    assert.deepEqual(plain(await D.getCurrentUser()), row(7, ON, result));
  }

  for (const fault of ['match', 'corrupt']) {
    const { D, cs, trace, faults } = device();
    await D.setCurrentUser(7, ON);
    if (fault === 'match') faults.mirrorReads = 1;
    else await (await cs.open(META)).put(MIRROR, new Response('corrupt'));
    trace.length = 0;
    assert.equal(await D.forgetCurrentUser(), true, fault);
    assert.deepEqual(trace, ['mirror', 'record'], fault);
    await assertSticky(D, cs);
    assert.deepEqual(plain(await D.getCurrentUser()), row(7, ON, true));
  }

  const blocked = device();
  await blocked.D.setCurrentUser(7, ON);
  Object.assign(blocked.faults, { mirrorReads: 1, put: true, delete: true, recordOpens: Infinity });
  blocked.trace.length = 0;
  assert.equal(await blocked.D.forgetCurrentUser(), false);
  assert.deepEqual(blocked.trace, ['put failed', 'delete ' + META]);
});

test('a mirror write that failed is retried by the next setCurrentUser (d4m1)', async () => {
  const storage = new Map();
  const { D, idb, cs, locks, faults, trace } = device({ storage });
  const worker = context(idb, cs, locks, null);
  faults.put = true;
  await D.setCurrentUser(7, ON);
  assert.deepEqual(plain(await D.getCurrentUser()), row(7, ON));
  assert.equal((await D.readMirror(cs)).state, 'missing');
  assert.deepEqual(trace, ['record', 'put failed']);
  faults.put = false;
  assert.equal(await worker.syncMirror(cs), false);
  for (const key of ['rf-wipe-pending', 'rf-logout-pending']) {
    storage.set(key, '1');
    assert.equal(await D.syncMirror(cs), false, key);
    assert.equal((await D.readMirror(cs)).state, 'missing', key);
    storage.delete(key);
  }

  trace.length = 0;
  await D.setCurrentUser(7, ON);
  assert.deepEqual(trace, ['record', 'mirror']);
  assert.equal((await D.readMirror(cs)).value.offlineEnabled, true);

  for (const key of ['rf-wipe-pending', 'rf-logout-pending']) {
    const storage = new Map();
    const { D, cs, trace } = device({ storage });
    await D.setCurrentUser(7, OFF);
    const off = plain(await D.readMirror(cs));
    storage.set(key, '1');
    trace.length = 0;
    await D.setCurrentUser(7, ON);
    await D.syncMirror(cs);
    assert.deepEqual(trace, ['record'], key);
    assert.deepEqual(plain(await D.readMirror(cs)), off, key);
    storage.delete(key);
    assert.equal(await D.syncMirror(cs), true);
    assert.equal((await D.readMirror(cs)).value.offlineEnabled, true);
  }

  // Without Web Locks an existing mirror can be demoted but cannot be restored.
  const unlocked = context(idb, cs, undefined);
  trace.length = 0;
  await unlocked.setCurrentUser(7, OFF);
  assert.deepEqual(trace, ['delete ' + META, 'record']);
  await unlocked.setCurrentUser(7, ON);
  assert.equal(await unlocked.syncMirror(cs), false);
  assert.equal((await D.readMirror(cs)).state, 'missing');

  await D.setCurrentUser(7, ON);
  const serving = plain(await D.readMirror(cs));
  const inaccessible = context(undefined, cs, locks, null);
  trace.length = 0;
  assert.equal(await inaccessible.syncMirror(cs), false);
  assert.deepEqual(plain(await D.readMirror(cs)), serving);
  assert.deepEqual(trace, []);

  await new Promise((resolve, reject) => {
    const request = idb.open(CURRENT);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const connection = request.result;
      const tx = connection.transaction('current', 'readwrite');
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
      tx.objectStore('current').put({ k: 'current', userId: 'invalid' });
      connection.close();
    };
  });
  trace.length = 0;
  assert.equal(await worker.syncMirror(cs), false);
  assert.deepEqual(plain(await D.readMirror(cs)), serving);
  assert.deepEqual(trace, []);
  await new Promise((resolve, reject) => {
    const request = idb.deleteDatabase(CURRENT);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
  trace.length = 0;
  assert.equal(await worker.syncMirror(cs), false);
  assert.deepEqual(plain(await D.readMirror(cs)), serving);
  assert.deepEqual(trace, []);

  await D.setCurrentUser(9, ON);
  await (await cs.open(META)).put(MIRROR, Response.json(serving.value));
  assert.equal(await worker.syncMirror(cs), false);
  assert.equal((await D.readMirror(cs)).state, 'missing');
});

test('wipe order: mirror pending, caches, user databases, current last', async () => {
  const { D, idb, cs, locks, trace } = device();
  const worker = context(idb, cs, locks, null);
  await D.setCurrentUser(7, ON);
  (await D.open(7)).close();
  for (const name of ['readfine-media-7', 'readfine-shell-v1', 'readfine-pages-7', 'unrelated']) await cs.open(name);
  const cache = cs.stores.get(META);
  const put = cache.put.bind(cache);
  let failNextPut = true;
  cache.put = async (key, response) => {
    assert.equal((await response.clone().json()).wipePending, true);
    if (failNextPut) {
      failNextPut = false;
      throw new Error('wipe marker put failed');
    }
    await put(key, response);
  };
  const names = [D.dbName(8), CURRENT, D.dbName(7)];
  const before = plain(await D.readMirror(cs));
  const cacheNames = await cs.keys();
  const databases = await idb.databases();
  trace.length = 0;
  await assert.rejects(D.wipeAll({ names }), /wipe marker put failed/);
  assert.deepEqual(trace, []);
  assert.deepEqual(await cs.keys(), cacheNames);
  assert.deepEqual(await idb.databases(), databases);
  assert.deepEqual(plain(await D.readMirror(cs)), before);

  const results = await Promise.all([D.wipeAll(), worker.syncMirror(cs), worker.markMirror(cs, PENDING)]);
  assert.deepEqual(results, [undefined, false, 'deleted']);
  assert.equal(trace.pop(), 'delete ' + META); // markMirror's fallback after the wipe releases the lock
  assert.deepEqual(trace, [
    'mirror', 'delete readfine-media-7', 'delete readfine-shell-v1', 'delete readfine-pages-7',
    'readfine-offline-7', CURRENT, 'record', 'delete ' + META,
  ]);
  assert.deepEqual(await cs.keys(), ['unrelated']);
  assert.deepEqual(await idb.databases(), []);

  const inaccessible = device();
  await inaccessible.D.setCurrentUser(7, ON);
  (await inaccessible.D.open(7)).close();
  await inaccessible.cs.open('readfine-pages-7');
  inaccessible.faults.recordOpens = Infinity;
  inaccessible.trace.length = 0;
  await inaccessible.D.wipeAll();
  assert.deepEqual(inaccessible.trace, [
    'mirror', 'delete readfine-pages-7', 'readfine-offline-7', CURRENT, 'record', 'delete ' + META,
  ]);
  assert.deepEqual(await inaccessible.idb.databases(), []);
  assert.deepEqual(await inaccessible.cs.keys(), []);

  for (const method of ['has', 'delete']) {
    const auxiliary = device();
    await auxiliary.D.setCurrentUser(7, ON);
    (await auxiliary.D.open(7)).close();
    await auxiliary.cs.open('readfine-pages-7');
    await auxiliary.cs.open(WIPE);
    const operation = auxiliary.cs[method].bind(auxiliary.cs);
    let attempts = 0;
    auxiliary.cs[method] = async (name) => {
      if (name !== WIPE) return operation(name);
      attempts += 1;
      throw new Error('wipe marker cleanup failed');
    };
    await auxiliary.D.wipeAll();
    assert.equal(attempts, 1, method);
    assert.deepEqual(await auxiliary.idb.databases(), [], method);
    assert.deepEqual(await auxiliary.cs.keys(), [WIPE], method);
  }

  const failing = device();
  await failing.D.setCurrentUser(7, ON);
  await failing.cs.open('readfine-pages-7');
  const remove = failing.cs.delete.bind(failing.cs);
  failing.cs.delete = async (name) => {
    if (name === 'readfine-pages-7') throw new Error('page cache delete failed');
    return remove(name);
  };
  await assert.rejects(failing.D.wipeAll(), /page cache delete failed/);
  assert.deepEqual(plain(await failing.D.getCurrentUser()), row(7, ON));
  assert.equal((await failing.D.readMirror(failing.cs)).value.wipePending, true);

  failing.faults.mirrorReads = 1;
  await assert.rejects(failing.D.wipeAll(), /page cache delete failed/);
  const { at, ...marker } = (await failing.D.readMirror(failing.cs)).value;
  assert.deepEqual(marker, { ...STICKY, wipePending: true });
});

test('readMirror: corrupt body reads as unreadable', async () => {
  const { D, cs, idb, locks } = device();
  assert.deepEqual(plain(await D.readMirror(cs)), { state: 'missing', value: null });
  assert.equal(await cs.has(META), false);
  await D.setCurrentUser(7, ON);
  await D.forgetCurrentUser();
  const cache = await cs.open(META);
  for (const body of ['not json', '{"offlineEnabled":true}', '{"uid":"7","offlineEnabled":true}']) {
    await cache.put(MIRROR, new Response(body));
    assert.deepEqual(plain(await D.readMirror(cs)), { state: 'unreadable', value: null });
  }
  const signedIn = context(idb, cs, locks, new Map(), 7);
  await signedIn.setCurrentUser(7, FORCED);
  await assertSticky(D, cs);

  const pendingDevice = device();
  await pendingDevice.D.setCurrentUser(7, ON);
  assert.equal(await pendingDevice.D.markMirror(pendingDevice.cs, PENDING), 'written');
  const pending = plain(await pendingDevice.D.readMirror(pendingDevice.cs));
  assert.equal(pending.value.wipePending, true);
  const match = pendingDevice.cs.match;
  pendingDevice.cs.match = async (url, opts) => {
    if (opts.cacheName === META) {
      pendingDevice.cs.match = match;
      throw new Error('mirror match failed');
    }
    return match(url, opts);
  };
  assert.equal(await pendingDevice.D.syncMirror(pendingDevice.cs), false);
  assert.deepEqual(plain(await pendingDevice.D.readMirror(pendingDevice.cs)), pending);

  const record = { userId: 7 };
  const mirror = { uid: 9, offlineEnabled: true };
  assert.equal(D.currentUid({ record, recordState: 'ok', mirror, mirrorState: 'ok' }), null);
  assert.equal(D.currentUid({ recordState: 'unreadable', mirror, mirrorState: 'ok' }), 9);
  assert.equal(D.currentUid({ recordState: 'missing', mirrorState: 'missing' }), null);
  assert.equal(D.currentUid({ record }), 7);
  assert.equal(D.shellUser('<html data-rf-user="9"><script>const x = \'<body data-rf-user=9>\';</script><body title="a > b" data-rf-user=7>'), 7);
  assert.equal(D.shellUser('<html data-rf-user="9"><!-- <body data-rf-user=9> --><body title=\'data-rf-user="9"\'>'), null);

  const own = await cs.open('readfine-pages-7');
  await cs.open('readfine-pages-9');
  await cs.open('readfine-shell-v1');
  assert.deepEqual(plain(await D.cleanupCaches(cs, null)), []);
  assert.deepEqual(plain(await D.cleanupCaches(cs, 7)), ['readfine-pages-9']);
  await own.put('/app', new Response('<body data-rf-user="7">'));
  assert.deepEqual(plain(await D.cleanupCaches(cs, 7)), ['readfine-shell-v1']);
  assert.deepEqual(await cs.keys(), [META, 'readfine-pages-7']);

  await cs.open('unrelated');
  await D.deleteCaches(cs);
  assert.deepEqual(await cs.keys(), ['unrelated']);
});

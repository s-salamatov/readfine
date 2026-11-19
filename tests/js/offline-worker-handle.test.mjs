import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedWorkerDb, worker } from './harness.mjs';

const record = { userId: 1, offlineEnabled: true, forceOffline: true };
const articles = () => new Request('https://readfine.test/htmx/articles');

async function setup(current) {
  const w = worker({
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
  });
  let queue = Promise.resolve();
  w.ctx.navigator = {
    locks: {
      request(name, callback) {
        assert.equal(name, 'readfine-mirror');
        const task = queue.then(callback);
        queue = task.catch(() => {});
        return task;
      },
    },
  };
  (await seedWorkerDb(w)).close();
  if (current) w.ctx.RFOffline.db.getCurrentUser = async () => ({ ...current });
  return w;
}

function post(w, type) {
  const waits = [];
  for (const listener of w.listeners.message) {
    listener({ data: { type }, waitUntil: (promise) => waits.push(promise) });
  }
  return Promise.all(waits);
}

// Gate entry to the real router, so its first IndexedDB operation runs after the message.
function pauseRoutes(w, count = 1) {
  const router = w.ctx.RFOffline.router;
  const handle = router.handle;
  const gates = Array.from({ length: count }, () => ({
    entered: Promise.withResolvers(),
    resume: Promise.withResolvers(),
  }));
  router.handle = async (request, db) => {
    const gate = gates.shift();
    gate.entered.resolve(db);
    if (await gate.resume.promise === false) return null;
    return handle(request, db);
  };
  return gates.slice();
}

async function assertRows(response) {
  const res = await response;
  assert.equal(res.status, 200);
  assert.match(await res.text(), /id="article-row-1"/);
}

test('an unchanged rf-current-user leaves the active handle open', { timeout: 1000 }, async () => {
  const w = await setup(record);
  const [first, second, third] = pauseRoutes(w, 3);
  const responses = [w.dispatch(articles()), w.dispatch(articles())];
  const [a, b] = await Promise.all([first.entered.promise, second.entered.promise]);

  await post(w, 'rf-current-user');
  first.resume.resolve();
  second.resume.resolve();
  await Promise.all(responses.map(assertRows));
  assert.equal(a, b, 'concurrent requests use one connection');
  assert.equal(a.closed, false);

  // Reproduce the old startup race after acquisition, before the router's first read.
  const failed = w.dispatch(articles());
  (await third.entered.promise).close();
  third.resume.resolve();
  assert.match(await (await failed).text(), /Needs a connection/);

  const diag = await w.message({ type: 'rf-diag' });
  assert.equal(diag.routeErrorCount, 1);
  assert.equal(diag.routeErrors.length, 1);
  const [error] = diag.routeErrors;
  assert.equal(error.kind, 'htmx');
  assert.equal(error.name, 'InvalidStateError');
  assert.match(error.message, /connection|state/i);
  assert.equal(error.row, null);
  assert.ok(diag.startedAt > 0 && error.at >= diag.startedAt);

  const pages = await w.cacheStorage.open('readfine-pages-1');
  await pages.put('/app', new Response('<body data-rf-user="1">Reader shell</body>'));
  w.ctx.RFOffline.router.shell = async () => {
    throw new DOMException('Secret title https://readfine.test/app?secret=1', 'SecurityError');
  };
  for (let i = 0; i < 10; i++) {
    const response = await w.dispatch({ url: 'https://readfine.test/app', method: 'GET', mode: 'navigate' });
    assert.equal(response.status, 503);
  }
  const later = await w.message({ type: 'rf-diag' });
  assert.equal(later.startedAt, diag.startedAt);
  assert.equal(later.routeErrorCount, 11);
  assert.equal(later.routeErrors.length, 10);
  for (const { kind, row, name, message } of later.routeErrors) {
    assert.equal(kind, 'navigate');
    assert.equal(row, 'R1');
    assert.equal(name, 'SecurityError');
    assert.ok(message.length <= 200);
    assert.doesNotMatch(message, /Secret title|https:|secret=1/);
  }
});

test('a changed record retires the old handle after its last request finishes', { timeout: 1000 }, async () => {
  const w = await setup({ ...record });
  const [first, second, later] = pauseRoutes(w, 3);
  const a = w.dispatch(articles());
  const old = await first.entered.promise;
  const b = w.dispatch(articles());
  assert.equal(await second.entered.promise, old);

  w.ctx.RFOffline.db.getCurrentUser = async () => ({ ...record, forceOffline: false });
  await post(w, 'rf-current-user');
  const c = w.dispatch(articles());
  const replacement = await later.entered.promise;
  assert.notEqual(replacement, old);

  first.resume.resolve();
  await assertRows(a);
  assert.equal(old.closed, false);
  second.resume.resolve();
  await assertRows(b);
  assert.equal(old.closed, true);
  later.resume.resolve();
  await assertRows(c);
  assert.equal(replacement.closed, false);
});

test('forget, versionchange and wipe close retired handles while requests are pending', { timeout: 1000 }, async () => {
  for (const invalidate of ['forget', 'versionchange', 'wipeAll']) {
    const w = await setup();
    const D = w.ctx.RFOffline.db;
    await D.setCurrentUser(1, record);
    const [gate] = pauseRoutes(w);
    const response = w.dispatch(articles());
    const old = await gate.entered.promise;
    try {
      await D.setCurrentUser(1, { ...record, forceOffline: false });
      await post(w, 'rf-current-user');
      assert.equal(old.closed, false, 'the retired lease is still held');

      if (invalidate === 'forget') {
        const wait = post(w, 'rf-forget-user');
        assert.equal(old.closed, true, 'forget closes within message dispatch');
        await wait;
      } else if (invalidate === 'versionchange') {
        // Delete from another connection, as a wipe in another context does.
        await new Promise((resolve, reject) => {
          const deletion = w.ctx.indexedDB.deleteDatabase(old.name);
          deletion.onsuccess = resolve;
          deletion.onerror = () => reject(deletion.error);
        });
      } else {
        const wiping = D.wipeAll({ blockedMs: 100 });
        const refresh = post(w, 'rf-current-user');
        await Promise.all([wiping, refresh]);
      }
      assert.equal(old.closed, true, invalidate);
    } finally {
      gate.resume.resolve(false);
      await response;
    }
  }
});

test('rf-current-user retries a readable mirror and leaves a deleted mirror missing', async () => {
  const w = await setup();
  const D = w.ctx.RFOffline.db;
  await D.setCurrentUser(1, record);
  await post(w, 'rf-current-user');
  const mirror = await w.cacheStorage.open('readfine-meta');
  await mirror.put('/__rf/meta', Response.json({ uid: 1, offlineEnabled: true, forceOffline: false }));

  await post(w, 'rf-current-user');
  assert.equal((await D.readMirror(w.cacheStorage)).value.forceOffline, true);

  await w.cacheStorage.delete('readfine-meta');
  await post(w, 'rf-current-user');
  assert.equal((await D.readMirror(w.cacheStorage)).state, 'missing');
  assert.equal(await w.cacheStorage.has('readfine-meta'), false);
});

test('forget during a database open prevents a stale request from reaching the router', { timeout: 1000 }, async () => {
  const w = await setup(record);
  const D = w.ctx.RFOffline.db;
  const open = D.openExisting;
  const opened = Promise.withResolvers();
  const resume = Promise.withResolvers();
  D.openExisting = async (userId) => {
    const db = await open(userId);
    opened.resolve(db);
    await resume.promise;
    return db;
  };

  const response = w.dispatch(articles());
  const db = await opened.promise;
  await post(w, 'rf-forget-user');
  resume.resolve();
  assert.match(await (await response).text(), /Needs a connection/);
  assert.deepEqual(w.calls, []);
  assert.equal(db.closed, true);
});

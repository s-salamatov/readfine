import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedWorkerDb, worker } from './harness.mjs';

const origin = 'https://readfine.test';
const shell = '<body data-rf-user="1">Reader shell</body>';
const on = { userId: 1, offlineEnabled: true };
const offline = async () => { throw new TypeError('Failed to fetch'); };
const nav = (path = '/app') => ({ url: origin + path, method: 'GET', mode: 'navigate' });
const asset = () => new Request(origin + '/static/css/tailwind.css?v=abc');

async function storePages(w, path = '/app') {
  const cache = await w.cacheStorage.open('readfine-pages-1');
  await cache.put(path, new Response(shell));
  await cache.put('/static/css/tailwind.css', new Response('offline CSS'));
}

async function storeMirror(w) {
  w.ctx.navigator = { locks: { request: (_name, fn) => fn() } };
  const cache = await w.cacheStorage.open('readfine-meta');
  await cache.put('/__rf/meta', Response.json({ uid: 1, offlineEnabled: true }));
}

function unreadableWorker() {
  const w = worker({ fetchImpl: offline });
  let reads = 0;
  w.userReads = () => reads;
  w.ctx.RFOffline.db.getCurrentUser = async () => {
    reads++;
    throw new Error('IndexedDB unavailable');
  };
  return w;
}

test('an unreadable record uses the mirror and is retried on the next navigation', async () => {
  for (const firstPath of ['/app', '/htmx/sidebar', '/static/css/tailwind.css', '/m/sig/1/abc']) {
    const w = unreadableWorker();
    await storeMirror(w);
    await storePages(w);
    const db = await seedWorkerDb(w);
    db.close();
    const media = await w.cacheStorage.open('readfine-media-1');
    await media.put('/m-cache/abc', new Response('offline image'));

    const sidebar = async () => {
      const res = await w.dispatch(new Request(origin + '/htmx/sidebar'));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('X-Readfine-Offline'), '1');
    };
    const staticAsset = async () => {
      const res = await w.dispatch(asset());
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'offline CSS');
    };
    if (firstPath === '/htmx/sidebar') await sidebar();
    if (firstPath === '/static/css/tailwind.css') await staticAsset();
    if (firstPath === '/m/sig/1/abc') {
      assert.equal(await (await w.dispatch(new Request(origin + firstPath))).text(), 'offline image');
    }

    const first = await w.dispatch(nav());
    assert.equal(first.status, 200);
    assert.equal(await first.text(), shell);
    const previousReads = w.userReads();
    assert.equal(await (await w.dispatch(nav())).text(), shell);
    assert.ok(w.userReads() > previousReads);
    await sidebar();
    await staticAsset();
    if (firstPath === '/app') {
      const mirror = await w.cacheStorage.open('readfine-meta');
      await mirror.put('/__rf/meta', Response.json({ uid: 1, offlineEnabled: true, logoutPending: true }));
      await assert.rejects(w.dispatch(new Request(origin + '/htmx/sidebar')), /Failed to fetch/);
      assert.equal((await w.dispatch(nav())).status, 503);
    }
  }
});

test('the step-aside navigation answers with the offline page after preload or network failure', async () => {
  const w = worker({ current: { ...on, offlineEnabled: false }, fetchImpl: offline });
  await w.ctx.RFOffline.policy.reload();
  for (const extra of [{ preloadResponse: Promise.reject(new Error('preload failed')) }, {}]) {
    const res = await w.dispatch(nav(), extra);
    assert.equal(res?.status, 503);
    assert.match(await res.text(), /Needs a connection/);
  }
});

test('query string on /app still gets the shell', async () => {
  const w = worker({ current: on, fetchImpl: offline });
  await storePages(w, '/app?cached=1');
  for (const path of ['/app?open_article_id=5', '/app?utm_source=x']) {
    assert.equal(await (await w.dispatch(nav(path))).text(), shell);
  }
  // The entry changes after gather inspects it, before the worker fetches the response.
  let matches = 0;
  w.cacheStorage.match = async (url, { cacheName, ...options }) => {
    if (cacheName === 'readfine-pages-1' && ++matches === 2) {
      return new Response('<body data-rf-user="2">Another reader</body>');
    }
    return w.cacheStorage.stores.get(cacheName)?.match(url, options);
  };
  assert.equal((await w.dispatch(nav('/app?open_article_id=5'))).status, 503);
});

test('activation with IndexedDB unreadable cleans caches only when the mirror names a reader', async () => {
  for (const hasMirror of [true, false]) {
    const w = unreadableWorker();
    if (hasMirror) await storeMirror(w);
    await storePages(w);
    await w.cacheStorage.open('readfine-pages-2');
    await w.cacheStorage.open('readfine-shell-2');
    await w.activate();
    const expected = hasMirror ? ['readfine-meta', 'readfine-pages-1']
      : ['readfine-pages-1', 'readfine-pages-2', 'readfine-shell-2'];
    assert.deepEqual((await w.cacheStorage.keys()).sort(), expected);
  }
});

test('rf-test-launch replies with the launch row without fetching', async () => {
  let fetches = 0;
  const w = worker({ current: on, fetchImpl: async () => { fetches++; return new Response('online'); } });
  await storePages(w);
  assert.deepEqual(await w.message({ type: 'rf-test-launch' }), {
    row: 'R1', answer: 'shell', cache: 'readfine-pages-1',
    pages: ['readfine-pages-1'], legacy: [], recordState: 'ok', mirrorState: 'missing',
  });
  assert.equal(fetches, 0);
});

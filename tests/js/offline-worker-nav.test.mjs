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
    const html = await res.text();
    assert.match(html, /Needs a connection/);
    assert.match(html, /<a href="\/__rf\/diagnostics">Why is this offline\? Diagnostics<\/a>/);
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

test('offline diagnostics report local state without worker fetches, using preload, or exposing content', { timeout: 5000 }, async () => {
  let fetches = 0;
  const w = worker({
    script: '/sw.js?offline=1&token=private-worker-token',
    fetchImpl: async () => { fetches++; return offline(); },
  });
  w.ctx.navigator = {
    locks: { request: async (_name, fn) => fn() },
    storage: { persisted: async () => true },
  };
  w.cacheStorage.match = async (url, { cacheName, ...options }) =>
    w.cacheStorage.stores.get(cacheName)?.match(url, options);
  await w.ctx.RFOffline.db.setCurrentUser(1, { offlineEnabled: true });
  await storePages(w);
  await w.activate();
  const ready = await w.dispatch(nav('/__rf/diagnostics'), { preloadResponse: new Promise(() => {}) });
  assert.equal(ready.status, 200);
  assert.match((await ready.text()).replaceAll('&quot;', '"'), /decision: .*"row":"R1".*"answer":"shell"/);

  const wipe = await w.cacheStorage.open('readfine-meta-wipe');
  await wipe.put('/__rf/meta', Response.json({ uid: 1, wipePending: true, token: 'private-mirror-token' }));
  await w.cacheStorage.open('https://readfine.test/app?token=private-cache-token');
  const res = await w.dispatch(nav('/__rf/diagnostics?token=private-navigation-token'), {
    preloadResponse: Promise.resolve(new Response('Browser preload', { status: 404 })),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('X-Readfine-Offline'), '1');
  assert.equal(res.headers.get('Content-Security-Policy'), "default-src 'none'");
  const html = await res.text();
  assert.match(html, /<textarea\b[^>]*\breadonly\b/);
  assert.match(html, /href="\/app"/);
  assert.doesNotMatch(html, /<script\b|\son\w+=|Reader shell|private-\w+-token/);
  const report = html.replaceAll('&quot;', '"');
  assert.match(report, /decision: .*"row":"R2".*"answer":"offline"/);
  assert.match(report, /recordState: ok/);
  assert.match(report, /mirror: .*"wipePending":true/);
  assert.match(report, /caches: .*readfine-meta-wipe/);
  assert.match(report, /pages: .*"name":"readfine-pages-1","hasApp":true,"data-rf-user":1/);
  assert.match(report, /routeErrors: \[\]/);
  assert.match(report, /routeErrorCount: 0/);
  assert.match(report, /startedAt: \d+/);
  assert.match(report, /scriptsLoaded: true/);
  assert.match(report, /workerScriptURL: \/sw\.js\s/);
  assert.match(report, /webLocks: true/);
  assert.match(report, /persisted: true/);

  w.cacheStorage.keys = async () => { throw new DOMException('private-cache-token', 'SecurityError'); };
  w.ctx.navigator.storage.persisted = async () => { throw new Error('private-storage-token'); };
  const degraded = await w.dispatch(nav('/__rf/diagnostics'), {
    preloadResponse: Promise.reject(new Error('Browser preload failed')),
  });
  assert.equal(degraded.status, 200);
  const degradedReport = (await degraded.text()).replaceAll('&quot;', '"');
  assert.match(degradedReport, /caches: .*"error":"SecurityError"/);
  assert.match(degradedReport, /pages: .*"error":"SecurityError"/);
  assert.match(degradedReport, /persisted: .*"error":"Error"/);
  assert.match(degradedReport, /recordState: ok/);
  assert.doesNotMatch(degradedReport, /private-\w+-token/);
  assert.equal(fetches, 0, 'diagnostics must not call worker fetch()');
});

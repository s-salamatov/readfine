// Offline media downloader (offline/media.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadOffline, fakeCaches } from './harness.mjs';

const RF = await loadOffline();

function quotaError() {
  const e = new Error('quota');
  e.name = 'QuotaExceededError';
  return e;
}

function imageFetch(sizes = {}, log = []) {
  return async (url) => {
    log.push(url);
    const n = sizes[url] ?? 100;
    return new Response(new Uint8Array(n), { headers: { 'content-type': 'image/jpeg' } });
  };
}

test('cacheKey uses the b64url of signed links and the path otherwise', () => {
  assert.equal(RF.media.cacheKey('/m/sig/1700000000/aHR0cHM6Ly94'), '/m-cache/aHR0cHM6Ly94');
  assert.equal(RF.media.cacheKey('https://readfine.test/m/other/1/aHR0cHM6Ly94'), '/m-cache/aHR0cHM6Ly94');
  assert.equal(RF.media.cacheKey('/img/video-thumb/abc.jpg?w=1'), '/img/video-thumb/abc.jpg?w=1');
  assert.equal(RF.media.cacheName(5), 'readfine-media-5');
});

test('test_media_download_stops_on_quota_error', async () => {
  const caches = fakeCaches({ putHook: (url, res, n) => { if (n === 3) throw quotaError(); } });
  const cache = await caches.open('readfine-media-1');
  const urls = ['/m/a/1/A1', '/m/a/1/A2', '/m/a/1/A3', '/m/a/1/A4', '/m/a/1/A5', '/m/a/1/A6'];
  const log = [];
  const res = await RF.media.downloadQueue(urls, { cache, fetchFn: imageFetch({}, log) });
  assert.equal(res.stoppedReason, 'quota');
  assert.equal(res.stored, 2);
  assert.deepEqual(Object.keys(res.entries), ['/m-cache/A1', '/m-cache/A2']);
  assert.equal(cache.entries.size, 2);
  assert.ok(log.length < urls.length, 'no new downloads start after the quota error');
});

test('downloads newest first (the order given), four at a time', async () => {
  const caches = fakeCaches();
  const cache = await caches.open('readfine-media-1');
  let inFlight = 0;
  let peak = 0;
  const started = [];
  const fetchFn = async (url) => {
    started.push(url);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return new Response(new Uint8Array(1));
  };
  const urls = Array.from({ length: 10 }, (_, i) => '/m/s/1/U' + i);
  const res = await RF.media.downloadQueue(urls, { cache, fetchFn });
  assert.equal(res.stored, 10);
  assert.equal(res.stoppedReason, null);
  assert.equal(peak, 4);
  assert.deepEqual(started, urls);
});

test('budget stops the queue; usedBytes counts what is already stored', async () => {
  const caches = fakeCaches();
  const cache = await caches.open('readfine-media-1');
  const urls = ['/m/s/1/A', '/m/s/1/B', '/m/s/1/C'];
  const res = await RF.media.downloadQueue(urls, {
    cache, fetchFn: imageFetch(), budgetBytes: 450, usedBytes: 250,
  });
  assert.equal(res.stored, 2);
  assert.equal(res.stoppedReason, 'budget');
  assert.equal(res.bytes, 200);
});

test('known keys, duplicates, oversize and failed answers are skipped', async () => {
  const caches = fakeCaches();
  const cache = await caches.open('readfine-media-1');
  const log = [];
  const sizes = { '/m/s/1/BIG': 11 * 1024 * 1024 };
  const base = imageFetch(sizes, log);
  const fetchFn = async (url) => (url.includes('GONE') ? (log.push(url), new Response('', { status: 403 })) : base(url));
  const res = await RF.media.downloadQueue(
    ['/m/s/1/HAVE', '/m/s/1/NEW', '/m/t/2/NEW', '/m/s/1/BIG', '/m/s/1/GONE'],
    { cache, fetchFn, known: new Set(['/m-cache/HAVE']) },
  );
  assert.equal(res.stored, 1);
  assert.equal(res.skipped, 3);
  assert.ok(!log.includes('/m/s/1/HAVE'));
  assert.equal(log.filter((u) => u.endsWith('/NEW')).length, 1);
});

test('a network failure stops the queue', async () => {
  const caches = fakeCaches();
  const cache = await caches.open('readfine-media-1');
  const res = await RF.media.downloadQueue(['/m/s/1/A'], {
    cache, fetchFn: async () => { throw new TypeError('Failed to fetch'); },
  });
  assert.equal(res.stoppedReason, 'network');
  assert.equal(res.stored, 0);
});

test('image downloads bypass the HTTP cache (cache: no-store) and send credentials', async () => {
  const caches = fakeCaches();
  const cache = await caches.open('readfine-media-1');
  const inits = [];
  const fetchFn = async (url, init) => { inits.push(init); return new Response(new Uint8Array(1)); };
  await RF.media.downloadQueue(['/m/s/1/N1', '/img/video-thumb/x.jpg'], { cache, fetchFn });
  assert.equal(inits.length, 2);
  for (const init of inits) {
    assert.equal(init.cache, 'no-store');
    assert.equal(init.credentials, 'include');
  }
});

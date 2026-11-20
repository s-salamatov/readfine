import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { seedWorkerDb, worker } from './harness.mjs';

const origin = 'https://readfine.test';
const shell = '<body data-rf-user="1">Reader shell</body>';
const on = { userId: 1, offlineEnabled: true };
const offline = async () => { throw new TypeError('Failed to fetch'); };
const nav = (path = '/app?rf_launch=bypass') => ({
  url: origin + path, method: 'GET', mode: 'navigate', destination: 'document',
});
const css = '/static/css/tailwind.css';
const asset = (query = '?v=abc') => new Request(origin + css + query);

async function storePages(w, path = '/app') {
  const cache = await w.cacheStorage.open('readfine-pages-1');
  await cache.put(path, new Response(shell));
  await cache.put(css, new Response('offline CSS'));
  await cache.put(css + '?v=abc', new Response('offline CSS'));
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
  const { launchTimings } = await w.message({ type: 'rf-diag' });
  assert.deepEqual(launchTimings.map(({ networkOutcome, result }) => [networkOutcome, result]), [
    ['error', 'offline-page'], ['error', 'offline-page'],
  ]);
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

test('launch timings distinguish the cold user read from static cache fallback', async () => {
  const fetches = [];
  const w = worker({ current: on, fetchImpl: async (request) => {
    fetches.push(request.url);
    return request.url.endsWith('?v=miss') ? new Response('network CSS') : offline();
  } });
  await storePages(w);
  let reads = 0;
  w.ctx.RFOffline.db.getCurrentUser = async () => {
    if (++reads === 1) await new Promise((resolve) => setTimeout(resolve, 55));
    return on;
  };
  assert.equal(await (await w.dispatch(nav('/app?token=private-launch-token'))).text(), shell);
  assert.equal(await (await w.dispatch(asset(''))).text(), 'offline CSS');
  const { launchTimings, workerStartedAt, startedAt } = await w.message({ type: 'rf-diag' });
  assert.equal(workerStartedAt, startedAt);
  assert.equal(launchTimings.length, 2);
  const [navigation, staticAsset] = launchTimings;
  for (const entry of launchTimings) {
    assert.equal(entry.networkOutcome, 'error');
    assert.ok(entry.sinceWorkerStartMs >= 0);
    assert.ok(entry.networkMs >= 0);
    assert.ok(entry.totalMs >= entry.loadCurrentMs + entry.networkMs + entry.gatherMs);
  }
  assert.equal(navigation.path, '/app');
  assert.equal(navigation.kind, 'navigate');
  assert.equal(navigation.currentLoaded, false);
  assert.ok(navigation.loadCurrentMs >= 50);
  assert.ok(navigation.gatherMs >= 0);
  assert.equal(navigation.row, 'R1');
  assert.equal(navigation.result, 'shell');
  assert.equal(staticAsset.path, '/static/css/tailwind.css');
  assert.equal(staticAsset.kind, 'static');
  assert.equal(staticAsset.currentLoaded, true);
  assert.equal(staticAsset.loadCurrentMs, 0);
  assert.equal(staticAsset.gatherMs, 0);
  assert.equal(staticAsset.row, null);
  assert.equal(staticAsset.result, 'cache');

  const legacy = await w.cacheStorage.open('readfine-shell-old');
  await legacy.put(css + '?v=abc', new Response('legacy loses'));
  await legacy.put(css + '?v=old', new Response('legacy exact'));
  assert.equal(await (await w.dispatch(asset())).text(), 'offline CSS');
  assert.equal(await (await w.dispatch(asset('?v=old'))).text(), 'legacy exact');
  assert.deepEqual(fetches, [origin + '/app?token=private-launch-token', origin + css]);
  assert.equal(await (await w.dispatch(asset('?v=miss'))).text(), 'network CSS');
  await assert.rejects(w.dispatch(asset('?v=abc&extra=1')), /Failed to fetch/);
  assert.deepEqual(fetches.slice(2), [origin + css + '?v=miss', origin + css + '?v=abc&extra=1']);
  const { launchTimings: timed } = await w.message({ type: 'rf-diag' });
  assert.deepEqual(timed.slice(2).map(({ path, networkOutcome, result }) => [path, networkOutcome, result]), [
    [css, 'skipped', 'cache'], [css, 'skipped', 'cache'], [css, 'ok', 'network'], [css, 'error', 'error'],
  ]);
  let responses = 0;
  const plain = worker({ script: '/sw.js' });
  await plain.dispatch(asset(), { respondWith() { responses++; } });
  assert.equal(responses, 0);

  const timeoutWorker = worker({ current: on, fetchImpl: () => new Promise(() => {}) });
  timeoutWorker.ctx.RFOffline.policy.NETWORK_TIMEOUT_MS = 5;
  assert.equal((await timeoutWorker.dispatch(nav())).status, 503);
  const { launchTimings: [timeout] } = await timeoutWorker.message({ type: 'rf-diag' });
  assert.equal(timeout.networkOutcome, 'timeout');
  assert.equal(timeout.result, 'offline-page');
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

  for (let i = 0; i < 101; i++) {
    const path = i === 0 ? '/app?rf_launch=bypass' : '/share/private-path-token?token=private-query-token';
    const response = await w.dispatch(nav(path), {
      preloadResponse: Promise.resolve(new Response('shared page')),
    });
    assert.equal(await response.text(), 'shared page');
  }

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
  assert.match(report, /workerStartedAt: \d+/);
  const timings = JSON.parse(report.match(/^launchTimings: (.+)$/m)[1]);
  assert.equal(timings.length, 100);
  assert.ok(timings.every(({ path, result, networkOutcome }) =>
    path === '/share/[redacted]' && result === 'network' && networkOutcome === 'ok'));
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

const mark = readFileSync(new URL(
  '../../docs/arh-w-dev/designs/assets/2026-11-20-instant-launch/variant_c.svgfrag', import.meta.url,
), 'utf8');
const scriptFrom = (html) => html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
const validSession = () => Response.json({ token: '0123456789ab' });

async function issue(w, path = '/app', clientId = 'issuer') {
  const res = await w.dispatch(nav(path), { resultingClientId: clientId });
  const html = await res.text();
  assert.match(html, /data-rf-launch-page/);
  return scriptFrom(html).match(/\b[0-9a-f]{32}\b/)[0];
}

async function confirm(w, code, clientId = 'issuer') {
  const response = await w.dispatch(new Request(origin + '/__rf/launch/' + code), { clientId });
  assert.ok(response, 'the worker owns the private confirmation route');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type'), /application\/json/);
  return (await response.json()).go;
}

test('plain launch paints an isolated copy of the approved mark without storage', { timeout: 2000 }, async () => {
  let storageOrFetch = 0;
  const unexpected = () => { storageOrFetch++; throw new Error('unexpected storage or fetch'); };
  const w = worker({ fetchImpl: unexpected });
  w.ctx.indexedDB.open = unexpected;
  w.ctx.caches = new Proxy({}, { get: unexpected });
  w.ctx.RFOffline.db.getCurrentUser = unexpected;

  const nonces = [];
  for (const path of ['/', '/app']) {
    const res = await w.dispatch(nav(path), {
      preloadResponse: path === '/' ? new Promise(() => {}) : Promise.reject(new Error('preload failed')),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const csp = res.headers.get('content-security-policy');
    const nonce = csp?.match(/'nonce-([^']+)'/)?.[1];
    assert.ok(nonce);
    nonces.push(nonce);
    assert.equal(csp, "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce
      + "'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'");
    const html = await res.text();
    assert.ok(html.includes('<script nonce="' + nonce + '">'));
    assert.ok(html.includes('<style nonce="' + nonce + '">'));
    assert.match(html, /data-rf-launch-page/);
    assert.match(html, /<title>Readfine<\/title>/);
    assert.doesNotMatch(html, /data-rf-user|<progress\b|\s(?:src|style|on\w+)=|<link\b|https?:/i);
    const animated = html.match(/<svg\b[^>]*data-rf-launch-animated[^>]*><rect[^>]*\/><([^]*?)<\/svg>/);
    assert.ok(animated, 'animated SVG follows the blue tile');
    assert.equal('<' + animated[1], mark);
    assert.match(html, /<svg\b[^>]*data-rf-launch-static/);
    assert.match(html, /prefers-reduced-motion:\s*reduce/);
    assert.ok(html.includes('href="' + path + '?rf_launch=bypass"'));
    assert.match(html, /animation:[^;{}]*\b3s\b/);
    assert.match(html, /Open Readfine<\/a>/);

    const script = scriptFrom(html);
    const code = script.match(/\b[0-9a-f]{32}\b/)[0];
    for (const [go, expected] of [
      ['shell', path + '?rf_launch=' + code], ['server', path + '?rf_launch=server'],
      ['network', path + '?rf_launch=bypass'], ['login', '/login'],
      ['bogus', path + '?rf_launch=server'], [null, path + '?rf_launch=server'],
    ]) {
      const frames = [];
      const replacements = [];
      const check = Promise.withResolvers();
      const replacement = Promise.withResolvers();
      runInNewContext(script, {
        document: { visibilityState: 'visible' },
        fetch(url, options) {
          assert.equal(url, '/__rf/launch/' + code);
          assert.equal(options.credentials, 'same-origin');
          assert.equal(options.cache, 'no-store');
          return check.promise;
        },
        location: { hash: '#article-17', replace(url) { replacements.push(url); replacement.resolve(); } },
        requestAnimationFrame(callback) { frames.push(callback); },
      });
      if (go === null) check.reject(new TypeError('fetch failed'));
      else check.resolve(Response.json({ go }));
      await new Promise(setImmediate);
      assert.deepEqual(replacements, []);
      assert.equal(frames.length, 1);
      frames.shift()();
      await new Promise(setImmediate);
      assert.deepEqual(replacements, []);
      assert.equal(frames.length, 1);
      frames.shift()();
      await replacement.promise;
      assert.deepEqual(replacements, [expected + '#article-17']);
    }
  }
  assert.notEqual(nonces[0], nonces[1]);
  assert.equal(storageOrFetch, 0);
  const other = worker({ current: on, fetchImpl: async () => new Response('network') });
  for (const request of [
    { ...nav('/app'), destination: 'iframe' }, { ...nav('/app'), method: 'POST' },
    { ...nav('/app'), url: 'https://other.test/app' }, nav('/app?x=1'), nav('/app?rf_launch='),
  ]) assert.doesNotMatch(await (await other.dispatch(request))?.text() || '', /data-rf-launch-page/);
  assert.equal(await worker({ script: '/sw.js' }).dispatch(nav('/app')), null);
});

test('launch confirmation is single-use and classifies every server and transport outcome', { timeout: 5000 }, async () => {
  function redirect(url) {
    return Object.defineProperties(validSession(), { redirected: { value: true }, url: { value: url } });
  }
  for (const [reply, expected] of [
    [validSession, 'shell'],
    [() => new Response(null, { status: 401 }), 'login'],
    [() => redirect(origin + '/login?next=/app'), 'login'],
    ...[409, 503, 429, 403, 204].map((status) => [() => new Response(null, { status }), 'server']),
    [() => redirect(origin + '/app'), 'server'],
    [() => redirect('https://other.test/login'), 'server'],
    [() => Response.json({ token: 'not-a-valid-token' }), 'server'],
    [() => new Response('html'), 'server'],
    [offline, 'shell'],
  ]) {
    let fetches = 0;
    const w = worker({ current: on, fetchImpl: (request, { signal }) => {
      fetches++;
      assert.equal(request.url, origin + '/sync/changes');
      assert.equal(request.method, 'GET');
      assert.equal(request.credentials, 'include');
      assert.equal(request.cache, 'no-store');
      assert.equal(request.redirect, 'follow');
      assert.equal(request.headers.get('X-Readfine-User'), '1');
      assert.equal(signal.aborted, false);
      return Promise.resolve().then(reply);
    } });
    const code = await issue(w);
    assert.equal(await confirm(w, code), expected);
    assert.equal(await confirm(w, code), 'network');
    assert.equal(fetches, 1);
  }

  const started = Promise.withResolvers();
  const reply = Promise.withResolvers();
  let fetches = 0;
  const w = worker({ current: on, fetchImpl: () => { fetches++; started.resolve(); return reply.promise; } });
  const code = await issue(w);
  assert.equal(await confirm(w, code, 'other'), 'network');
  assert.equal(await confirm(w, 'f'.repeat(32)), 'network');
  assert.equal(await confirm(w, 'malformed/path'), 'network');
  const restarted = worker({ current: on, fetchImpl: w.ctx.fetch });
  assert.equal(await confirm(restarted, code), 'network');
  assert.equal(w.userReads() + restarted.userReads(), 0);
  const pending = confirm(w, code);
  await started.promise;
  assert.equal(await confirm(w, code, 'other'), 'network');
  assert.equal(await confirm(w, code), 'network');
  reply.resolve(validSession());
  assert.equal(await pending, 'shell');
  assert.equal(fetches, 1);

  const missingId = worker({ current: on, fetchImpl: async () => validSession() });
  assert.equal(await confirm(missingId, await issue(missingId, '/', ''), 'issuer'), 'shell');
  assert.equal(await confirm(missingId, await issue(missingId), ''), 'shell');

  let now = 0;
  const bounded = worker({ current: on, fetchImpl: w.ctx.fetch });
  bounded.ctx.Date = { now: () => now };
  const expired = await issue(bounded);
  now += 60_000;
  assert.equal(await confirm(bounded, expired), 'network');
  const evicted = await issue(bounded);
  for (let i = 0; i < 16; i++) await issue(bounded);
  assert.equal(await confirm(bounded, evicted), 'network');
  assert.equal(bounded.userReads(), 0);
  assert.equal(fetches, 1);

  const timeout = Promise.withResolvers();
  let signal;
  const slow = worker({ current: on, fetchImpl: (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  slow.ctx.setTimeout = (callback, delay) => { assert.equal(delay, 8000); timeout.resolve(callback); };
  const timingOut = confirm(slow, await issue(slow));
  (await timeout.promise)();
  assert.equal(await timingOut, 'shell');
  assert.equal(signal.aborted, true);

  for (const record of [null, ...[
    { offlineEnabled: false }, { stale: true }, { forceOffline: true },
    { logoutPending: true }, { wipePending: true },
  ].map((patch) => ({ ...on, ...patch }))]) {
    const restricted = worker({ current: record, fetchImpl: w.ctx.fetch });
    assert.equal(await confirm(restricted, await issue(restricted)), 'network');
  }
  for (const flag of ['logoutPending', 'wipePending', 'stale', 'forget']) {
    const restricted = worker({ current: on, fetchImpl: w.ctx.fetch });
    if (flag === 'forget') restricted.ctx.RFOffline.policy.onMessage({ data: { type: 'rf-forget-user' } });
    else {
      await storeMirror(restricted);
      await (await restricted.cacheStorage.open('readfine-meta')).put('/__rf/meta',
        Response.json({ uid: 1, offlineEnabled: true, [flag]: true }));
    }
    assert.equal(await confirm(restricted, await issue(restricted)), 'network');
  }
  assert.equal(fetches, 1);

  for (const change of ['forget', 'record', 'mirror']) {
    const inFlight = Promise.withResolvers();
    const release = Promise.withResolvers();
    const changed = worker({ current: on, fetchImpl: () => { inFlight.resolve(); return release.promise; } });
    const check = confirm(changed, await issue(changed));
    await inFlight.promise;
    if (change === 'forget') changed.ctx.RFOffline.policy.onMessage({ data: { type: 'rf-forget-user' } });
    if (change === 'record') changed.ctx.RFOffline.db.getCurrentUser = async () => ({ ...on, logoutPending: true });
    if (change === 'mirror') await (await changed.cacheStorage.open('readfine-meta')).put('/__rf/meta',
      Response.json({ uid: 1, offlineEnabled: true, wipePending: true }));
    release.resolve(validSession());
    assert.equal(await check, 'network', change);
  }
});

test('launch confirmation aborts a stalled 200 body at the network deadline', { timeout: 2000 }, async () => {
  const reading = Promise.withResolvers();
  let signal;
  const w = worker({ current: on, fetchImpl: async (_, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
      pull() { reading.resolve(); },
    }, { highWaterMark: 0 }), { status: 200 });
  } });
  const timers = new Map();
  w.ctx.setTimeout = (callback, delay) => {
    assert.equal(delay, 8000);
    const id = Symbol();
    timers.set(id, callback);
    return id;
  };
  w.ctx.clearTimeout = (id) => { timers.delete(id); };

  const pending = confirm(w, await issue(w));
  await reading.promise;
  assert.equal(signal.aborted, false);
  for (const callback of timers.values()) callback();
  assert.equal(signal.aborted, true, 'request must be aborted at the deadline even after headers');
  assert.equal(await pending, 'shell');
});

test('launch navigation consumes grants and keeps rejected checks off the stored shell', { timeout: 5000 }, async () => {
  const continueAt = (code, path = '/app') => nav(path + '?rf_launch=' + code);
  for (const row of ['R1', 'R6', 'L1', 'R1-miss']) {
    const fetches = [];
    const w = worker({ current: on, fetchImpl: async (request) => {
      fetches.push(request.url);
      return request.url.endsWith('/sync/changes') ? validSession() : new Response('network navigation');
    } });
    if (row !== 'R1-miss') {
      const cache = await w.cacheStorage.open(row === 'L1' ? 'readfine-shell-old' : 'readfine-pages-1');
      await cache.put('/app', new Response(shell, { headers: { 'Content-Security-Policy': "script-src 'nonce-keep'" } }));
    }
    const code = await issue(w, '/');
    assert.equal(await confirm(w, code), 'shell');
    if (row === 'R6') {
      await storeMirror(w);
      w.ctx.RFOffline.db.getCurrentUser = async () => { throw new Error('IndexedDB unavailable'); };
    }
    assert.equal(await (await w.dispatch(continueAt(code))).text(), 'network navigation', 'wrong path');
    const response = await w.dispatch(continueAt(code, '/'));
    if (row === 'R1-miss') assert.equal(await response.text(), 'network navigation');
    else {
      assert.equal(await response.text(), shell);
      assert.equal(response.headers.get('content-security-policy'), "script-src 'nonce-keep'");
    }
    const { launchTimings } = await w.message({ type: 'rf-diag' });
    assert.equal(launchTimings.at(-1).row, row);
    assert.deepEqual(fetches, [origin + '/sync/changes', origin + '/app?rf_launch=' + code,
      ...(row === 'R1-miss' ? [origin + '/?rf_launch=' + code] : [])]);
    for (const value of [code, '0'.repeat(32), 'bypass']) {
      assert.equal(await (await w.dispatch(continueAt(value, '/'))).text(), 'network navigation');
    }
    assert.doesNotMatch(JSON.stringify(await w.message({ type: 'rf-diag' })), new RegExp(code));
  }

  const expired = worker({ current: on, fetchImpl: async (request) =>
    request.url.endsWith('/sync/changes') ? validSession() : new Response('network navigation') });
  let now = Date.now();
  expired.ctx.Date = { now: () => now };
  await storePages(expired);
  const expiredCode = await issue(expired);
  assert.equal(await confirm(expired, expiredCode), 'shell');
  now += 60_000;
  assert.equal(await (await expired.dispatch(continueAt(expiredCode))).text(), 'network navigation');

  for (const owned of [true, false]) {
    let fetches = 0;
    const w = worker({ current: on, fetchImpl: () => { fetches++; return offline(); } });
    if (owned) await storePages(w);
    const code = await issue(w);
    assert.equal(await confirm(w, code), 'shell');
    const res = await w.dispatch(continueAt(code), { preloadResponse: new Promise(() => {}) });
    assert.equal(res.status, owned ? 200 : 503);
    assert.match(await res.text(), owned ? /Reader shell/ : /Offline – Readfine/);
    assert.equal(fetches, 1);
  }

  for (const change of ['mirror', 'generation']) {
    const w = worker({ current: on, fetchImpl: async (request) =>
      request.url.endsWith('/sync/changes') ? validSession() : new Response('network navigation') });
    await storePages(w);
    const code = await issue(w);
    assert.equal(await confirm(w, code), 'shell');
    const { router, policy } = w.ctx.RFOffline;
    const readShell = router.shell;
    const reading = Promise.withResolvers();
    const resume = Promise.withResolvers();
    router.shell = async (name) => { const hit = await readShell(name); reading.resolve(); await resume.promise; return hit; };
    const navigation = w.dispatch(continueAt(code));
    await reading.promise;
    if (change === 'mirror') await (await w.cacheStorage.open('readfine-meta')).put('/__rf/meta',
      Response.json({ uid: 1, offlineEnabled: true, logoutPending: true }));
    else {
      w.ctx.RFOffline.db.getCurrentUser = async () => ({ ...on, userId: 2 });
      await policy.reload();
    }
    resume.resolve();
    assert.equal(await (await navigation).text(), 'network navigation');
  }

  for (const forceOffline of [false, true]) {
    const w = worker({ current: on, fetchImpl: async (request) => {
      if (request.url.endsWith('/sync/changes')) return new Response(null, { status: 409 });
      return new Response('server unavailable', { status: 503 });
    } });
    await storePages(w);
    const code = await issue(w);
    assert.equal(await confirm(w, code), 'server');
    w.ctx.RFOffline.db.getCurrentUser = async () => ({ ...on, forceOffline });
    await w.ctx.RFOffline.policy.reload();
    for (const value of [code, 'server']) {
      const res = await w.dispatch(continueAt(value));
      assert.equal(res.status, 503);
      assert.equal(await res.text(), 'server unavailable');
    }
    w.ctx.fetch = offline;
    const fresh = worker({ current: { ...on, forceOffline }, fetchImpl: offline });
    await storePages(fresh);
    for (const [target, value] of [[w, code], [w, 'server'], [fresh, 'server']]) {
      const res = await target.dispatch(continueAt(value));
      assert.equal(res.status, 503);
      const html = await res.text();
      assert.match(html, /Offline – Readfine/);
      assert.doesNotMatch(html, /Reader shell/);
    }
  }
});

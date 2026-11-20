import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import { IDBFactory } from 'fake-indexeddb';
import { JSDOM } from 'jsdom';
import { fakeCaches } from './harness.mjs';

const source = new URL('../../backend/app/static/js/offline/diagnostics.js', import.meta.url);
const markup = `
  <div data-rf-offline-settings hidden></div>
  <div data-rf-offline-diagnostics data-rf-app-version="1" data-rf-template-version="2">
    <button data-rf-diag-action="test"></button>
    <button data-rf-diag-action="copy"></button>
    <pre data-rf-diag-out></pre>
    <p data-rf-offline-install-note hidden></p>
  </div>`;
const noWorker = { row: 'no-flagged-worker', answer: 'safari-error' };
const json = (value) => JSON.parse(JSON.stringify(value));

async function setup(t, { standalone, controller = null } = {}) {
  const { window: win } = new JSDOM('', { runScripts: 'outside-only', url: 'https://readfine.test/settings/preferences' });
  t.after(() => win.close());
  // Load after DOMContentLoaded so only explicit bind() calls trigger the panel in these tests.
  await new Promise((resolve) => win.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  win.indexedDB = new IDBFactory();
  win.MessageChannel = MessageChannel;
  win.matchMedia = () => ({ matches: standalone === true });
  win.navigator.standalone = standalone;
  Object.defineProperty(win.navigator, 'serviceWorker', {
    value: { controller, getRegistration: async () => ({ active: controller }) },
  });
  Object.defineProperty(win.navigator, 'storage', {
    value: { persisted: async () => false, estimate: async () => ({ usage: 10, quota: 100 }) },
  });

  const storage = fakeCaches();
  const listed = new Set();
  win.caches = {
    keys: async () => {
      const names = await storage.keys();
      for (const name of names) listed.add(name);
      return names;
    },
    async open(name) {
      assert.ok(listed.has(name), `opened an unlisted cache: ${name}`);
      const cache = storage.stores.get(name);
      return { keys: cache.keys, match: cache.match };
    },
    match: async (url, opts) => storage.stores.get(opts.cacheName)?.match(url, opts),
  };
  async function put(name, url, body, headers) {
    const cache = await storage.open(name);
    await cache.put(url, new Response(body, { headers }));
  }
  if (fs.existsSync(source)) win.eval(fs.readFileSync(source, 'utf8'));
  assert.ok(win.RFOffline?.diagnostics, 'diagnostics must load as a standalone script');
  win.document.body.innerHTML = markup;
  return { win, put, diagnostics: win.RFOffline.diagnostics, root: win.document.querySelector('[data-rf-offline-diagnostics]') };
}

test('the report explains a failed cold start inside the app', async (t) => {
  const controller = {
    scriptURL: '/sw.js',
    state: 'activated',
    postMessage({ type }, [port]) {
      if (type === 'rf-diag') port.postMessage({ flagged: false, scriptsLoaded: false, importError: null });
      port.close();
    },
  };
  const { win, put, diagnostics } = await setup(t, { controller, standalone: true });
  win.localStorage.setItem('rf-sw-error', JSON.stringify({ at: 123, message: 'install failed' }));
  Object.defineProperty(win.navigator, 'locks', { value: {} });
  await put('readfine-meta', '/__rf/meta', JSON.stringify({ uid: 7, offlineEnabled: true }));
  await put('readfine-pages-7', '/app', '<body data-rf-user="7">');
  await put('readfine-pages-7', '/__rf/pages-info', JSON.stringify({ savedAt: '2026-11-19T00:00:00.000Z' }));
  await put('readfine-pages-7', '/static/js/app.js', '');
  await put('readfine-shell-7', '/app', '<body data-rf-user="7">');
  await put('readfine-media-7', '/m-cache/a', 'abc', { 'Content-Length': '3' });
  await put('readfine-media-7', '/m-cache/b', 'ab');
  await put('readfine-media-8', '/m-cache/c', 'abcd', { 'Content-Length': '4' });

  // Exercise the fallback open path on older Safari. A failed read must leave no DB behind.
  const databases = win.indexedDB.databases.bind(win.indexedDB);
  win.indexedDB.databases = undefined;
  const report = await diagnostics.collect({ win });
  assert.equal(report.record, null);
  assert.deepEqual(await databases(), []);
  assert.equal(report.databases.error, 'TypeError');
  assert.equal(report.sw.diag.scriptsLoaded, false);
  assert.equal(report.pages[0].savedAt, '2026-11-19T00:00:00.000Z');
  assert.equal(report.pages[0].entries, 3);
  assert.equal(report.legacyShells[0].appUser, 7);
  assert.equal(report.legacyShells[0].entries, 1);
  assert.deepEqual(json(report.media), { entries: 3, bytes: 7 });
  const formatted = diagnostics.format(report);
  for (const line of [
    'display mode: home-screen app', 'controller: /sw.js (plain)',
    'last update: update failed, previous version running', 'mirror: ok uid=7 offline=on',
    'readfine-pages-7: app=yes user=7 entries=3', 'media: {"entries":3,"bytes":7}',
    'persisted: no', 'Web Locks: yes',
  ]) assert.ok(formatted.includes(line), line);

  await put('readfine-meta-wipe', '/__rf/meta', JSON.stringify({ uid: null, wipePending: true }));
  const pending = await diagnostics.collect({ win });
  assert.deepEqual(json(pending.mirror), { state: 'ok', value: { uid: null, wipePending: true } });
  assert.ok(pending.caches.includes('readfine-meta'));
  assert.ok(pending.caches.includes('readfine-meta-wipe'));
  const open = win.caches.open;
  win.caches.open = async (name) => {
    if (name === 'readfine-pages-7') throw new DOMException('Unavailable', 'SecurityError');
    const cache = await open(name);
    if (name === 'readfine-media-8') cache.match = () => { throw new DOMException('Unavailable', 'SecurityError'); };
    return cache;
  };
  const partial = await diagnostics.collect({ win });
  assert.equal(partial.pages[0].appUser, 7);
  assert.equal(partial.pages[0].entries.error, 'SecurityError');
  assert.deepEqual(json(partial.media), { entries: 3, bytes: { error: 'SecurityError' } });
  await put('readfine-meta-wipe', '/__rf/meta', 'not json');
  assert.deepEqual(json((await diagnostics.collect({ win })).mirror), { state: 'unreadable', value: null });
});

test('the panel renders without a page.js controller', async (t) => {
  const { win, diagnostics, root } = await setup(t);
  assert.equal(win.RFOffline.page, undefined);
  assert.equal(win.RFOffline.db, undefined);
  await diagnostics.bind(root);
  assert.equal(root.hidden, false);
  assert.match(root.querySelector('[data-rf-diag-out]').textContent, /controller: none/);
});

test('test launch without a flagged controller answers within 2 s', { timeout: 5000 }, async (t) => {
  const { win, diagnostics } = await setup(t);
  const sw = win.navigator.serviceWorker;
  const start = performance.now();
  assert.deepEqual(json(await diagnostics.testLaunch({ win })), noWorker);
  assert.ok(performance.now() - start < 2100);

  sw.controller = { scriptURL: '/sw.js' };
  assert.deepEqual(json(await diagnostics.testLaunch({ win })), noWorker);

  sw.controller = { scriptURL: '/sw.js?offline=1', postMessage(_data, [port]) { port.close(); } };
  const timeoutStart = performance.now();
  assert.deepEqual(json(await diagnostics.testLaunch({ win })), noWorker);
  assert.ok(performance.now() - timeoutStart < 2100);

  sw.controller.postMessage = ({ type }, [port]) => {
    if (type === 'rf-test-launch') port.postMessage({ row: 'R6', answer: 'shell' });
    port.close();
  };
  assert.deepEqual(json(await diagnostics.testLaunch({ win })), { row: 'R6', answer: 'shell' });
});

test('Copy report includes launch and page timings without article content or queries', async (t) => {
  const controller = {
    scriptURL: '/sw.js?offline=1&token=private-worker-token',
    state: 'activated',
    postMessage({ type }, [port]) {
      if (type === 'rf-diag') port.postMessage({
        flagged: true, scriptsLoaded: true, importError: null, startedAt: 123,
        routeErrorCount: 11,
        routeErrors: [{ at: 456, kind: 'htmx', name: 'InvalidStateError',
          message: 'IndexedDB connection or storage state is unavailable.', row: null }],
        workerStartedAt: 123,
        launchTimings: [{ path: '/app', kind: 'navigate', sinceWorkerStartMs: 2, currentLoaded: false,
          loadCurrentMs: 55, networkMs: 0, networkOutcome: 'skipped', gatherMs: 5, row: 'R1',
          totalMs: 60, result: 'shell' }],
      });
      port.close();
    },
  };
  const { win, put, diagnostics, root } = await setup(t, { controller });
  const navigation = {
    name: '/settings/preferences?token=private-navigation-token', workerStart: 12.4, fetchStart: 13.7,
    responseStart: 81.2, responseEnd: 94.8, domInteractive: 151.1, domContentLoadedEventEnd: 160.5,
    loadEventEnd: 0,
  };
  win.performance.getEntriesByType = (type) => type === 'navigation' ? [navigation] : [{
    name: 'https://readfine.test/static/js/offline/boot.js?v=123', initiatorType: 'script', responseEnd: 135.7,
  }];
  win.performance.getEntriesByName = (name) => [{ startTime: name === 'first-paint' ? 172.3 : 177.7 }];
  await put('readfine-pages-7', '/app', '<body data-rf-user="7"><h2>Secret title</h2>');
  win.localStorage.setItem('rf-last-sync', JSON.stringify({
    articles: 3,
    media: { done: 1, failed: 0 },
    mediaQueue: ['https://feed.test/articles/secret'],
    errorDetail: 'Secret title',
  }));
  let copied;
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async (text) => { copied = text; } } });
  await diagnostics.bind(root);
  navigation.loadEventEnd = 170.3;
  root.querySelector('[data-rf-diag-action="copy"]').click();
  assert.match(copied, /"articles":3/);
  assert.match(copied, /"startedAt":123,"routeErrorCount":11/);
  assert.match(copied, /"at":456,"kind":"htmx","name":"InvalidStateError","message":"IndexedDB connection or storage state is unavailable\.","row":null/);
  assert.match(copied, /"workerStartedAt":123/);
  assert.match(copied, /"launchTimings":\[\{"path":"\/app","kind":"navigate"/);
  assert.deepEqual(JSON.parse(copied.match(/^pageTiming: (.+)$/m)[1]), {
    workerStart: 12, fetchStart: 14, responseStart: 81, responseEnd: 95, domInteractive: 151,
    domContentLoadedEventEnd: 161, loadEventEnd: 170, 'first-paint': 172, 'first-contentful-paint': 178,
    bootScriptResponseEnd: 136, pageScriptResponseEnd: null,
  });
  assert.doesNotMatch(copied, /Secret title|https?:\/\/|\?|private-\w+-token/);
  assert.equal(root.querySelector('[data-rf-diag-out]').textContent, copied);
});

test('Safari tab shows the install note; the home-screen app does not', async (t) => {
  for (const standalone of [false, true]) {
    const { diagnostics, root } = await setup(t, { standalone });
    await diagnostics.bind(root);
    const note = root.querySelector('[data-rf-offline-install-note]');
    assert.equal(note.hidden, standalone);
    if (!standalone) assert.equal(note.textContent, 'The Home Screen app keeps its own offline copy — turn this on inside the app.');
  }
});

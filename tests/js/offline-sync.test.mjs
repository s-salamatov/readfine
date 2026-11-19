// Offline device store and sync engine (offline/db.js, offline/sync.js).
//
// The server is a small in-memory fake of /sync/v1 that keeps the shapes the backend
// returns (routers/web/sync.py), and records every request so a test can check order,
// headers and bodies.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { loadOffline, fakeCaches } from './harness.mjs';

const RF = await loadOffline();
const NOW = Date.parse('2026-11-16T10:00:00Z');

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// articles: {id: {version, content_version, published_at}}
function fakeServer({ articles = {}, templates = 't1', prefs = 'p1' } = {}) {
  const s = {
    articles, templates, prefs,
    listsVersion: 'l1',
    calls: [],
    limits: undefined, // manifest "limits", when the test sets it
    failSnapshots: false,
    opsResult: null, // (op) => result
    opsHandler: null, // (body, init) => Response for the whole request, or null
    status: {},      // path prefix -> status to answer with
  };
  s.fetch = async (url, init = {}) => {
    const u = new URL(url, 'https://readfine.test/');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    s.calls.push({ method, path: u.pathname, search: u.search, headers: init.headers || {}, body });
    for (const [prefix, st] of Object.entries(s.status)) {
      if (u.pathname.startsWith(prefix)) return json({ detail: 'x' }, st);
    }
    const rec = (id) => ({ id, version: s.articles[id].version, content_version: s.articles[id].content_version,
      published_at: s.articles[id].published_at || null, is_read: false });
    switch (u.pathname) {
      case '/sync/v1/ops': {
        const custom = s.opsHandler && s.opsHandler(body, init);
        if (custom) return custom;
      }
        return json({ server_time: new Date(NOW).toISOString(), results: body.ops.map((op) =>
          s.opsResult ? s.opsResult(op) : { op_id: op.op_id, status: 'applied', reason: null, retryable: false,
            article: s.articles[op.article_id] ? rec(op.article_id) : null }) });
      case '/sync/v1/manifest':
        return json({
          server_time: new Date(NOW).toISOString(),
          articles: Object.keys(s.articles).map(Number).map((id) => [id, s.articles[id].version]),
          lists: { folders: s.listsVersion, feeds: s.listsVersion, labels: s.listsVersion,
                   saved_searches: s.listsVersion, prefs: s.prefs, templates: s.templates },
          ...(s.limits ? { limits: s.limits } : {}),
        });
      case '/sync/v1/articles':
        return json({ articles: body.ids.filter((id) => s.articles[id]).map(rec) });
      case '/sync/v1/snapshots': {
        if (s.failSnapshots) throw new TypeError('Failed to fetch');
        const ids = u.searchParams.get('ids').split(',').map(Number).filter((id) => s.articles[id]);
        return json({ snapshots: ids.map((id) => ({
          id, content_version: s.articles[id].content_version, template_version: s.templates,
          prefs_version: s.prefs, row_html: '<div>row ' + id + '</div>', detail_html: '<div>detail</div>',
          media: s.articles[id].media || [],
        })) });
      }
      case '/sync/v1/lists':
        return json({
          folders: [{ id: 1, name: 'F', position: 0 }], feeds: [], labels: [], saved_searches: [],
          prefs: { timezone: 'UTC' },
          versions: { folders: s.listsVersion, feeds: s.listsVersion, labels: s.listsVersion,
                      saved_searches: s.listsVersion, prefs: s.prefs, templates: s.templates },
        });
      default:
        return new Response('not found', { status: 404 });
    }
  };
  s.paths = () => s.calls.map((c) => c.method + ' ' + c.path);
  return s;
}

const arts = (...ids) => Object.fromEntries(ids.map((id) => [id, { version: 'v' + id, content_version: 1 }]));
const runOpts = (srv, extra = {}) => ({ fetchFn: srv.fetch, now: () => NOW, csrfToken: 'tok', ...extra });

test('diffManifest fetches new and changed, removes missing', () => {
  const local = new Map([[1, 'a'], [2, 'b'], [3, 'c']]);
  const out = RF.sync.diffManifest(local, [[1, 'a'], [2, 'B'], [4, 'd']]);
  assert.deepEqual(out.fetch.sort(), [2, 4]);
  assert.deepEqual(out.remove, [3]);
  assert.deepEqual(RF.sync.diffManifest(new Map(), []), { fetch: [], remove: [] });
});

test('open creates the schema', async () => {
  const db = await RF.db.open(7);
  assert.equal(db.idb.name, 'readfine-offline-7');
  assert.deepEqual([...db.idb.objectStoreNames].sort(), ['articles', 'lists', 'meta', 'outbox', 'snapshots']);
  const tx = db.idb.transaction('outbox');
  assert.deepEqual([...tx.objectStore('outbox').indexNames], ['op_id']);
  assert.equal(tx.objectStore('outbox').autoIncrement, true);
  assert.equal(await RF.db.getMeta(db, 'user_id'), 7);
  db.close();
  await assert.rejects(RF.db.open(0));
});

test('first run stores records, snapshots and lists; all ready', async () => {
  const srv = fakeServer({ articles: arts(1, 2, 3) });
  const db = await RF.db.open(1);
  const rep = await RF.sync.run(db, runOpts(srv));
  assert.equal(rep.error, null);
  assert.equal(rep.articles, 3);
  assert.equal(rep.snapshots, 3);
  assert.equal(rep.listsFetched, true);
  assert.equal(rep.finishedAt, new Date(NOW).toISOString());
  assert.deepEqual(await RF.db.readyIds(db), [1, 2, 3]);
  assert.deepEqual((await RF.db.get(db, 'lists', 'folders')).items, [{ id: 1, name: 'F', position: 0 }]);
  assert.deepEqual((await RF.db.get(db, 'lists', 'prefs')).items, { timezone: 'UTC' });
  // A second run with nothing changed asks for nothing but the manifest.
  srv.calls.length = 0;
  const again = await RF.sync.run(db, runOpts(srv));
  assert.deepEqual(srv.paths(), ['GET /sync/v1/manifest']);
  assert.equal(again.articles, 0);
  db.close();
});

test('run sends outbox before manifest', async () => {
  const srv = fakeServer({ articles: arts(1, 2) });
  const db = await RF.db.open(1);
  await RF.db.enqueueOp(db, { type: 'star', article_id: 1, at: new Date(NOW - 1000) });
  await RF.db.enqueueOp(db, { type: 'read', article_id: 2 });
  const rep = await RF.sync.run(db, runOpts(srv));
  assert.deepEqual(srv.paths().slice(0, 2), ['POST /sync/v1/ops', 'GET /sync/v1/manifest']);
  const sent = srv.calls[0];
  assert.equal(sent.headers['x-csrftoken'], 'tok');
  assert.deepEqual(sent.body.ops.map((o) => o.type), ['star', 'read']);
  for (const t of [sent.body.client_time, ...sent.body.ops.map((o) => o.at)]) {
    assert.match(t, /Z$/, 'times carry an offset');
  }
  assert.equal(rep.pendingOps, 0);
  assert.deepEqual(await RF.db.outboxEntries(db), []);
  db.close();
});

test('retryable ops stay in the outbox and are resent with the same op_id', async () => {
  const srv = fakeServer({ articles: arts(1) });
  srv.opsResult = (op) => ({ op_id: op.op_id, status: op.type === 'save_url' ? 'skipped' : 'applied',
    reason: op.type === 'save_url' ? 'rate_limited' : null, retryable: op.type === 'save_url', article: null });
  const db = await RF.db.open(1);
  const kept = await RF.db.enqueueOp(db, { type: 'save_url', value: { url: 'https://x.test/a' } });
  await RF.db.enqueueOp(db, { type: 'star', article_id: 1 });
  const rep = await RF.sync.run(db, runOpts(srv));
  assert.equal(rep.pendingOps, 1);
  const left = await RF.db.outboxEntries(db);
  assert.deepEqual(left.map((e) => e.op.op_id), [kept.op_id]);
  srv.calls.length = 0;
  srv.opsResult = null;
  await RF.sync.run(db, runOpts(srv));
  assert.deepEqual(srv.calls[0].body.ops.map((o) => o.op_id), [kept.op_id]);
  assert.deepEqual(await RF.db.outboxEntries(db), []);
  db.close();
});

test('auth responses stop the run and keep data and outbox', async () => {
  const srv = fakeServer({ articles: arts(1, 2) });
  const db = await RF.db.open(1);
  await RF.sync.run(db, runOpts(srv));
  srv.status['/sync/v1/manifest'] = 403;
  assert.equal((await RF.sync.run(db, runOpts(srv))).error, 'auth');
  delete srv.status['/sync/v1/manifest'];
  await RF.db.enqueueOp(db, { type: 'star', article_id: 1 });
  srv.status['/sync/v1/'] = 401;
  delete srv.articles[2];
  const rep = await RF.sync.run(db, runOpts(srv));
  assert.equal(rep.error, 'auth');
  assert.equal(rep.pendingOps, 1);
  assert.deepEqual(srv.paths().slice(-1), ['POST /sync/v1/ops']);
  assert.deepEqual(await RF.db.readyIds(db), [1, 2]);
  const login = new Response('<html>Log in</html>', { headers: { 'content-type': 'text/html' } });
  Object.defineProperties(login, {
    redirected: { value: true },
    url: { value: 'https://readfine.test/login?next=/app' },
  });
  assert.equal((await RF.sync.run(db, runOpts(srv, { fetchFn: async () => login }))).error, 'auth');
  assert.equal((await RF.db.outboxEntries(db)).length, 1);
  db.close();
});

test('every sync request names the reader; 409 account_mismatch stops before anything is written', async () => {
  const srv = fakeServer({ articles: arts(1, 2) });
  const db = await RF.db.open(1);
  await RF.sync.run(db, runOpts(srv));
  assert.ok(srv.calls.length > 3);
  for (const c of srv.calls) assert.equal(c.headers['x-readfine-user'], '1', c.method + ' ' + c.path);
  // Another reader signed in elsewhere in this browser: the server refuses.
  await RF.db.enqueueOp(db, { type: 'star', article_id: 1 });
  srv.calls.length = 0;
  srv.articles[3] = { version: 'v3', content_version: 1 };
  srv.status['/sync/v1/'] = 409;
  const before = await RF.db.readyIds(db);
  const rep = await RF.sync.run(db, runOpts(srv));
  assert.equal(rep.error, 'account');
  // Stopped at the first call (the ops POST): no manifest, nothing written.
  assert.deepEqual(srv.paths(), ['POST /sync/v1/ops']);
  assert.deepEqual(await RF.db.readyIds(db), before);
  assert.equal((await RF.db.outboxEntries(db)).length, 1);
  db.close();
});

test('a failed ops request stops before the manifest', async () => {
  const srv = fakeServer({ articles: arts(1) });
  srv.status['/sync/v1/ops'] = 429;
  const db = await RF.db.open(1);
  await RF.db.enqueueOp(db, { type: 'star', article_id: 1 });
  const rep = await RF.sync.run(db, runOpts(srv));
  assert.equal(rep.error, 'rate_limited');
  assert.deepEqual(srv.paths(), ['POST /sync/v1/ops']);
  assert.equal(rep.pendingOps, 1);
  delete srv.status['/sync/v1/ops'];
  for (const [status, url] of [
    [200, ''],
    [200, 'https://portal.test/login'],
    [403, 'https://portal.test/login'],
    [200, 'https://readfine.test/portal'],
    [302, ''],
  ]) {
    const portal = new Response('<html>Connect to Wi-Fi</html>', { status, headers: { 'content-type': 'text/html' } });
    if (url) Object.defineProperties(portal, { redirected: { value: true }, url: { value: url } });
    srv.opsHandler = () => portal;
    srv.calls.length = 0;
    const failed = await RF.sync.run(db, runOpts(srv));
    assert.equal(failed.error, 'network', url || String(status));
    assert.deepEqual(srv.paths(), ['POST /sync/v1/ops']);
    assert.equal(failed.pendingOps, 1);
  }
  db.close();
});

test('run removes stored articles and snapshots for removed ids', async () => {
  const srv = fakeServer({ articles: arts(1, 2, 3, 4) });
  const db = await RF.db.open(1);
  await RF.sync.run(db, runOpts(srv));
  delete srv.articles[2];
  delete srv.articles[3];
  delete srv.articles[4];
  // 4 is open on screen; it stays until it is closed.
  const rep = await RF.sync.run(db, runOpts(srv, { keepIds: [4] }));
  assert.equal(rep.removed, 2);
  assert.deepEqual(await RF.db.getAllKeys(db, 'articles'), [1, 4]);
  assert.deepEqual(await RF.db.getAllKeys(db, 'snapshots'), [1, 4]);
  assert.deepEqual(await RF.db.readyIds(db), [1, 4]);
  db.close();
});

test('test_partial_sync_hides_articles_without_snapshot', async () => {
  const srv = fakeServer({ articles: arts(1, 2) });
  srv.failSnapshots = true;
  const db = await RF.db.open(1);
  const rep = await RF.sync.run(db, runOpts(srv));
  assert.equal(rep.error, 'network');
  assert.deepEqual(await RF.db.getAllKeys(db, 'articles'), [1, 2], 'records are stored');
  assert.deepEqual(await RF.db.readyIds(db), [], 'but not shown without a snapshot');
  srv.failSnapshots = false;
  const next = await RF.sync.run(db, runOpts(srv));
  assert.equal(next.error, null);
  assert.equal(next.articles, 0, 'records are not fetched again');
  assert.equal(next.snapshots, 2);
  assert.deepEqual(await RF.db.readyIds(db), [1, 2]);
  db.close();
});

test('a state-only version change keeps the snapshot and readiness', async () => {
  const srv = fakeServer({ articles: arts(1, 2) });
  const db = await RF.db.open(1);
  await RF.sync.run(db, runOpts(srv));
  srv.articles[1].version = 'v1-read';
  srv.calls.length = 0;
  const rep = await RF.sync.run(db, runOpts(srv));
  assert.equal(rep.articles, 1);
  assert.equal(rep.snapshots, 0);
  assert.ok(!srv.paths().includes('GET /sync/v1/snapshots'));
  assert.deepEqual(await RF.db.readyIds(db), [1, 2]);
  assert.equal((await RF.db.get(db, 'articles', 1)).version, 'v1-read');
  db.close();
});

test('content version change refetches that snapshot', async () => {
  const srv = fakeServer({ articles: arts(1, 2) });
  const db = await RF.db.open(1);
  await RF.sync.run(db, runOpts(srv));
  srv.articles[2] = { version: 'v2b', content_version: 2 };
  srv.calls.length = 0;
  await RF.sync.run(db, runOpts(srv));
  const snap = srv.calls.find((c) => c.path === '/sync/v1/snapshots');
  assert.equal(snap.search, '?ids=2');
  assert.equal((await RF.db.get(db, 'snapshots', 2)).content_version, 2);
  db.close();
});

test('templates version change refetches all snapshots', async () => {
  const srv = fakeServer({ articles: arts(...Array.from({ length: 60 }, (_, i) => i + 1)) });
  const db = await RF.db.open(1);
  await RF.sync.run(db, runOpts(srv));
  srv.templates = 't2';
  srv.calls.length = 0;
  const rep = await RF.sync.run(db, runOpts(srv));
  assert.equal(rep.articles, 0);
  assert.equal(rep.snapshots, 60);
  const batches = srv.calls.filter((c) => c.path === '/sync/v1/snapshots');
  assert.deepEqual(batches.map((c) => c.search.split(',').length), [50, 10]);
  const snaps = await RF.db.getAll(db, 'snapshots');
  assert.ok(snaps.every((s) => s.template_version === 't2'));
  db.close();
});

test('prefs version change refetches snapshots and lists', async () => {
  const srv = fakeServer({ articles: arts(1) });
  const db = await RF.db.open(1);
  await RF.sync.run(db, runOpts(srv));
  srv.prefs = 'p2';
  srv.calls.length = 0;
  const rep = await RF.sync.run(db, runOpts(srv));
  assert.equal(rep.snapshots, 1);
  assert.equal(rep.listsFetched, true);
  db.close();
});

test('articles are fetched 200 per request', async () => {
  const srv = fakeServer({ articles: arts(...Array.from({ length: 450 }, (_, i) => i + 1)) });
  const db = await RF.db.open(1);
  await RF.sync.run(db, runOpts(srv, { }));
  const sizes = srv.calls.filter((c) => c.path === '/sync/v1/articles').map((c) => c.body.ids.length);
  assert.deepEqual(sizes, [200, 200, 50]);
  assert.ok(srv.calls.filter((c) => c.path === '/sync/v1/articles').every((c) => c.headers['x-csrftoken'] === 'tok'));
  db.close();
});

test('articles with unsent ops are neither refetched nor removed', async () => {
  const srv = fakeServer({ articles: arts(1, 2) });
  const db = await RF.db.open(1);
  await RF.sync.run(db, runOpts(srv));
  srv.opsResult = (op) => ({ op_id: op.op_id, status: 'failed', reason: 'error', retryable: true, article: null });
  await RF.db.enqueueOp(db, { type: 'unstar', article_id: 1 });
  srv.articles[1].version = 'changed';
  delete srv.articles[2];
  await RF.db.enqueueOp(db, { type: 'read', article_id: 2 });
  srv.calls.length = 0;
  const rep = await RF.sync.run(db, runOpts(srv));
  assert.equal(rep.error, null);
  assert.equal(rep.removed, 0);
  assert.ok(!srv.paths().includes('POST /sync/v1/articles'));
  assert.equal(rep.pendingOps, 2);
  db.close();
});

test('media queue lists ready snapshots newest first, once per image', async () => {
  const srv = fakeServer({ articles: {
    1: { version: 'a', content_version: 1, published_at: '2026-11-01T00:00:00Z', media: ['/m/s1/1/AAA', '/img/video-thumb/x.jpg'] },
    2: { version: 'b', content_version: 1, published_at: '2026-11-10T00:00:00Z', media: ['/m/s2/2/BBB', '/m/s9/9/AAA'] },
  } });
  const db = await RF.db.open(1);
  const rep = await RF.sync.run(db, runOpts(srv));
  assert.deepEqual(rep.mediaQueue, ['/m/s2/2/BBB', '/m/s9/9/AAA', '/img/video-thumb/x.jpg']);
  assert.equal(rep.mediaQueued, 3);
  db.close();
});

test('downloadMedia stores by stable key and records sizes; re-signed urls are not refetched', async () => {
  const srv = fakeServer({ articles: {
    1: { version: 'a', content_version: 1, media: ['/m/s1/1/AAA'] },
  } });
  const caches = fakeCaches();
  const mediaFetch = async (url, init) => {
    srv.calls.push({ method: 'GET', path: new URL(url, 'https://readfine.test').pathname });
    if (url.startsWith('/m/')) return new Response(new Uint8Array(10), { headers: { 'content-type': 'image/png' } });
    return srv.fetch(url, init);
  };
  const db = await RF.db.open(1);
  const rep = await RF.sync.run(db, runOpts(srv, { fetchFn: mediaFetch, caches, downloadMedia: true, shell: false }));
  assert.equal(rep.media.stored, 1);
  assert.deepEqual(await RF.db.getMeta(db, 'media'), { '/m-cache/AAA': 10 });
  const cache = await caches.open('readfine-media-1');
  assert.ok(await RF.media.match(cache, '/m/other-sig/999/AAA'), 'served by b64url whatever the signature');
  // New signature for the same image (snapshot refetched): no second download.
  srv.articles[1] = { version: 'a2', content_version: 2, media: ['/m/s2/2/AAA'] };
  srv.calls.length = 0;
  const again = await RF.sync.run(db, runOpts(srv, { fetchFn: mediaFetch, caches, downloadMedia: true, shell: false }));
  assert.equal(again.mediaQueued, 0);
  assert.ok(!srv.paths().some((p) => p.startsWith('GET /m/')));
  // The article leaves the scope: its image is dropped from cache and index.
  delete srv.articles[1];
  await RF.sync.run(db, runOpts(srv, { fetchFn: mediaFetch, caches, shell: false }));
  assert.deepEqual(await RF.db.getMeta(db, 'media'), {});
  assert.deepEqual(await cache.keys(), []);
  db.close();
});

test('pages cache holds /app and its assets for this reader; the first v2 sync drops v1 shells and another reader\'s pages', async () => {
  const srv = fakeServer({ articles: arts(1) });
  const caches = fakeCaches();
  await (await caches.open('readfine-shell-2')).put('/app', new Response('old'));
  await (await caches.open('readfine-pages-9')).put('/app', new Response('reader 9'));
  await (await caches.open(RF.db.META_CACHE)).put(RF.db.MIRROR_URL, json({ uid: 7, offlineEnabled: true }));
  await RF.db.setCurrentUser(7, { offlineEnabled: true });
  const html = '<link rel="stylesheet" href="/static/css/tailwind.css?v=abc">'
    + '<script src="/static/js/htmx.min.js?v=1"></script><script src="/static/js/offline/db.js?v=2"></script>'
    // The scripts boot.js loads on demand are named, not script tags: cached too.
    + '<script src="/static/js/offline/boot.js?v=3" data-rf-scripts="/static/js/offline/db.js?v=2 /static/js/offline/page.js?v=4"></script>'
    + '<body data-rf-user="7"><a href="/settings">x</a><img src="https://cdn.example/x.png"></body>';
  const css = '@font-face{src:url(../fonts/inter.woff2)} .a{background:url("https://cdn.example/y.png")}';
  const fetchFn = async (url, init) => {
    const p = new URL(url, 'https://readfine.test');
    if (p.pathname === '/app') return new Response(html, { headers: { 'content-type': 'text/html' } });
    if (p.pathname === '/static/css/tailwind.css') return new Response(css);
    if (p.pathname.startsWith('/static/')) return new Response('asset');
    return srv.fetch(url, init);
  };
  const db = await RF.db.open(7);
  const rep = await RF.sync.run(db, runOpts(srv, { fetchFn, caches }));
  assert.equal(rep.shell, 'ok');
  assert.deepEqual((await caches.keys()).sort(), ['readfine-media-7', 'readfine-meta', 'readfine-pages-7']);
  assert.equal(rep.shellError, null);
  const cache = await caches.open('readfine-pages-7');
  assert.equal(await (await cache.match('/app?open_article_id=5', { ignoreSearch: true })).text(), html);
  const info = await (await cache.match('/__rf/pages-info')).json();
  assert.equal(info.templateVersion, 't1');
  assert.ok(Number.isFinite(Date.parse(info.savedAt)));
  const keys = (await cache.keys()).map((k) => new URL(k.url).pathname + new URL(k.url).search);
  assert.deepEqual(keys.sort(), ['/__rf/pages-info', '/app', '/static/css/tailwind.css?v=abc', '/static/fonts/inter.woff2',
    '/static/js/htmx.min.js?v=1', '/static/js/offline/boot.js?v=3', '/static/js/offline/db.js?v=2',
    '/static/js/offline/page.js?v=4']);
  db.close();
});

test('pages cache is not written from a login redirect', async () => {
  const srv = fakeServer({ articles: arts(1) });
  const caches = fakeCaches();
  const fetchFn = async (url, init) => {
    if (url === '/app') {
      const r = new Response('<html>login</html>');
      Object.defineProperty(r, 'redirected', { value: true });
      return r;
    }
    return srv.fetch(url, init);
  };
  const db = await RF.db.open(1);
  const rep = await RF.sync.run(db, runOpts(srv, { fetchFn, caches }));
  assert.equal(rep.error, null, 'a shell failure does not fail the sync');
  assert.equal(rep.shell, 'failed');
  assert.match(rep.shellError, /\/app not served/);
  assert.equal(await caches.has('readfine-pages-1'), false);
  db.close();
});

test('a failed asset leaves the previous /app in place', async () => {
  const srv = fakeServer();
  const caches = fakeCaches();
  const cssPath = '/static/css/tailwind.css';
  const jsPath = '/static/js/app.js';
  const shell = (version) => `<link href="${cssPath}?v=${version}">`
    + `<script src="${jsPath}?v=${version}"></script><body data-rf-user="7">${version}</body>`;
  const fetchFn = async (url, init) => {
    if (url === '/app') return new Response(shell(srv.templates));
    if (url === `${jsPath}?v=${srv.templates}` && srv.templates !== 't1') {
      return new Response('error', { status: 503 });
    }
    if (url.startsWith('/static/')) return new Response('asset');
    return srv.fetch(url, init);
  };
  const db = await RF.db.open(7);
  const opts = runOpts(srv, { fetchFn, caches });
  assert.equal((await RF.sync.run(db, opts)).shell, 'ok');
  const cache = caches.stores.get('readfine-pages-7');
  const keys = async () => (await cache.keys()).map(({ url }) => url).sort();
  const publishedKeys = await keys();
  const counts = [];
  for (let version = 2; version <= 13; version++) {
    srv.templates = `t${version}`;
    const next = await RF.sync.run(db, opts);
    assert.equal(next.error, null);
    assert.equal(next.shell, 'failed');
    assert.match(next.shellError, /app\.js\?v=t\d+ 503/);
    assert.equal(await (await cache.match('/app')).text(), shell('t1'));
    assert.equal((await (await cache.match('/__rf/pages-info')).json()).templateVersion, 't1');
    counts.push((await keys()).length);
  }
  assert.deepEqual(counts, Array(12).fill(publishedKeys.length));
  assert.deepEqual(await keys(), publishedKeys);
  db.close();
});

test('another reader\'s /app is refused', async () => {
  const srv = fakeServer();
  const caches = fakeCaches();
  const fetchFn = (url, init) => url === '/app'
    ? Promise.resolve(new Response('<html data-rf-user="7"><body data-rf-user="9"></body></html>'))
    : srv.fetch(url, init);
  const db = await RF.db.open(7);
  const rep = await RF.sync.run(db, runOpts(srv, { fetchFn, caches }));
  assert.equal(rep.shell, 'failed');
  assert.match(rep.shellError, /not this reader/);
  assert.equal(await caches.has('readfine-pages-7'), false);
  db.close();
});

test('a failed /app write leaves the previous cache metadata in place', async () => {
  const srv = fakeServer();
  const fontPath = '/static/fonts/shared.woff2';
  const undeletablePath = '/static/js/undeletable.js';
  const stagedPath = '/static/js/staged.js';
  const caches = fakeCaches({
    putHook(url) {
      if (srv.templates === 't2' && new URL(url).pathname === '/app') throw new Error('quota');
    },
  });
  const fetchFn = async (url, init) => {
    if (url === '/app') {
      const assets = srv.templates === 't1' ? '<link href="/static/css/old.css">'
        : `<link href="${fontPath}"><script src="${undeletablePath}"></script><script src="${stagedPath}"></script>`;
      return new Response(`${assets}<body data-rf-user="7">${srv.templates}</body>`);
    }
    if (url === '/static/css/old.css') return new Response(`@font-face{src:url(${fontPath})}`);
    if (url.startsWith('/static/')) return new Response('asset');
    return srv.fetch(url, init);
  };
  const db = await RF.db.open(7);
  const opts = runOpts(srv, { fetchFn, caches });
  assert.equal((await RF.sync.run(db, opts)).shell, 'ok');
  const cache = await caches.open('readfine-pages-7');
  // The update refills a missing dependency of the published stylesheet.
  assert.equal(await cache.delete(fontPath), true);
  const deleteEntry = cache.delete;
  cache.delete = async (url) => {
    if (new URL(url).pathname === undeletablePath) throw new Error('delete failed');
    return deleteEntry(url);
  };
  srv.templates = 't2';
  const next = await RF.sync.run(db, opts);
  assert.equal(next.shell, 'failed');
  assert.match(next.shellError, /quota/);
  assert.match(await (await cache.match('/app')).text(), /t1/);
  assert.equal((await (await cache.match('/__rf/pages-info')).json()).templateVersion, 't1');
  assert.ok(await cache.match(fontPath));
  assert.ok(await cache.match(undeletablePath));
  assert.equal(await cache.match(stagedPath), undefined);
  db.close();
});

test('every page sync retries the mirror (d4m1), even when the shell is skipped', async (t) => {
  // The a1 page promotion requires Web Locks, which older test runtimes lack.
  const localStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  if (!navigator.locks) {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: async (_name, fn) => fn() },
    });
    t.after(() => { delete navigator.locks; });
  }
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: {} },
    localStorage: { configurable: true, value: { getItem: () => null } },
  });
  t.after(() => {
    delete globalThis.document;
    if (localStorage) Object.defineProperty(globalThis, 'localStorage', localStorage);
    else delete globalThis.localStorage;
  });
  const srv = fakeServer();
  const caches = fakeCaches();
  await RF.db.setCurrentUser(7, { offlineEnabled: true });
  const db = await RF.db.open(7);
  const opts = runOpts(srv, { caches, shell: false });
  for (const status of [401, undefined]) {
    srv.status = status ? { '/sync/v1/manifest': status } : {};
    await caches.delete(RF.db.META_CACHE);
    assert.equal((await RF.db.readMirror(caches)).state, 'missing');
    const rep = await RF.sync.run(db, opts);
    assert.equal(rep.error, status ? 'auth' : null);
    assert.equal(rep.shell, 'skipped');
    assert.equal((await RF.db.readMirror(caches)).value?.uid, 7);
    assert.equal(rep.shellError, null);
  }
  db.close();
});

test('concurrent runs share one run', async () => {
  const srv = fakeServer({ articles: arts(1) });
  const db = await RF.db.open(1);
  const [a, b] = await Promise.all([RF.sync.run(db, runOpts(srv)), RF.sync.run(db, runOpts(srv))]);
  assert.equal(a, b);
  assert.equal(srv.paths().filter((p) => p === 'GET /sync/v1/manifest').length, 1);
  db.close();
});

test('wipeAll deletes databases and caches', async () => {
  const a = await RF.db.open(1);
  const b = await RF.db.open(2);
  await RF.db.setMeta(a, 'x', 1);
  // Someone else's database on the origin stays.
  await new Promise((res) => { const r = indexedDB.open('other-db'); r.onsuccess = () => { r.result.close(); res(); }; });
  const caches = fakeCaches();
  for (const n of ['readfine-media-1', 'readfine-media-2', 'readfine-shell-t1', 'unrelated']) await caches.open(n);
  await RF.db.wipeAll({ caches });
  const names = (await indexedDB.databases()).map((d) => d.name);
  assert.deepEqual(names, ['other-db']);
  assert.deepEqual(await caches.keys(), ['unrelated']);
  void b;
  // A fresh open after the wipe starts empty.
  const again = await RF.db.open(1);
  assert.equal(await RF.db.getMeta(again, 'x'), undefined);
  again.close();
});

test('a download cut off half way keeps what it stored; the next queue skips it', async () => {
  const media = ['/m/s/1/A', '/m/s/1/B', '/m/s/1/C'];
  const srv = fakeServer({ articles: { 1: { version: 'a', content_version: 1, media } } });
  const caches = fakeCaches();
  const db = await RF.db.open(1);
  const first = await RF.sync.run(db, runOpts(srv, { caches, shell: false }));
  let release;
  const hang = new Promise((r) => { release = r; });
  const fetchFn = async (url) => {
    if (url.endsWith('/C')) await hang; // the worker is suspended here
    return new Response(new Uint8Array(7));
  };
  const pending = RF.sync.downloadMedia(db, first.mediaQueue, { caches, fetchFn });
  assert.equal(RF.sync.downloadMedia(db, first.mediaQueue, { caches, fetchFn }), pending, 'one download at a time');
  for (let i = 0; i < 50 && Object.keys((await RF.db.getMeta(db, 'media')) || {}).length < 2; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.deepEqual(await RF.db.getMeta(db, 'media'), { '/m-cache/A': 7, '/m-cache/B': 7 });
  const next = await RF.sync.run(db, runOpts(srv, { caches, shell: false }));
  assert.deepEqual(next.mediaQueue, ['/m/s/1/C']);
  release();
  await pending;
  db.close();
});

test('images that can never be stored are not queued again', async () => {
  const srv = fakeServer({ articles: { 1: { version: 'a', content_version: 1, media: ['/m/s/1/GONE', '/m/s/1/OK'] } } });
  const caches = fakeCaches();
  const db = await RF.db.open(1);
  const rep = await RF.sync.run(db, runOpts(srv, { caches, shell: false }));
  const fetchFn = async (url) => (url.endsWith('GONE') ? new Response('', { status: 404 }) : new Response(new Uint8Array(3)));
  const res = await RF.sync.downloadMedia(db, rep.mediaQueue, { caches, fetchFn });
  assert.deepEqual(res.failed, { '/m-cache/GONE': 'http_404' });
  const again = await RF.sync.run(db, runOpts(srv, { caches, shell: false }));
  assert.equal(again.mediaQueued, 0);
  db.close();
});

test('lists are fetched again after ops were sent', async () => {
  const srv = fakeServer({ articles: arts(1) });
  const db = await RF.db.open(1);
  await RF.sync.run(db, runOpts(srv));
  await RF.db.enqueueOp(db, { type: 'read', article_id: 1 });
  const rep = await RF.sync.run(db, runOpts(srv));
  assert.equal(rep.listsFetched, true);
  db.close();
});

test('enqueueOp refuses what the server would refuse for the whole batch', async () => {
  const db = await RF.db.open(1);
  await assert.rejects(RF.db.enqueueOp(db, { type: 'bogus', article_id: 1 }));
  await assert.rejects(RF.db.enqueueOp(db, { type: 'read', article_id: 1, op_id: 'abc' }));
  await assert.rejects(RF.db.enqueueOp(db, { type: 'read', article_id: 1, value: [] }));
  await assert.rejects(RF.db.enqueueOp(db, { type: 'read', article_id: 1, at: 'yesterday' }));
  const op = await RF.db.enqueueOp(db, { type: 'mark_scope_read', value: { all: true, max_article_id: 9 } });
  assert.match(op.op_id, /^[0-9a-f-]{36}$/);
  assert.equal(op.article_id, null);
  assert.deepEqual((await RF.db.outboxEntries(db)).map((e) => e.op.type), ['mark_scope_read']);
  db.close();
});

// ---- fix round 1: poison and stuck ops, ordering, wipe races ------------------------

const opTypes = (srv) => srv.calls.filter((c) => c.path === '/sync/v1/ops').map((c) => c.body.ops.map((o) => o.type + ':' + o.article_id));

test('more than 500 ops go in several requests, in order', async () => {
  const srv = fakeServer({ articles: arts(1) });
  const db = await RF.db.open(1);
  for (let i = 1; i <= 501; i++) await RF.db.enqueueOp(db, { type: 'read', article_id: 1000 + i });
  const rep = await RF.sync.run(db, runOpts(srv));
  const sizes = srv.calls.filter((c) => c.path === '/sync/v1/ops').map((c) => c.body.ops.length);
  assert.deepEqual(sizes, [500, 1]);
  assert.equal(srv.calls[1].body.ops[0].article_id, 1501);
  assert.equal(rep.pendingOps, 0);
  db.close();
});

test('a request never carries two ops for one article', async () => {
  const srv = fakeServer({ articles: arts(1, 2) });
  const db = await RF.db.open(1);
  await RF.db.enqueueOp(db, { type: 'read', article_id: 1 });
  await RF.db.enqueueOp(db, { type: 'star', article_id: 2 });
  await RF.db.enqueueOp(db, { type: 'star', article_id: 1 });
  await RF.sync.run(db, runOpts(srv));
  assert.deepEqual(opTypes(srv), [['read:1', 'star:2'], ['star:1']]);
  db.close();
});

test('a poison op is isolated, kept for the user, and the run goes on', async () => {
  const srv = fakeServer({ articles: arts(1, 2, 3, 4, 5) });
  srv.opsHandler = (body) => (body.ops.some((o) => o.value.bad) ? json({ detail: 'bad' }, 422) : null);
  const db = await RF.db.open(1);
  await RF.sync.run(db, runOpts(srv));
  for (const id of [1, 2, 3, 4, 5]) {
    await RF.db.enqueueOp(db, { type: 'label_add', article_id: id, value: id === 3 ? { bad: true, label_id: 1 } : { label_id: 1 } });
  }
  srv.calls.length = 0;
  const rep = await RF.sync.run(db, runOpts(srv));
  assert.equal(rep.error, null);
  assert.ok(srv.paths().includes('GET /sync/v1/manifest'));
  assert.equal(rep.pendingOps, 0);
  assert.equal(rep.stuckOps.length, 1);
  assert.equal(rep.stuckOps[0].article_id, 3);
  assert.equal(rep.stuckOps[0].poison, true);
  assert.equal(rep.stuckOps[0].last_error, 'http_422');
  const stuck = await RF.db.stuckOps(db);
  assert.equal(stuck.length, 1);
  // Not sent again, and its article is no longer pinned.
  srv.articles[3].version = 'v3b';
  srv.calls.length = 0;
  await RF.sync.run(db, runOpts(srv));
  assert.ok(!srv.paths().includes('POST /sync/v1/ops'));
  assert.equal((await RF.db.get(db, 'articles', 3)).version, 'v3b');
  // The user retries it (refused again), then discards it.
  assert.equal(await RF.db.retryStuck(db, stuck[0].op.op_id), true);
  srv.calls.length = 0;
  await RF.sync.run(db, runOpts(srv));
  assert.deepEqual(opTypes(srv), [['label_add:3']]);
  assert.equal(await RF.db.discardStuck(db, stuck[0].op.op_id), true);
  assert.deepEqual(await RF.db.outboxEntries(db), []);
  db.close();
});

test('a final failed/invalid_url, failed/invalid or unknown reason is kept for the user; failed/not_found goes quietly', async () => {
  // Found by the e2e suite: a URL saved offline that the server cannot save
  // (save_url -> failed/invalid_url) vanished with its pending row and no word to the
  // reader, the "silently lost" the design rules out. Ruling R12: invalid_url and
  // invalid are kept as poison; not_found (the article is gone) and skipped are dropped.
  // Round 2: an unknown reason (a server newer than this client) is kept too.
  const srv = fakeServer({ articles: arts(1, 2, 3, 4) });
  srv.opsResult = (op) => {
    const reason = op.type === 'save_url' ? 'invalid_url'
      : op.article_id === 1 ? 'invalid' : op.article_id === 2 ? 'not_found'
        : op.article_id === 4 ? 'whatever' : null;
    return reason
      ? { op_id: op.op_id, status: 'failed', reason, retryable: false, article: null }
      : { op_id: op.op_id, status: 'skipped', reason: 'conflict', retryable: false, article: null };
  };
  const db = await RF.db.open(1);
  await RF.sync.run(db, runOpts(srv));
  await RF.db.enqueueOp(db, { type: 'save_url', value: { url: 'https://nowhere.invalid/a' } });
  await RF.db.enqueueOp(db, { type: 'label_add', article_id: 1, value: { label_id: 7 } });
  await RF.db.enqueueOp(db, { type: 'star', article_id: 2 });
  await RF.db.enqueueOp(db, { type: 'star', article_id: 3 });
  await RF.db.enqueueOp(db, { type: 'archive', article_id: 4 });
  const rep = await RF.sync.run(db, runOpts(srv));
  assert.equal(rep.error, null);
  assert.equal(rep.pendingOps, 0);
  const kept = rep.stuckOps.map((o) => [o.type, o.article_id ?? null, o.poison, o.last_error]);
  assert.deepEqual(kept, [
    ['save_url', null, true, 'failed/invalid_url'],
    ['label_add', 1, true, 'failed/invalid'],
    ['archive', 4, true, 'failed/whatever'],
  ]);
  const left = await RF.db.outboxEntries(db);
  assert.deepEqual(left.map((e) => e.op.type), ['save_url', 'label_add', 'archive']);
  // Not sent again until the reader retries; discarding removes them.
  srv.calls.length = 0;
  await RF.sync.run(db, runOpts(srv));
  assert.ok(!srv.paths().includes('POST /sync/v1/ops'));
  for (const e of left) assert.equal(await RF.db.discardStuck(db, e.op.op_id), true);
  assert.deepEqual(await RF.db.outboxEntries(db), []);
  db.close();
});

test('discardStuck leaves an op that is still in delivery', async () => {
  const db = await RF.db.open(1);
  const op = await RF.db.enqueueOp(db, { type: 'read', article_id: 1 });
  assert.equal(await RF.db.discardStuck(db, op.op_id), false);
  assert.equal(await RF.db.retryStuck(db, op.op_id), false);
  assert.equal((await RF.db.outboxEntries(db)).length, 1);
  db.close();
});

test('a 5xx caused by one op is isolated once the server answers the manifest', async () => {
  const srv = fakeServer({ articles: arts(1, 2, 3) });
  srv.opsHandler = (body) => (body.ops.some((o) => o.article_id === 2) ? json({}, 500) : null);
  const db = await RF.db.open(1);
  await RF.sync.run(db, runOpts(srv));
  for (const id of [1, 2, 3]) await RF.db.enqueueOp(db, { type: 'star', article_id: id });
  const rep = await RF.sync.run(db, runOpts(srv));
  assert.equal(rep.error, null);
  assert.equal(rep.pendingOps, 1);
  const [left] = await RF.db.outboxEntries(db);
  assert.equal(left.op.article_id, 2);
  assert.equal(left.op.attempts, 1);
  assert.equal(left.op.last_error, 'http_500');
  db.close();
});

test('a server that is down counts no attempts and stops the run', async () => {
  const srv = fakeServer({ articles: arts(1) });
  const db = await RF.db.open(1);
  await RF.db.enqueueOp(db, { type: 'star', article_id: 1 });
  await RF.db.enqueueOp(db, { type: 'star', article_id: 2 });
  srv.status['/sync/v1/'] = 503;
  const rep = await RF.sync.run(db, runOpts(srv));
  assert.equal(rep.error, 'http');
  assert.equal(rep.errorDetail, 503);
  assert.deepEqual((await RF.db.outboxEntries(db)).map((e) => e.op.attempts), [0, 0]);
  db.close();
});

test('a 403 is retried once with a fresh token; twice is a csrf stop', async () => {
  const srv = fakeServer({ articles: arts(1) });
  srv.opsHandler = (body, init) => (init.headers['x-csrftoken'] !== 'fresh' ? json({}, 403) : null);
  const db = await RF.db.open(1);
  await RF.db.enqueueOp(db, { type: 'star', article_id: 1 });
  const tokens = ['stale', 'fresh'];
  let asked = 0;
  const rep = await RF.sync.run(db, runOpts(srv, { csrfToken: () => tokens[Math.min(asked++, 1)] }));
  assert.equal(rep.error, null);
  assert.equal(asked >= 2, true);
  assert.equal(rep.pendingOps, 0);
  await RF.db.enqueueOp(db, { type: 'unstar', article_id: 1 });
  const bad = await RF.sync.run(db, runOpts(srv, { csrfToken: () => 'stale' }));
  assert.equal(bad.error, 'csrf');
  assert.equal(bad.pendingOps, 1);
  db.close();
});

test('an op retryable ten times is stuck and stops pinning its article', async () => {
  const srv = fakeServer({ articles: arts(1) });
  srv.opsResult = (op) => ({ op_id: op.op_id, status: 'failed', reason: 'error', retryable: true, article: null });
  const db = await RF.db.open(1);
  await RF.sync.run(db, runOpts(srv));
  const op = await RF.db.enqueueOp(db, { type: 'ai_summary', article_id: 1 });
  srv.articles[1].version = 'v1b';
  let rep;
  for (let i = 0; i < 9; i++) rep = await RF.sync.run(db, runOpts(srv));
  assert.equal(rep.pendingOps, 1);
  assert.equal((await RF.db.get(db, 'articles', 1)).version, 'v1', 'pinned while in delivery');
  rep = await RF.sync.run(db, runOpts(srv));
  assert.equal(rep.pendingOps, 0);
  assert.deepEqual(rep.stuckOps.map((o) => [o.op_id, o.attempts, o.stuck, o.last_error]),
    [[op.op_id, 10, true, 'failed/error']]);
  assert.equal((await RF.db.get(db, 'articles', 1)).version, 'v1b', 'no longer pinned');
  srv.calls.length = 0;
  await RF.sync.run(db, runOpts(srv));
  assert.ok(!srv.paths().includes('POST /sync/v1/ops'), 'not resent on its own');
  await RF.db.retryStuck(db, op.op_id);
  srv.opsResult = null;
  rep = await RF.sync.run(db, runOpts(srv));
  assert.equal(rep.pendingOps, 0);
  assert.deepEqual(rep.stuckOps, []);
  assert.deepEqual(await RF.db.outboxEntries(db), []);
  db.close();
});

test('later ops for an article wait while an earlier one is retryable', async () => {
  const srv = fakeServer({ articles: arts(1, 2) });
  const db = await RF.db.open(1);
  await RF.sync.run(db, runOpts(srv));
  let first = true;
  srv.opsResult = (op) => {
    const retry = op.type === 'label_add' && first;
    if (retry) first = false;
    return { op_id: op.op_id, status: retry ? 'failed' : 'applied', reason: retry ? 'error' : null, retryable: retry, article: null };
  };
  await RF.db.enqueueOp(db, { type: 'label_add', article_id: 1, value: { label_id: 4 } });
  await RF.db.enqueueOp(db, { type: 'read', article_id: 2 });
  await RF.db.enqueueOp(db, { type: 'label_remove', article_id: 1, value: { label_id: 4 } });
  srv.calls.length = 0;
  const rep = await RF.sync.run(db, runOpts(srv));
  assert.deepEqual(opTypes(srv), [['label_add:1', 'read:2']], 'label_remove not sent in the same run');
  assert.equal(rep.pendingOps, 2);
  srv.calls.length = 0;
  await RF.sync.run(db, runOpts(srv));
  assert.deepEqual(opTypes(srv), [['label_add:1'], ['label_remove:1']]);
  assert.deepEqual(await RF.db.outboxEntries(db), []);
  db.close();
});

test('an op the page makes mid-sync keeps its record from being overwritten', async () => {
  const srv = fakeServer({ articles: arts(1, 2) });
  const db = await RF.db.open(1);
  await RF.sync.run(db, runOpts(srv));
  srv.articles[1].version = 'server-new';
  srv.articles[2].version = 'server-new';
  const fetchFn = async (url, init) => {
    if (url === '/sync/v1/articles') await RF.db.enqueueOp(db, { type: 'star', article_id: 1 });
    return srv.fetch(url, init);
  };
  const rep = await RF.sync.run(db, runOpts(srv, { fetchFn }));
  assert.equal(rep.articles, 1);
  assert.equal((await RF.db.get(db, 'articles', 1)).version, 'v1');
  assert.equal((await RF.db.get(db, 'articles', 2)).version, 'server-new');
  db.close();
});

function gate() {
  let open;
  const p = new Promise((r) => { open = r; });
  return { p, open };
}

async function until(fn) {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(fn(), 'condition reached');
}

const readfineCaches = async (caches) => (await caches.keys()).filter((k) => k.startsWith('readfine-'));

for (const awaitWipeFirst of [true, false]) {
  test('a wipe during shell caching leaves no cache behind (' + (awaitWipeFirst ? 'wipe done first' : 'wipe waits') + ')', async () => {
    const srv = fakeServer({ articles: arts(1) });
    const caches = fakeCaches();
    const g = gate();
    let asked = false;
    const fetchFn = async (url, init) => {
      if (url === '/app') {
        asked = true;
        await g.p;
        return new Response('<script src="/static/js/app.js?v=1"></script><body data-rf-user="1"></body>');
      }
      if (url.startsWith('/static/')) return new Response('x');
      return srv.fetch(url, init);
    };
    const db = await RF.db.open(1);
    const running = RF.sync.run(db, runOpts(srv, { fetchFn, caches }));
    await until(() => asked);
    const wipe = RF.db.wipeAll({ caches, waitMs: awaitWipeFirst ? 5 : 5000 });
    if (awaitWipeFirst) await wipe;
    g.open();
    const rep = await running;
    await wipe;
    assert.equal(rep.error, 'wiped');
    assert.deepEqual(await readfineCaches(caches), []);
    assert.deepEqual((await indexedDB.databases()).map((d) => d.name), []);
  });

  test('a wipe during a media download leaves no cache behind (' + (awaitWipeFirst ? 'wipe done first' : 'wipe waits') + ')', async () => {
    const srv = fakeServer({ articles: { 1: { version: 'a', content_version: 1, media: ['/m/s/1/A', '/m/s/1/B'] } } });
    const caches = fakeCaches();
    const db = await RF.db.open(1);
    const rep = await RF.sync.run(db, runOpts(srv, { caches, shell: false }));
    const g = gate();
    let asked = false;
    const fetchFn = async (url) => {
      if (url.endsWith('/B')) { asked = true; await g.p; }
      return new Response(new Uint8Array(4));
    };
    const download = RF.sync.downloadMedia(db, rep.mediaQueue, { caches, fetchFn });
    await until(() => asked);
    const wipe = RF.db.wipeAll({ caches, waitMs: awaitWipeFirst ? 5 : 5000 });
    if (awaitWipeFirst) await wipe;
    g.open();
    const res = await download;
    await wipe;
    assert.equal(res.stoppedReason, 'wiped');
    assert.deepEqual(await readfineCaches(caches), []);
  });
}

test('a run started after a wipe on a stale handle does nothing', async () => {
  const srv = fakeServer({ articles: arts(1) });
  const caches = fakeCaches();
  const db = await RF.db.open(1);
  await RF.db.wipeAll({ caches });
  const rep = await RF.sync.run(db, runOpts(srv, { caches }));
  assert.equal(rep.error, 'wiped');
  assert.deepEqual(srv.calls, []);
  assert.deepEqual(await readfineCaches(caches), []);
});

test('a wipe from another context (versionchange) stops a run here too', async () => {
  const srv = fakeServer({ articles: arts(1) });
  const caches = fakeCaches();
  const g = gate();
  let asked = false;
  const fetchFn = async (url, init) => {
    if (url === '/app') { asked = true; await g.p; return new Response('<p>app</p>'); }
    return srv.fetch(url, init);
  };
  const db = await RF.db.open(1);
  const running = RF.sync.run(db, runOpts(srv, { fetchFn, caches }));
  await until(() => asked);
  // What wipeAll in the page does, as seen from the worker: the database goes away
  // (versionchange closes this handle) and the caches are deleted.
  await new Promise((res, rej) => { const r = indexedDB.deleteDatabase('readfine-offline-1'); r.onsuccess = res; r.onerror = rej; });
  for (const k of await caches.keys()) await caches.delete(k);
  assert.equal(db.closed, true);
  g.open();
  const rep = await running;
  assert.equal(rep.error, 'wiped');
  assert.deepEqual(await readfineCaches(caches), []);
});

// ---- fix round 2: budget skips, blocked-op holds, wipe cache cleanup ----------------

test('ops skipped for the server budget are resent, never counted, never stuck', async () => {
  const srv = fakeServer({ articles: arts(1) });
  const applied = new Set();
  // The server's per-request budget: 20 save_url, the rest skipped/rate_limited.
  srv.opsHandler = (body) => {
    let budget = 20;
    return json({ server_time: new Date(NOW).toISOString(), results: body.ops.map((op) => {
      if (op.type === 'save_url' && budget-- <= 0) {
        return { op_id: op.op_id, status: 'skipped', reason: 'rate_limited', retryable: true, article: null };
      }
      applied.add(op.op_id);
      return { op_id: op.op_id, status: 'applied', reason: null, retryable: false, article: null };
    }) });
  };
  const db = await RF.db.open(1);
  for (let i = 0; i < 250; i++) await RF.db.enqueueOp(db, { type: 'save_url', value: { url: 'https://x.test/' + i } });
  await RF.db.enqueueOp(db, { type: 'read', article_id: 1 });
  const rep = await RF.sync.run(db, runOpts(srv));
  const requests = srv.calls.filter((c) => c.path === '/sync/v1/ops').length;
  assert.equal(requests, 11, 'one request plus ten resends');
  assert.equal(rep.error, null);
  assert.equal(applied.size, 20 * 11 + 1);
  assert.deepEqual(rep.stuckOps, []);
  const left = await RF.db.outboxEntries(db);
  assert.equal(left.length, 30);
  assert.ok(left.every((e) => e.op.attempts === 0 && !e.op.stuck));
  const next = await RF.sync.run(db, runOpts(srv));
  assert.equal(next.pendingOps, 0);
  assert.equal(applied.size, 251);
  db.close();
});

test('budget resends stop when a pass gets nothing through', async () => {
  const srv = fakeServer({ articles: arts(1) });
  srv.opsResult = (op) => ({ op_id: op.op_id, status: 'skipped', reason: 'rate_limited', retryable: true, article: null });
  const db = await RF.db.open(1);
  await RF.db.enqueueOp(db, { type: 'extract_readable', article_id: 1 });
  const rep = await RF.sync.run(db, runOpts(srv));
  assert.equal(srv.calls.filter((c) => c.path === '/sync/v1/ops').length, 2);
  assert.equal(rep.pendingOps, 1);
  assert.equal((await RF.db.outboxEntries(db))[0].op.attempts, 0);
  db.close();
});

for (const resolve of ['retry', 'discard']) {
  test('later ops wait behind a poison op until it is ' + (resolve === 'retry' ? 'retried' : 'discarded'), async () => {
    const srv = fakeServer({ articles: arts(1) });
    let refuse = true;
    srv.opsHandler = (body) => (refuse && body.ops.some((o) => o.type === 'label_add') ? json({}, 422) : null);
    const db = await RF.db.open(1);
    await RF.sync.run(db, runOpts(srv));
    const add = await RF.db.enqueueOp(db, { type: 'label_add', article_id: 1, value: { label_id: 4 } });
    await RF.db.enqueueOp(db, { type: 'label_remove', article_id: 1, value: { label_id: 4 } });
    srv.calls.length = 0;
    let rep = await RF.sync.run(db, runOpts(srv));
    assert.deepEqual(opTypes(srv), [['label_add:1']], 'label_remove waits in the run that poisoned label_add');
    assert.equal(rep.pendingOps, 1);
    srv.calls.length = 0;
    await RF.sync.run(db, runOpts(srv));
    assert.deepEqual(opTypes(srv), [], 'and in later runs');
    refuse = false;
    if (resolve === 'retry') assert.equal(await RF.db.retryStuck(db, add.op_id), true);
    else assert.equal(await RF.db.discardStuck(db, add.op_id), true);
    srv.calls.length = 0;
    rep = await RF.sync.run(db, runOpts(srv));
    assert.deepEqual(opTypes(srv), resolve === 'retry' ? [['label_add:1'], ['label_remove:1']] : [['label_remove:1']]);
    assert.deepEqual(await RF.db.outboxEntries(db), []);
    db.close();
  });
}

test('wipeAll deletes the caches even when a database delete fails', async () => {
  const caches = fakeCaches();
  await caches.open('readfine-media-1');
  const real = indexedDB;
  const failing = {
    databases: () => Promise.resolve([{ name: 'readfine-offline-1' }]),
    deleteDatabase() {
      const r = {};
      setTimeout(async () => {
        // A writer recreates a cache while the delete is in progress, then it fails.
        await caches.open('readfine-shell-t9');
        r.error = new Error('UnknownError');
        r.onerror();
      }, 1);
      return r;
    },
  };
  void real;
  await assert.rejects(RF.db.wipeAll({ indexedDB: failing, caches }), /not deleted/);
  const mirror = await RF.db.readMirror(caches);
  assert.equal(mirror.state, 'ok');
  assert.equal(mirror.value.uid, null);
  assert.equal(mirror.value.wipePending, true);
  assert.deepEqual(await caches.keys(), [RF.db.META_CACHE]);
});

test('run reports progress for articles, snapshots and images; a throwing callback is harmless', async () => {
  const srv = fakeServer({ articles: {
    1: { version: 'a', content_version: 1, media: ['/m/s1/1/AAA'] },
    2: { version: 'b', content_version: 1, media: ['/m/s2/2/BBB'] },
  } });
  const mediaFetch = async (url, init) => (url.startsWith('/m/')
    ? new Response(new Uint8Array(4), { headers: { 'content-type': 'image/png' } })
    : srv.fetch(url, init));
  const seen = [];
  const db = await RF.db.open(1);
  const rep = await RF.sync.run(db, runOpts(srv, {
    fetchFn: mediaFetch, caches: fakeCaches(), downloadMedia: true, shell: false,
    onProgress: (p) => { seen.push(p.stage + ' ' + p.done + '/' + p.total); throw new Error('display bug'); },
  }));
  assert.equal(rep.error, null);
  assert.equal(rep.media.stored, 2);
  assert.deepEqual(seen, ['articles 0/2', 'articles 2/2', 'snapshots 0/2', 'snapshots 2/2',
    'media 0/2', 'media 1/2', 'media 2/2']);
  db.close();
});

test('the image budget comes from the server (manifest limits.media_budget_mb)', async () => {
  const srv = fakeServer({ articles: {
    1: { version: 'a', content_version: 1, media: ['/m/s1/1/AAA', '/m/s1/1/BBB'] },
  } });
  // 1 MB budget; each image is 600 KB: the second one does not fit.
  srv.limits = { media_budget_mb: 1 };
  const caches = fakeCaches();
  const mediaFetch = async (url, init) => {
    if (url.startsWith('/m/')) return new Response(new Uint8Array(600 * 1024), { headers: { 'content-type': 'image/png' } });
    return srv.fetch(url, init);
  };
  const db = await RF.db.open(1);
  const rep = await RF.sync.run(db, runOpts(srv, { fetchFn: mediaFetch, caches, downloadMedia: true, shell: false }));
  assert.equal(rep.mediaBudgetBytes, 1024 * 1024);
  assert.equal(rep.media.stored, 1);
  assert.equal(rep.media.stoppedReason, 'budget');
  // Without limits in the manifest, media.js's default applies.
  srv.limits = undefined;
  const plain = await RF.sync.run(db, runOpts(srv, { fetchFn: mediaFetch, caches, shell: false }));
  assert.equal(plain.mediaBudgetBytes, undefined);
  db.close();
});

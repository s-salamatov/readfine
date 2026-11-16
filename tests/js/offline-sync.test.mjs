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
    failSnapshots: false,
    opsResult: null, // (op) => result
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
      case '/sync/v1/ops':
        return json({ server_time: new Date(NOW).toISOString(), results: body.ops.map((op) =>
          s.opsResult ? s.opsResult(op) : { op_id: op.op_id, status: 'applied', reason: null, retryable: false,
            article: s.articles[op.article_id] ? rec(op.article_id) : null }) });
      case '/sync/v1/manifest':
        return json({
          server_time: new Date(NOW).toISOString(),
          articles: Object.keys(s.articles).map(Number).map((id) => [id, s.articles[id].version]),
          lists: { folders: s.listsVersion, feeds: s.listsVersion, labels: s.listsVersion,
                   saved_searches: s.listsVersion, prefs: s.prefs, templates: s.templates },
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
  const srv = fakeServer({ articles: arts(1) });
  const db = await RF.db.open(1);
  await RF.db.enqueueOp(db, { type: 'star', article_id: 1, at: new Date(NOW - 1000) });
  await RF.db.enqueueOp(db, { type: 'read', article_id: 1 });
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

test('401 stops the run and keeps data and outbox', async () => {
  const srv = fakeServer({ articles: arts(1, 2) });
  const db = await RF.db.open(1);
  await RF.sync.run(db, runOpts(srv));
  await RF.db.enqueueOp(db, { type: 'star', article_id: 1 });
  srv.status['/sync/v1/'] = 401;
  delete srv.articles[2];
  const rep = await RF.sync.run(db, runOpts(srv));
  assert.equal(rep.error, 'auth');
  assert.equal(rep.pendingOps, 1);
  assert.deepEqual(srv.paths().slice(-1), ['POST /sync/v1/ops']);
  assert.deepEqual(await RF.db.readyIds(db), [1, 2]);
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

test('shell cache stores /app and its static files, drops older shells', async () => {
  const srv = fakeServer({ articles: arts(1) });
  const caches = fakeCaches();
  (await caches.open('readfine-shell-t0')).put('https://readfine.test/app', new Response('old'));
  const html = '<link rel="stylesheet" href="/static/css/tailwind.css?v=abc">'
    + '<script src="/static/js/htmx.min.js?v=1"></script><script src="/static/js/offline/db.js?v=2"></script>'
    + '<a href="/settings">x</a><img src="https://cdn.example/x.png">';
  const css = '@font-face{src:url(../fonts/inter.woff2)} .a{background:url("https://cdn.example/y.png")}';
  const fetchFn = async (url, init) => {
    const p = new URL(url, 'https://readfine.test');
    if (p.pathname === '/app') return new Response(html, { headers: { 'content-type': 'text/html' } });
    if (p.pathname === '/static/css/tailwind.css') return new Response(css);
    if (p.pathname.startsWith('/static/')) return new Response('asset');
    return srv.fetch(url, init);
  };
  const db = await RF.db.open(1);
  const rep = await RF.sync.run(db, runOpts(srv, { fetchFn, caches }));
  assert.equal(rep.shell, 'ok');
  assert.deepEqual(await caches.keys(), ['readfine-media-1', 'readfine-shell-t1']);
  const keys = (await (await caches.open('readfine-shell-t1')).keys()).map((k) => new URL(k.url).pathname + new URL(k.url).search);
  assert.deepEqual(keys.sort(), ['/app', '/static/css/tailwind.css?v=abc', '/static/fonts/inter.woff2',
    '/static/js/htmx.min.js?v=1', '/static/js/offline/db.js?v=2']);
  db.close();
});

test('shell cache is not written from a login redirect', async () => {
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
  assert.ok(!(await caches.keys()).some((k) => k.startsWith('readfine-shell-')));
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

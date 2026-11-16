// Offline local search (offline/search.js, the `q` path of lists.js, the search window
// of router.js, and the reindex step of sync.js).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { loadOffline } from './harness.mjs';

const RF = await loadOffline();

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  RF.router.clearOpenCopies();
});

function rec(id, title, over = {}) {
  return Object.assign({
    id, feed_id: 10, title, url: 'https://example.com/' + id, published_at: new Date(Date.parse('2026-11-16T00:00:00Z') + id * 60000).toISOString(),
    fetched_at: '2026-11-16T00:00:00+00:00', story_id: null, is_read: false, is_starred: false, is_archived: false,
    saved_at: null, label_ids: [], version: 'v' + id, content_version: 1,
  }, over);
}

// The detail snapshot as the server renders it: chrome (buttons, svg) around the body
// container, which is what the index reads.
function detail(id, body) {
  return '<div id="article-detail-root"><article class="reading-area">'
    + '<button data-header-star><svg><title>chromeword</title></svg>Chromebutton</button>'
    + '<div id="article-content-' + id + '"><div class="prose">' + body + '</div></div></article></div>';
}

async function store(items) {
  const db = await RF.db.open(1);
  await RF.db.putRecords(db, items.map((i) => i.rec));
  await RF.db.putSnapshots(db, items.map((i) => ({
    id: i.rec.id, content_version: 1, template_version: 't', prefs_version: 'p',
    row_html: '<div id="article-row-' + i.rec.id + '" data-article-id="' + i.rec.id + '" data-rf-article="' + i.rec.id + '"><a data-article-title>' + i.rec.title + '</a></div>',
    detail_html: detail(i.rec.id, i.body), media: [],
  })));
  await RF.db.putMany(db, 'lists', [
    { name: 'folders', items: [] }, { name: 'labels', items: [] }, { name: 'saved_searches', items: [] },
    { name: 'feeds', items: [{ user_feed_id: 100, feed_id: 10, title: 'A', folder_id: null, position: 0 }] },
    { name: 'prefs', items: { timezone: 'UTC', default_sort_order: 'newest', articles_per_page: 50, story_dedup: 'collapse', format_profile: 'iso' } },
  ]);
  return db;
}

const A = { rec: rec(1, 'Weekly roundup'), body: '<p>The <b>lighthouse</b> keeper wrote about tides &amp; storms.</p><script>evilscript()</script>' };
const B = { rec: rec(2, 'Cooking notes'), body: '<p>A small café near the harbour serves bread. Send your résumé.</p>' };
const C = { rec: rec(3, 'Space news'), body: '<p>Telescopes watch distant galaxies.</p>' };

test('finds article by word in body', async () => {
  const db = await store([A, B, C]);
  await RF.search.rebuild(db);
  assert.deepEqual(await RF.search.query(db, 'lighthouse'), [1]);
  assert.deepEqual(await RF.search.query(db, 'storms tides'), [1]);   // all words
  assert.deepEqual(await RF.search.query(db, 'galaxies'), [3]);
  assert.deepEqual(await RF.search.query(db, 'nothingmatchesthis'), []);
});

test('title words match too', async () => {
  const db = await store([A, B]);
  await RF.search.rebuild(db);
  assert.deepEqual(await RF.search.query(db, 'cooking'), [2]);
});

test('tags, scripts and the detail chrome are not indexed', async () => {
  const db = await store([A]);
  await RF.search.rebuild(db);
  assert.deepEqual(await RF.search.query(db, 'evilscript'), []);
  assert.deepEqual(await RF.search.query(db, 'chromebutton'), []);
  assert.deepEqual(await RF.search.query(db, 'chromeword'), []);
  assert.deepEqual(await RF.search.query(db, 'prose'), []);
  assert.deepEqual(await RF.search.query(db, 'tides storms'), [1]);   // &amp; decoded, not a term
});

test('prefix match', async () => {
  const db = await store([A, B, C]);
  await RF.search.rebuild(db);
  assert.deepEqual(await RF.search.query(db, 'lighth'), [1]);
  assert.deepEqual(await RF.search.query(db, 'telesc'), [3]);
});

test('typo within the fuzzy tolerance still matches', async () => {
  const db = await store([A, C]);
  await RF.search.rebuild(db);
  assert.deepEqual(await RF.search.query(db, 'lighthose'), [1]);
});

test('accent-insensitive (cafe matches café)', async () => {
  const db = await store([A, B]);
  await RF.search.rebuild(db);
  assert.deepEqual(await RF.search.query(db, 'cafe'), [2]);
  assert.deepEqual(await RF.search.query(db, 'CAFÉ'), [2]);
  assert.deepEqual(await RF.search.query(db, 'caf'), [2]);
  // two accents: beyond what fuzzy matching alone would forgive
  assert.deepEqual(await RF.search.query(db, 'resume'), [2]);
  assert.deepEqual(await RF.search.query(db, 'RÉSUMÉ'), [2]);
});

test('removed article not returned after rebuild', async () => {
  const db = await store([A, B]);
  await RF.search.rebuild(db);
  await RF.db.removeArticles(db, [1]);
  // Before any rebuild the stale index still knows the article, but it is not returned.
  assert.deepEqual(await RF.search.query(db, 'lighthouse'), []);
  await RF.search.rebuild(db);
  assert.deepEqual(await RF.search.query(db, 'lighthouse'), []);
  assert.deepEqual(await RF.search.query(db, 'harbour'), [2]);
});

test('a rebuild is picked up by a reader that cached the previous index', async () => {
  const db = await store([A]);
  await RF.search.rebuild(db);
  assert.deepEqual(await RF.search.query(db, 'galaxies'), []);   // loads and caches
  await RF.db.putRecords(db, [C.rec]);
  await RF.db.putSnapshots(db, [{ id: 3, content_version: 1, template_version: 't', prefs_version: 'p', row_html: '<div></div>', detail_html: detail(3, C.body), media: [] }]);
  assert.deepEqual(await RF.search.query(db, 'galaxies'), []);   // not rebuilt yet
  await RF.search.rebuild(db);
  assert.deepEqual(await RF.search.query(db, 'galaxies'), [3]);
});

test('no index: lookup is null and the list falls back to the title match', async () => {
  const db = await store([A, B]);
  assert.equal(await RF.search.lookup(db, 'lighthouse'), null);
  assert.deepEqual(await RF.lists.query(db, new URLSearchParams('q=cooking')), [2]);
  assert.deepEqual(await RF.lists.query(db, new URLSearchParams('q=lighthouse')), []);
});

test('ensure rebuilds only when the stored articles changed', async () => {
  const db = await store([A, B]);
  assert.equal(await RF.search.ensure(db), true);
  assert.equal(await RF.search.ensure(db), false);
  await RF.db.putRecords(db, [rec(1, 'Weekly roundup', { content_version: 2, version: 'v1b' })]);
  assert.equal(await RF.search.ensure(db), true);
  await RF.db.removeArticles(db, [2]);
  assert.equal(await RF.search.ensure(db), true);
  assert.equal(await RF.search.ensure(db), false);
});

test('the list searches the body through the index', async () => {
  const db = await store([A, B, C]);
  await RF.search.rebuild(db);
  assert.deepEqual(await RF.lists.query(db, new URLSearchParams('q=lighthouse')), [1]);
  const res = await RF.router.handle(new Request('https://readfine.test/htmx/articles?q=harbour'), db);
  const html = await res.text();
  assert.deepEqual([...html.matchAll(/id="article-row-(\d+)"/g)].map((m) => +m[1]), [2]);
  assert.match(html, /1 result/);
  assert.match(html, /Searching articles on this device/);
});

test('offline search modal shows "Searching articles on this device"', async () => {
  const db = await store([A]);
  const res = await RF.router.handle(new Request('https://readfine.test/htmx/search-modal?q=tides'), db);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Searching articles on this device/);
  assert.match(html, /id="search-input" value="tides"/);
  assert.match(html, /data-action="submit-search"/);
  assert.doesNotMatch(html, /needs a connection/i);
});

test('wiping the database drops the index', async () => {
  const db = await store([A]);
  await RF.search.rebuild(db);
  assert.deepEqual(await RF.search.query(db, 'lighthouse'), [1]);
  await RF.db.wipeAll({ caches: { keys: async () => [], delete: async () => true } });
  const again = await RF.db.open(1);
  assert.equal(await RF.search.lookup(again, 'lighthouse'), null);
});

// ---- sync keeps the index current ---------------------------------------------------

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function server(articles) {
  return async (url, init = {}) => {
    const u = new URL(url, 'https://readfine.test/');
    const body = init.body ? JSON.parse(init.body) : null;
    const ver = (id) => ({ id, title: articles[id].title, version: 'v' + id, content_version: 1, published_at: null, is_read: false, label_ids: [] });
    switch (u.pathname) {
      case '/sync/v1/ops': return json({ server_time: '2026-11-16T10:00:00Z', results: [] });
      case '/sync/v1/manifest':
        return json({ server_time: '2026-11-16T10:00:00Z', articles: Object.keys(articles).map((id) => [+id, 'v' + id]),
          lists: { folders: 'l', feeds: 'l', labels: 'l', saved_searches: 'l', prefs: 'p', templates: 't' } });
      case '/sync/v1/articles': return json({ articles: body.ids.filter((id) => articles[id]).map(ver) });
      case '/sync/v1/snapshots':
        return json({ snapshots: u.searchParams.get('ids').split(',').map(Number).filter((id) => articles[id]).map((id) => ({
          id, content_version: 1, template_version: 't', prefs_version: 'p', row_html: '<div></div>',
          detail_html: detail(id, articles[id].body), media: [] })) });
      case '/sync/v1/lists':
        return json({ folders: [], feeds: [], labels: [], saved_searches: [], prefs: {},
          versions: { folders: 'l', feeds: 'l', labels: 'l', saved_searches: 'l', prefs: 'p', templates: 't' } });
      default: return new Response('nf', { status: 404 });
    }
  };
}

test('a sync run builds the index and drops removed articles from it', async () => {
  const articles = { 1: { title: 'One', body: '<p>lighthouse</p>' }, 2: { title: 'Two', body: '<p>harbour</p>' } };
  const db = await RF.db.open(1);
  const opts = { fetchFn: server(articles), now: () => Date.parse('2026-11-16T10:00:00Z'), csrfToken: 't', shell: false };
  const rep = await RF.sync.run(db, opts);
  assert.equal(rep.error, null);
  assert.deepEqual(await RF.search.query(db, 'lighthouse'), [1]);
  assert.deepEqual(await RF.search.query(db, 'harbour'), [2]);
  delete articles[1];
  articles[3] = { title: 'Three', body: '<p>galaxies</p>' };
  await RF.sync.run(db, opts);
  assert.deepEqual(await RF.search.query(db, 'lighthouse'), []);
  assert.deepEqual(await RF.search.query(db, 'galaxies'), [3]);
  const idx = await RF.db.getMeta(db, 'searchIndex');
  assert.equal(idx.n, 2);
});

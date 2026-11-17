// Offline router in the service worker (offline/router.js, lists.js, templates.js, sw.js).
//
// The device store is real (fake-indexeddb); snapshots are small hand-made fragments
// carrying the same hooks as article_row.html / article_detail.html (task 7 contract).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import { loadOffline, fakeCaches, overlayPage, SW_JS, STATIC_DIR } from './harness.mjs';

const RF = await loadOffline();

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  RF.router.clearOpenCopies();
});

function rowHtml(id, density = 'comfortable') {
  return '<div id="article-row-' + id + '" class="article-row border-b border-gray-100 cursor-pointer  pl-2 pr-4"'
    + ' data-article-id="' + id + '" data-rf-article="' + id + '" data-rf-read-classes="opacity-75" data-rf-unread-classes=""'
    + ' data-density="' + density + '" data-is-read="false" hx-get="/htmx/articles/' + id + '">'
    + '<button data-star-btn data-rf-slot="star-button" title="Star article"><span class="text-lg text-gray-300 hover:text-gray-500">☆</span></button>'
    + '<a data-article-title data-rf-read-classes="font-medium text-gray-800" data-rf-unread-classes="font-bold text-gray-900" class="text-sm font-bold text-gray-900">Title ' + id + '</a>'
    + '<span data-archived-indicator data-rf-slot="archive-button" class="text-[10px] hidden">· archived</span>'
    + '<div id="article-labels-' + id + '" data-rf-slot="labels" class="flex items-center"><button data-label-trigger>o</button></div>'
    + '<span class="text-xs text-gray-500"><time datetime="2026-11-16T09:00:00+00:00" data-rf-time="2026-11-16T09:00:00+00:00">09:00</time></span>'
    + '<div data-rf-slot="related-count" data-rf-placeholder></div></div>';
}

function detailHtml(id) {
  return '<div id="article-detail-root" data-article-id="' + id + '" data-rf-article="' + id + '">'
    + '<article class="reading-area" data-article-id="' + id + '" data-is-read="false">'
    + '<button data-header-star data-rf-slot="star-button"><svg fill="none"></svg><span data-label>Star</span></button>'
    + '<button data-show-chat-modal="' + id + '" data-rf-online-only>Chat</button>'
    + '<div class="hidden"><div id="star-btn-' + id + '" data-rf-slot="star-button"><button title="Star article"><span class="text-lg text-gray-300 hover:text-gray-500">☆</span></button></div>'
    + '<div id="read-btn-' + id + '" data-rf-slot="read-button"><button>○ Unread</button></div></div>'
    + '<div class="mb-5 space-y-3" data-rf-placeholder="ai"><div data-rf-slot="ai-summary"><div id="ai-summary-' + id + '" class="ai-loading-indicator"></div></div>'
    + '<div id="ai-context-area-' + id + '" data-rf-slot="ai-context"><div id="ai-context-' + id + '"></div></div></div>'
    + '<div data-rf-slot="related-count" data-rf-placeholder></div>'
    + '</article></div>';
}

function rec(id, over = {}) {
  return Object.assign({
    id, feed_id: 10, title: 'Title ' + id, url: 'https://example.com/' + id, author: null,
    published_at: new Date(Date.parse('2026-11-16T00:00:00Z') + id * 60000).toISOString(),
    fetched_at: '2026-11-16T00:00:00+00:00', story_id: null, image_url: null, is_read: false,
    is_starred: false, is_archived: false, saved_at: null, hidden_at: null, share_token: null,
    ai_score: null, lexical_score: null, ai_summary: null, ai_summary_truncated: false, ai_context: null,
    ai_summary_html: null, ai_context_html: null, label_ids: [], version: 'v' + id, content_version: 1,
  }, over);
}

const LISTS = {
  folders: [{ id: 1, name: 'Tech', position: 0 }, { id: 2, name: 'News', position: 1 }],
  feeds: [
    { user_feed_id: 100, feed_id: 10, title: 'Feed A', folder_id: 1, position: 0 },
    { user_feed_id: 101, feed_id: 11, title: 'Feed B', folder_id: 2, position: 0 },
    { user_feed_id: 102, feed_id: 12, title: 'Feed C', folder_id: null, position: 0 },
  ],
  labels: [{ id: 7, name: 'Keep', color: '#ff0000', position: 0 }],
  saved_searches: [],
  prefs: { timezone: 'UTC', default_sort_order: 'newest', articles_per_page: 50, story_dedup: 'collapse',
    label_display: 'indicator', format_profile: 'iso', mark_read_on_scroll: true },
};

async function store(records, lists = {}) {
  const db = await RF.db.open(1);
  await RF.db.putRecords(db, records);
  await RF.db.putSnapshots(db, records.map((r) => ({
    id: r.id, content_version: 1, template_version: 't', prefs_version: 'p',
    row_html: rowHtml(r.id), detail_html: detailHtml(r.id), media: [],
  })));
  const all = Object.assign({}, LISTS, lists);
  await RF.db.putMany(db, 'lists', Object.keys(all).map((name) => ({ name, items: all[name] })));
  return db;
}

function get(p) { return new Request('https://readfine.test' + p); }
function post(p, body = '', type = 'application/x-www-form-urlencoded') {
  return new Request('https://readfine.test' + p, { method: 'POST', body, headers: { 'content-type': type } });
}
async function ops(db) { return (await RF.db.outboxEntries(db)).map((e) => e.op); }
function rowIds(html) { return [...html.matchAll(/id="article-row-(\d+)"/g)].map((m) => +m[1]); }
function islandOf(html) {
  const m = /<script type="application\/json" data-rf-state>([\s\S]*?)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}

// ---- lists ---------------------------------------------------------------------------

test('list query unread folder sorted newest', async () => {
  const db = await store([
    rec(1), rec(2, { is_read: true }), rec(3), rec(4, { feed_id: 11 }), rec(5),
  ]);
  const ids = await RF.lists.query(db, new URLSearchParams('folder_id=1&unread_only=true'));
  assert.deepEqual(ids, [5, 3, 1]);
  // Through the router: the same rows, in that order, plus the list config island.
  const res = await RF.router.handle(get('/htmx/articles?folder_id=1&unread_only=true'), db);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.deepEqual(rowIds(body), [5, 3, 1]);
  assert.match(body, /id="article-list-cfg"/);
  assert.deepEqual(Object.keys(islandOf(body).records).map(Number).sort(), [1, 3, 5]);
});

test('list query saved search uses member ids', async () => {
  const db = await store([rec(1), rec(2), rec(3, { feed_id: 999 }), rec(4)], {
    saved_searches: [{ id: 9, name: 'Mine', params: { q: 'nothing matches this' }, member_ids: [1, 3, 99] }],
  });
  // Member ids decide, not the stored query; an id not on the device is skipped, and a
  // member from an unsubscribed feed still counts (search views are feed-optional).
  assert.deepEqual(await RF.lists.query(db, new URLSearchParams('saved_search_id=9')), [3, 1]);
  assert.deepEqual(await RF.lists.query(db, new URLSearchParams('view_id=9')), [3, 1]);
  const body = await (await RF.router.handle(get('/htmx/articles?saved_search_id=9'), db)).text();
  assert.match(body, /data-saved-search-id="9"/);
});

test('story collapsing shows one row per story', async () => {
  const db = await store([
    rec(1, { story_id: 50 }), rec(2, { story_id: 50 }), rec(3), rec(4, { story_id: 50, is_read: true }),
  ]);
  assert.deepEqual(await RF.lists.query(db, new URLSearchParams('')), [3, 2]);
  const body = await (await RF.router.handle(get('/htmx/articles'), db)).text();
  const state = islandOf(body);
  assert.equal(state.interactive, true);
  assert.deepEqual(state.stories['2'], { others: 2, total: 2, read: 1 });
  // A single feed does not fold.
  assert.deepEqual(await RF.lists.query(db, new URLSearchParams('feed_id=10')), [3, 2, 1]);
  // Story dedup off: nothing folds.
  await RF.db.put(db, 'lists', { name: 'prefs', items: Object.assign({}, LISTS.prefs, { story_dedup: 'off' }) });
  assert.deepEqual(await RF.lists.query(db, new URLSearchParams('')), [3, 2, 1]);
});

test('load more pages by cursor and carries the shown stories', async () => {
  const many = [];
  for (let i = 1; i <= 7; i++) many.push(rec(i, { story_id: i <= 2 ? 70 : null }));
  const db = await store(many, { prefs: Object.assign({}, LISTS.prefs, { articles_per_page: 3 }) });
  const first = await (await RF.router.handle(get('/htmx/articles'), db)).text();
  assert.deepEqual(rowIds(first), [7, 6, 5]);
  const more = /hx-get="\/htmx\/articles\/more\?([^"]+)"/.exec(first)[1].replace(/&amp;/g, '&');
  const params = new URLSearchParams(more);
  assert.equal(params.get('cursor_id'), '5');
  assert.equal(params.get('unread_only'), 'true');
  // Rows marked read meanwhile do not shift the window.
  const page2 = await (await RF.router.handle(get('/htmx/articles/more?' + more), db)).text();
  assert.deepEqual(rowIds(page2), [4, 3, 2]);
  const p3 = new URLSearchParams(/hx-get="\/htmx\/articles\/more\?([^"]+)"/.exec(page2)[1].replace(/&amp;/g, '&'));
  assert.equal(p3.get('shown_stories'), '70');
  // Story 70 already has a row (2): its other member does not come back as a row.
  const page3 = await (await RF.router.handle(get('/htmx/articles/more?' + p3.toString()), db)).text();
  assert.deepEqual(rowIds(page3), []);
});

test('the list config carries the title bar count of label and starred views', async () => {
  const db = await store([rec(1, { label_ids: [7] }), rec(2, { label_ids: [7], is_read: true }), rec(3, { is_starred: true })]);
  const cfg = (body) => JSON.parse(/id="article-list-cfg">([^<]*)</.exec(body)[1]);
  const label = cfg(await (await RF.router.handle(get('/htmx/articles?label_id=7'), db)).text());
  assert.deepEqual([label.titleBarCount, label.titleBarCountType], [1, 'unread']);
  const starred = cfg(await (await RF.router.handle(get('/htmx/articles?starred_only=true'), db)).text());
  assert.deepEqual([starred.titleBarCount, starred.titleBarCountType], [1, 'starred']);
  const plain = cfg(await (await RF.router.handle(get('/htmx/articles'), db)).text());
  assert.equal(plain.titleBarCount, null);
});

test('feedless and unsubscribed articles show only in state and label views', async () => {
  const db = await store([rec(1), rec(2, { feed_id: null, saved_at: '2026-11-16T00:00:00+00:00' }), rec(3, { feed_id: 999, is_starred: true })]);
  assert.deepEqual(await RF.lists.query(db, new URLSearchParams('')), [1]);
  assert.deepEqual(await RF.lists.query(db, new URLSearchParams('saved_only=true')), [2]);
  assert.deepEqual(await RF.lists.query(db, new URLSearchParams('starred_only=true')), [3]);
});

// ---- detail --------------------------------------------------------------------------

test('article detail served from snapshot with overlay', async () => {
  const db = await store([rec(5, { is_starred: true, is_read: true, ai_summary_html: '<p>Short </script> summary</p>' })]);
  const res = await RF.router.handle(get('/htmx/articles/5'), db);
  const body = await res.text();
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  // The island cannot be closed early by stored HTML.
  assert.equal((body.match(/<\/script>/g) || []).length, 1);
  const w = overlayPage('<main id="article-detail"></main>');
  const out = w.RFOffline.overlay.transform(body, w.document);
  w.document.getElementById('article-detail').innerHTML = out;
  const d = w.document;
  assert.equal(d.querySelector('script[data-rf-state]'), null);
  assert.equal(d.querySelector('[data-header-star] svg').getAttribute('fill'), 'currentColor');
  assert.equal(d.querySelector('[data-header-star] [data-label]').textContent, 'Starred');
  assert.match(d.getElementById('star-btn-5').innerHTML, /★/);
  assert.equal(d.querySelector('article.reading-area').getAttribute('data-is-read'), 'true');
  assert.match(d.getElementById('ai-summary-5').textContent, /Short/);
  assert.ok(!d.querySelector('[data-rf-placeholder="ai"]').classList.contains('hidden'));
  const chat = d.querySelector('[data-rf-online-only]');
  assert.ok(chat.hasAttribute('disabled'));
  assert.equal(chat.getAttribute('title'), 'Needs a connection');
});

test('test_removed_article_kept_while_open', async () => {
  const db = await store([rec(1), rec(2)]);
  const opened = await (await RF.router.handle(get('/htmx/articles/2'), db)).text();
  assert.match(opened, /article-detail-root/);
  // A sync removes it while it is open (read elsewhere).
  await RF.db.removeArticles(db, [2]);
  const again = await (await RF.router.handle(get('/htmx/articles/2'), db)).text();
  assert.match(again, /article-detail-root/);
  // Acting on it still works from the open copy and queues the op, without putting the
  // record back in the store.
  const star = await RF.router.handle(post('/htmx/articles/2/star'), db);
  assert.equal(star.status, 200);
  assert.deepEqual((await ops(db)).map((o) => [o.type, o.article_id]), [['star', 2]]);
  assert.equal(await RF.db.get(db, 'articles', 2), undefined);
  // The next list leaves it out.
  assert.deepEqual(await RF.lists.query(db, new URLSearchParams('')), [1]);
  // An article never opened and not stored has no copy.
  const missing = await (await RF.router.handle(get('/htmx/articles/3'), db)).text();
  assert.match(missing, /not stored on this device/);
});

// ---- actions -------------------------------------------------------------------------

test('read action updates record and appends op', async () => {
  const db = await store([rec(1, { story_id: 60 }), rec(2, { story_id: 60 }), rec(3)]);
  const res = await RF.router.handle(post('/htmx/articles/1/read', 'story_unfolded=false'), db);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.headers.get('HX-Trigger')), { sidebarRefresh: true, articleReadChanged: { id: 1, isRead: true } });
  assert.match(await res.text(), /✓ Read/);
  assert.equal((await RF.db.get(db, 'articles', 1)).is_read, true);
  // Reading a row closes its story, as the server does when the op replays.
  assert.equal((await RF.db.get(db, 'articles', 2)).is_read, true);
  const queued = await ops(db);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].type, 'read');
  assert.equal(queued[0].article_id, 1);
  assert.deepEqual(queued[0].value, { story_unfolded: false });
  assert.match(queued[0].op_id, /^[0-9a-f-]{36}$/);
  assert.ok(!isNaN(Date.parse(queued[0].at)));
  // Un-reading it reopens what was closed on its account.
  await RF.router.handle(post('/htmx/articles/1/read', ''), db);
  assert.equal((await RF.db.get(db, 'articles', 1)).is_read, false);
  assert.equal((await RF.db.get(db, 'articles', 2)).is_read, false);
  assert.deepEqual((await ops(db)).map((o) => o.type), ['read', 'unread']);
});

test('star, archive, unsave and label toggle answer like the server', async () => {
  const db = await store([rec(1, { saved_at: '2026-11-16T00:00:00+00:00' })]);
  const star = await RF.router.handle(post('/htmx/articles/1/star'), db);
  assert.deepEqual(JSON.parse(star.headers.get('HX-Trigger')), { sidebarRefresh: true, articleStarChanged: { id: 1, isStarred: true } });
  assert.match(await star.text(), /hx-target="#star-btn-1"[\s\S]*★/);
  const arch = await RF.router.handle(post('/htmx/articles/1/archive'), db);
  assert.deepEqual(JSON.parse(arch.headers.get('HX-Trigger')), { sidebarRefresh: true, articleArchiveChanged: { id: 1, isArchived: true } });
  const label = await RF.router.handle(post('/htmx/articles/1/labels/7/toggle'), db);
  assert.equal(label.headers.get('HX-Trigger'), 'sidebarRefresh');
  const picker = await label.text();
  assert.match(picker, /id="article-labels-1" hx-swap-oob="outerHTML"/);
  assert.match(picker, /id="detail-labels-1" hx-swap-oob="outerHTML"/);
  const unsave = await RF.router.handle(post('/htmx/articles/1/unsave'), db);
  assert.deepEqual(JSON.parse(unsave.headers.get('HX-Trigger')), { savedArticleRemoved: { id: 1 }, sidebarRefresh: true });
  const r = await RF.db.get(db, 'articles', 1);
  assert.deepEqual([r.is_starred, r.is_archived, r.label_ids, r.saved_at], [true, true, [7], null]);
  assert.deepEqual((await ops(db)).map((o) => [o.type, o.value]),
    [['star', {}], ['archive', {}], ['label_add', { label_id: 7 }], ['unsave', {}]]);
  // An unknown label is the server's 404, and nothing is queued.
  assert.equal((await RF.router.handle(post('/htmx/articles/1/labels/99/toggle'), db)).status, 404);
  assert.equal((await ops(db)).length, 4);
});

test('mark folder read appends mark_scope_read with max_article_id', async () => {
  const db = await store([rec(1), rec(4), rec(9, { feed_id: 11 }), rec(6, { is_read: true })]);
  const res = await RF.router.handle(post('/htmx/folders/1/mark-read', 'before=2026-11-17T00%3A00%3A00.000Z'), db);
  assert.equal(res.headers.get('HX-Trigger'), 'sidebarRefresh');
  assert.match(await res.text(), /mark-read-badge[^>]*text-gray-400[^>]*>3</);
  const queued = await ops(db);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].type, 'mark_scope_read');
  assert.equal(queued[0].article_id, null);
  assert.deepEqual(queued[0].value, { folder_id: 1, max_article_id: 6, before: '2026-11-17T00:00:00.000Z' });
  assert.equal((await RF.db.get(db, 'articles', 1)).is_read, true);
  assert.equal((await RF.db.get(db, 'articles', 9)).is_read, false);
});

test('mark read without a time is refused, as by the server', async () => {
  const db = await store([rec(1)]);
  assert.equal((await RF.router.handle(post('/htmx/folders/1/mark-read', ''), db)).status, 422);
  assert.equal((await RF.router.handle(post('/htmx/articles/mark-read', 'before=soon'), db)).status, 400);
  assert.equal((await ops(db)).length, 0);
  assert.equal((await RF.db.get(db, 'articles', 1)).is_read, false);
});

test('mark starred read goes as one read op per article', async () => {
  const db = await store([rec(1, { is_starred: true }), rec(2, { is_starred: true, is_read: true }), rec(3)]);
  await RF.router.handle(post('/htmx/articles/mark-read', 'before=2026-11-17T00%3A00%3A00Z&starred_only=1'), db);
  assert.deepEqual((await ops(db)).map((o) => [o.type, o.article_id, o.value]), [['read', 1, { story_unfolded: true }]]);
  assert.equal((await RF.db.get(db, 'articles', 3)).is_read, false);
});

test('POST bodies of batch read, dwell and save-url are read', async () => {
  const db = await store([rec(1), rec(2)]);
  const batch = await RF.router.handle(post('/htmx/articles/set-read-batch', JSON.stringify({ ids: [1, 2, 'x'], unfolded: [2] }), 'application/json'), db);
  assert.equal(batch.status, 200);
  assert.equal((await RF.router.handle(post('/htmx/articles/1/dwell', 'seconds=40'), db)).status, 204);
  assert.equal((await RF.router.handle(post('/htmx/articles/1/dwell', 'seconds=2'), db)).status, 204);
  const saved = await RF.router.handle(post('/htmx/articles/save-url', 'url=https%3A%2F%2Fexample.org%2Fa'), db);
  assert.equal(JSON.parse(saved.headers.get('HX-Trigger')).sidebarRefresh, true);
  assert.match(await saved.text(), /example\.org\/a[\s\S]*fetched after sync/);
  assert.deepEqual((await ops(db)).map((o) => [o.type, o.article_id, o.value]), [
    ['read', 1, { story_unfolded: false }], ['read', 2, { story_unfolded: true }],
    ['dwell', 1, { seconds: 40 }], ['save_url', null, { url: 'https://example.org/a' }],
  ]);
  const bad = await RF.router.handle(post('/htmx/articles/save-url', 'url=javascript%3Aalert(1)'), db);
  assert.equal(JSON.parse(bad.headers.get('HX-Trigger')).showToast.type, 'error');
  assert.equal((await ops(db)).length, 4);
});

test('AI requests are queued and shown as requested', async () => {
  const db = await store([rec(1)]);
  const sum = await RF.router.handle(post('/htmx/articles/1/ai-summary'), db);
  assert.match(await sum.text(), /id="ai-summary-1"[\s\S]*Requested – arrives after sync/);
  const ctx = await RF.router.handle(post('/htmx/articles/1/ai-context', 'focus=x'), db);
  assert.equal(ctx.headers.get('HX-Retarget'), '#ai-context-1');
  assert.equal(ctx.headers.get('HX-Reswap'), 'outerHTML');
  assert.deepEqual((await ops(db)).map((o) => o.type), ['ai_summary', 'ai_context']);
  // Reopened, the article says so too.
  const body = await (await RF.router.handle(get('/htmx/articles/1'), db)).text();
  assert.deepEqual(islandOf(body).requested['1'], { summary: true, context: true });
});

test('unknown htmx route returns needs-connection fragment', async () => {
  const db = await store([rec(1)]);
  for (const [req, word] of [
    [post('/htmx/articles/1/ai-chat', 'message=hi'), 'AI chat'],
    [get('/htmx/articles/1/ai-summary/poll'), 'AI summary'],
    [post('/htmx/feeds/10/refresh'), 'Feed refresh'],
    [get('/htmx/whatever'), 'Needs a connection'],
  ]) {
    const res = await RF.router.handle(req, db);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /data-rf-needs-connection/);
    assert.ok(body.includes(word), body);
  }
  // Not the app's: null, the caller answers online-only.
  assert.equal(await RF.router.handle(get('/settings'), db), null);
});

test('sidebar is drawn from local counts and escapes names', async () => {
  const db = await store([rec(1), rec(2, { feed_id: 11, label_ids: [7] })], {
    labels: [{ id: 7, name: '<img src=x onerror=alert(1)>', color: 'red;background:url(x)', position: 0 }],
  });
  const body = await (await RF.router.handle(get('/htmx/sidebar'), db)).text();
  assert.ok(!body.includes('<img src=x'));
  assert.ok(body.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!body.includes('url(x)'));
  assert.match(body, /hx-post="\/htmx\/folders\/1\/mark-read"/);
  assert.match(body, /id="feed-badge-10"><span class="mark-read-badge[^"]*rounded-full">1</);
  assert.match(body, /id="label-badge-7"><span class="mark-read-badge[^"]*rounded-full">1</);
});

test('story rows come back as members of the row', async () => {
  const db = await store([rec(1, { story_id: 5 }), rec(2, { story_id: 5 }), rec(3, { story_id: 5, feed_id: 11 })]);
  const body = await (await RF.router.handle(get('/htmx/articles/1/story-rows?folder_id=1'), db)).text();
  assert.deepEqual(rowIds(body), [2]);
  const w = overlayPage('<div id="article-list"></div>');
  w.document.getElementById('article-list').innerHTML = w.RFOffline.overlay.transform(body, w.document);
  const row = w.document.getElementById('article-row-2');
  assert.equal(row.getAttribute('data-story-parent'), '1');
  assert.ok(row.classList.contains('pl-7') && !row.classList.contains('pl-2'));
  assert.equal(row.querySelector('[data-rf-slot="related-count"]'), null);
});

// ---- the database handles --------------------------------------------------------------

test('openExisting never creates a database and the current user round-trips', async () => {
  assert.equal(await RF.db.openExisting(4), null);
  const names = (await indexedDB.databases()).map((d) => d.name);
  assert.ok(!names.includes('readfine-offline-4'));
  const db = await RF.db.open(4);
  db.close();
  const again = await RF.db.openExisting(4);
  assert.ok(again && again.userId === 4);
  again.close();
  assert.equal(await RF.db.getCurrentUser(), null);
  await RF.db.setCurrentUser(null);
  // Asking (or clearing) never creates the store.
  assert.ok(!(await indexedDB.databases()).some((d) => d.name === 'readfine-offline-current'));
  await RF.db.setCurrentUser(4, { offlineEnabled: true });
  assert.deepEqual(await RF.db.getCurrentUser(), { userId: 4, offlineEnabled: true, forceOffline: false });
  await RF.db.setCurrentUser(null);
  assert.equal(await RF.db.getCurrentUser(), null);
  await assert.rejects(RF.db.setCurrentUser('4'));
});

// ---- the worker (sw.js + policy.js) ------------------------------------------------------

// Evaluates sw.js the way a browser does: importScripts reads the same-origin files.
// `script` is the URL it was registered with ("/sw.js" or "/sw.js?offline=1").
function worker({ fetchImpl, current, script = '/sw.js?offline=1' }) {
  const listeners = {};
  const imported = [];
  const cacheStorage = fakeCaches();
  const preload = { enabled: null };
  const ctx = {
    console, URL, URLSearchParams, Request, Response, Headers, Intl, JSON, Promise, Map, Set,
    Date, Math, Number, String, Array, Object, Error, TypeError, RegExp, setTimeout, clearTimeout,
    AbortController, crypto: globalThis.crypto, indexedDB: new IDBFactory(), caches: cacheStorage,
    location: new URL('https://readfine.test' + script),
    registration: { navigationPreload: {
      enable: async () => { preload.enabled = true; }, disable: async () => { preload.enabled = false; },
    } },
    clients: { claim: () => Promise.resolve() },
    skipWaiting() {},
    fetch: fetchImpl,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  ctx.self = ctx;
  ctx.importScripts = (...urls) => {
    imported.push(...urls);
    for (const u of urls) {
      vm.runInContext(fs.readFileSync(path.join(STATIC_DIR, u.replace(/^\/static\//, '')), 'utf8'), ctx, { filename: u });
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SW_JS, 'utf8'), ctx, { filename: 'sw.js' });
  let userReads = 0;
  if (current !== undefined) {
    ctx.RFOffline.db.getCurrentUser = async () => { userReads += 1; return current; };
  }
  const calls = [];
  if (ctx.RFOffline) {
    const realHandle = ctx.RFOffline.router.handle;
    ctx.RFOffline.router.handle = (...a) => { calls.push(a[0].url); return realHandle(...a); };
  }
  return {
    ctx, listeners, calls, cacheStorage, preload, imported,
    userReads: () => userReads,
    async dispatch(request, extra = {}) {
      let responded = null;
      const event = Object.assign({ request, respondWith(p) { responded = Promise.resolve(p); } }, extra);
      listeners.fetch.forEach((fn) => fn(event));
      return responded;
    },
    async activate() {
      const waits = [];
      listeners.activate.forEach((fn) => fn({ waitUntil(p) { waits.push(p); } }));
      await Promise.all(waits);
    },
  };
}

async function seedWorkerDb(w, userId = 1) {
  const RFw = w.ctx.RFOffline;
  const db = await RFw.db.open(userId);
  await RFw.db.putRecords(db, [rec(1)]);
  await RFw.db.putSnapshots(db, [{ id: 1, row_html: rowHtml(1), detail_html: detailHtml(1), media: [] }]);
  await RFw.db.putMany(db, 'lists', Object.keys(LISTS).map((name) => ({ name, items: LISTS[name] })));
  return db;
}

test('online request bypasses router', async () => {
  const net = [];
  const w = worker({
    current: { userId: 1, offlineEnabled: true, forceOffline: false },
    fetchImpl: async (req) => { net.push(req.url); return new Response('from server', { status: 200 }); },
  });
  const res = await w.dispatch(new Request('https://readfine.test/htmx/articles?feed_id=1'));
  assert.equal(await res.text(), 'from server');
  assert.deepEqual(net, ['https://readfine.test/htmx/articles?feed_id=1']);
  assert.deepEqual(w.calls, []);
  assert.equal(w.cacheStorage.stores.size, 0);
  // Not the app's request (a video range request, another origin): no respondWith.
  assert.equal(await w.dispatch(new Request('https://readfine.test/video.mp4')), null);
  assert.equal(await w.dispatch(new Request('https://cdn.example/x.js')), null);
});

test('an unflagged worker takes no request at all', async () => {
  // No stub for getCurrentUser: the real one would open IndexedDB.
  const w = worker({ script: '/sw.js', fetchImpl: async () => { throw new Error('must not fetch'); } });
  for (const r of [
    new Request('https://readfine.test/htmx/sidebar'),
    new Request('https://readfine.test/htmx/articles/1/star', { method: 'POST' }),
    new Request('https://readfine.test/static/js/app.js'),
    new Request('https://readfine.test/m/sig/1/abc'),
    { url: 'https://readfine.test/app', method: 'GET', mode: 'navigate' },
  ]) {
    assert.equal(await w.dispatch(r), null);
  }
  assert.deepEqual(await w.ctx.indexedDB.databases(), []);
  await w.activate();
  assert.equal(w.preload.enabled, false);
  // Exactly upstream's worker: nothing imported, one empty fetch handler, no message
  // handler, so the browser can skip dispatching fetch events to it.
  assert.deepEqual(w.imported, []);
  assert.equal(w.ctx.RFOffline, undefined);
  assert.equal(w.listeners.fetch.length, 1);
  assert.match(String(w.listeners.fetch[0]), /^function \(\) \{\}$/);
  assert.equal(w.listeners.message, undefined);
});

test('a flagged worker whose scripts fail to load behaves as the plain one', async () => {
  const listeners = {};
  const ctx = {
    location: new URL('https://readfine.test/sw.js?offline=1'),
    registration: { navigationPreload: { enable: async () => {}, disable: async () => {} } },
    clients: { claim: () => Promise.resolve() }, skipWaiting() {}, Promise,
    importScripts() { throw new Error('404'); },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SW_JS, 'utf8'), ctx, { filename: 'sw.js' });
  assert.equal(listeners.fetch.length, 1);
  assert.match(String(listeners.fetch[0]), /^function \(\) \{\}$/);
});

test('a flagged cold worker loads the user once and answers offline', async () => {
  const w = worker({
    current: { userId: 1, offlineEnabled: true, forceOffline: false },
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
  });
  await seedWorkerDb(w);
  await w.activate();
  assert.equal(w.preload.enabled, true);
  const res = await w.dispatch(new Request('https://readfine.test/htmx/articles'));
  assert.match(await res.text(), /id="article-row-1"/);
  const again = await w.dispatch(new Request('https://readfine.test/htmx/articles/1'));
  assert.match(await again.text(), /article-detail-root/);
  assert.equal(w.userReads(), 1);
  // Known and switched off: the flagged worker steps aside too.
  const off = worker({ current: { userId: 1, offlineEnabled: false }, fetchImpl: async () => new Response('x') });
  assert.equal(await (await off.dispatch(new Request('https://readfine.test/htmx/sidebar'))).text(), 'x');
  assert.equal(await off.dispatch(new Request('https://readfine.test/htmx/sidebar')), null);
});

test('network failure answers from the router, keeping the POST body', async () => {
  const w = worker({
    current: { userId: 1, offlineEnabled: true, forceOffline: false },
    fetchImpl: async (req) => { await req.text(); throw new TypeError('Failed to fetch'); },
  });
  const db = await seedWorkerDb(w);
  const RFw = w.ctx.RFOffline;
  const res = await w.dispatch(new Request('https://readfine.test/htmx/articles/1/dwell', {
    method: 'POST', body: 'seconds=30', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }));
  assert.equal(res.status, 204);
  const queued = (await RFw.db.outboxEntries(db)).map((e) => e.op);
  assert.equal(JSON.stringify(queued.map((o) => [o.type, o.value.seconds])), '[["dwell",30]]');
  assert.equal(w.calls.length, 1);
  // A navigation to a page only the server has: the plain offline page, locked down.
  // (Request() refuses mode 'navigate', so the request is a plain object here.)
  const nav = await w.dispatch({ url: 'https://readfine.test/settings', method: 'GET', mode: 'navigate' });
  assert.equal(nav.status, 503);
  assert.equal(nav.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'");
  assert.match(await nav.text(), /Needs a connection/);
});

test('a hanging GET falls back offline after the timeout; a POST never does', async () => {
  const w = worker({
    current: { userId: 1, offlineEnabled: true, forceOffline: false },
    fetchImpl: (req, init) => new Promise((resolve, reject) => {
      if (init && init.signal) init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  await seedWorkerDb(w);
  w.ctx.RFOffline.policy.NETWORK_TIMEOUT_MS = 20;
  const res = await w.dispatch(new Request('https://readfine.test/htmx/articles'));
  assert.match(await res.text(), /id="article-row-1"/);
  const pending = w.dispatch(new Request('https://readfine.test/htmx/articles/1/star', { method: 'POST' }));
  const winner = await Promise.race([pending.then((p) => p).then(() => 'answered'), new Promise((r) => setTimeout(() => r('waiting'), 80))]);
  assert.equal(winner, 'waiting');
});

test('a sign-in forgets the reader at once; a slow first page is not timed out into the old shell', async () => {
  let release;
  const userRead = new Promise((r) => { release = r; });
  const w = worker({
    current: { userId: 1, offlineEnabled: true, forceOffline: false },
    fetchImpl: (req, init) => new Promise((resolve, reject) => {
      if (init && init.signal) init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  await seedWorkerDb(w);
  const P = w.ctx.RFOffline.policy;
  P.NETWORK_TIMEOUT_MS = 20;
  const post = (type) => w.listeners.message.forEach((fn) => fn({ data: { type }, waitUntil() {} }));
  // A read of the store in flight when the forget arrives does not bring the reader back.
  w.ctx.RFOffline.db.getCurrentUser = () => userRead;
  post('rf-current-user');
  post('rf-forget-user');
  release({ userId: 1, offlineEnabled: true, forceOffline: false });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(P._current.value, null);
  // Nobody known: the navigation goes to the network as if there were no worker.
  assert.equal(await w.dispatch({ url: 'https://readfine.test/app', method: 'GET', mode: 'navigate' }), null);
  // Even if the record still named the old reader (the stale mark never landed), a
  // navigation inside the window waits for the network instead of timing out offline.
  w.ctx.RFOffline.db.getCurrentUser = async () => ({ userId: 1, offlineEnabled: true, forceOffline: false });
  post('rf-current-user');
  await P._current.loading;
  const pending = w.dispatch({ url: 'https://readfine.test/app', method: 'GET', mode: 'navigate' });
  const winner = await Promise.race([pending.then((p) => p).then(() => 'answered'), new Promise((r) => setTimeout(() => r('waiting'), 80))]);
  assert.equal(winner, 'waiting');
  // Out of the window: the usual timeout applies again.
  P.FORGET_WINDOW_MS = 0;
  const later = await w.dispatch(new Request('https://readfine.test/htmx/articles'));
  assert.match(await later.text(), /id="article-row-1"/);
});

test('a stale current-user record names nobody for the worker', async () => {
  const w = worker({
    current: { userId: 1, offlineEnabled: true, forceOffline: false, stale: true },
    fetchImpl: async () => { throw new TypeError('offline'); },
  });
  await seedWorkerDb(w);
  // Steps aside: the request goes to the network (and fails there), no offline answer.
  await assert.rejects(w.dispatch(new Request('https://readfine.test/htmx/articles')), /offline/);
  assert.deepEqual(w.calls, []);
});

test('navigations use the preloaded response', async () => {
  const w = worker({
    current: { userId: 1, offlineEnabled: true, forceOffline: false },
    fetchImpl: async () => { throw new Error('must use the preload'); },
  });
  const res = await w.dispatch({ url: 'https://readfine.test/app', method: 'GET', mode: 'navigate' },
    { preloadResponse: Promise.resolve(new Response('preloaded')) });
  assert.equal(await res.text(), 'preloaded');
});

test('open copies stay with their user', async () => {
  const w = worker({
    current: { userId: 1, offlineEnabled: true, forceOffline: true },
    fetchImpl: async () => { throw new TypeError('offline'); },
  });
  const db1 = await seedWorkerDb(w, 1);
  assert.match(await (await w.dispatch(new Request('https://readfine.test/htmx/articles/1'))).text(), /article-detail-root/);
  await w.ctx.RFOffline.db.removeArticles(db1, [1]);
  // Removed while open: user 1 still has it.
  assert.match(await (await w.dispatch(new Request('https://readfine.test/htmx/articles/1'))).text(), /article-detail-root/);
  // Another user signs in on this device; their database has no article 1.
  const db2 = await w.ctx.RFOffline.db.open(2);
  await w.ctx.RFOffline.db.putMany(db2, 'lists', Object.keys(LISTS).map((name) => ({ name, items: LISTS[name] })));
  w.ctx.RFOffline.db.getCurrentUser = async () => ({ userId: 2, offlineEnabled: true, forceOffline: true });
  const waits = [];
  w.listeners.message.forEach((fn) => fn({ data: { type: 'rf-current-user' }, waitUntil(p) { waits.push(p); } }));
  await Promise.all(waits);
  const other = await (await w.dispatch(new Request('https://readfine.test/htmx/articles/1'))).text();
  assert.match(other, /not stored on this device/);
  const star = await w.dispatch(new Request('https://readfine.test/htmx/articles/1/star', { method: 'POST' }));
  assert.equal(star.status, 404);
  assert.equal((await w.ctx.RFOffline.db.outboxEntries(db2)).length, 0);
});

test('a wiped database is not recreated by the worker', async () => {
  const w = worker({
    current: { userId: 3, offlineEnabled: true, forceOffline: true },
    fetchImpl: async () => { throw new TypeError('offline'); },
  });
  const res = await w.dispatch(new Request('https://readfine.test/htmx/articles'));
  assert.match(await res.text(), /data-rf-needs-connection/);
  const names = (await w.ctx.indexedDB.databases()).map((d) => d.name);
  assert.ok(!names.includes('readfine-offline-3'));
});

test('the cached shell is served verbatim for /app', async () => {
  const shellRes = new Response('<html nonce-abc>', { headers: { 'content-security-policy': "script-src 'nonce-abc'" } });
  const caches = fakeCaches();
  const c = await caches.open('readfine-shell-t1');
  await c.put('https://readfine.test/app', shellRes);
  const prev = globalThis.caches;
  globalThis.caches = caches;
  try {
    const db = await store([rec(1)]);
    const res = await RF.router.handle(get('/app'), db);
    assert.equal(await res.text(), '<html nonce-abc>');
    assert.equal(res.headers.get('content-security-policy'), "script-src 'nonce-abc'");
  } finally {
    globalThis.caches = prev;
  }
});

test('the page registers the flagged worker only for offline mode', async () => {
  const registered = [];
  let active = null;
  const sw = {
    getRegistration: async () => (active ? { active: { scriptURL: active } } : undefined),
    register: async (url, opts) => { registered.push([url, opts.updateViaCache]); active = 'https://readfine.test' + url; return {}; },
  };
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: sw }, configurable: true });
  try {
    await RF.sw.register({});                 // nobody opted in: plain
    await RF.sw.register({ offline: true });  // the switch turned on
    await RF.sw.register({});                 // later loads keep the flag
    await RF.sw.register({ offline: false });
  } finally {
    if (desc) Object.defineProperty(globalThis, 'navigator', desc); else delete globalThis.navigator;
  }
  assert.deepEqual(registered, [
    ['/sw.js', 'none'], ['/sw.js?offline=1', 'none'], ['/sw.js?offline=1', 'none'], ['/sw.js', 'none'],
  ]);
});

test('register() resolves once the new worker is active, or after a bound', async () => {
  // Found by the e2e suite in Chrome: requests sent while the new worker was still
  // activating (the first sync after switching on; POST /logout and the navigation to
  // /login after switching off) restarted the old worker. The flagged one then stayed
  // waiting, and the /login navigation, handed to the old worker as it went, never
  // finished. So the page sends nothing more until the switch is done.
  function fakeWorker(url) {
    const listeners = new Set();
    return {
      scriptURL: 'https://readfine.test' + url, state: 'installing',
      addEventListener: (type, fn) => { if (type === 'statechange') listeners.add(fn); },
      removeEventListener: (type, fn) => listeners.delete(fn),
      go(state) { this.state = state; listeners.forEach((fn) => fn()); },
      listeners,
    };
  }
  let w = null;
  const sw = {
    getRegistration: async () => undefined,
    register: async (url) => { w = fakeWorker(url); return { installing: w }; },
  };
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: sw }, configurable: true });
  const prevWait = RF.sw.ACTIVATE_WAIT_MS;
  try {
    let done = false;
    const p = RF.sw.register({ offline: true }).then((reg) => { done = true; return reg; });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(done, false, 'still activating: not resolved');
    w.go('installed');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(done, false);
    w.go('activated');
    const reg = await p;
    assert.equal(reg.installing.scriptURL, 'https://readfine.test/sw.js?offline=1');
    assert.equal(w.listeners.size, 0, 'listener removed');
    // A worker that never activates (Chrome can keep it waiting): the bound ends the wait.
    RF.sw.ACTIVATE_WAIT_MS = 30;
    const t0 = Date.now();
    await RF.sw.register({ offline: false });
    assert.ok(Date.now() - t0 >= 25);
    assert.equal(w.state, 'installing');
    assert.equal(w.listeners.size, 0);
    // A redundant worker (its install failed) ends the wait too.
    RF.sw.ACTIVATE_WAIT_MS = 5000;
    const q = RF.sw.register({ offline: true });
    await new Promise((r) => setTimeout(r, 5));
    w.go('redundant');
    await q;
  } finally {
    RF.sw.ACTIVATE_WAIT_MS = prevWait;
    if (desc) Object.defineProperty(globalThis, 'navigator', desc); else delete globalThis.navigator;
  }
});

test('the unread setting decides what a feed list and a saved-search view open with', async () => {
  const db = await store([rec(1), rec(2, { is_read: true }), rec(3)], {
    saved_searches: [{ id: 9, name: 'Mine', params: {}, member_ids: [1, 2] }],
  });
  const withFilter = (f) => RF.db.put(db, 'lists', { name: 'prefs', items: Object.assign({}, LISTS.prefs, { unread_filter: f }) });
  // adaptive (the default): unread while there is any.
  assert.deepEqual(await RF.lists.query(db, new URLSearchParams('feed_id=10')), [3, 1]);
  assert.deepEqual(await RF.lists.query(db, new URLSearchParams('saved_search_id=9')), [1]);
  await withFilter('show_all');
  assert.deepEqual(await RF.lists.query(db, new URLSearchParams('feed_id=10')), [3, 2, 1]);
  assert.deepEqual(await RF.lists.query(db, new URLSearchParams('saved_search_id=9')), [2, 1]);
  await withFilter('unread_only');
  await RF.db.put(db, 'articles', rec(1, { is_read: true }));
  await RF.db.put(db, 'articles', rec(3, { is_read: true }));
  // Nothing unread left: unread_only still lists only unread (adaptive would show all).
  assert.deepEqual(await RF.lists.query(db, new URLSearchParams('feed_id=10')), []);
  assert.deepEqual(await RF.lists.query(db, new URLSearchParams('saved_search_id=9')), []);
  // A status of the view's own wins over the setting.
  assert.deepEqual(await RF.lists.query(db, new URLSearchParams('saved_search_id=9&show_read=true')), [2, 1]);
  await withFilter('adaptive');
  assert.deepEqual(await RF.lists.query(db, new URLSearchParams('feed_id=10')), [3, 2, 1]);
});

test('the offline page offers to try again and the offline reader', async () => {
  const res = RF.router.offlinePage('https://readfine.test/settings/feeds?x="1"');
  assert.equal(res.status, 503);
  const body = await res.text();
  assert.match(body, /You're offline or the connection is too slow\. This page isn't stored on this device\./);
  assert.match(body, /<a href="\/settings\/feeds\?x=%221%22">Try again<\/a>/);
  assert.match(body, /<a href="\/app">Open offline reader<\/a>/);
});

test('a flagged worker with offline mode off still uses the navigation preload', async () => {
  const net = [];
  const w = worker({
    current: { userId: 1, offlineEnabled: false, forceOffline: false },
    fetchImpl: async (req) => { net.push(req.url); return new Response('net'); },
  });
  // Loads the user once (the cold request passes through, using the preload).
  const first = await w.dispatch({ url: 'https://readfine.test/app', method: 'GET', mode: 'navigate' },
    { preloadResponse: Promise.resolve(new Response('preloaded-1')) });
  assert.equal(await first.text(), 'preloaded-1');
  // Known and off: a navigation still answers with its preload, nothing else is taken.
  const nav = await w.dispatch({ url: 'https://readfine.test/app', method: 'GET', mode: 'navigate' },
    { preloadResponse: Promise.resolve(new Response('preloaded-2')) });
  assert.equal(await nav.text(), 'preloaded-2');
  assert.equal(await w.dispatch({ url: 'https://readfine.test/app', method: 'GET', mode: 'navigate' }), null);
  assert.equal(await w.dispatch(new Request('https://readfine.test/htmx/sidebar')), null);
  assert.deepEqual(net, []);
  assert.deepEqual(w.calls, []);
});

test('registration reads the newest worker and ensure() never re-registers a right one', async () => {
  const registered = [];
  let reg = null;
  const sw = {
    getRegistration: async () => reg || undefined,
    register: async (url) => {
      registered.push(url);
      reg = { active: reg && reg.active, installing: { scriptURL: 'https://readfine.test' + url } };
      return reg;
    },
  };
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: sw }, configurable: true });
  try {
    // Active plain worker, flagged one installing (the switch was just turned on): the
    // installing one is what the reader asked for.
    reg = { active: { scriptURL: 'https://readfine.test/sw.js' }, installing: { scriptURL: 'https://readfine.test/sw.js?offline=1' } };
    assert.equal(await RF.sw.currentFlag(), true);
    await RF.sw.register({});
    assert.deepEqual(registered, ['/sw.js?offline=1']);
    registered.length = 0;
    await RF.sw.ensure();          // something registered: left alone
    await RF.sw.ensure(true);      // already flagged: left alone
    assert.deepEqual(registered, []);
    await RF.sw.ensure(false);     // wrong flag: registered plain
    assert.deepEqual(registered, ['/sw.js']);
    reg = null;
    registered.length = 0;
    // Nothing registered; page.js and app.js both ask at once: queued, so app.js sees
    // the flagged registration page.js just made and leaves it (unqueued, both would
    // see none and the plain one, registered last, would win).
    await Promise.all([RF.sw.ensure(true), RF.sw.ensure()]);
    assert.deepEqual(registered, ['/sw.js?offline=1']);
    await RF.sw.ensure();
    assert.deepEqual(registered, ['/sw.js?offline=1']);
  } finally {
    if (desc) Object.defineProperty(globalThis, 'navigator', desc); else delete globalThis.navigator;
  }
});

// ---- device performance at the design limits -------------------------------------------

test('list state is read once and reused until a write bumps the data version', async () => {
  const db = await store([rec(1), rec(2), rec(3)]);
  RF.lists.clearCache();
  const reads = [];
  const realGetAll = RF.db.getAll;
  RF.db.getAll = (d, s) => { reads.push(s); return realGetAll(d, s); };
  try {
    const a = await RF.lists.loadState(db);
    const b = await RF.lists.loadState(db);
    assert.deepEqual(reads, ['articles', 'lists'], 'second load from the cache');
    assert.notEqual(a.records, b.records, 'each call has its own records map');
    b.records.delete(1);
    assert.ok((await RF.lists.loadState(db)).records.has(1), 'a caller cannot change the cache');
    // Every write path bumps the version: the next load reads again.
    const writes = [
      () => RF.db.putRecords(db, [rec(4)]),
      () => RF.db.putSnapshots(db, [{ id: 4, content_version: 1, template_version: 't', prefs_version: 'p', row_html: rowHtml(4), detail_html: detailHtml(4), media: [] }]),
      () => RF.db.commitLocal(db, { records: [rec(1, { is_read: true })], ops: [{ type: 'read', article_id: 1 }] }),
      () => RF.db.removeArticles(db, [2]),
      () => RF.db.putMany(db, 'lists', [{ name: 'labels', items: [] }]),
    ];
    for (const w of writes) {
      reads.length = 0;
      await w();
      await RF.lists.loadState(db);
      assert.deepEqual(reads, ['articles', 'lists'], String(w));
    }
    const st = await RF.lists.loadState(db);
    assert.deepEqual([...st.records.keys()].sort(), [1, 3, 4]);
    assert.equal(st.records.get(1).is_read, true);
    // Through the router: an offline action shows in the next list at once.
    await RF.router.handle(post('/htmx/articles/3/star'), db);
    const body = await (await RF.router.handle(get('/htmx/articles?starred_only=true'), db)).text();
    assert.deepEqual(rowIds(body), [3]);
  } finally { RF.db.getAll = realGetAll; }
});

test('list state holds no AI output; the detail and a written-back record keep it', async () => {
  const db = await store([rec(1, { ai_summary: 'S', ai_summary_html: '<p>Summary</p>', ai_context: 'C', ai_context_html: '<p>Context</p>' })]);
  RF.lists.clearCache();
  const st = await RF.lists.loadState(db);
  const r = st.records.get(1);
  for (const k of ['ai_summary', 'ai_summary_html', 'ai_context', 'ai_context_html']) assert.equal(k in r, false, k);
  // The detail still carries it for the overlay.
  const detail = await (await RF.router.handle(get('/htmx/articles/1'), db)).text();
  assert.equal(islandOf(detail).records[1].ai_summary_html, '<p>Summary</p>');
  // An action on the light record does not lose it in the store.
  await RF.router.handle(post('/htmx/articles/1/star'), db);
  const stored = await RF.db.get(db, 'articles', 1);
  assert.equal(stored.is_starred, true);
  assert.equal(stored.ai_summary_html, '<p>Summary</p>');
  assert.equal(stored.ai_context_html, '<p>Context</p>');
  assert.equal('_rf_light' in stored, false);
});

test('search indexes at most 5000 characters of body text per article', () => {
  assert.equal(RF.search.LIMITS.maxText, 5000);
});

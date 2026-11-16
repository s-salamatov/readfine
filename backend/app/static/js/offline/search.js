// Offline full-text search over the articles stored on this device.
//
// Plain script, no DOM (page, service worker and Node tests all load it). MiniSearch
// (vendor/minisearch.js, UMD global `MiniSearch`) must be loaded first.
//
// The page builds the index (rebuild/ensure, called by sync.js after a run changed
// the stored articles) and writes it to IndexedDB, in three meta rows written in one
// transaction: `searchIndex` {json: MiniSearch JSON}, `searchIndexItems` {id: content
// version} (what the index holds) and `searchIndexV` {v, fmt, n}. The update is
// incremental: only articles whose content version changed (or whose snapshot was just
// fetched) are re-read and re-indexed, the rest of the index is kept; a full build
// happens only without a stored index, after a format change or when the stored one
// cannot be loaded. Text per article is capped (MAX_TEXT) and work goes in batches
// that yield to the event loop. The worker never builds or syncs: it only reads. It
// keeps one parsed index in memory, keyed by the database name and `v`, so an update in
// the page is picked up by the next query; a wipe or user switch drops it (clearCache).
//
// Text per article: the title plus the text of the snapshot's article body, with tags
// stripped. The stripping is regex based (a worker has no DOMParser).
(function (root) {
  'use strict';
  var RF = root.RFOffline = root.RFOffline || {};
  function D() { return RF.db; }

  var INDEX_KEY = 'searchIndex';
  var ITEMS_KEY = 'searchIndexItems';
  var VERSION_KEY = 'searchIndexV';
  var FIELDS = ['title', 'text'];
  var FORMAT = 'ms7-title-text-fold1';   // bump when the options or the text extraction change
  var MAX_TEXT = 20000;                  // chars of body text indexed per article
  var BATCH = 50;                        // articles per batch before yielding

  function tick() { return new Promise(function (resolve) { setTimeout(resolve, 0); }); }

  // Accents folded, case folded. Used for indexing and for the query alike.
  function processTerm(term) {
    return String(term).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  var NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–' };
  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
      if (e.charAt(0) === '#') {
        var code = e.charAt(1).toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '; } catch (err) { return ' '; }
      }
      var v = NAMED[e.toLowerCase()];
      return v === undefined ? m : v;
    });
  }

  // The article body of a detail snapshot as plain text, at most MAX_TEXT chars. The
  // body container is marked `data-rf-search-text` by the snapshot renderer; older
  // snapshots have `id="article-content-<id>"` instead, and without either the whole
  // panel is used. Elements with no reading text (scripts, styles, svg, buttons,
  // templates) go first, then the tags.
  function htmlToText(html, id) {
    var s = String(html || '');
    var at = s.indexOf('data-rf-search-text');
    if (at < 0) at = s.indexOf('id="article-content-' + id + '"');
    if (at >= 0) {
      s = s.slice(at);
      var end = s.indexOf('</article>');
      if (end >= 0) s = s.slice(0, end);
    }
    s = s.replace(/<(script|style|svg|button|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]*>/g, ' ');
    s = decodeEntities(s).replace(/\s+/g, ' ').trim();
    return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
  }

  function options() {
    return { fields: FIELDS, idField: 'id', processTerm: processTerm };
  }

  function searchOptions() {
    return { prefix: true, fuzzy: 0.2, combineWith: 'AND', boost: { title: 2 } };
  }

  // id -> content_version of the articles the device holds (record and snapshot).
  async function currentItems(db) {
    var ready = await D().readyIds(db);
    var records = await D().getAll(db, 'articles');
    var byId = new Map(records.map(function (r) { return [r.id, r]; }));
    var items = {};
    var titles = new Map();
    ready.forEach(function (id) {
      var r = byId.get(id);
      if (!r) return;
      items[id] = r.content_version;
      titles.set(id, r.title || '');
    });
    return { items: items, titles: titles };
  }

  var chains = new Map();   // db.name -> tail promise: one update at a time per database

  function serial(db, fn) {
    var prev = chains.get(db.name) || Promise.resolve();
    var next = prev.catch(function () {}).then(fn);
    chains.set(db.name, next);
    var clean = function () { if (chains.get(db.name) === next) chains.delete(db.name); };
    next.then(clean, clean);
    return next;
  }

  // Adds (or replaces) the documents of `ids` in `ms`, reading one snapshot at a time
  // and yielding between batches.
  async function indexIds(db, ms, ids, titles) {
    for (var i = 0; i < ids.length; i++) {
      if (!D().alive(db)) return false;
      var id = ids[i];
      var snap = await D().get(db, 'snapshots', id);
      if (!snap) continue;
      if (ms.has(id)) ms.discard(id);
      ms.add({ id: id, title: titles.get(id) || '', text: htmlToText(snap.detail_html, id) });
      if ((i + 1) % BATCH === 0) await tick();
    }
    return true;
  }

  async function write(db, ms, items) {
    if (!D().alive(db)) return;
    var v = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await D().putMany(db, 'meta', [
      { k: INDEX_KEY, v: { json: JSON.stringify(ms) } },
      { k: ITEMS_KEY, v: items },
      { k: VERSION_KEY, v: { v: v, fmt: FORMAT, n: Object.keys(items).length } },
    ]);
  }

  // Updates the stored index to match the stored articles. opts.touched: ids whose
  // snapshot was just replaced (same content version, possibly new text). opts.full:
  // build from scratch. -> Promise<boolean> whether an index was written.
  function update(db, opts) {
    opts = opts || {};
    return serial(db, async function () {
      if (!root.MiniSearch || !D().alive(db)) return false;
      var cur = await currentItems(db);
      var row = await D().getMeta(db, VERSION_KEY);
      var stored = row && row.fmt === FORMAT && !opts.full ? await D().getMeta(db, ITEMS_KEY) : null;
      var ms = null;
      if (stored) {
        try {
          var idx = await D().getMeta(db, INDEX_KEY);
          ms = idx ? root.MiniSearch.loadJSON(idx.json, options()) : null;
        } catch (err) { ms = null; }
      }
      var ids = Object.keys(cur.items).map(Number);
      var changed;
      var removed = [];
      if (ms) {
        var touched = new Set(opts.touched || []);
        changed = ids.filter(function (id) { return stored[id] !== cur.items[id] || touched.has(id); });
        Object.keys(stored).map(Number).forEach(function (id) { if (!(id in cur.items)) removed.push(id); });
        if (!changed.length && !removed.length) return false;
        removed.forEach(function (id) { if (ms.has(id)) ms.discard(id); });
      } else {
        if (!ids.length && !row) return false;
        ms = new root.MiniSearch(options());
        changed = ids;
      }
      if (!(await indexIds(db, ms, changed, cur.titles))) return false;
      await write(db, ms, cur.items);
      return true;
    });
  }

  // A full build, regardless of what is stored.
  function rebuild(db) {
    return update(db, { full: true }).then(function () {});
  }

  // Brings the index up to date; resolves true when something was written.
  function ensure(db, opts) { return update(db, opts); }

  var cache = null;   // {name, v, ms, items: Set<number>}

  function clearCache() { cache = null; }

  async function load(db) {
    var row = await D().getMeta(db, VERSION_KEY);
    if (!row || row.fmt !== FORMAT) { if (cache && cache.name === db.name) cache = null; return null; }
    if (cache && cache.name === db.name && cache.v === row.v) return cache;
    cache = null;   // one parsed index at a time: another database's is dropped
    var idx = await D().getMeta(db, INDEX_KEY);
    var items = await D().getMeta(db, ITEMS_KEY);
    if (!idx || !items || !root.MiniSearch) return null;
    var ms;
    try { ms = root.MiniSearch.loadJSON(idx.json, options()); } catch (err) { return null; }
    cache = { name: db.name, v: row.v, ms: ms, items: new Set(Object.keys(items).map(Number)) };
    return cache;
  }

  // Articles the device holds that the index does not know yet (a sync is between the
  // fetch and the index update): found by title only.
  async function titleHits(db, ids, text) {
    var words = processTerm(text).split(/\s+/).filter(Boolean);
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var rec = await D().get(db, 'articles', ids[i]);
      var title = processTerm(rec ? rec.title : '');
      if (rec && words.every(function (w) { return title.indexOf(w) >= 0; })) out.push(ids[i]);
    }
    return out;
  }

  // -> Promise<number[] | null>: ids of matching articles, best first; null when the
  // device has no index (the caller falls back to a title match). Only articles the
  // device still holds are returned, so a removed article never shows up.
  async function lookup(db, q) {
    var c = await load(db);
    if (!c) return null;
    var text = String(q || '').trim();
    if (!text) return [];
    var ready = await D().readyIds(db);
    var readySet = new Set(ready);
    var hits = c.ms.search(text, searchOptions())
      .map(function (r) { return r.id; })
      .filter(function (id) { return readySet.has(id); });
    var unindexed = ready.filter(function (id) { return !c.items.has(id); });
    if (unindexed.length) {
      var have = new Set(hits);
      (await titleHits(db, unindexed, text)).forEach(function (id) { if (!have.has(id)) hits.push(id); });
    }
    return hits;
  }

  async function query(db, q) {
    return (await lookup(db, q)) || [];
  }

  RF.search = {
    rebuild: rebuild,
    ensure: ensure,
    query: query,
    lookup: lookup,
    clearCache: clearCache,
    htmlToText: htmlToText,
    processTerm: processTerm,
    LIMITS: { maxText: MAX_TEXT, batch: BATCH },
    INDEX_KEY: INDEX_KEY,
    ITEMS_KEY: ITEMS_KEY,
    VERSION_KEY: VERSION_KEY,
  };
})(self);

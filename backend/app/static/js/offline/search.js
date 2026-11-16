// Offline full-text search over the articles stored on this device.
//
// Plain script, no DOM (page, service worker and Node tests all load it). MiniSearch
// (vendor/minisearch.min.js, UMD global `MiniSearch`) must be loaded first.
//
// The page builds the index (rebuild/ensure, called by sync.js after a run changed
// the stored articles) and writes it to IndexedDB: meta `searchIndex` holds
// {json: MiniSearch JSON, n}, and meta `searchIndexV` holds {v, sig}. The worker never
// builds or syncs: it only reads. It keeps the loaded index in memory, keyed by the
// database name and `v`, so a rebuild in the page is picked up by the next query, and a
// wipe (database deleted, `searchIndexV` gone) drops it.
//
// Text per article: the title plus the text of the snapshot's article body, with tags
// stripped. The stripping is regex based (a worker has no DOMParser).
(function (root) {
  'use strict';
  var RF = root.RFOffline = root.RFOffline || {};
  function D() { return RF.db; }

  var INDEX_KEY = 'searchIndex';
  var VERSION_KEY = 'searchIndexV';
  var FIELDS = ['title', 'text'];

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

  // The article body of a detail snapshot as plain text. The snapshot is the whole
  // detail panel; the body starts at its `article-content-<id>` container. Elements
  // that carry no reading text (scripts, styles, svg, buttons, templates) go first.
  function htmlToText(html, id) {
    var s = String(html || '');
    var at = s.indexOf('id="article-content-' + id + '"');
    if (at >= 0) {
      s = s.slice(at);
      var end = s.indexOf('</article>');
      if (end >= 0) s = s.slice(0, end);
    }
    s = s.replace(/<(script|style|svg|button|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]*>/g, ' ');
    return decodeEntities(s).replace(/\s+/g, ' ').trim();
  }

  function options() {
    return { fields: FIELDS, idField: 'id', processTerm: processTerm };
  }

  function searchOptions() {
    return { prefix: true, fuzzy: 0.2, combineWith: 'AND', boost: { title: 2 } };
  }

  // FNV-1a over `id:content_version` of the ready articles: tells whether the stored
  // index still matches what the device holds.
  function signature(ids, byId) {
    var h = 2166136261;
    var s = ids.map(function (id) { var r = byId.get(id); return id + ':' + (r ? r.content_version : ''); }).join('|');
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return ids.length + '-' + h.toString(16);
  }

  async function readInputs(db) {
    var ready = await D().readyIds(db);
    var records = await D().getAll(db, 'articles');
    var byId = new Map(records.map(function (r) { return [r.id, r]; }));
    ready = ready.filter(function (id) { return byId.has(id); });
    return { ready: ready, byId: byId };
  }

  var chains = new Map();   // db.name -> tail promise: one rebuild at a time per database

  function serial(db, fn) {
    var prev = chains.get(db.name) || Promise.resolve();
    var next = prev.catch(function () {}).then(fn);
    chains.set(db.name, next);
    var clean = function () { if (chains.get(db.name) === next) chains.delete(db.name); };
    next.then(clean, clean);
    return next;
  }

  // Builds the index from the stored articles and snapshots and stores it. Resolves
  // without writing when MiniSearch is missing or the database was wiped meanwhile.
  function rebuild(db) {
    return serial(db, async function () {
      if (!root.MiniSearch || !D().alive(db)) return;
      var inp = await readInputs(db);
      var snaps = new Map((await D().getAll(db, 'snapshots')).map(function (s) { return [s.id, s]; }));
      var ms = new root.MiniSearch(options());
      var docs = [];
      inp.ready.forEach(function (id) {
        var snap = snaps.get(id);
        if (!snap) return;
        docs.push({ id: id, title: inp.byId.get(id).title || '', text: htmlToText(snap.detail_html, id) });
      });
      ms.addAll(docs);
      var v = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      if (!D().alive(db)) return;
      await D().putMany(db, 'meta', [
        { k: INDEX_KEY, v: { json: JSON.stringify(ms), n: docs.length } },
        { k: VERSION_KEY, v: { v: v, sig: signature(inp.ready, inp.byId) } },
      ]);
    });
  }

  // Rebuilds only when the stored index does not match the stored articles.
  async function ensure(db) {
    if (!root.MiniSearch || !D().alive(db)) return false;
    var inp = await readInputs(db);
    var row = await D().getMeta(db, VERSION_KEY);
    if (row && row.sig === signature(inp.ready, inp.byId)) return false;
    if (!row && !inp.ready.length) return false;
    await rebuild(db);
    return true;
  }

  var loaded = new Map();   // db.name -> {v, ms}

  async function load(db) {
    var row = await D().getMeta(db, VERSION_KEY);
    if (!row) { loaded.delete(db.name); return null; }
    var hit = loaded.get(db.name);
    if (hit && hit.v === row.v) return hit.ms;
    var idx = await D().getMeta(db, INDEX_KEY);
    if (!idx || !root.MiniSearch) return null;
    var ms = root.MiniSearch.loadJSON(idx.json, options());
    loaded.set(db.name, { v: row.v, ms: ms });
    return ms;
  }

  // -> Promise<number[] | null>: ids of matching articles, best first; null when the
  // device has no index (the caller falls back to a title match). Only articles the
  // device still holds are returned, so a removed article never shows up.
  async function lookup(db, q) {
    var ms = await load(db);
    if (!ms) return null;
    var text = String(q || '').trim();
    if (!text) return [];
    var ready = new Set(await D().readyIds(db));
    return ms.search(text, searchOptions())
      .map(function (r) { return r.id; })
      .filter(function (id) { return ready.has(id); });
  }

  async function query(db, q) {
    return (await lookup(db, q)) || [];
  }

  RF.search = {
    rebuild: rebuild,
    ensure: ensure,
    query: query,
    lookup: lookup,
    htmlToText: htmlToText,
    processTerm: processTerm,
    INDEX_KEY: INDEX_KEY,
    VERSION_KEY: VERSION_KEY,
  };
})(self);

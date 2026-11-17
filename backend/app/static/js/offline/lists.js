// Offline article lists: the device's answer to list_articles.
//
// Plain script, no DOM; loaded by the service worker (and by tests in Node). Works on
// a state object read from the user's IndexedDB once per request (loadState), and
// mirrors the server's list rules where the device has the data to do so:
//   - which articles a view holds (render_list / list_articles filters), including the
//     "feed optional" rule: an article from a feed the reader does not subscribe to
//     (or saved by URL) shows only in starred, saved, archived, label and search views;
//   - ordering (newest, oldest, score) with the id as tie-break, on
//     published_at || fetched_at, and a keyset cursor (cursor_ts, cursor_id,
//     cursor_key) plus shown_stories for "load more", like _build_more_qs;
//   - story collapsing (collapses_stories / collapse_page / next_shown) and the
//     per-row story counts.
// Known differences, all because the device does not have the data:
//   - only stored articles exist here (unread in scope, plus starred/saved/archived),
//     so totals and story counts can be lower than the server's;
//   - `q` goes through the local full-text index (search.js) when the device has one,
//     else it is a plain title match; the relevance
//     sort without a rank is newest first, as the server does without a query term;
//   - read_status engaged/not_engaged has no dwell data here and filters nothing.
(function (root) {
  'use strict';
  var RF = root.RFOffline = root.RFOffline || {};
  function D() { return RF.db; }

  var DEDUP_OFF = 'off';
  var MAX_SHOWN_STORIES = 300;
  var SCORE_SOURCES = ['ai', 'basic', 'relevance'];
  var SEARCH_STATES = ['starred', 'saved', 'archived'];

  // ---- reading the store -------------------------------------------------------------

  // -> Promise<state>: {records: Map<id, record> (ready ids only), lists: {folders,
  //    feeds, labels, saved_searches, prefs}, feedFolder: Map<feed_id, folder_id|null>}
  //
  // Read from the store only when it changed: every write to articles, lists or the
  // ready set bumps meta data_version in the same transaction (db.js), and the state
  // built last is kept per database handle under that version. Each call gets its own
  // records Map (callers add to it); records are shared and never changed in place
  // (the router copies before it edits). Records are light: without the stored AI
  // output (db.js HEAVY), which no list reads; the detail reads the full record.
  var cached = null; // {db, version, base}

  function loadState(db) {
    return D().getMeta(db, D().META.dataVersion).then(function (v) {
      var version = v || 0;
      if (cached && cached.db === db && cached.version === version) return fresh(cached.base);
      return Promise.all([D().readyIds(db), D().getAll(db, 'articles'), D().getAll(db, 'lists')])
        .then(function (r) {
          var base = buildState(r[0], r[1], r[2]);
          // Read after the version: if a write landed in between, this state is newer
          // than its key, and the next call (seeing the bump) simply rebuilds.
          cached = { db: db, version: version, base: base };
          return fresh(base);
        });
    });
  }

  function fresh(base) {
    return { records: new Map(base.records), lists: base.lists, feedFolder: base.feedFolder };
  }

  function clearCache() { cached = null; }

  function light(rec) {
    var heavy = D().HEAVY;
    if (!heavy.some(function (k) { return rec[k] !== undefined && rec[k] !== null; })) return rec;
    var out = Object.assign({}, rec);
    heavy.forEach(function (k) { delete out[k]; });
    out._rf_light = true;
    return out;
  }

  function buildState(readyIds, records, listRows) {
    var ready = new Set(readyIds);
    var map = new Map();
    records.forEach(function (rec) { if (ready.has(rec.id)) map.set(rec.id, light(rec)); });
    var lists = { folders: [], feeds: [], labels: [], saved_searches: [], prefs: {} };
    listRows.forEach(function (row) { if (row && row.name in lists && row.items) lists[row.name] = row.items; });
    var feedFolder = new Map();
    lists.feeds.forEach(function (f) { feedFolder.set(f.feed_id, f.folder_id === undefined ? null : f.folder_id); });
    return { records: map, lists: lists, feedFolder: feedFolder };
  }

  // ---- parameters --------------------------------------------------------------------

  function truthy(v) {
    return v !== null && v !== undefined && ['true', '1', 'on', 'yes'].indexOf(String(v).toLowerCase()) >= 0;
  }

  function intOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return Number.isInteger(n) ? n : null;
  }

  function jsonList(v) {
    if (Array.isArray(v)) return v;
    if (typeof v !== 'string' || !v.trim()) return [];
    try { var out = JSON.parse(v); return Array.isArray(out) ? out : []; } catch (e) { return []; }
  }

  function tokenIds(items, prefix) {
    var out = [];
    items.forEach(function (it) {
      if (typeof it === 'string' && it.indexOf(prefix) === 0) {
        var n = intOrNull(it.slice(prefix.length));
        if (n !== null && n >= 0) out.push(n);
      }
    });
    return out;
  }

  function get(params, k) {
    if (!params) return null;
    if (typeof params.get === 'function') return params.get(k);
    return params[k] === undefined ? null : params[k];
  }

  // search_score: the score knobs as list_articles takes them.
  function searchScore(source, op, val, sort) {
    var src = SCORE_SOURCES.indexOf(source) >= 0 ? source : 'relevance';
    var v = val === null || val === undefined || val === '' ? null : Number(val);
    if ((op === 'gte' || op === 'lt') && v !== null && isFinite(v)) return { score_source: src, score_op: op, score_val: v };
    if (sort === 'score') return { score_source: src };
    return {};
  }

  // The request's filters, normalised as render_list sees them.
  function parseFilters(params, state) {
    var f = {
      feed_id: intOrNull(get(params, 'feed_id')),
      folder_id: intOrNull(get(params, 'folder_id')),
      scope_include: get(params, 'scope_include') || null,
      label_id: intOrNull(get(params, 'label_id')),
      unread_only: truthy(get(params, 'unread_only')),
      starred_only: truthy(get(params, 'starred_only')),
      archived_only: truthy(get(params, 'archived_only')),
      saved_only: truthy(get(params, 'saved_only')),
      labeled_only: truthy(get(params, 'labeled_only')),
      q: get(params, 'q') || null,
      sort: get(params, 'sort') || null,
      read_status: get(params, 'read_status') || null,
      label_filter: get(params, 'label_filter') || null,
      since_days: intOrNull(get(params, 'since_days')),
      state: SEARCH_STATES.indexOf(get(params, 'state')) >= 0 ? get(params, 'state') : null,
      show_read: truthy(get(params, 'show_read')),
      saved_search: null,
      score: null,
    };
    f.score = searchScore(get(params, 'score_source'), get(params, 'score_op'), get(params, 'score_val'), f.sort);
    var sid = intOrNull(get(params, 'saved_search_id'));
    if (sid === null) sid = intOrNull(get(params, 'view_id'));
    if (sid !== null && state) {
      var saved = state.lists.saved_searches.filter(function (s) { return s.id === sid; })[0] || null;
      f.saved_search = saved || { id: sid, name: '', params: {}, member_ids: [], missing: true };
      // A saved search opened as a view takes its stored parameters; others are ignored.
      var p = f.saved_search.params || {};
      f.feed_id = f.folder_id = f.label_id = null;
      f.unread_only = f.starred_only = f.archived_only = f.saved_only = f.labeled_only = false;
      f.q = p.q || null;
      f.sort = p.sort || 'relevance';
      f.read_status = f.show_read ? null : (p.read_status || null);
      f.scope_include = p.scope_include ? JSON.stringify(p.scope_include) : null;
      f.label_filter = p.label_filter ? JSON.stringify(p.label_filter) : null;
      f.since_days = p.since_days || null;
      f.state = SEARCH_STATES.indexOf(p.state) >= 0 ? p.state : null;
      f.score = searchScore(p.score_source, p.score_op, p.score_val, p.sort);
    }
    f.is_search = !!((f.q && f.q.trim()) || f.scope_include || f.label_filter || f.read_status
      || Object.keys(f.score).length || f.since_days || f.state);
    f.in_starred = f.starred_only || f.state === 'starred';
    f.in_archived = f.archived_only || f.state === 'archived';
    f.in_saved = f.saved_only || f.state === 'saved';
    return f;
  }

  // ---- matching and ordering ---------------------------------------------------------

  function sortTs(rec) {
    var t = Date.parse(rec.published_at || rec.fetched_at || '');
    return isNaN(t) ? 0 : t;
  }

  function scoreOf(rec, source) {
    if (source === 'ai') return rec.ai_score === undefined ? null : rec.ai_score;
    if (source === 'basic') return rec.lexical_score === undefined ? null : rec.lexical_score;
    if (rec.ai_score !== null && rec.ai_score !== undefined) return rec.ai_score;
    return rec.lexical_score === undefined ? null : rec.lexical_score;
  }

  function fold(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function subscribed(state, rec) {
    return rec.feed_id !== null && rec.feed_id !== undefined && state.feedFolder.has(rec.feed_id);
  }

  // The structural filters (no read/star/archive/saved state): which articles a view
  // is about. story_scope's filters plus the subscription rule.
  function matchesStructure(state, rec, f, now) {
    // A saved search is its member ids: the server ran its filters (query, scope,
    // labels, score, time, status, list) at sync time. Local read/star changes since
    // are applied on top by matchesState.
    if (f.saved_search) return (f.saved_search.member_ids || []).indexOf(rec.id) >= 0;
    var feedOptional = f.in_starred || f.in_archived || f.in_saved || f.label_id !== null
      || f.labeled_only || f.is_search || !!f.saved_search;
    if (!feedOptional && !subscribed(state, rec)) return false;
    if (f.feed_id !== null && rec.feed_id !== f.feed_id) return false;
    if (f.folder_id !== null) {
      if (!subscribed(state, rec)) return false;
      var folder = state.feedFolder.get(rec.feed_id);
      if (f.folder_id === 0 ? folder !== null : folder !== f.folder_id) return false;
    }
    if (f.scope_include) {
      var items = jsonList(f.scope_include);
      var feeds = tokenIds(items, 'feed:');
      var folders = tokenIds(items, 'folder:');
      if (feeds.length || folders.length) {
        if (!subscribed(state, rec)) return false;
        var fo = state.feedFolder.get(rec.feed_id);
        var ok = feeds.indexOf(rec.feed_id) >= 0 || folders.some(function (id) {
          return id === 0 ? fo === null : fo === id;
        });
        if (!ok) return false;
      }
    }
    var labels = rec.label_ids || [];
    if (f.label_id !== null && labels.indexOf(f.label_id) < 0) return false;
    if (f.label_id === null && f.labeled_only && !labels.length) return false;
    if (f.label_filter) {
      var lf = jsonList(f.label_filter);
      if (lf.indexOf('any') >= 0) { if (!labels.length) return false; } else {
        var ids = tokenIds(lf, 'label:');
        if (ids.length && !ids.some(function (id) { return labels.indexOf(id) >= 0; })) return false;
      }
    }
    var sc = f.score;
    if (sc.score_op) {
      var s = scoreOf(rec, sc.score_source);
      var cut = (Math.ceil(sc.score_val) - 0.5) / 100;
      if (s === null || (sc.score_op === 'gte' ? !(s >= cut) : !(s < cut))) return false;
    }
    if (f.since_days && sortTs(rec) < now - f.since_days * 86400000) return false;
    if (f.q && f.q.trim() && state.search && state.search.q === f.q.trim()) {
      if (!state.search.ids.has(rec.id)) return false;
    } else if (f.q && f.q.trim()) {
      var title = fold(rec.title);
      var words = fold(f.q).split(/\s+/).filter(Boolean);
      if (!words.every(function (w) { return title.indexOf(w) >= 0; })) return false;
    }
    return true;
  }

  function matchesState(rec, f, unreadOnly) {
    if (unreadOnly && rec.is_read) return false;
    if (f.read_status === 'unread' && rec.is_read) return false;
    if (f.read_status === 'read' && !rec.is_read) return false;
    if (f.in_starred && !rec.is_starred) return false;
    if (f.in_archived && !rec.is_archived) return false;
    if (f.in_saved && !rec.saved_at) return false;
    return true;
  }

  function sortOrder(f, prefs) {
    var order = prefs.default_sort_order || 'newest';
    if (f.is_search || f.saved_search) order = f.sort || 'relevance';
    return order;
  }

  function comparator(order, source) {
    if (order === 'score') {
      return function (a, b) {
        var sa = scoreOf(a, source), sb = scoreOf(b, source);
        if (sa !== sb) {
          if (sa === null) return 1;
          if (sb === null) return -1;
          return sb - sa;
        }
        return (sortTs(b) - sortTs(a)) || (b.id - a.id);
      };
    }
    if (order === 'oldest') return function (a, b) { return (sortTs(a) - sortTs(b)) || (a.id - b.id); };
    return function (a, b) { return (sortTs(b) - sortTs(a)) || (b.id - a.id); };
  }

  // Rows after the cursor, the way list_articles' keyset reads them.
  function afterCursor(order, source, cur) {
    if (!cur) return function () { return true; };
    return function (rec) {
      var t = sortTs(rec);
      var lt = t < cur.ts || (t === cur.ts && rec.id < cur.id);
      if (order === 'score') {
        var s = scoreOf(rec, source);
        if (cur.key === null) return s === null && lt;
        if (s === null) return true;
        return s < cur.key || (s === cur.key && lt);
      }
      if (order === 'oldest') return t > cur.ts || (t === cur.ts && rec.id > cur.id);
      return lt;
    };
  }

  function parseCursor(params) {
    var ts = get(params, 'cursor_ts');
    var id = intOrNull(get(params, 'cursor_id'));
    if (!ts || id === null) return null;
    var t = Date.parse(ts);
    if (isNaN(t)) return null;
    var key = get(params, 'cursor_key');
    var k = key === null || key === undefined || key === '' ? null : Number(key);
    return { ts: t, id: id, key: k !== null && isFinite(k) ? k : null };
  }

  function parseShown(raw) {
    if (!raw) return [];
    var out = [];
    String(raw).split(',').forEach(function (p) { var n = intOrNull(p); if (n !== null) out.push(n); });
    return out.slice(-MAX_SHOWN_STORIES);
  }

  function collapsesStories(dedup, f) {
    if (dedup === DEDUP_OFF) return false;
    return !(f.feed_id !== null || f.in_starred || f.in_archived || f.in_saved);
  }

  // story_scope: the structural filters that decide which members of a story belong in
  // this view, as [key, value] pairs in the server's order (for data-story-scope).
  function storyScope(f) {
    var out = [];
    if (f.feed_id !== null) out.push(['feed_id', f.feed_id]);
    if (f.folder_id !== null) out.push(['folder_id', f.folder_id]);
    if (f.scope_include) out.push(['scope_include', f.scope_include]);
    if (f.label_id !== null) out.push(['label_id', f.label_id]);
    else if (f.labeled_only) out.push(['labeled_only', 'True']);
    if (f.label_filter) out.push(['label_filter', f.label_filter]);
    if (f.q && f.q.trim()) out.push(['q', f.q]);
    if (f.score.score_op) {
      out.push(['score_source', f.score.score_source], ['score_op', f.score.score_op], ['score_val', f.score.score_val]);
    }
    if (f.since_days) out.push(['since_days', f.since_days]);
    return out;
  }

  function qs(pairs) {
    return pairs.map(function (p) {
      return encodeURIComponent(p[0]).replace(/%20/g, '+') + '=' + encodeURIComponent(String(p[1])).replace(/%20/g, '+');
    }).join('&');
  }

  // A filter object holding only the structure of a story scope (for unfolding).
  function scopeFilters(params) {
    var f = parseFilters(params, null);
    return {
      feed_id: f.feed_id, folder_id: f.folder_id, scope_include: f.scope_include, label_id: f.label_id,
      labeled_only: f.labeled_only, label_filter: f.label_filter, q: f.q, since_days: f.since_days,
      score: f.score.score_op ? f.score : {}, is_search: true, saved_search: null,
      in_starred: false, in_archived: false, in_saved: false,
    };
  }

  // Story counts for one row: others in this view, the whole group, and how many of
  // the others are read. Over what the device holds.
  function storyInfo(state, rec, scopeF, now) {
    if (rec.story_id === null || rec.story_id === undefined) return null;
    var members = [];
    state.records.forEach(function (r) { if (r.id !== rec.id && r.story_id === rec.story_id) members.push(r); });
    if (!members.length) return null;
    var others = scopeF ? members.filter(function (m) { return matchesStructure(state, m, scopeF, now); }) : members;
    return {
      others: others.length,
      total: members.length,
      read: others.filter(function (m) { return m.is_read; }).length,
    };
  }

  // ---- the list ------------------------------------------------------------------------

  // One page of a list, as render_list / htmx_article_list_more compute it.
  // opts: now (ms), first (true for /htmx/articles: applies the adaptive unread rule).
  // -> {ids, rawIds, hasMore, moreQs, unreadOnly, collapses, storyScopeQs, stories,
  //     filters, sortOrder, perPage, resultCount}
  function page(state, params, opts) {
    opts = opts || {};
    var now = opts.now === undefined ? Date.now() : opts.now;
    var prefs = state.lists.prefs || {};
    var f = parseFilters(params, state);
    var order = sortOrder(f, prefs);
    var perPage = intOrNull(prefs.articles_per_page) || 50;
    var dedup = prefs.story_dedup || 'collapse';

    var structural = [];
    state.records.forEach(function (rec) { if (matchesStructure(state, rec, f, now)) structural.push(rec); });

    // The reader's unread setting (synced pref, server default "adaptive": unread when
    // there is any, else everything), as render_list and saved_view_unread_only apply it.
    var unreadFilter = prefs.unread_filter || 'adaptive';
    var unreadOnly;
    if (!opts.first) {
      unreadOnly = f.unread_only;
    } else if (f.saved_search) {
      if (f.read_status || f.show_read) unreadOnly = false;
      else if (unreadFilter === 'unread_only') unreadOnly = true;
      else if (unreadFilter === 'show_all') unreadOnly = false;
      else {
        unreadOnly = structural.some(function (r) { return !r.is_read && matchesState(r, f, false); });
      }
    } else if (f.is_search || f.starred_only || f.archived_only || f.saved_only) {
      unreadOnly = false;
    } else if (f.unread_only) {
      unreadOnly = true;
    } else if (unreadFilter === 'unread_only') {
      unreadOnly = true;
    } else if (unreadFilter === 'show_all') {
      unreadOnly = false;
    } else {
      unreadOnly = structural.some(function (r) { return !r.is_read; });
    }

    var source = f.score.score_source;
    var matched = structural.filter(function (r) { return matchesState(r, f, unreadOnly); });
    matched.sort(comparator(order, source));
    var cursor = parseCursor(params);
    var after = afterCursor(order, source, cursor);
    var offset = cursor ? 0 : (intOrNull(get(params, 'offset')) || 0);
    var raw = matched.filter(after).slice(offset, offset + perPage);
    var hasMore = raw.length >= perPage;

    var collapses = collapsesStories(dedup, f);
    var shown = parseShown(get(params, 'shown_stories'));
    var rows = raw;
    var nextShown = [];
    if (collapses) {
      var seen = new Set(shown);
      rows = raw.filter(function (r) {
        if (r.story_id === null || r.story_id === undefined) return true;
        if (seen.has(r.story_id)) return false;
        seen.add(r.story_id);
        return true;
      });
      nextShown = shown.slice();
      var known = new Set(nextShown);
      rows.forEach(function (r) {
        if (r.story_id !== null && r.story_id !== undefined && !known.has(r.story_id)) {
          known.add(r.story_id); nextShown.push(r.story_id);
        }
      });
      nextShown = nextShown.slice(-MAX_SHOWN_STORIES);
    }

    var scopePairs = storyScope(f);
    var stories = {};
    if (dedup !== DEDUP_OFF) {
      var scopeF = collapses && scopePairs.length ? scopeFilters(new URLSearchParams(qs(scopePairs))) : null;
      rows.forEach(function (r) {
        var info = storyInfo(state, r, scopeF, now);
        if (info) stories[r.id] = info;
      });
    }

    var more = filterParams(f, order, unreadOnly);
    if (raw.length) {
      var last = raw[raw.length - 1];
      more.push(['cursor_ts', new Date(sortTs(last)).toISOString()], ['cursor_id', last.id]);
      if (order === 'score' || (f.q && f.q.trim() && order !== 'newest' && order !== 'oldest')) {
        var k = order === 'score' ? scoreOf(last, source) : null;
        more.push(['cursor_key', k === null ? '' : String(k)]);
      }
    }
    if (nextShown.length) more.push(['shown_stories', nextShown.join(',')]);

    return {
      ids: rows.map(function (r) { return r.id; }),
      rawIds: raw.map(function (r) { return r.id; }),
      hasMore: hasMore,
      moreQs: qs(more),
      unreadOnly: unreadOnly,
      collapses: collapses,
      storyScopeQs: qs(scopePairs),
      stories: stories,
      filters: f,
      sortOrder: order,
      perPage: perPage,
      resultCount: f.is_search || f.saved_search ? countIds(matched, collapses) : null,
    };
  }

  // _build_filter_params, plus saved_search_id: the device answers "load more" of a
  // saved search from its member ids, which the filters alone cannot reproduce.
  function filterParams(f, order, unreadOnly) {
    var p = [];
    if (f.saved_search) p.push(['saved_search_id', f.saved_search.id]);
    if (f.feed_id !== null) p.push(['feed_id', f.feed_id]);
    if (f.folder_id !== null) p.push(['folder_id', f.folder_id]);
    if (f.scope_include) p.push(['scope_include', f.scope_include]);
    if (f.label_id !== null) p.push(['label_id', f.label_id]);
    if (unreadOnly) p.push(['unread_only', 'true']);
    if (f.starred_only) p.push(['starred_only', 'true']);
    if (f.archived_only) p.push(['archived_only', 'true']);
    if (f.saved_only) p.push(['saved_only', 'true']);
    if (f.labeled_only) p.push(['labeled_only', 'true']);
    if (f.q && f.q.trim()) p.push(['q', f.q.trim()]);
    if (f.is_search) {
      p.push(['sort', order]);
      if (f.read_status) p.push(['read_status', f.read_status]);
      if (f.label_filter) p.push(['label_filter', f.label_filter]);
      Object.keys(f.score).forEach(function (k) { p.push([k, f.score[k]]); });
      if (f.since_days) p.push(['since_days', f.since_days]);
      if (f.state) p.push(['state', f.state]);
    }
    return p;
  }

  // Rows the way a badge counts them: one per story where the view collapses.
  function countIds(recs, collapsing) {
    if (!collapsing) return recs.length;
    var keys = new Set();
    recs.forEach(function (r) { keys.add(r.story_id === null || r.story_id === undefined ? -r.id : r.story_id); });
    return keys.size;
  }

  // Attaches the local full-text hits for the request's `q` (offline/search.js) to the
  // state, so `page` filters by them. Without an index (not built yet) `q` stays the
  // plain title match.
  function withSearch(db, state, params) {
    var q = String(parseFilters(params, state).q || '').trim();
    if (!q || !RF.search) return Promise.resolve(state);
    return RF.search.lookup(db, q).then(function (ids) {
      if (ids) state.search = { q: q, ids: new Set(ids) };
      return state;
    }, function () { return state; });
  }

  // -> Promise<number[]>: the ids of one page, in order, after story collapsing.
  function query(db, params, opts) {
    return loadState(db).then(function (state) {
      return withSearch(db, state, params);
    }).then(function (state) {
      return page(state, params, Object.assign({ first: true }, opts || {})).ids;
    });
  }

  // Ids of a scope's articles (for mark-read), unread or not. scope: {feed_id} |
  // {folder_id} | {label_id} | {labeled_only} | {starred_only} | {archived_only} |
  // {saved_only} | {saved_search_id} | {all: true}.
  function scopeRecords(state, scope, now) {
    var params = {};
    Object.keys(scope).forEach(function (k) { if (k !== 'all') params[k] = String(scope[k]); });
    var f = parseFilters(params, state);
    var out = [];
    state.records.forEach(function (rec) {
      if (matchesStructure(state, rec, f, now === undefined ? Date.now() : now) && matchesState(rec, f, false)) out.push(rec);
    });
    return out;
  }

  // ---- sidebar counts --------------------------------------------------------------------

  // sidebar_counts over the device's articles. Unread counts follow the view's
  // collapsing (the main list, folders and labels count one row per story when the
  // reader folds stories); feeds, starred, archived and saved count articles.
  function counts(state) {
    var dedup = (state.lists.prefs || {}).story_dedup || 'collapse';
    var collapse = dedup !== DEDUP_OFF;
    var recs = Array.from(state.records.values());
    function badge(list, collapsing) {
      var unread = list.filter(function (r) { return !r.is_read; });
      return { unread: countIds(unread, collapsing), total: countIds(list, collapsing) };
    }
    var subscribedRecs = recs.filter(function (r) { return subscribed(state, r); });
    var out = {
      all: badge(subscribedRecs, collapse),
      starred: badge(recs.filter(function (r) { return r.is_starred; }), false),
      archived: badge(recs.filter(function (r) { return r.is_archived; }), false),
      saved: badge(recs.filter(function (r) { return !!r.saved_at; }), false),
      labeled: badge(recs.filter(function (r) { return (r.label_ids || []).length; }), collapse),
      labels: {}, folders: {}, feeds: {}, noFolder: null,
    };
    state.lists.labels.forEach(function (l) {
      out.labels[l.id] = badge(recs.filter(function (r) { return (r.label_ids || []).indexOf(l.id) >= 0; }), collapse);
    });
    var byFolder = new Map();
    var byFeed = new Map();
    subscribedRecs.forEach(function (r) {
      var fo = state.feedFolder.get(r.feed_id);
      if (!byFolder.has(fo)) byFolder.set(fo, []);
      byFolder.get(fo).push(r);
      if (!byFeed.has(r.feed_id)) byFeed.set(r.feed_id, []);
      byFeed.get(r.feed_id).push(r);
    });
    state.lists.folders.forEach(function (fo) { out.folders[fo.id] = badge(byFolder.get(fo.id) || [], collapse); });
    out.noFolder = badge(byFolder.get(null) || [], collapse);
    state.lists.feeds.forEach(function (fe) { out.feeds[fe.feed_id] = badge(byFeed.get(fe.feed_id) || [], false); });
    out.savedSearches = {};
    state.lists.saved_searches.forEach(function (s) {
      var st = (s.params || {}).state;
      var f = parseFilters({ saved_search_id: String(s.id) }, state);
      var members = recs.filter(function (r) { return matchesStructure(state, r, f, Date.now()) && matchesState(r, f, false); });
      out.savedSearches[s.id] = badge(members, collapsesStories(dedup, { feed_id: null,
        in_starred: st === 'starred', in_archived: st === 'archived', in_saved: st === 'saved' }));
    });
    return out;
  }

  // Story members of an article, in the reader's sort order, filtered by a scope (the
  // unfolding row's data-story-scope) when given. Excludes the article itself.
  function storyMembers(state, rec, scopeParams) {
    if (!rec || rec.story_id === null || rec.story_id === undefined) return [];
    var scopeF = scopeParams ? scopeFilters(scopeParams) : null;
    var now = Date.now();
    var members = [];
    state.records.forEach(function (r) {
      if (r.id === rec.id || r.story_id !== rec.story_id) return;
      if (rec.url && r.url && r.url === rec.url) return;
      if (scopeF && !matchesStructure(state, r, scopeF, now)) return;
      members.push(r);
    });
    var order = (state.lists.prefs || {}).default_sort_order || 'newest';
    members.sort(comparator(order === 'oldest' ? 'oldest' : 'newest', null));
    return members;
  }

  RF.lists = {
    loadState: loadState,
    clearCache: clearCache,
    buildState: buildState,
    parseFilters: parseFilters,
    page: page,
    query: query,
    withSearch: withSearch,
    scopeRecords: scopeRecords,
    counts: counts,
    countIds: countIds,
    storyMembers: storyMembers,
    storyInfo: storyInfo,
    sortTs: sortTs,
    scoreOf: scoreOf,
    truthy: truthy,
    intOrNull: intOrNull,
    qs: qs,
  };
})(self);

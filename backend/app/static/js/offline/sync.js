// Offline sync engine: brings the device store in line with the server.
//
// Plain script for page and worker (`self.RFOffline.sync`); needs db.js and media.js.
//
// One run, in this order (design 5.4):
//   1. send the outbox (POST /sync/v1/ops, up to 500 per request)
//   2. manifest (GET /sync/v1/manifest) and diff it against the stored versions
//   3. remove ids that left the scope (record, snapshot and ready mark together)
//   4. fetch records for new and changed ids (POST /sync/v1/articles, 200 per request)
//   5. fetch snapshots that are missing or stale (GET /sync/v1/snapshots, 50 per request)
//   6. lists (GET /sync/v1/lists) when a list version changed, articles came or went,
//      or ops were sent
//   7. media queue: images of ready snapshots, newest article first, not yet cached
// then, on success, the app shell cache (R1).
//
// Every "what is needed" decision is made from what is stored plus the manifest, never
// from this run's diff alone, so a run that stops half way (network, 401) is finished
// by the next one. Each batch is committed on its own; no IndexedDB transaction is held
// across a request.
//
// A wipe (RFOffline.db.wipeAll) can happen at any moment. Every request and every cache
// write checks `RFOffline.db.alive(db)`; once it is false the run stops with
// error 'wiped' and deletes any cache it touched after the wipe.
(function (root) {
  'use strict';
  var RF = root.RFOffline = root.RFOffline || {};

  var OPS_BATCH = 500;
  var ARTICLES_BATCH = 200;
  var SNAPSHOTS_BATCH = 50;
  // Signed media links live 30 days (services/sync/media.py). A snapshot older than this
  // whose images are not all cached is fetched again for fresh links.
  var RESIGN_AFTER_MS = 25 * 24 * 3600 * 1000;
  var LIST_NAMES = ['folders', 'feeds', 'labels', 'saved_searches', 'prefs'];
  // The server refuses the request itself for these (the whole batch): find the op.
  var POISON_STATUS = [400, 413, 422];
  // Ops the server skipped only for its per-request budget (save_url, extract_readable,
  // ai_*) are sent again in further requests of the same run, at most this many.
  var BUDGET_RESENDS = 10;

  function D() { return RF.db; }
  function M() { return RF.media; }

  // ---- pure --------------------------------------------------------------------------

  // local: Map<id, version>; remote: [[id, version], ...] -> {fetch, remove}
  function diffManifest(local, remote) {
    var fetch = [];
    var seen = new Set();
    remote.forEach(function (pair) {
      var id = pair[0];
      seen.add(id);
      if (!local.has(id) || local.get(id) !== pair[1]) fetch.push(id);
    });
    var remove = [];
    local.forEach(function (_, id) { if (!seen.has(id)) remove.push(id); });
    return { fetch: fetch, remove: remove };
  }

  // Does this stored snapshot need fetching again?
  function snapshotStale(record, snap, versions, mediaKnown, nowMs) {
    if (!snap) return true;
    if (snap.content_version !== record.content_version) return true;
    if (versions.templates !== undefined && snap.template_version !== versions.templates) return true;
    if (versions.prefs !== undefined && snap.prefs_version !== versions.prefs) return true;
    if (snap.fetched_at && nowMs - Date.parse(snap.fetched_at) > RESIGN_AFTER_MS) {
      return (snap.media || []).some(function (u) { return !mediaKnown.has(M().cacheKey(u)); });
    }
    return false;
  }

  function chunks(list, n) {
    var out = [];
    for (var i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
    return out;
  }

  function hasArticle(op) {
    return op.article_id !== null && op.article_id !== undefined;
  }

  // ---- transport ---------------------------------------------------------------------

  function Stop(kind, detail) {
    this.kind = kind;
    this.detail = detail;
  }

  function readCookie(name) {
    var doc = root.document;
    if (!doc || typeof doc.cookie !== 'string') return null;
    var hit = doc.cookie.split('; ').find(function (c) { return c.indexOf(name + '=') === 0; });
    return hit ? hit.slice(name.length + 1) : null;
  }

  // Called for every request, so a getter can hand out a fresh token each time.
  function csrfToken(opts) {
    if (typeof opts.csrfToken === 'function') return opts.csrfToken();
    if (typeof opts.csrfToken === 'string') return opts.csrfToken;
    return readCookie('csrftoken');
  }

  // -> call(method, path, body) -> Promise<json>; throws Stop.
  // A POST answered 403 is sent once more with a token read again; a second 403 is
  // Stop('csrf').
  // Every request names the reader this database belongs to (X-Readfine-User). The
  // server answers 409 {"error": "account_mismatch"} before doing anything when the
  // session is another reader's (signed in elsewhere in this browser): Stop('account'),
  // so this reader's ops never land in that account and its data never lands here.
  function client(opts, alive, userId) {
    var fetchFn = opts.fetchFn || root.fetch.bind(root);
    async function once(method, path, body) {
      if (!alive()) throw new Stop('wiped');
      var init = { method: method, credentials: 'include', headers: { accept: 'application/json', 'x-readfine-user': String(userId) } };
      if (method !== 'GET') {
        init.headers['content-type'] = 'application/json';
        var token = await csrfToken(opts);
        if (token) init.headers['x-csrftoken'] = token;
        init.body = JSON.stringify(body);
      }
      var res;
      try {
        res = await fetchFn(path, init);
      } catch (err) {
        throw new Stop('network', String((err && err.message) || err));
      }
      if (!alive()) throw new Stop('wiped');
      return res;
    }
    return async function call(method, path, body) {
      var res = await once(method, path, body);
      if (res.status === 403 && method !== 'GET') {
        res = await once(method, path, body);
        if (res.status === 403) throw new Stop('csrf', 403);
      }
      // A 401, or a redirect to the login page, means the session is over.
      if (res.status === 401 || res.redirected) throw new Stop('auth', res.status);
      if (res.status === 409) throw new Stop('account', 409);
      if (res.status === 429) throw new Stop('rate_limited', 429);
      if (!res.ok) throw new Stop('http', res.status);
      try {
        return await res.json();
      } catch (e) {
        throw new Stop('auth', 'not json');
      }
    };
  }

  // ---- 1. outbox ---------------------------------------------------------------------
  //
  // Rules:
  // - Ops go in the order they were made. A request never carries two ops for the same
  //   article, so an op that comes back retryable has nothing after it applied already;
  //   later ops for that article are held until the next run ("held").
  // - Final result (retryable false): the row is deleted, except a `failed` whose reason
  //   is not in DROP_FAILED (the server refused what the reader asked for: an address it
  //   cannot save, an invalid value, or a reason this client does not know yet). That op
  //   is kept as `poison`, so the reader sees it. `failed/not_found` (the article is
  //   gone) and every `skipped` go quietly.
  // - Retryable result: attempts+1 and last_error; at MAX_ATTEMPTS the op is `stuck`.
  //   Except `skipped/rate_limited` (the server's per-request budget): not an attempt,
  //   not held; resent in up to BUDGET_RESENDS further requests this run, while each
  //   pass gets at least one op through.
  // - 400/413/422 for the request: split it in halves until the op is alone; that op is
  //   `poison`. The rest goes through and the run continues.
  // - 5xx for the request: once per run the manifest is fetched as a health check (if
  //   that fails too the server is down: the run stops, nothing counted). Then the same
  //   split; an op alone that still gets 5xx counts an attempt and is held.
  // - Network, 401, 403 twice, 429: the run stops before the manifest, nothing counted.
  // Poison and stuck ops are not sent and are listed in SyncReport.stuckOps until the user
  // retries (db.retryStuck) or discards them (db.discardStuck). Later ops for the same
  // article wait behind them, so a retried op never lands after what followed it.

  function opBody(e) {
    var op = e.op;
    return { op_id: op.op_id, type: op.type, article_id: op.article_id, value: op.value || {}, at: op.at };
  }

  async function markAttempt(ctx, e, error) {
    var op = await D().updateOutboxOp(ctx.db, e.key, function (row) {
      row.attempts = (row.attempts || 0) + 1;
      row.last_error = error;
      if (row.attempts >= D().MAX_ATTEMPTS) row.stuck = true;
      return row;
    });
    if (op && hasArticle(op)) ctx.held.add(op.article_id);
  }

  // Final `failed` reasons dropped quietly; every other one is kept for the reader
  // (see the rules above), so a reason added on the server later is never lost unseen.
  var DROP_FAILED = ['not_found'];

  async function markPoison(ctx, e, error) {
    await D().updateOutboxOp(ctx.db, e.key, function (row) {
      row.poison = true;
      row.last_error = error;
      return row;
    });
    if (hasArticle(e.op)) ctx.held.add(e.op.article_id);
  }

  async function applyResults(ctx, ops, resp) {
    ctx.report.opsSent += ops.length;
    var byId = new Map();
    (resp.results || []).forEach(function (r) { byId.set(r.op_id, r); });
    var finalKeys = [];
    var records = [];
    for (var i = 0; i < ops.length; i++) {
      var e = ops[i];
      var r = byId.get(e.op.op_id);
      if (r && !r.retryable && r.status === 'failed' && DROP_FAILED.indexOf(r.reason) < 0) {
        // Refused for good: kept for the user as poison rather than dropped, so it is
        // never lost unseen.
        ctx.progress = true;
        await markPoison(ctx, e, 'failed/' + (r.reason || ''));
      } else if (r && !r.retryable) {
        finalKeys.push(e.key);
        ctx.progress = true;
        if (r.article) records.push(r.article);
      } else if (r && r.reason === 'rate_limited') {
        ctx.budgetSkipped.push(e);
      } else {
        await markAttempt(ctx, e, r ? r.status + '/' + (r.reason || '') : 'no_result');
      }
    }
    await D().deleteOutboxKeys(ctx.db, finalKeys);
    // The server's record after the op, for articles kept here, unless an op still in
    // the outbox (read in the same transaction) has yet to change it.
    if (records.length) await D().putRecords(ctx.db, records, { onlyExisting: true });
  }

  async function sendGroup(ctx, ops) {
    // An article held by an earlier half of this request waits for the next run.
    ops = ops.filter(function (e) { return !(hasArticle(e.op) && ctx.held.has(e.op.article_id)); });
    if (!ops.length) return;
    var resp;
    try {
      resp = await ctx.call('POST', '/sync/v1/ops', { client_time: ctx.nowIso(), ops: ops.map(opBody) });
    } catch (err) {
      if (!(err instanceof Stop) || err.kind !== 'http') throw err;
      var status = err.detail;
      var poison = POISON_STATUS.indexOf(status) >= 0;
      if (!poison && status < 500) throw err;
      if (!poison && !ctx.probed) {
        ctx.probed = true;
        await ctx.call('GET', '/sync/v1/manifest'); // throws if the server is down
      }
      if (ops.length === 1) {
        if (poison) await markPoison(ctx, ops[0], 'http_' + status);
        else await markAttempt(ctx, ops[0], 'http_' + status);
        return;
      }
      var mid = Math.ceil(ops.length / 2);
      await sendGroup(ctx, ops.slice(0, mid));
      await sendGroup(ctx, ops.slice(mid));
      return;
    }
    await applyResults(ctx, ops, resp);
  }

  async function sendQueue(ctx, queue) {
    while (queue.length) {
      var batch = [];
      var inBatch = new Set();
      var rest = [];
      queue.forEach(function (e) {
        var a = hasArticle(e.op) ? e.op.article_id : null;
        if (a !== null && ctx.held.has(a)) return; // next run
        if (rest.length || batch.length >= OPS_BATCH || (a !== null && inBatch.has(a))) {
          rest.push(e);
          return;
        }
        batch.push(e);
        if (a !== null) inBatch.add(a);
      });
      if (!batch.length) break;
      await sendGroup(ctx, batch);
      queue = rest;
    }
  }

  async function sendOutbox(ctx) {
    var queue = [];
    (await D().outboxEntries(ctx.db)).forEach(function (e) {
      if (D().isBlocked(e.op)) {
        // Whatever comes after a stuck or poison op on the same article waits for it.
        if (hasArticle(e.op)) ctx.held.add(e.op.article_id);
        return;
      }
      queue.push(e);
    });
    await sendQueue(ctx, queue);
    for (var pass = 0; pass < BUDGET_RESENDS && ctx.budgetSkipped.length; pass++) {
      var again = ctx.budgetSkipped.sort(function (x, y) { return x.key - y.key; });
      ctx.budgetSkipped = [];
      ctx.progress = false;
      await sendQueue(ctx, again);
      if (!ctx.progress) break; // nothing got through: leave the rest for the next run
    }
  }

  async function outboxState(db) {
    var ops = (await D().outboxEntries(db)).map(function (e) { return e.op; });
    var live = ops.filter(function (op) { return !D().isBlocked(op); });
    return {
      ids: D().pendingIdsOf(ops),
      count: live.length,
      stuck: ops.filter(D().isBlocked).map(function (op) {
        return { op_id: op.op_id, type: op.type, article_id: op.article_id, attempts: op.attempts || 0,
                 last_error: op.last_error || null, poison: !!op.poison, stuck: !!op.stuck };
      }),
    };
  }

  // ---- 4–6. articles, snapshots, lists -----------------------------------------------

  // opts.onProgress({stage: 'articles'|'snapshots'|'media', done, total}), for the
  // page's "Syncing… done/total". A throwing callback never breaks the sync.
  function progress(fn, stage, done, total) {
    if (typeof fn !== 'function') return;
    try { fn({ stage: stage, done: done, total: total }); } catch (e) { /* display only */ }
  }

  async function fetchArticles(ctx, ids) {
    var batches = chunks(ids, ARTICLES_BATCH);
    var done = 0;
    if (ids.length) progress(ctx.onProgress, 'articles', 0, ids.length);
    for (var i = 0; i < batches.length; i++) {
      var resp = await ctx.call('POST', '/sync/v1/articles', { ids: batches[i] });
      var recs = (resp.articles || []).filter(function (r) { return r && typeof r.id === 'number'; });
      // Skips articles the page put an op on while this request was out.
      ctx.report.articles += await D().putRecords(ctx.db, recs);
      done += batches[i].length;
      progress(ctx.onProgress, 'articles', done, ids.length);
    }
  }

  async function fetchSnapshots(ctx, versions) {
    var db = ctx.db;
    var r = await Promise.all([
      D().getAll(db, 'articles'), D().getAll(db, 'snapshots'), D().getMeta(db, D().META.media),
    ]);
    var nowMs = ctx.nowMs();
    var snaps = new Map(r[1].map(function (s) { return [s.id, s]; }));
    var known = new Set(Object.keys(r[2] || {}));
    var need = r[0].filter(function (rec) {
      return snapshotStale(rec, snaps.get(rec.id), versions, known, nowMs);
    }).map(function (rec) { return rec.id; });
    var fetchedAt = new Date(nowMs).toISOString();
    var batches = chunks(need, SNAPSHOTS_BATCH);
    var done = 0;
    if (need.length) progress(ctx.onProgress, 'snapshots', 0, need.length);
    for (var i = 0; i < batches.length; i++) {
      var resp = await ctx.call('GET', '/sync/v1/snapshots?ids=' + batches[i].join(','));
      var list = (resp.snapshots || []).map(function (s) {
        return {
          id: s.id, content_version: s.content_version, template_version: s.template_version,
          prefs_version: s.prefs_version, row_html: s.row_html, detail_html: s.detail_html,
          media: s.media || [], fetched_at: fetchedAt,
        };
      });
      ctx.report.snapshots += await D().putSnapshots(db, list);
      list.forEach(function (sn) { ctx.snapshotted.push(sn.id); });
      done += batches[i].length;
      progress(ctx.onProgress, 'snapshots', done, need.length);
    }
  }

  async function syncLists(ctx, versions, force) {
    var db = ctx.db;
    var stored = (await D().getMeta(db, D().META.listVersions)) || {};
    var have = new Set(await D().getAllKeys(db, 'lists'));
    var changed = force || LIST_NAMES.some(function (n) { return !have.has(n) || stored[n] !== versions[n]; });
    if (!changed) return false;
    var resp = await ctx.call('GET', '/sync/v1/lists');
    var rows = LIST_NAMES.map(function (n) {
      return { name: n, items: resp[n] === undefined ? (n === 'prefs' ? {} : []) : resp[n] };
    });
    await D().putMany(db, 'lists', rows);
    await D().setMeta(db, D().META.listVersions, resp.versions || versions);
    return true;
  }

  // ---- caches under the wipe guard ---------------------------------------------------

  // Opens a cache only while `alive()`; a cache opened (so possibly recreated) after a
  // wipe is deleted again. -> cache; throws Stop('wiped')
  async function openGuarded(cs, name, alive) {
    if (!alive()) throw new Stop('wiped');
    var cache = await cs.open(name);
    await checkGuard(cs, name, alive);
    return cache;
  }

  async function checkGuard(cs, name, alive) {
    if (alive()) return;
    await cs.delete(name);
    throw new Stop('wiped');
  }

  // ---- 7. media ----------------------------------------------------------------------

  // Media of ready articles, newest article first, not stored and not given up on.
  // Drops cache entries and ledger keys that no ready snapshot uses any more.
  async function buildMediaQueue(db, cache) {
    var r = await Promise.all([
      D().readyIds(db), D().getAll(db, 'articles'), D().getAll(db, 'snapshots'),
      D().getMeta(db, D().META.media), D().getMeta(db, D().META.mediaSkipped),
    ]);
    var ready = new Set(r[0]);
    var recs = new Map(r[1].map(function (a) { return [a.id, a]; }));
    var known = r[3] || {};
    var skipped = r[4] || {};
    var snaps = r[2].filter(function (s) { return ready.has(s.id); });
    function when(s) {
      var a = recs.get(s.id);
      var t = a && (a.published_at || a.fetched_at);
      return t ? Date.parse(t) : 0;
    }
    snaps.sort(function (a, b) { return (when(b) - when(a)) || (b.id - a.id); });
    var referenced = new Set();
    var queue = [];
    var queued = new Set();
    snaps.forEach(function (s) {
      (s.media || []).forEach(function (u) {
        var k = M().cacheKey(u);
        referenced.add(k);
        if (!known[k] && !skipped[k] && !queued.has(k)) { queued.add(k); queue.push(u); }
      });
    });
    function keepReferenced(obj) {
      var out = {};
      Object.keys(obj || {}).forEach(function (k) { if (referenced.has(k)) out[k] = obj[k]; });
      return out;
    }
    // Ledger edits in their own transactions: a download running in parallel may be
    // adding keys, and those must not be lost to a stale copy read above.
    await D().updateMeta(db, D().META.media, keepReferenced);
    await D().updateMeta(db, D().META.mediaSkipped, keepReferenced);
    if (cache) await M().prune(cache, referenced);
    return queue;
  }

  var downloading = new Map();

  // Downloads `urls` into the user's media cache. Each stored image is recorded in meta
  // `media` as it lands, and each definitive failure in `media_skipped`, so a worker
  // suspended half way loses nothing. One download per database at a time: a second
  // call while one runs gets the running one. A wipe stops it ('wiped') and the cache
  // it wrote to is deleted.
  // opts: caches, fetchFn, budgetBytes, onProgress (stage 'media': images stored or
  // given up on, of urls.length). -> downloadQueue's result
  function downloadMedia(db, urls, opts) {
    if (downloading.has(db.name)) return downloading.get(db.name);
    opts = opts || {};
    var cs = opts.caches || root.caches;
    var name = M().cacheName(db.userId);
    var alive = function () { return D().alive(db); };
    function record(k, key, value) {
      return D().updateMeta(db, k, function (m) { m = m || {}; m[key] = value; return m; })
        .catch(function (err) { if (alive()) throw err; });
    }
    var p = (async function () {
      var cache;
      try {
        cache = await openGuarded(cs, name, alive);
      } catch (err) {
        if (err instanceof Stop) return { stored: 0, skipped: 0, stoppedReason: 'wiped', bytes: 0, entries: {}, failed: {} };
        throw err;
      }
      var known = (await D().getMeta(db, D().META.media)) || {};
      var given = (await D().getMeta(db, D().META.mediaSkipped)) || {};
      var used = Object.keys(known).reduce(function (s, k) { return s + known[k]; }, 0);
      var settled = 0;
      var tick = function () { settled += 1; progress(opts.onProgress, 'media', settled, urls.length); };
      if (urls.length) progress(opts.onProgress, 'media', 0, urls.length);
      var res = await M().downloadQueue(urls, {
        cache: cache, fetchFn: opts.fetchFn, budgetBytes: opts.budgetBytes, alive: alive,
        usedBytes: used, known: new Set(Object.keys(known).concat(Object.keys(given))),
        onStored: function (key, bytes) { tick(); return record(D().META.media, key, bytes); },
        onFailed: function (key, reason) { tick(); return record(D().META.mediaSkipped, key, reason); },
      });
      if (!alive()) {
        res.stoppedReason = 'wiped';
        await cs.delete(name);
      }
      return res;
    })().finally(function () { downloading.delete(db.name); });
    downloading.set(db.name, p);
    D().track(p);
    return p;
  }

  // ---- shell cache (R1) --------------------------------------------------------------

  function staticRefs(text, base, origin, cssOnly) {
    var out = [];
    var re = cssOnly ? /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g : /(?:src|href)\s*=\s*["']([^"']+)["']/g;
    var m;
    while ((m = re.exec(text))) {
      var u;
      try { u = new URL(m[1].replace(/&amp;/g, '&'), base); } catch (e) { continue; }
      if (u.origin === origin && u.pathname.indexOf('/static/') === 0) out.push(u.pathname + u.search);
    }
    return out;
  }

  function isCss(path) {
    return /\.css(\?|$)/.test(path);
  }

  // Caches /app and the static files it references in readfine-shell-<templateVersion>,
  // then deletes older shell caches. opts: caches, fetchFn, templateVersion, alive
  // (optional; checked around every write, a wipe deletes this cache and throws).
  // -> {stored, assets}; throws on failure.
  async function cacheShell(opts) {
    var cs = opts.caches || root.caches;
    var fetchFn = opts.fetchFn || root.fetch.bind(root);
    var alive = opts.alive || function () { return true; };
    var origin = (root.location && root.location.origin) || 'https://readfine.invalid';
    var name = D().SHELL_PREFIX + opts.templateVersion;
    var abs = function (p) { return new URL(p, origin).href; };

    var res = await fetchFn('/app', { credentials: 'include' });
    var finalPath = res.url ? new URL(res.url, origin).pathname : '/app';
    if (!res.ok || res.redirected || finalPath !== '/app') throw new Error('shell: /app not served');
    var html = await res.clone().text();

    var cache = await openGuarded(cs, name, alive);
    var assets = Array.from(new Set(staticRefs(html, abs('/app'), origin, false)));
    var all = new Set(assets);
    var stored = 0;
    await cache.put(abs('/app'), res);
    await checkGuard(cs, name, alive);
    for (var i = 0; i < assets.length; i++) {
      var path = assets[i];
      var hit = await cache.match(abs(path));
      if (hit && !isCss(path)) continue;
      var r = hit;
      if (!r) {
        r = await fetchFn(path, { credentials: 'include' });
        if (!r.ok) throw new Error('shell: ' + path + ' ' + r.status);
        await cache.put(abs(path), r.clone());
        await checkGuard(cs, name, alive);
        stored++;
      }
      if (isCss(path)) {
        staticRefs(await r.clone().text(), abs(path), origin, true).forEach(function (p) {
          if (!all.has(p)) { all.add(p); assets.push(p); }
        });
      }
    }
    all.add('/app');
    var reqs = await cache.keys();
    await Promise.all(reqs.map(function (q) {
      var u = new URL(typeof q === 'string' ? q : q.url, origin);
      return all.has(u.pathname + u.search) ? null : cache.delete(q);
    }));
    var names = await cs.keys();
    await Promise.all(names.filter(function (n) {
      return n !== name && n.indexOf(D().SHELL_PREFIX) === 0;
    }).map(function (n) { return cs.delete(n); }));
    await checkGuard(cs, name, alive);
    return { stored: stored, assets: all.size };
  }

  // ---- run ---------------------------------------------------------------------------

  var running = new Map();

  // opts: fetchFn, now (() => Date|ms), csrfToken (string, or a function called for
  //   every request — a worker has no cookies and must pass one; default the csrftoken
  //   cookie where `document` exists), keepIds (ids open on screen: never removed),
  //   caches (CacheStorage; enables media pruning and the shell cache), downloadMedia
  //   (await the media download in this run), budgetBytes, shell (false skips the shell).
  // -> SyncReport {articles, removed, pendingOps, stuckOps, mediaQueued, finishedAt,
  //    snapshots, opsSent, listsFetched, mediaQueue, media, shell, error, errorDetail}
  // error: null | 'auth' | 'account' | 'csrf' | 'network' | 'rate_limited' | 'http' |
  // 'wiped'. It
  // never rejects for these; data and outbox are kept, and the next run continues.
  function run(db, opts) {
    var key = db.name;
    if (running.has(key)) return running.get(key);
    var p = runOnce(db, opts || {}).finally(function () { running.delete(key); });
    running.set(key, p);
    D().track(p);
    return p;
  }

  // Keeps the local search index in step with the stored articles (offline/search.js).
  // A failure here never fails the sync: search falls back to a title match.
  async function reindex(ctx) {
    if (!RF.search || !D().alive(ctx.db)) return;
    try { await RF.search.ensure(ctx.db, { touched: ctx.snapshotted }); } catch (err) { /* search is a convenience */ }
  }

  async function runOnce(db, opts) {
    var nowFn = opts.now || function () { return Date.now(); };
    var alive = function () { return D().alive(db); };
    var ctx = {
      db: db,
      call: client(opts, alive, db.userId),
      held: new Set(),
      snapshotted: [],
      probed: false,
      budgetSkipped: [],
      progress: false,
      onProgress: opts.onProgress,
      nowMs: function () { var t = nowFn(); return t instanceof Date ? t.getTime() : Number(t); },
      report: {
        articles: 0, removed: 0, pendingOps: 0, stuckOps: [], mediaQueued: 0, finishedAt: null,
        snapshots: 0, opsSent: 0, listsFetched: false, mediaQueue: [], media: null,
        shell: 'skipped', error: null, errorDetail: null,
      },
    };
    ctx.nowIso = function () { return new Date(ctx.nowMs()).toISOString(); };
    var report = ctx.report;
    var keep = new Set(opts.keepIds || []);
    var cs = opts.caches || null;

    try {
      await sendOutbox(ctx);
      var manifest = await ctx.call('GET', '/sync/v1/manifest');
      // The server's image budget per device (OFFLINE_MEDIA_BUDGET_MB), for downloads.
      var budgetMb = manifest.limits && manifest.limits.media_budget_mb;
      if (budgetMb > 0) report.mediaBudgetBytes = budgetMb * 1024 * 1024;
      var local = new Map((await D().getAll(db, 'articles')).map(function (a) { return [a.id, a.version]; }));
      var pending = (await outboxState(db)).ids;
      var diff = diffManifest(local, manifest.articles || []);
      // An article with ops still in delivery keeps the device's state until they land.
      diff.fetch = diff.fetch.filter(function (id) { return !pending.has(id); });
      diff.remove = diff.remove.filter(function (id) { return !pending.has(id) && !keep.has(id); });
      report.removed = diff.remove.length;
      await D().removeArticles(db, diff.remove);
      await fetchArticles(ctx, diff.fetch);
      await fetchSnapshots(ctx, manifest.lists || {});
      await reindex(ctx);
      // Saved-search member ids follow article state, which no list version covers.
      var force = diff.fetch.length > 0 || diff.remove.length > 0 || report.opsSent > 0;
      report.listsFetched = await syncLists(ctx, manifest.lists || {}, force);
      var cache = cs ? await openGuarded(cs, M().cacheName(db.userId), alive) : null;
      report.mediaQueue = await buildMediaQueue(db, cache);
      if (cs) await checkGuard(cs, M().cacheName(db.userId), alive);
      report.mediaQueued = report.mediaQueue.length;
      report.finishedAt = ctx.nowIso();
      await D().setMeta(db, D().META.lastSync, {
        finishedAt: report.finishedAt, serverTime: manifest.server_time || null,
      });
      if (cs && opts.shell !== false && manifest.lists && manifest.lists.templates) {
        try {
          await cacheShell({ caches: cs, fetchFn: opts.fetchFn, templateVersion: manifest.lists.templates, alive: alive });
          report.shell = 'ok';
        } catch (err) {
          if (err instanceof Stop) throw err;
          report.shell = 'failed';
        }
      }
      if (opts.downloadMedia && cs && report.mediaQueue.length) {
        report.media = await downloadMedia(db, report.mediaQueue, {
          caches: cs, fetchFn: opts.fetchFn,
          budgetBytes: opts.budgetBytes !== undefined ? opts.budgetBytes : report.mediaBudgetBytes,
          onProgress: opts.onProgress,
        });
        if (report.media.stoppedReason === 'wiped') throw new Stop('wiped');
      }
    } catch (err) {
      if (!(err instanceof Stop) || err.kind !== 'wiped') {
        // A run that stopped half way may still have changed what the device holds.
        if (report.articles || report.removed || report.snapshots) await reindex(ctx);
      }
      if (err instanceof Stop) {
        report.error = err.kind;
        report.errorDetail = err.detail === undefined ? null : err.detail;
      } else if (!alive()) {
        // IndexedDB refuses a closed connection: the wipe got there first.
        report.error = 'wiped';
      } else {
        throw err;
      }
    }
    if (report.error === 'wiped' || !alive()) {
      report.error = 'wiped';
      return report;
    }
    var state = await outboxState(db);
    report.pendingOps = state.count;
    report.stuckOps = state.stuck;
    return report;
  }

  RF.sync = {
    diffManifest: diffManifest,
    run: run,
    downloadMedia: downloadMedia,
    cacheShell: cacheShell,
    LIMITS: { ops: OPS_BATCH, articles: ARTICLES_BATCH, snapshots: SNAPSHOTS_BATCH },
  };
})(self);

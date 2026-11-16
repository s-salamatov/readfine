// Offline sync engine: brings the device store in line with the server.
//
// Plain script for page and worker (`self.RFOffline.sync`); needs db.js and media.js.
//
// One run, in this order (design 5.4):
//   1. send the outbox (POST /sync/v1/ops, 500 per request)
//   2. manifest (GET /sync/v1/manifest) and diff it against the stored versions
//   3. remove ids that left the scope (record, snapshot and ready mark together)
//   4. fetch records for new and changed ids (POST /sync/v1/articles, 200 per request)
//   5. fetch snapshots that are missing or stale (GET /sync/v1/snapshots, 50 per request)
//   6. lists (GET /sync/v1/lists) when a list version changed or articles came or went
//   7. media queue: images of ready snapshots, newest article first, not yet cached
// then, on success, the app shell cache (R1).
//
// Every "what is needed" decision is made from what is stored plus the manifest, never
// from this run's diff alone, so a run that stops half way (network, 401) is finished
// by the next one. Each batch is committed on its own; no IndexedDB transaction is held
// across a request.
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

  function csrfToken(opts) {
    if (typeof opts.csrfToken === 'function') return opts.csrfToken();
    if (typeof opts.csrfToken === 'string') return opts.csrfToken;
    return readCookie('csrftoken');
  }

  function client(opts) {
    var fetchFn = opts.fetchFn || root.fetch.bind(root);
    return function (method, path, body) {
      var init = { method: method, credentials: 'include', headers: { accept: 'application/json' } };
      if (method !== 'GET') {
        init.headers['content-type'] = 'application/json';
        var token = csrfToken(opts);
        if (token) init.headers['x-csrftoken'] = token;
        init.body = JSON.stringify(body);
      }
      return Promise.resolve().then(function () { return fetchFn(path, init); }).then(function (res) {
        // A 401, or a redirect to the login page, means the session is over.
        if (res.status === 401 || res.redirected) throw new Stop('auth', res.status);
        if (res.status === 429) throw new Stop('rate_limited', 429);
        if (!res.ok) throw new Stop('http', res.status);
        return res.json().catch(function () { throw new Stop('auth', 'not json'); });
      }, function (err) {
        if (err instanceof Stop) throw err;
        throw new Stop('network', String(err && err.message || err));
      });
    };
  }

  // ---- steps -------------------------------------------------------------------------

  // Sends the outbox; keeps every op without a final result (retryable, or no answer).
  function sendOutbox(db, call, nowIso, report) {
    return D().outboxEntries(db).then(function (entries) {
      var batches = chunks(entries, OPS_BATCH);
      var i = 0;
      function nextBatch() {
        if (i >= batches.length) return Promise.resolve();
        var batch = batches[i++];
        var body = {
          client_time: nowIso(),
          ops: batch.map(function (e) {
            return { op_id: e.op.op_id, type: e.op.type, article_id: e.op.article_id,
                     value: e.op.value || {}, at: e.op.at };
          }),
        };
        return call('POST', '/sync/v1/ops', body).then(function (resp) {
          report.opsSent += batch.length;
          var byId = new Map();
          (resp.results || []).forEach(function (r) { byId.set(r.op_id, r); });
          var finalKeys = [];
          var keptArticles = new Set();
          batch.forEach(function (e) {
            var r = byId.get(e.op.op_id);
            if (r && !r.retryable) finalKeys.push(e.key);
            else if (e.op.article_id !== null && e.op.article_id !== undefined) keptArticles.add(e.op.article_id);
          });
          // The server's record after the op, unless a kept op still has to change it.
          var records = [];
          (resp.results || []).forEach(function (r) {
            if (!r.retryable && r.article && !keptArticles.has(r.article.id)) records.push(r.article);
          });
          return D().deleteOutboxKeys(db, finalKeys)
            .then(function () { return records.length ? updateRecords(db, records) : null; })
            .then(nextBatch);
        });
      }
      return nextBatch();
    });
  }

  // Upserts server records for articles the device already keeps (op results).
  function updateRecords(db, records) {
    return D().getAllKeys(db, 'articles').then(function (keys) {
      var have = new Set(keys);
      return D().putMany(db, 'articles', records.filter(function (r) { return have.has(r.id); }));
    });
  }

  function pendingArticleIds(db) {
    return D().outboxEntries(db).then(function (entries) {
      var ids = new Set();
      entries.forEach(function (e) {
        if (e.op.article_id !== null && e.op.article_id !== undefined) ids.add(e.op.article_id);
      });
      return { ids: ids, count: entries.length };
    });
  }

  function fetchArticles(db, call, ids, report) {
    return chunks(ids, ARTICLES_BATCH).reduce(function (p, batch) {
      return p.then(function () {
        return call('POST', '/sync/v1/articles', { ids: batch }).then(function (resp) {
          var recs = (resp.articles || []).filter(function (r) { return r && typeof r.id === 'number'; });
          report.articles += recs.length;
          return D().putMany(db, 'articles', recs);
        });
      });
    }, Promise.resolve());
  }

  function fetchSnapshots(db, call, versions, nowMs, report) {
    return Promise.all([
      D().getAll(db, 'articles'), D().getAll(db, 'snapshots'), D().getMeta(db, D().META.media),
    ]).then(function (r) {
      var snaps = new Map(r[1].map(function (s) { return [s.id, s]; }));
      var known = new Set(Object.keys(r[2] || {}));
      var need = r[0].filter(function (rec) {
        return snapshotStale(rec, snaps.get(rec.id), versions, known, nowMs);
      }).map(function (rec) { return rec.id; });
      var fetchedAt = new Date(nowMs).toISOString();
      return chunks(need, SNAPSHOTS_BATCH).reduce(function (p, batch) {
        return p.then(function () {
          return call('GET', '/sync/v1/snapshots?ids=' + batch.join(',')).then(function (resp) {
            var list = (resp.snapshots || []).map(function (s) {
              return {
                id: s.id, content_version: s.content_version, template_version: s.template_version,
                prefs_version: s.prefs_version, row_html: s.row_html, detail_html: s.detail_html,
                media: s.media || [], fetched_at: fetchedAt,
              };
            });
            return D().putSnapshots(db, list).then(function (n) { report.snapshots += n; });
          });
        });
      }, Promise.resolve());
    });
  }

  function syncLists(db, call, versions, force) {
    return Promise.all([
      D().getMeta(db, D().META.listVersions), D().getAllKeys(db, 'lists'),
    ]).then(function (r) {
      var stored = r[0] || {};
      var have = new Set(r[1]);
      var changed = force || LIST_NAMES.some(function (n) {
        return !have.has(n) || stored[n] !== versions[n];
      });
      if (!changed) return false;
      return call('GET', '/sync/v1/lists').then(function (resp) {
        var rows = LIST_NAMES.map(function (n) {
          return { name: n, items: resp[n] === undefined ? (n === 'prefs' ? {} : []) : resp[n] };
        });
        return D().putMany(db, 'lists', rows)
          .then(function () { return D().setMeta(db, D().META.listVersions, resp.versions || versions); })
          .then(function () { return true; });
      });
    });
  }

  // Media of ready articles, newest article first, not stored and not given up on.
  // Drops cache entries and ledger keys that no ready snapshot uses any more.
  function buildMediaQueue(db, cache) {
    return Promise.all([
      D().readyIds(db), D().getAll(db, 'articles'), D().getAll(db, 'snapshots'),
      D().getMeta(db, D().META.media), D().getMeta(db, D().META.mediaSkipped),
    ]).then(function (r) {
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
      return D().updateMeta(db, D().META.media, keepReferenced)
        .then(function () { return D().updateMeta(db, D().META.mediaSkipped, keepReferenced); })
        .then(function () { return cache ? M().prune(cache, referenced) : []; })
        .then(function () { return queue; });
    });
  }

  var downloading = new Map();

  // Downloads `urls` into the user's media cache. Each stored image is recorded in meta
  // `media` as it lands, and each definitive failure in `media_skipped`, so a worker
  // suspended half way loses nothing. One download per database at a time: a second
  // call while one runs gets the running one.
  // opts: caches, fetchFn, budgetBytes. -> downloadQueue's result
  function downloadMedia(db, urls, opts) {
    if (downloading.has(db.name)) return downloading.get(db.name);
    opts = opts || {};
    var cs = opts.caches || root.caches;
    var p = cs.open(M().cacheName(db.userId)).then(function (cache) {
      return Promise.all([
        D().getMeta(db, D().META.media), D().getMeta(db, D().META.mediaSkipped),
      ]).then(function (r) {
        var known = r[0] || {};
        var used = Object.keys(known).reduce(function (s, k) { return s + known[k]; }, 0);
        var skip = new Set(Object.keys(known).concat(Object.keys(r[1] || {})));
        return M().downloadQueue(urls, {
          cache: cache, fetchFn: opts.fetchFn, budgetBytes: opts.budgetBytes,
          usedBytes: used, known: skip,
          onStored: function (key, bytes) {
            return D().updateMeta(db, D().META.media, function (m) { m = m || {}; m[key] = bytes; return m; });
          },
          onFailed: function (key, reason) {
            return D().updateMeta(db, D().META.mediaSkipped, function (m) { m = m || {}; m[key] = reason; return m; });
          },
        });
      });
    }).finally(function () { downloading.delete(db.name); });
    downloading.set(db.name, p);
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

  // Caches /app and the static files it references in readfine-shell-<templateVersion>,
  // then deletes older shell caches. -> {stored, assets} ; throws on failure.
  function cacheShell(opts) {
    var cs = opts.caches || root.caches;
    var fetchFn = opts.fetchFn || root.fetch.bind(root);
    var origin = (root.location && root.location.origin) || 'https://readfine.invalid';
    var name = D().SHELL_PREFIX + opts.templateVersion;
    var abs = function (p) { return new URL(p, origin).href; };
    return fetchFn('/app', { credentials: 'include' }).then(function (res) {
      var finalPath = res.url ? new URL(res.url, origin).pathname : '/app';
      if (!res.ok || res.redirected || finalPath !== '/app') throw new Error('shell: /app not served');
      return res.clone().text().then(function (html) { return { res: res, html: html }; });
    }).then(function (page) {
      return cs.open(name).then(function (cache) {
        var assets = Array.from(new Set(staticRefs(page.html, abs('/app'), origin, false)));
        var all = new Set(assets);
        var stored = 0;
        return cache.put(abs('/app'), page.res).then(function () {
          var i = 0;
          function next() {
            if (i >= assets.length) return Promise.resolve();
            var path = assets[i++];
            return cache.match(abs(path)).then(function (hit) {
              if (hit && !/\.css(\?|$)/.test(path)) return null;
              return Promise.resolve(hit || fetchFn(path, { credentials: 'include' }).then(function (r) {
                if (!r.ok) throw new Error('shell: ' + path + ' ' + r.status);
                return cache.put(abs(path), r.clone()).then(function () { stored++; return r; });
              })).then(function (r) {
                if (!/\.css(\?|$)/.test(path)) return null;
                return r.clone().text().then(function (css) {
                  staticRefs(css, abs(path), origin, true).forEach(function (p) {
                    if (!all.has(p)) { all.add(p); assets.push(p); }
                  });
                });
              });
            }).then(next);
          }
          return next();
        }).then(function () {
          all.add('/app');
          return cache.keys().then(function (reqs) {
            return Promise.all(reqs.map(function (r) {
              var u = new URL(typeof r === 'string' ? r : r.url, origin);
              return all.has(u.pathname + u.search) ? null : cache.delete(r);
            }));
          });
        }).then(function () {
          return cs.keys().then(function (names) {
            return Promise.all(names.filter(function (n) {
              return n !== name && n.indexOf(D().SHELL_PREFIX) === 0;
            }).map(function (n) { return cs.delete(n); }));
          });
        }).then(function () { return { stored: stored, assets: all.size }; });
      });
    });
  }

  // ---- run ---------------------------------------------------------------------------

  var running = new Map();

  // opts: fetchFn, now (() => Date|ms), csrfToken (string | () => string; default the
  //   csrftoken cookie where `document` exists — a worker must pass it), keepIds (ids
  //   open on screen: never removed), caches (CacheStorage; enables media pruning and
  //   the shell cache), downloadMedia (await the media download in this run),
  //   budgetBytes, shell (false skips the shell cache).
  // -> SyncReport {articles, removed, pendingOps, mediaQueued, finishedAt,
  //    snapshots, opsSent, listsFetched, mediaQueue, media, shell, error}
  // error: null | 'auth' | 'network' | 'rate_limited' | 'http'. It never rejects for
  // these; data and outbox are kept, and the next run continues.
  function run(db, opts) {
    var key = db.name;
    if (running.has(key)) return running.get(key);
    var p = runOnce(db, opts || {}).finally(function () { running.delete(key); });
    running.set(key, p);
    return p;
  }

  function runOnce(db, opts) {
    var nowFn = opts.now || function () { return Date.now(); };
    var nowMs = function () { var t = nowFn(); return t instanceof Date ? t.getTime() : Number(t); };
    var nowIso = function () { return new Date(nowMs()).toISOString(); };
    var call = client(opts);
    var keep = new Set(opts.keepIds || []);
    var cs = opts.caches || null;
    var report = {
      articles: 0, removed: 0, pendingOps: 0, mediaQueued: 0, finishedAt: null,
      snapshots: 0, opsSent: 0, listsFetched: false, mediaQueue: [], media: null,
      shell: 'skipped', error: null,
    };
    var manifest;
    var diff;

    return sendOutbox(db, call, nowIso, report)
      .then(function () { return call('GET', '/sync/v1/manifest'); })
      .then(function (m) {
        manifest = m;
        return Promise.all([D().getAll(db, 'articles'), pendingArticleIds(db)]);
      })
      .then(function (r) {
        var local = new Map(r[0].map(function (a) { return [a.id, a.version]; }));
        var pending = r[1].ids;
        diff = diffManifest(local, manifest.articles || []);
        // An article with unsent ops keeps the device's state until they are sent.
        diff.fetch = diff.fetch.filter(function (id) { return !pending.has(id); });
        diff.remove = diff.remove.filter(function (id) { return !pending.has(id) && !keep.has(id); });
        report.removed = diff.remove.length;
        return D().removeArticles(db, diff.remove);
      })
      .then(function () { return fetchArticles(db, call, diff.fetch, report); })
      .then(function () { return fetchSnapshots(db, call, manifest.lists || {}, nowMs(), report); })
      .then(function () {
        // Saved-search member ids follow article state, which no list version covers.
        var force = diff.fetch.length > 0 || diff.remove.length > 0 || report.opsSent > 0;
        return syncLists(db, call, manifest.lists || {}, force);
      })
      .then(function (fetched) {
        report.listsFetched = fetched;
        var open = cs ? cs.open(M().cacheName(db.userId)) : Promise.resolve(null);
        return open.then(function (cache) { return buildMediaQueue(db, cache); });
      })
      .then(function (queue) {
        report.mediaQueue = queue;
        report.mediaQueued = queue.length;
        report.finishedAt = nowIso();
        return D().setMeta(db, D().META.lastSync, {
          finishedAt: report.finishedAt, serverTime: manifest.server_time || null,
        });
      })
      .then(function () {
        if (!cs || opts.shell === false || !manifest.lists || !manifest.lists.templates) return null;
        return cacheShell({ caches: cs, fetchFn: opts.fetchFn, templateVersion: manifest.lists.templates })
          .then(function () { report.shell = 'ok'; }, function () { report.shell = 'failed'; });
      })
      .then(function () {
        if (!opts.downloadMedia || !cs || !report.mediaQueue.length) return null;
        return downloadMedia(db, report.mediaQueue, {
          caches: cs, fetchFn: opts.fetchFn, budgetBytes: opts.budgetBytes,
        }).then(function (res) { report.media = res; });
      })
      .catch(function (err) {
        if (!(err instanceof Stop)) throw err;
        report.error = err.kind;
        report.errorDetail = err.detail;
      })
      .then(function () { return pendingArticleIds(db); })
      .then(function (p) {
        report.pendingOps = p.count;
        return report;
      });
  }

  RF.sync = {
    diffManifest: diffManifest,
    run: run,
    downloadMedia: downloadMedia,
    cacheShell: cacheShell,
    LIMITS: { ops: OPS_BATCH, articles: ARTICLES_BATCH, snapshots: SNAPSHOTS_BATCH },
  };
})(self);

// Offline device store: one IndexedDB database per signed-in user.
//
// Plain script, no modules, no DOM: the page and the service worker both load it, and
// both get the same `self.RFOffline.db`. Nothing here runs at load time apart from
// defining functions, so loading it in a worker that never goes offline costs nothing.
//
// Database `readfine-offline-<userId>`, version 1:
//   articles   key `id`        the record /sync/v1/articles returns (plus local edits)
//   snapshots  key `id`        {id, content_version, template_version, prefs_version,
//                               row_html, detail_html, media, fetched_at}
//   lists      key `name`      {name, items}: folders, feeds, labels, saved_searches, prefs
//   outbox     autoIncrement   {op_id, type, article_id, value, at}; index `op_id`
//   meta       key `k`         {k, v}: see META below
//
// An article is shown by offline lists only when both its record and its snapshot are
// stored. That set is kept in meta `ready`, written in the same transaction as the
// snapshot or the removal that changes it, so a sync cut off half way never leaves a
// list pointing at an article it cannot draw.
(function (root) {
  'use strict';
  var RF = root.RFOffline = root.RFOffline || {};

  var DB_PREFIX = 'readfine-offline-';
  var MEDIA_PREFIX = 'readfine-media-';
  var SHELL_PREFIX = 'readfine-shell-';
  var VERSION = 1;
  var STORES = ['articles', 'snapshots', 'lists', 'outbox', 'meta'];

  // Every meta key in one place. Values are whatever is written under `v`.
  var META = {
    userId: 'user_id',            // number
    ready: 'ready',               // number[] sorted: ids with record + snapshot
    listVersions: 'list_versions',// {folders, feeds, labels, saved_searches, prefs, templates}
    lastSync: 'last_sync',        // {finishedAt, serverTime}
    media: 'media',               // {cacheKey: bytes} of what the media cache holds
    mediaSkipped: 'media_skipped',// {cacheKey: reason} definitive failures, not queued again
    displayName: 'display_name',  // string: the page writes it, the offline sidebar's avatar reads it
  };

  var openHandles = [];

  // Wipe generation. wipeAll bumps it and closes every handle; a run or download that
  // started before checks `alive(db)` before and after every cache write and aborts
  // (deleting what it just wrote) once it is false. Another context (page vs worker)
  // learns of a wipe through `versionchange` on its connection, which closes its handle.
  var generation = 0;
  var inflight = new Set();

  function alive(db) {
    return !!db && !db.closed && db.gen === generation;
  }

  // Registers a run or download so wipeAll can wait for it. -> the same promise
  function track(p) {
    inflight.add(p);
    var drop = function () { inflight.delete(p); };
    p.then(drop, drop);
    return p;
  }

  function idbFactory() {
    if (!root.indexedDB) throw new Error('IndexedDB is not available');
    return root.indexedDB;
  }

  function req(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  function done(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('transaction aborted')); };
    });
  }

  function dbName(userId) {
    return DB_PREFIX + userId;
  }

  // -> Promise<DB>, DB = {userId, name, idb, close()}.
  function open(userId) {
    if (!(Number.isInteger(userId) && userId > 0)) {
      return Promise.reject(new Error('open needs a positive integer user id'));
    }
    var name = dbName(userId);
    var r = idbFactory().open(name, VERSION);
    r.onupgradeneeded = function () {
      var idb = r.result;
      if (!idb.objectStoreNames.contains('articles')) idb.createObjectStore('articles', { keyPath: 'id' });
      if (!idb.objectStoreNames.contains('snapshots')) idb.createObjectStore('snapshots', { keyPath: 'id' });
      if (!idb.objectStoreNames.contains('lists')) idb.createObjectStore('lists', { keyPath: 'name' });
      if (!idb.objectStoreNames.contains('outbox')) {
        var outbox = idb.createObjectStore('outbox', { autoIncrement: true });
        outbox.createIndex('op_id', 'op_id', { unique: true });
      }
      if (!idb.objectStoreNames.contains('meta')) idb.createObjectStore('meta', { keyPath: 'k' });
    };
    return req(r).then(function (idb) {
      var db = handle(userId, idb);
      return setMeta(db, META.userId, userId).then(function () { return db; });
    });
  }

  function handle(userId, idb) {
    var db = {
      userId: userId,
      name: idb.name,
      idb: idb,
      gen: generation,
      closed: false,
      close: function () {
        db.closed = true;
        idb.close();
        var i = openHandles.indexOf(db);
        if (i >= 0) openHandles.splice(i, 1);
      },
    };
    // Another tab, or wipeAll, wants the database gone: let go so it is not blocked.
    idb.onversionchange = function () { db.close(); };
    openHandles.push(db);
    return db;
  }

  // The user's database if it exists, else null; never creates one. The service worker
  // opens with this: a database a logout or an account switch wiped must stay gone,
  // and a worker that recreated it would leave an empty store behind for the next
  // person. -> Promise<DB | null>
  function openExisting(userId) {
    if (!(Number.isInteger(userId) && userId > 0)) return Promise.resolve(null);
    return new Promise(function (resolve, reject) {
      var created = false;
      var r = idbFactory().open(dbName(userId));
      // Opened without a version, an upgrade is only ever asked for when there was no
      // such database. Aborting it leaves none behind.
      r.onupgradeneeded = function () {
        created = true;
        r.transaction.abort();
      };
      r.onsuccess = function () {
        var idb = r.result;
        if (created || !idb.objectStoreNames.contains('outbox')) { idb.close(); resolve(null); return; }
        resolve(handle(userId, idb));
      };
      r.onerror = function (e) {
        if (created) {
          if (e && typeof e.preventDefault === 'function') e.preventDefault();
          resolve(null);
          return;
        }
        reject(r.error);
      };
    });
  }

  // ---- current user (for the service worker) -----------------------------------------
  //
  // A worker cannot read cookies or the page, so the page tells it who is signed in and
  // whether offline mode is on, in a database of its own with one record and no user
  // data beyond the numeric id: {k: 'current', userId, offlineEnabled, forceOffline}.
  // Its name shares the readfine-offline- prefix on purpose: wipeAll deletes it too, so
  // after a logout the worker knows nobody. Opened and closed per call, so it never
  // holds up a wipe.
  var CURRENT_DB = DB_PREFIX + 'current';

  // Runs fn over the store in one transaction. Reading never creates the database (a
  // worker that only asks must not leave one behind in every browser, or recreate it
  // after a wipe): with no database, fn is not called and this resolves false.
  function withCurrent(mode, fn, create) {
    var write = !!create;
    return new Promise(function (resolve, reject) {
      var created = false;
      var r = write ? idbFactory().open(CURRENT_DB, 1) : idbFactory().open(CURRENT_DB);
      r.onupgradeneeded = function () {
        if (!write) { created = true; r.transaction.abort(); return; }
        // (creating: only setCurrentUser with a user id)
        if (!r.result.objectStoreNames.contains('current')) r.result.createObjectStore('current', { keyPath: 'k' });
      };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function (e) {
        if (created) { if (e && e.preventDefault) e.preventDefault(); resolve(null); return; }
        reject(r.error);
      };
    }).then(function (idb) {
      if (!idb) return false;
      if (!idb.objectStoreNames.contains('current')) { idb.close(); return false; }
      idb.onversionchange = function () { idb.close(); };
      var tx = idb.transaction('current', mode);
      fn(tx.objectStore('current'));
      return done(tx).then(function () { idb.close(); return true; }, function (err) { idb.close(); throw err; });
    });
  }

  // -> Promise<{userId, offlineEnabled, forceOffline[, stale: true]} | null>
  // stale: someone is signing in on this browser (forgetCurrentUser); the worker treats
  // the record as nobody, page.js restores it for the same reader and wipes for another.
  function getCurrentUser() {
    var got;
    return withCurrent('readonly', function (s) {
      s.get('current').onsuccess = function (e) { got = e.target.result; };
    }).then(function () {
      if (!got || !(Number.isInteger(got.userId) && got.userId > 0)) return null;
      var out = { userId: got.userId, offlineEnabled: !!got.offlineEnabled, forceOffline: !!got.forceOffline };
      if (got.stale) out.stale = true;
      return out;
    });
  }

  // The sign-in form was submitted (offline/boot.js): whoever the record names is about
  // to stop being the session's reader. Marks the record stale (never creates the
  // database) and tells the worker. -> Promise<bool: a record was there>
  function forgetCurrentUser() {
    var had = false;
    return withCurrent('readwrite', function (s) {
      s.get('current').onsuccess = function (e) {
        var rec = e.target.result;
        if (!rec) return;
        had = true;
        rec.stale = true;
        s.put(rec);
      };
    }).then(function () {
      if (had) notifyWorker();
      return had;
    });
  }

  // The page calls this on every authenticated load, when the offline switch or "Work
  // offline" changes, and with null on logout. Tells a controlling worker to re-read.
  // opts: offlineEnabled (bool), forceOffline (bool). -> Promise<void>
  function setCurrentUser(userId, opts) {
    opts = opts || {};
    if (userId !== null && !(Number.isInteger(userId) && userId > 0)) {
      return Promise.reject(new Error('setCurrentUser needs a positive integer user id or null'));
    }
    // Clearing never creates the database just to empty it.
    return withCurrent('readwrite', function (s) {
      if (userId === null) s.delete('current');
      else s.put({ k: 'current', userId: userId, offlineEnabled: !!opts.offlineEnabled, forceOffline: !!opts.forceOffline });
    }, userId !== null).then(notifyWorker);
  }

  // Tells the controlling worker and every other tab (page.js listens on CHANNEL) that
  // the current-user record changed, so none of them acts on a stale copy.
  var CHANNEL = 'readfine-offline';

  function notifyWorker() {
    try {
      var sw = root.navigator && root.navigator.serviceWorker;
      if (sw && sw.controller) sw.controller.postMessage({ type: 'rf-current-user' });
    } catch (e) { /* no worker: nothing to tell */ }
    broadcast();
  }

  function broadcast() {
    try {
      if (typeof root.BroadcastChannel !== 'function') return;
      var ch = new root.BroadcastChannel(CHANNEL);
      ch.postMessage({ type: 'rf-current-user' });
      ch.close();
    } catch (e) { /* no channel: tabs reconcile on their next action */ }
  }

  // ---- small helpers over one store ------------------------------------------------

  function get(db, store, key) {
    var tx = db.idb.transaction(store, 'readonly');
    return req(tx.objectStore(store).get(key));
  }

  function getAll(db, store) {
    var tx = db.idb.transaction(store, 'readonly');
    return req(tx.objectStore(store).getAll());
  }

  function getAllKeys(db, store) {
    var tx = db.idb.transaction(store, 'readonly');
    return req(tx.objectStore(store).getAllKeys());
  }

  function put(db, store, value) {
    var tx = db.idb.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    return done(tx);
  }

  function putMany(db, store, values) {
    var tx = db.idb.transaction(store, 'readwrite');
    var s = tx.objectStore(store);
    values.forEach(function (v) { s.put(v); });
    return done(tx);
  }

  function getMeta(db, k) {
    return get(db, 'meta', k).then(function (row) { return row ? row.v : undefined; });
  }

  function setMeta(db, k, v) {
    return put(db, 'meta', { k: k, v: v });
  }

  // Read-modify-write of one meta value in a single transaction. fn(old) -> new.
  function updateMeta(db, k, fn) {
    var tx = db.idb.transaction('meta', 'readwrite');
    var s = tx.objectStore('meta');
    var out;
    s.get(k).onsuccess = function (e) {
      out = fn(e.target.result ? e.target.result.v : undefined);
      s.put({ k: k, v: out });
    };
    return done(tx).then(function () { return out; });
  }

  // ---- readiness ---------------------------------------------------------------------

  // Ids whose record and snapshot are both stored: the only source offline lists use.
  function readyIds(db) {
    return getMeta(db, META.ready).then(function (ids) { return ids ? ids.slice() : []; });
  }

  function sortedIds(set) {
    return Array.from(set).sort(function (a, b) { return a - b; });
  }

  // Stores snapshots and marks their ids ready, in one transaction. A snapshot whose
  // record is missing (the article left the scope in between) is not stored.
  function putSnapshots(db, snaps) {
    var tx = db.idb.transaction(['articles', 'snapshots', 'meta'], 'readwrite');
    var articles = tx.objectStore('articles');
    var snapshots = tx.objectStore('snapshots');
    var meta = tx.objectStore('meta');
    var stored = 0;
    meta.get(META.ready).onsuccess = function (e) {
      var ready = new Set((e.target.result && e.target.result.v) || []);
      var pending = snaps.length;
      if (!pending) return;
      snaps.forEach(function (snap) {
        articles.getKey(snap.id).onsuccess = function (ev) {
          if (ev.target.result !== undefined) {
            snapshots.put(snap);
            ready.add(snap.id);
            stored++;
          }
          if (--pending === 0) meta.put({ k: META.ready, v: sortedIds(ready) });
        };
      });
    };
    return done(tx).then(function () { return stored; });
  }

  // Deletes records and snapshots for `ids` and drops them from `ready`, together.
  function removeArticles(db, ids) {
    if (!ids.length) return Promise.resolve();
    var tx = db.idb.transaction(['articles', 'snapshots', 'meta'], 'readwrite');
    var articles = tx.objectStore('articles');
    var snapshots = tx.objectStore('snapshots');
    var meta = tx.objectStore('meta');
    ids.forEach(function (id) { articles.delete(id); snapshots.delete(id); });
    meta.get(META.ready).onsuccess = function (e) {
      var ready = new Set((e.target.result && e.target.result.v) || []);
      ids.forEach(function (id) { ready.delete(id); });
      meta.put({ k: META.ready, v: sortedIds(ready) });
    };
    return done(tx);
  }

  // ---- outbox ------------------------------------------------------------------------

  function uuid() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    // Fallback for older WebKit: RFC 4122 v4 from getRandomValues.
    var b = new Uint8Array(16);
    root.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function isoTime(t) {
    if (t === undefined || t === null) return new Date().toISOString();
    if (t instanceof Date) return t.toISOString();
    if (typeof t === 'number') return new Date(t).toISOString();
    // A string must already carry an offset; the server rejects naive times.
    return new Date(t).toISOString();
  }

  var OP_TYPES = ['read', 'unread', 'star', 'unstar', 'archive', 'unarchive', 'label_add',
    'label_remove', 'mark_scope_read', 'save_url', 'unsave', 'share', 'dwell', 'link_opened',
    'ai_summary', 'ai_context', 'extract_readable'];
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // The outbox row for an op, or an Error for what the server would refuse for the
  // whole batch (422): an unknown type, a non-UUID op_id, a value that is not an
  // object, an unparseable time.
  function opRow(op) {
    if (OP_TYPES.indexOf(op.type) < 0) return new Error('unknown op type: ' + op.type);
    if (op.op_id !== undefined && !UUID.test(op.op_id)) return new Error('op_id must be a UUID');
    if (op.value !== undefined && (op.value === null || typeof op.value !== 'object' || Array.isArray(op.value))) {
      return new Error('op value must be an object');
    }
    if (op.at !== undefined && op.at !== null && isNaN(new Date(op.at).getTime())) {
      return new Error('op at is not a time');
    }
    return {
      op_id: op.op_id || uuid(),
      type: op.type,
      article_id: op.article_id === undefined ? null : op.article_id,
      value: op.value || {},
      at: isoTime(op.at),
      // Delivery bookkeeping, kept on the row (see sync.js sendOutbox):
      attempts: 0,       // retryable answers and isolated server errors so far
      last_error: null,  // 'skipped/rate_limited', 'http_422', ...
      poison: false,     // the server refused it outright (400/413/422): resent only after retryStuck
      stuck: false,      // gave up after MAX_ATTEMPTS: resent only after retryStuck
    };
  }

  // Appends one op; fills op_id and at (ISO, UTC) when absent. -> Promise<op>
  // Rejects what opRow refuses.
  function enqueueOp(db, op) {
    var row = opRow(op);
    if (row instanceof Error) return Promise.reject(row);
    return put(db, 'outbox', row).then(function () { return row; });
  }

  // An offline action: changed records and the ops that carry them to the server, in
  // one transaction, so an action is never half applied. A record is only replaced
  // when it is still stored (an article removed by a sync while open on screen is not
  // brought back by acting on it); the op is queued either way.
  // -> Promise<op[]>; rejects, writing nothing, when any op is invalid.
  function commitLocal(db, change) {
    var records = change.records || [];
    var rows = (change.ops || []).map(opRow);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] instanceof Error) return Promise.reject(rows[i]);
    }
    var tx = db.idb.transaction(['articles', 'outbox'], 'readwrite');
    var articles = tx.objectStore('articles');
    records.forEach(function (rec) {
      articles.getKey(rec.id).onsuccess = function (e) {
        if (e.target.result !== undefined) articles.put(rec);
      };
    });
    var outbox = tx.objectStore('outbox');
    rows.forEach(function (row) { outbox.put(row); });
    return done(tx).then(function () { return rows; });
  }

  // -> Promise<Array<{key, op}>> in the order the ops were made.
  function outboxEntries(db) {
    var tx = db.idb.transaction('outbox', 'readonly');
    var out = [];
    return new Promise(function (resolve, reject) {
      var c = tx.objectStore('outbox').openCursor();
      c.onsuccess = function () {
        var cur = c.result;
        if (!cur) { resolve(out); return; }
        out.push({ key: cur.key, op: cur.value });
        cur.continue();
      };
      c.onerror = function () { reject(c.error); };
    });
  }

  var MAX_ATTEMPTS = 10;

  // A poison or stuck op is not sent and waits for the user. It does not pin its article
  // (pendingIdsOf leaves it out, so the server's record may replace the local one), but
  // later ops for the same article wait behind it (sync.js holds them).
  function isBlocked(op) {
    return !!(op && (op.poison || op.stuck));
  }

  // Read-modify-write of one outbox row by key, in one transaction. fn(op) -> op | null
  // (null leaves it). A row deleted meanwhile is left deleted.
  function updateOutboxOp(db, key, fn) {
    var tx = db.idb.transaction('outbox', 'readwrite');
    var s = tx.objectStore('outbox');
    var out;
    s.get(key).onsuccess = function (e) {
      var op = e.target.result;
      if (!op) return;
      out = fn(op);
      if (out) s.put(out, key);
    };
    return done(tx).then(function () { return out; });
  }

  // Ops waiting for the user: [{key, op}] with op.poison or op.stuck.
  function stuckOps(db) {
    return outboxEntries(db).then(function (entries) {
      return entries.filter(function (e) { return isBlocked(e.op); });
    });
  }

  function keyForOpId(db, opId) {
    var tx = db.idb.transaction('outbox', 'readonly');
    return req(tx.objectStore('outbox').index('op_id').getKey(opId));
  }

  // Puts a stuck or poison op back in the queue (same op_id, attempts reset). -> bool
  function retryStuck(db, opId) {
    return keyForOpId(db, opId).then(function (key) {
      if (key === undefined) return false;
      return updateOutboxOp(db, key, function (op) {
        if (!isBlocked(op)) return null;
        op.poison = false;
        op.stuck = false;
        op.attempts = 0;
        op.last_error = null;
        return op;
      }).then(function (op) { return !!op; });
    });
  }

  // Deletes a stuck or poison op on the user's word. Ops still in delivery are not
  // touched. -> bool
  function discardStuck(db, opId) {
    return keyForOpId(db, opId).then(function (key) {
      if (key === undefined) return false;
      var tx = db.idb.transaction('outbox', 'readwrite');
      var s = tx.objectStore('outbox');
      var gone = false;
      s.get(key).onsuccess = function (e) {
        if (isBlocked(e.target.result)) { s.delete(key); gone = true; }
      };
      return done(tx).then(function () { return gone; });
    });
  }

  // Article ids an op still in delivery (not blocked) targets.
  function pendingIdsOf(ops) {
    var ids = new Set();
    ops.forEach(function (op) {
      if (!isBlocked(op) && op.article_id !== null && op.article_id !== undefined) ids.add(op.article_id);
    });
    return ids;
  }

  // Stores server records, except for articles an op in the outbox still has to change
  // (read in the same transaction, so an op the page enqueues mid-sync is respected).
  // opts.onlyExisting: only replace records already stored. -> number stored
  function putRecords(db, records, opts) {
    opts = opts || {};
    var tx = db.idb.transaction(['articles', 'outbox'], 'readwrite');
    var articles = tx.objectStore('articles');
    var stored = 0;
    tx.objectStore('outbox').getAll().onsuccess = function (e) {
      var pending = pendingIdsOf(e.target.result || []);
      records.forEach(function (rec) {
        if (pending.has(rec.id)) return;
        if (!opts.onlyExisting) { articles.put(rec); stored++; return; }
        articles.getKey(rec.id).onsuccess = function (ev) {
          if (ev.target.result !== undefined) { articles.put(rec); stored++; }
        };
      });
    };
    return done(tx).then(function () { return stored; });
  }

  function deleteOutboxKeys(db, keys) {
    if (!keys.length) return Promise.resolve();
    var tx = db.idb.transaction('outbox', 'readwrite');
    var s = tx.objectStore('outbox');
    keys.forEach(function (k) { s.delete(k); });
    return done(tx);
  }

  // ---- wipe --------------------------------------------------------------------------

  function withTimeout(p, ms, onTimeout) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { resolve(onTimeout()); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  function deleteCaches(cacheStorage) {
    if (!cacheStorage) return Promise.resolve();
    return cacheStorage.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k.indexOf(MEDIA_PREFIX) === 0 || k.indexOf(SHELL_PREFIX) === 0;
      }).map(function (k) { return cacheStorage.delete(k); }));
    });
  }

  // Deletes every readfine-offline-* database and every readfine-media-* and
  // readfine-shell-* cache on this origin (logout, account switch, "Remove offline data").
  // opts: indexedDB / caches override the globals; names adds database names for
  // browsers without indexedDB.databases(); waitMs (default 5000) bounds the wait for
  // runs in flight here, blockedMs (default 10000) the wait for a blocked delete.
  // Order: bump the generation and close handles (in-flight work here aborts at its
  // next check), delete caches, wait for in-flight work, delete databases, delete caches
  // again (a write that slipped in between is gone). Rejects, after all of that, if a
  // database stayed blocked; the caches are deleted either way.
  function wipeAll(opts) {
    opts = opts || {};
    var factory = opts.indexedDB || root.indexedDB;
    var cacheStorage = opts.caches || root.caches;
    var waitMs = opts.waitMs === undefined ? 5000 : opts.waitMs;
    var blockedMs = opts.blockedMs === undefined ? 10000 : opts.blockedMs;
    generation++;
    if (root.RFOffline && root.RFOffline.search) root.RFOffline.search.clearCache();
    openHandles.slice().forEach(function (db) { db.close(); });

    var names = Promise.resolve(opts.names ? opts.names.slice() : []);
    if (factory && typeof factory.databases === 'function') {
      names = names.then(function (extra) {
        return factory.databases().then(function (list) {
          return extra.concat(list.map(function (d) { return d.name; }));
        });
      });
    }
    var blocked = [];
    var failed = [];
    function deleteDb(n) {
      var p = new Promise(function (resolve, reject) {
        var r = factory.deleteDatabase(n);
        r.onsuccess = function () { resolve(); };
        r.onerror = function () { reject(r.error); };
        // Blocked: another context still holds it. Its versionchange handler (open()
        // sets one) closes it and the delete completes; wait, but not forever.
        r.onblocked = function () {};
      });
      return withTimeout(p, blockedMs, function () { blocked.push(n); });
    }
    var settle = function (p) { return p.then(function () {}, function () {}); };
    var running = Array.from(inflight).map(settle);

    return deleteCaches(cacheStorage)
      .then(function () { return withTimeout(Promise.all(running), waitMs, function () {}); })
      .then(function () { return names; })
      .then(function (list) {
        var mine = Array.from(new Set(list)).filter(function (n) { return n && n.indexOf(DB_PREFIX) === 0; });
        return Promise.all(mine.map(function (n) {
          return deleteDb(n).catch(function (err) { failed.push(n + ' (' + ((err && err.name) || err) + ')'); });
        }));
      })
      .then(function () { return null; }, function (err) { return err; })
      .then(function (err) {
        // The last cache pass runs whatever happened to the databases.
        return deleteCaches(cacheStorage).then(function () {
          broadcast(); // the current-user record went with them
          if (err) throw err;
          if (blocked.length) throw new Error('offline database still in use: ' + blocked.join(', '));
          if (failed.length) throw new Error('offline database not deleted: ' + failed.join(', '));
        });
      });
  }

  RF.db = {
    DB_PREFIX: DB_PREFIX,
    MEDIA_PREFIX: MEDIA_PREFIX,
    SHELL_PREFIX: SHELL_PREFIX,
    META: META,
    open: open,
    openExisting: openExisting,
    getCurrentUser: getCurrentUser,
    forgetCurrentUser: forgetCurrentUser,
    setCurrentUser: setCurrentUser,
    CURRENT_DB: CURRENT_DB,
    CHANNEL: CHANNEL,
    commitLocal: commitLocal,
    dbName: dbName,
    get: get,
    getAll: getAll,
    getAllKeys: getAllKeys,
    put: put,
    putMany: putMany,
    getMeta: getMeta,
    setMeta: setMeta,
    updateMeta: updateMeta,
    alive: alive,
    track: track,
    generation: function () { return generation; },
    MAX_ATTEMPTS: MAX_ATTEMPTS,
    isBlocked: isBlocked,
    updateOutboxOp: updateOutboxOp,
    stuckOps: stuckOps,
    retryStuck: retryStuck,
    discardStuck: discardStuck,
    pendingIdsOf: pendingIdsOf,
    putRecords: putRecords,
    OP_TYPES: OP_TYPES,
    readyIds: readyIds,
    putSnapshots: putSnapshots,
    removeArticles: removeArticles,
    enqueueOp: enqueueOp,
    outboxEntries: outboxEntries,
    deleteOutboxKeys: deleteOutboxKeys,
    isoTime: isoTime,
    wipeAll: wipeAll,
  };
})(self);

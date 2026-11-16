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
  };

  var openHandles = [];

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
      var db = {
        userId: userId,
        name: name,
        idb: idb,
        close: function () {
          idb.close();
          var i = openHandles.indexOf(db);
          if (i >= 0) openHandles.splice(i, 1);
        },
      };
      // Another tab, or wipeAll, wants the database gone: let go so it is not blocked.
      idb.onversionchange = function () { db.close(); };
      openHandles.push(db);
      return setMeta(db, META.userId, userId).then(function () { return db; });
    });
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

  // Appends one op; fills op_id and at (ISO, UTC) when absent. -> Promise<op>
  // Rejects what the server would refuse for the whole batch (422): an unknown type, a
  // non-UUID op_id, a value that is not an object, an unparseable time.
  function enqueueOp(db, op) {
    if (OP_TYPES.indexOf(op.type) < 0) return Promise.reject(new Error('unknown op type: ' + op.type));
    if (op.op_id !== undefined && !UUID.test(op.op_id)) return Promise.reject(new Error('op_id must be a UUID'));
    if (op.value !== undefined && (op.value === null || typeof op.value !== 'object' || Array.isArray(op.value))) {
      return Promise.reject(new Error('op value must be an object'));
    }
    if (op.at !== undefined && op.at !== null && isNaN(new Date(op.at).getTime())) {
      return Promise.reject(new Error('op at is not a time'));
    }
    var row = {
      op_id: op.op_id || uuid(),
      type: op.type,
      article_id: op.article_id === undefined ? null : op.article_id,
      value: op.value || {},
      at: isoTime(op.at),
    };
    return put(db, 'outbox', row).then(function () { return row; });
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

  function deleteOutboxKeys(db, keys) {
    if (!keys.length) return Promise.resolve();
    var tx = db.idb.transaction('outbox', 'readwrite');
    var s = tx.objectStore('outbox');
    keys.forEach(function (k) { s.delete(k); });
    return done(tx);
  }

  // ---- wipe --------------------------------------------------------------------------

  // Deletes every readfine-offline-* database and every readfine-media-* and
  // readfine-shell-* cache on this origin (logout, account switch, "Remove offline data").
  // `opts.indexedDB` / `opts.caches` override the globals; `opts.names` adds database
  // names for browsers without indexedDB.databases().
  function wipeAll(opts) {
    opts = opts || {};
    var factory = opts.indexedDB || root.indexedDB;
    var cacheStorage = opts.caches || root.caches;
    openHandles.slice().forEach(function (db) { db.close(); });

    var names = Promise.resolve(opts.names ? opts.names.slice() : []);
    if (factory && typeof factory.databases === 'function') {
      names = names.then(function (extra) {
        return factory.databases().then(function (list) {
          return extra.concat(list.map(function (d) { return d.name; }));
        });
      });
    }
    var dbs = names.then(function (list) {
      var mine = Array.from(new Set(list)).filter(function (n) { return n && n.indexOf(DB_PREFIX) === 0; });
      return Promise.all(mine.map(function (n) {
        return new Promise(function (resolve, reject) {
          var r = factory.deleteDatabase(n);
          r.onsuccess = function () { resolve(); };
          r.onerror = function () { reject(r.error); };
          // Blocked means another context still holds it; onversionchange there closes
          // it and the delete then completes, so keep waiting for success.
        });
      }));
    });
    var caches = !cacheStorage ? Promise.resolve() : cacheStorage.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k.indexOf(MEDIA_PREFIX) === 0 || k.indexOf(SHELL_PREFIX) === 0;
      }).map(function (k) { return cacheStorage.delete(k); }));
    });
    return Promise.all([dbs, caches]).then(function () {});
  }

  RF.db = {
    DB_PREFIX: DB_PREFIX,
    MEDIA_PREFIX: MEDIA_PREFIX,
    SHELL_PREFIX: SHELL_PREFIX,
    META: META,
    open: open,
    dbName: dbName,
    get: get,
    getAll: getAll,
    getAllKeys: getAllKeys,
    put: put,
    putMany: putMany,
    getMeta: getMeta,
    setMeta: setMeta,
    updateMeta: updateMeta,
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

// Offline media: downloads the images synced snapshots point at into Cache Storage.
//
// Plain script for page and worker (`self.RFOffline.media`), like db.js.
//
// Cache `readfine-media-<userId>`. A snapshot links images as `/m/{sig}/{exp}/{b64url}`;
// the signature and expiry change every time a snapshot is fetched, the b64url does
// not. So each image is stored under the stable key `/m-cache/{b64url}` (R7), and the
// worker answers an `/m/…` request by looking up that key (`match`). Same-origin images
// that are not signed (e.g. `/img/video-thumb/…`) are stored under their own path.
//
// The bytes each key holds are kept in meta `media` ({key: bytes}) by the caller (sync),
// which is how the budget carries across runs.
(function (root) {
  'use strict';
  var RF = root.RFOffline = root.RFOffline || {};

  var DEFAULT_BUDGET = 2 * 1024 * 1024 * 1024;
  var MAX_ITEM_BYTES = 10 * 1024 * 1024;
  var CONCURRENCY = 4;
  var SIGNED = /^\/m\/[^/]+\/[^/]+\/([^/?#]+)/;

  function origin() {
    return (root.location && root.location.origin) || 'https://readfine.invalid';
  }

  function pathOf(url) {
    var u = new URL(url, origin());
    return u.pathname + u.search;
  }

  // Stable cache key (a path) for a media URL, or the URL's own path if it is not signed.
  function cacheKey(url) {
    var p = pathOf(url);
    var m = SIGNED.exec(p);
    return m ? '/m-cache/' + m[1] : p;
  }

  // Absolute URL for the key; Cache Storage keys are requests, so make them absolute.
  function keyUrl(key) {
    return new URL(key, origin()).href;
  }

  function cacheName(userId) {
    return 'readfine-media-' + userId;
  }

  // The stored response for a media request (signed or not), or undefined.
  function match(cache, url) {
    return cache.match(keyUrl(cacheKey(url)));
  }

  function isQuota(err) {
    return !!err && (err.name === 'QuotaExceededError' || err.code === 22);
  }

  // Downloads `urls` in the order given (callers pass newest first), four at a time.
  // opts: cache (required), budgetBytes, usedBytes (already stored), fetchFn,
  //       known (Set of keys already stored or given up on: skipped without a request),
  //       maxItemBytes, onStored(key, bytes) and onFailed(key, reason): awaited, so the
  //       caller can record progress as it goes (a worker can be suspended any time).
  // -> {stored, skipped, stoppedReason, bytes, entries: {key: bytes}, failed: {key: reason}}
  //    failed lists definitive failures only (too large, 404/410/415/422); a 403 (expired
  //    signature), 5xx or a network error is worth trying again later.
  //    stoppedReason: null | 'quota' | 'budget' | 'network' | 'auth'
  // Writes are serialised so that a QuotaExceededError stops every later write.
  function downloadQueue(urls, opts) {
    opts = opts || {};
    var cache = opts.cache;
    if (!cache) return Promise.reject(new Error('downloadQueue needs opts.cache'));
    var budget = opts.budgetBytes === undefined ? DEFAULT_BUDGET : opts.budgetBytes;
    var used = opts.usedBytes || 0;
    var maxItem = opts.maxItemBytes || MAX_ITEM_BYTES;
    var fetchFn = opts.fetchFn || root.fetch.bind(root);
    var known = opts.known || new Set();

    var onStored = opts.onStored || function () {};
    var onFailed = opts.onFailed || function () {};
    var result = { stored: 0, skipped: 0, stoppedReason: null, bytes: 0, entries: {}, failed: {} };
    var seen = new Set();
    var queue = [];
    urls.forEach(function (u) {
      var k = cacheKey(u);
      if (seen.has(k)) return;
      seen.add(k);
      if (known.has(k)) { result.skipped++; return; }
      queue.push({ url: u, key: k });
    });

    var next = 0;
    var writes = Promise.resolve();
    function stop(reason) {
      if (!result.stoppedReason) result.stoppedReason = reason;
    }

    function write(item, blob, headers) {
      writes = writes.then(function () {
        if (result.stoppedReason) return;
        if (used + blob.size > budget) { stop('budget'); return; }
        var res = new Response(blob, { status: 200, headers: headers });
        return cache.put(keyUrl(item.key), res).then(function () {
          used += blob.size;
          result.bytes += blob.size;
          result.stored++;
          result.entries[item.key] = blob.size;
          return onStored(item.key, blob.size);
        }, function (err) {
          if (isQuota(err)) stop('quota');
          else result.skipped++;
        });
      });
      return writes;
    }

    function fail(item, reason) {
      result.skipped++;
      result.failed[item.key] = reason;
      return onFailed(item.key, reason);
    }

    function one(item) {
      return fetchFn(item.url, { credentials: 'include' }).then(function (res) {
        if (result.stoppedReason) return;
        if (res.status === 401) { stop('auth'); return; }
        // 403: the signature expired; the next snapshot fetch brings a fresh one.
        if ([404, 410, 415, 422].indexOf(res.status) >= 0) return fail(item, 'http_' + res.status);
        if (!res.ok) { result.skipped++; return; }
        var len = Number(res.headers.get('content-length'));
        if (len && len > maxItem) return fail(item, 'too_large');
        return res.blob().then(function (blob) {
          if (blob.size > maxItem) return fail(item, 'too_large');
          var headers = {};
          var type = res.headers.get('content-type');
          if (type) headers['content-type'] = type;
          return write(item, blob, headers);
        });
      }, function () {
        stop('network');
      });
    }

    function worker() {
      if (result.stoppedReason || next >= queue.length) return Promise.resolve();
      var item = queue[next++];
      return one(item).then(worker);
    }

    var workers = [];
    for (var i = 0; i < CONCURRENCY; i++) workers.push(worker());
    return Promise.all(workers).then(function () { return writes; }).then(function () {
      return result;
    });
  }

  // Deletes cache entries whose key is not in `keep` (a Set of keys). -> removed keys
  function prune(cache, keep) {
    return cache.keys().then(function (reqs) {
      var gone = [];
      return Promise.all(reqs.map(function (r) {
        var key = pathOf(typeof r === 'string' ? r : r.url);
        if (keep.has(key)) return null;
        gone.push(key);
        return cache.delete(r);
      })).then(function () { return gone; });
    });
  }

  RF.media = {
    DEFAULT_BUDGET: DEFAULT_BUDGET,
    MAX_ITEM_BYTES: MAX_ITEM_BYTES,
    cacheKey: cacheKey,
    cacheName: cacheName,
    keyUrl: keyUrl,
    match: match,
    downloadQueue: downloadQueue,
    prune: prune,
  };
})(self);

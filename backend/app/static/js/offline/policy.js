// The service worker's fetch policy: whether a request is the worker's to answer at
// all, and how (network first, then the offline router).
//
// Plain script, no DOM; sw.js loads it last. Opt-in is visible synchronously: the page
// registers "/sw.js?offline=1" for a reader who switched offline mode on for this
// device and plain "/sw.js" otherwise (RFOffline.sw.register, sw-register.js). An
// unflagged worker never calls respondWith and never touches IndexedDB, so for
// everyone else the worker stays out of the way exactly as upstream's did (range
// requests, Cache-Control: no-store pages).
//
// A flagged worker keeps the current user in memory (respondWith has to be called
// synchronously): loaded once, reloaded when the page says so ('rf-current-user') or
// when the user's database is found gone. While it is not known yet (a cold worker,
// e.g. the app opened in flight mode) the app's own requests go through the worker and
// the decision is made inside the promise.
//   media (/m/):        the media cache by b64url key, else network
//   /img/, /static/:    network, else the media / shell cache
//   navigations, /htmx/: network (GET: 8 s timeout, then offline; POST: no timeout,
//                        offline only when the request fails), else the offline router.
// Nothing fetched online is ever cached here.
(function (root) {
  'use strict';
  var RF = root.RFOffline = root.RFOffline || {};
  function D() { return RF.db; }

  var policy = { NETWORK_TIMEOUT_MS: 8000 };

  function flagged() {
    var search = (root.location && root.location.search) || '';
    return /(?:^\?|&)offline=1(?:&|$)/.test(search);
  }

  var current = { loaded: false, value: null, loading: null };
  var handleCache = null;

  function loadCurrent() {
    if (!current.loading) {
      current.loading = D().getCurrentUser().then(function (v) {
        current.value = v; current.loaded = true; current.loading = null; return v;
      }, function () {
        // Unreadable: treated as "nobody", so the worker stays out of the way rather
        // than taking every request while it keeps failing to know.
        current.value = null; current.loaded = true; current.loading = null; return null;
      });
    }
    return current.loading;
  }

  function resetCurrent() {
    current.loaded = false;
    current.value = null;
    if (handleCache && handleCache.db && !handleCache.db.closed) handleCache.db.close();
    handleCache = null;
    RF.router.clearOpenCopies();
    return loadCurrent();
  }

  // The user's database, reopened when a wipe or another context closed it; null when
  // it no longer exists (never recreated here). A different user drops the open copies.
  async function userDb(userId) {
    if (handleCache && handleCache.userId === userId && D().alive(handleCache.db)) return handleCache.db;
    if (handleCache && handleCache.userId !== userId) RF.router.clearOpenCopies();
    if (handleCache && handleCache.db && !handleCache.db.closed) handleCache.db.close();
    handleCache = null;
    var db = await D().openExisting(userId);
    if (db) handleCache = { userId: userId, db: db };
    else await resetCurrent();
    return db;
  }

  function classify(request) {
    var url;
    try { url = new URL(request.url); } catch (e) { return null; }
    var origin = (root.location && root.location.origin) || url.origin;
    if (url.origin !== origin) return null;
    var p = url.pathname;
    if (request.method === 'GET' && p.indexOf('/m/') === 0) return 'media';
    if (request.method === 'GET' && p.indexOf('/img/') === 0) return 'img';
    if (request.mode === 'navigate' && request.method === 'GET') return 'nav';
    if (p.indexOf('/htmx/') === 0) return 'htmx';
    if (request.method === 'GET' && p.indexOf('/static/') === 0) return 'static';
    return null;
  }

  function enabled() {
    return current.loaded && !!(current.value && current.value.offlineEnabled);
  }

  function onFetch(event) {
    if (!flagged()) return;
    var kind = classify(event.request);
    if (!kind) return;
    if (current.loaded && !enabled()) {
      // Stepping aside, but a navigation preload this worker turned on was already
      // started for it: answer with that response rather than leave it unused (the
      // browser would warn and the navigation would be fetched twice).
      if (kind === 'nav' && event.preloadResponse) event.respondWith(network(event, event.request, false));
      return;
    }
    event.respondWith(respond(event, kind));
  }

  // Navigation preload for the flagged worker only: a navigation then starts on the
  // network while the worker boots. The unflagged worker turns it off again.
  function onActivate() {
    var np = root.registration && root.registration.navigationPreload;
    if (!np) return Promise.resolve();
    return (flagged() ? np.enable() : np.disable()).catch(function () {});
  }

  async function mediaCache(userId) {
    var cs = root.caches;
    var name = RF.media.cacheName(userId);
    if (!cs || !(await cs.has(name))) return null;
    return cs.open(name);
  }

  // The network attempt; `timed`: give up (and abort) after NETWORK_TIMEOUT_MS.
  function network(event, request, timed) {
    var ctl = timed && root.AbortController ? new root.AbortController() : null;
    var go = function () { return ctl ? root.fetch(request, { signal: ctl.signal }) : root.fetch(request); };
    var p = request.mode === 'navigate' && event.preloadResponse
      ? Promise.resolve(event.preloadResponse).then(function (r) { return r || go(); })
      : go();
    if (!timed) return p;
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        if (ctl) ctl.abort();
        reject(new Error('network timeout'));
      }, policy.NETWORK_TIMEOUT_MS);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  async function respond(event, kind) {
    var request = event.request;
    var cur = current.loaded ? current.value : await loadCurrent();
    if (!cur || !cur.offlineEnabled) return network(event, request, false);
    var userId = cur.userId;
    if (kind === 'media') {
      var cache = await mediaCache(userId);
      var hit = cache && await RF.media.match(cache, request.url);
      return hit || root.fetch(request);
    }
    if (kind === 'img' || kind === 'static') {
      try { return await root.fetch(request); } catch (e) {
        var fallback = kind === 'img'
          ? await mediaCache(userId).then(function (c) { return c && RF.media.match(c, request.url); })
          : await staticHit(request);
        if (fallback) return fallback;
        throw e;
      }
    }
    // Navigations and /htmx/: the request body is gone once fetch has read it, so a
    // POST keeps a copy for the offline answer. A POST is never timed out: whether the
    // server applied it would be unknown, and the queued op would apply it twice.
    var isGet = request.method === 'GET';
    var spare = isGet ? request : request.clone();
    if (!cur.forceOffline) {
      try { return await network(event, request, isGet); } catch (e) { /* offline: answer below */ }
    }
    return offline(spare, kind, userId);
  }

  async function staticHit(request) {
    var cs = root.caches;
    if (!cs) return null;
    var names = (await cs.keys()).filter(function (n) { return n.indexOf(D().SHELL_PREFIX) === 0; });
    for (var i = 0; i < names.length; i++) {
      var c = await cs.open(names[i]);
      var hit = await c.match(request.url) || await c.match(request.url, { ignoreSearch: true });
      if (hit) return hit;
    }
    return null;
  }

  async function offline(request, kind, userId) {
    var R = RF.router;
    var fallback = function () { return kind === 'nav' ? R.offlinePage(request.url) : R.needsConnection(''); };
    try {
      var db = await userDb(userId);
      if (!db) return fallback();
      var res = await R.handle(request, db);
      return res || fallback();
    } catch (err) {
      if (root.console) root.console.warn('offline router failed:', err);
      return fallback();
    }
  }

  function onMessage(event) {
    var data = event && event.data;
    if (data && data.type === 'rf-current-user' && flagged()) {
      var p = resetCurrent();
      if (event.waitUntil) event.waitUntil(p);
    }
  }

  policy.flagged = flagged;
  policy.classify = classify;
  policy.onFetch = onFetch;
  policy.onActivate = onActivate;
  policy.onMessage = onMessage;
  policy.reload = resetCurrent;
  policy._current = current;
  RF.policy = policy;
})(self);

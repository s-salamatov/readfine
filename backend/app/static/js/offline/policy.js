// The service worker's fetch policy: whether a request is the worker's to answer at
// all, and when it can use the offline router or the instant launch page.
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
//   /img/, /static/:    network, else the media / shell cache (versioned statics: exact cache first)
//   / and /app:         plain launches get the neutral page, followed by a session check
//   navigations, /htmx/: network (GET: 8 s timeout, then offline; POST: no timeout,
//                        offline only when the request fails), else the offline router.
//                        Within FORGET_WINDOW_MS of a sign-in ('rf-forget-user', or
//                        a POST to /login or /register seen here) a navigation is not
//                        timed out either.
// Nothing fetched online is ever cached here.
(function (root) {
  'use strict';
  var RF = root.RFOffline = root.RFOffline || {};
  function D() { return RF.db; }

  var policy = { NETWORK_TIMEOUT_MS: 8000, FORGET_WINDOW_MS: 10000 };
  var CONFIRM_PREFIX = '/__rf/launch/';

  function flagged() {
    var search = (root.location && root.location.search) || '';
    return /(?:^\?|&)offline=1(?:&|$)/.test(search);
  }

  var current = { loaded: false, value: null, loading: null, readError: false, gen: 0 };
  var handleCache = null;
  var handles = new Set();
  var fallbackState = null;
  var fallbackGen = 0;
  // When the page last said someone is signing in ('rf-forget-user'), see onMessage.
  var forgotAt = -Infinity;
  var routeErrors = [];
  var routeErrorCount = 0;
  var launchTimings = [];
  var workerStartedAt = root.startedAt || Date.now();
  var routeErrorMessages = {
    AbortError: 'The operation was aborted.',
    InvalidStateError: 'IndexedDB connection or storage state is unavailable.',
    NetworkError: 'A network operation failed.',
    NotFoundError: 'A required storage resource was missing.',
    QuotaExceededError: 'Storage quota was exceeded.',
    SecurityError: 'Access to a resource was denied.',
    TransactionInactiveError: 'The IndexedDB transaction was inactive.',
    TypeError: 'The operation failed with a TypeError.',
  };

  function recordRouteError(kind, error, row) {
    // Exception text can contain request URLs or values read from articles.
    var name = error && Object.hasOwn(routeErrorMessages, error.name) ? error.name : 'Error';
    var message = routeErrorMessages[name] || 'The offline route failed.';
    routeErrorCount++;
    if (routeErrors.length === 10) routeErrors.shift();
    routeErrors.push({ at: Date.now(), kind: kind, name: name, message: message.slice(0, 200), row: row });
  }

  function routeDiagnostics() {
    return {
      routeErrors: routeErrors.slice(), routeErrorCount: routeErrorCount,
      // Keep the original rf-diag shape until there are timings to report.
      ...(launchTimings.length ? { launchTimings: launchTimings.slice(), workerStartedAt: workerStartedAt } : {}),
    };
  }

  function timingPath(url) {
    var path = new URL(url).pathname;
    // A navigation can go directly to a signed or token-bearing route.
    var decoded;
    try { decoded = decodeURIComponent(path); } catch (e) { decoded = path; }
    if (decoded.startsWith(CONFIRM_PREFIX)) return CONFIRM_PREFIX + '[redacted]';
    var sensitive = /^\/(reset-password|share|m)\//i.exec(decoded);
    return sensitive ? '/' + sensitive[1] + '/[redacted]' : path;
  }

  function elapsed(start) {
    return Math.max(0, Date.now() - start);
  }

  function recordLaunchTiming(trace, started) {
    trace.totalMs = elapsed(started);
    if (launchTimings.length === 100) launchTimings.shift();
    launchTimings.push(trace);
  }

  function sameRecord(a, b) {
    if (!a || !b) return a === b;
    return a.userId === b.userId && a.offlineEnabled === b.offlineEnabled
      && a.forceOffline === b.forceOffline && !!a.stale === !!b.stale
      && !!a.logoutPending === !!b.logoutPending && !!a.wipePending === !!b.wipePending;
  }

  function loadCurrent(refresh) {
    if (refresh || !current.loading) {
      var settle = function (value, readError) {
        // Forget or a newer refresh supersedes this read.
        if (loading !== current.loading) return current.loading || current.value;
        current.loading = null;
        current.loaded = !readError;
        current.readError = readError;
        if (!sameRecord(current.value, value)) {
          current.gen++;
          current.value = value;
          clearFallback();
          retireHandle();
          clearReaderCaches();
        }
        return current.value;
      };
      var loading = D().getCurrentUser().then(function (v) {
        return settle(v, false);
      }, function () {
        return settle(null, true);
      });
      current.loading = loading;
    }
    return current.loading;
  }

  function clearReaderCaches() {
    RF.router.clearOpenCopies();
    if (RF.search) RF.search.clearCache();
    if (RF.lists) RF.lists.clearCache();
  }

  function clearFallback() {
    fallbackGen++;
    fallbackState = null;
  }

  function closeHandle(entry) {
    if (entry.db && !entry.db.closed) entry.db.close();
    handles.delete(entry);
    if (handleCache === entry) handleCache = null;
  }

  function retireHandle() {
    var entry = handleCache;
    if (!entry) return;
    handleCache = null;
    entry.retired = true;
    if (!entry.refs) closeHandle(entry);
  }

  function dropHandle() {
    handles.forEach(function (entry) {
      entry.retired = true;
      closeHandle(entry);
    });
    clearReaderCaches();
  }

  // Someone is signing in on this browser: from now on the worker knows nobody, without
  // re-reading the store (the page marks the record stale right after; a read started
  // before that would still find the previous reader).
  function forget() {
    current.gen++;
    current.loading = null;
    current.loaded = true;
    current.value = null;
    current.readError = false;
    clearFallback();
    forgotAt = Date.now();
    dropHandle();
  }

  function resetCurrent() {
    current.loaded = false;
    return loadCurrent(true);
  }

  async function openHandle(entry) {
    try {
      entry.db = await D().openExisting(entry.userId);
      if (entry.retired || !D().alive(entry.db)) {
        closeHandle(entry);
        if (!entry.retired && !entry.db) await resetCurrent();
      }
    } catch (err) {
      closeHandle(entry);
      throw err;
    } finally {
      entry.opening = null;
    }
  }

  // Concurrent requests share the open. Retired handles belong only to requests
  // already using them. db.js also closes connections on versionchange and wipe.
  async function acquire(userId) {
    var entry = handleCache;
    if (entry && (entry.userId !== userId || !entry.opening && !D().alive(entry.db))) {
      retireHandle();
      clearReaderCaches();
      entry = null;
    }
    if (!entry) {
      entry = { userId: userId, db: null, refs: 0, retired: false, opening: null };
      handleCache = entry;
      handles.add(entry);
      entry.opening = openHandle(entry);
    }
    if (entry.opening) await entry.opening;
    if (entry.retired || !D().alive(entry.db)) return null;
    entry.refs++;
    return {
      db: entry.db,
      release: function () {
        entry.refs--;
        if (!entry.refs && entry.retired) closeHandle(entry);
      },
    };
  }

  function classify(request) {
    var url;
    try { url = new URL(request.url); } catch (e) { return null; }
    var origin = (root.location && root.location.origin) || url.origin;
    if (url.origin !== origin) return null;
    var p = url.pathname;
    if (request.mode === 'navigate' && request.method === 'GET') return 'nav';
    if (request.method === 'GET' && p.indexOf('/m/') === 0) return 'media';
    if (request.method === 'GET' && p.indexOf('/img/') === 0) return 'img';
    if (p.indexOf('/htmx/') === 0) return 'htmx';
    if (request.method === 'GET' && p.indexOf('/static/') === 0) return 'static';
    return null;
  }

  function enabled(record) {
    return !!(record && record.offlineEnabled && !record.stale);
  }

  function inForgetWindow() {
    return Date.now() - forgotAt < policy.FORGET_WINDOW_MS;
  }

  function isLaunchPath(path) {
    return path === '/' || path === '/app';
  }

  function drainPreload(event) {
    if (event.preloadResponse) Promise.resolve(event.preloadResponse).catch(function () {});
  }

  // A sign-in or sign-up form posted on this browser. -> bool
  function isSignIn(request) {
    if (request.method !== 'POST') return false;
    var url;
    try { url = new URL(request.url); } catch (e) { return false; }
    var origin = (root.location && root.location.origin) || url.origin;
    return url.origin === origin && (url.pathname === '/login' || url.pathname === '/register');
  }

  function onFetch(event) {
    if (!flagged()) return;
    if (isSignIn(event.request)) {
      // The page forgets the reader before it submits (offline/boot.js), but only when
      // a flagged worker controls it; a sign-in page it does not control (a force
      // reload) leaves the worker still knowing the previous reader, and a slow first
      // page after it would time out into that reader's stored shell. So the worker
      // forgets here too, and marks the record stale; the request itself goes to the
      // network untouched (no respondWith).
      forget();
      var marked = D().forgetCurrentUser().catch(function () { return false; });
      if (event.waitUntil) event.waitUntil(marked);
      return;
    }
    var request = event.request;
    var url;
    try { url = new URL(request.url); } catch (e) { return; }
    if (request.method === 'GET' && url.origin === root.location.origin && url.pathname.startsWith(CONFIRM_PREFIX)) {
      drainPreload(event);
      event.respondWith(confirmLaunch(event, url.pathname.slice(CONFIRM_PREFIX.length)));
      return;
    }
    var kind = classify(request);
    if (!kind) return;
    if (kind === 'nav') kind = 'navigate';
    // Navigations and shell assets still need a fallback when offline is switched off.
    var trace = { row: null };
    var timed = kind === 'navigate' || kind === 'static';
    var started;
    if (timed) {
      started = Date.now();
      Object.assign(trace, {
        path: timingPath(event.request.url), kind: kind,
        sinceWorkerStartMs: Math.max(0, started - workerStartedAt),
        currentLoaded: current.loaded, loadCurrentMs: 0, networkMs: 0,
        networkOutcome: 'skipped', gatherMs: 0, result: null,
      });
    }
    var response;
    if (kind === 'navigate') {
      if (isLaunchPath(url.pathname) && request.destination === 'document' && !url.search) {
        drainPreload(event);
        trace.result = 'launch-page';
        response = Promise.resolve(RF.launch.createPage(url.pathname, event.resultingClientId));
      } else if (isLaunchPath(url.pathname) && url.searchParams.has('rf_launch')) {
        response = respondLaunchNav(event, url, trace);
      } else {
        response = respondNav(event, trace);
      }
    } else {
      if (kind !== 'static' && current.loaded && (inForgetWindow() || current.value && !enabled(current.value))) return;
      response = respond(event, kind, trace);
    }
    var onError = function (error) {
      recordRouteError(kind, error, trace.row);
      if (timed) {
        trace.result = 'error';
        recordLaunchTiming(trace, started);
      }
      throw error;
    };
    event.respondWith(timed ? response.then(function (res) {
      recordLaunchTiming(trace, started);
      return res;
    }, onError) : response.catch(onError));
  }

  // Navigation preload for the flagged worker only: a navigation then starts on the
  // network while the worker boots. The unflagged worker turns it off again.
  async function onActivate() {
    var np = root.registration && root.registration.navigationPreload;
    var preload = np && (flagged() ? np.enable() : np.disable()).catch(function () {});
    if (flagged()) {
      try {
        var state = await RF.decision.gather();
        await D().cleanupCaches(root.caches, D().currentUid(state));
      } catch (e) { /* Cache cleanup is best-effort. */ }
    }
    await preload;
  }

  async function mediaCache(userId) {
    var cs = root.caches;
    var name = RF.media.cacheName(userId);
    if (!cs || !(await cs.has(name))) return null;
    return cs.open(name);
  }

  // The network attempt; `timed`: give up (and abort) after NETWORK_TIMEOUT_MS.
  async function network(event, request, timed, trace, readResponse) {
    var ctl = timed && root.AbortController ? new root.AbortController() : null;
    var go = function () { return ctl ? root.fetch(request, { signal: ctl.signal }) : root.fetch(request); };
    var p = request.mode === 'navigate' && event.preloadResponse
      ? Promise.resolve(event.preloadResponse).then(function (r) { return r || go(); })
      : go();
    if (readResponse) p = p.then(readResponse);
    if (!timed) return p;
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        if (ctl) ctl.abort();
        if (trace) trace.networkOutcome = 'timeout';
        reject(new Error('network timeout'));
      }, policy.NETWORK_TIMEOUT_MS);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  async function launchState() {
    var state = await RF.decision.gather({ forgetWindow: inForgetWindow() });
    state.forgetWindow = state.forgetWindow || inForgetWindow();
    return state;
  }

  function pending(record) {
    return record && (record.logoutPending || record.wipePending);
  }

  function eligibleForConfirmation(record) {
    return enabled(record) && Number.isInteger(record.userId) && record.userId > 0
      && !record.forceOffline && !pending(record) && !inForgetWindow();
  }

  function mirrorAllowsConfirmation(mirror, uid) {
    return mirror.state === 'missing' || (mirror.state === 'ok' && mirror.value.uid === uid
      && mirror.value.offlineEnabled === true && !mirror.value.stale && !pending(mirror.value));
  }

  function currentConfirmation(context) {
    return context.gen === current.gen && context.fallbackGen === fallbackGen
      && eligibleForConfirmation(current.value) && context.uid === current.value.userId;
  }

  function loginResponse(response) {
    if (response.status === 401) return true;
    if (!response.redirected) return false;
    var url = new URL(response.url);
    return url.origin === root.location.origin && url.pathname === '/login';
  }

  function confirmationResponse(go) {
    return new Response(JSON.stringify({ go: go }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  async function confirmLaunch(event, code) {
    var entry = /^[0-9a-f]{32}$/.test(code) && RF.launch.beginConfirmation(code, event.clientId);
    if (!entry) return confirmationResponse('network');
    function finish(state, go, context) {
      return confirmationResponse(RF.launch.finishConfirmation(entry, state, context) ? go : 'network');
    }
    if (inForgetWindow()) return finish('rejected', 'network');
    var cur = await loadCurrent();
    if (!eligibleForConfirmation(cur)) return finish('rejected', 'network');
    var context = { uid: cur.userId, gen: current.gen, fallbackGen: fallbackGen };
    var mirror = await D().readMirror(root.caches);
    if (!currentConfirmation(context) || !RF.launch.isFresh(entry) || !mirrorAllowsConfirmation(mirror, context.uid)) {
      return finish('rejected', 'network');
    }

    var request = new Request(new URL('/sync/changes', root.location.origin), {
      method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'follow',
      headers: { 'X-Readfine-User': String(context.uid) },
    });
    var response, body;
    try {
      response = await network(event, request, true, null, async function (res) {
        if (currentConfirmation(context) && !res.redirected && res.status === 200) {
          try { body = await res.json(); } catch (e) { /* An invalid body cannot confirm the session. */ }
        }
        return res;
      });
    } catch (e) {
      return currentConfirmation(context) ? finish('offline', 'shell') : finish('rejected', 'network');
    }

    if (!currentConfirmation(context)) return finish('rejected', 'network');
    if (loginResponse(response)) return finish('rejected', 'login');
    if (!body || typeof body.token !== 'string' || !/^[0-9a-f]{12}$/.test(body.token)) {
      return finish('rejected', 'server');
    }

    await loadCurrent(true);
    mirror = await D().readMirror(root.caches);
    if (!currentConfirmation(context) || !mirrorAllowsConfirmation(mirror, context.uid)) {
      return finish('rejected', 'network');
    }
    return finish('confirmed', 'shell', context);
  }

  async function respondLaunchNav(event, url, trace) {
    drainPreload(event);
    var code = url.searchParams.get('rf_launch');
    var entry = RF.launch.takeNavigation(code, url.pathname);
    var failClosed = code === 'server' || entry?.state === 'rejected';
    if (!failClosed) {
      if (entry?.state === 'offline') return answerNav(event, trace);
      if (!entry || !currentConfirmation(entry)) return respondNav(event, trace);
      var hit = await answerNav(event, trace, entry);
      if (hit) return hit;
    }
    var networkStart = Date.now();
    try {
      var res = await network(event, event.request, false, trace);
      trace.networkOutcome = 'ok';
      trace.result = 'network';
      return res;
    } catch (e) {
      trace.networkOutcome = 'error';
      if (!failClosed) throw e;
      trace.result = 'offline-page';
      return RF.router.offlinePage(event.request.url);
    } finally {
      trace.networkMs = elapsed(networkStart);
    }
  }

  async function answerNav(event, trace, confirmedEntry) {
    var url = event.request.url;
    var path = new URL(url).pathname;
    if (isLaunchPath(path)) {
      try {
        var gen = current.gen;
        while (gen === current.gen) {
          var decisionGen = fallbackGen;
          var gatherStart = Date.now();
          var state;
          try {
            state = await launchState();
          } finally {
            trace.gatherMs += elapsed(gatherStart);
          }
          if (gen !== current.gen) break;
          if (decisionGen !== fallbackGen) continue;
          if (confirmedEntry && (!currentConfirmation(confirmedEntry) || !RF.launch.isFresh(confirmedEntry)
            || pending(state.record) || state.record && state.record.userId !== confirmedEntry.uid)) break;
          var answer = RF.decision.decide(state);
          trace.row = answer.row;
          var hit = null;
          if (answer.answer === 'shell') {
            if (fallbackState && !confirmedEntry) {
              clearFallback();
              decisionGen = fallbackGen;
            }
            var entry = state.pages.concat(state.legacy).find(function (item) { return item.name === answer.cache; });
            hit = await RF.router.shell(answer.cache);
            // A concurrent write can replace the entry after gather checked ownership.
            var owner = hit && D().shellUser(await hit.clone().text());
            if (gen !== current.gen) break;
            if (decisionGen !== fallbackGen) continue;
            if (!entry || owner !== entry.appUser || inForgetWindow()) hit = null;
            if (hit && confirmedEntry) {
              if (owner !== confirmedEntry.uid) break;
              var mirror = await D().readMirror(root.caches);
              if (!currentConfirmation(confirmedEntry) || !RF.launch.isFresh(confirmedEntry)
                || !mirrorAllowsConfirmation(mirror, confirmedEntry.uid)) break;
              state.mirror = mirror.value;
              state.mirrorState = mirror.state;
              if (RF.decision.decide(state).cache !== answer.cache) break;
            }
          }
          if (hit) {
            rememberFallback(state, answer.row);
            trace.result = 'shell';
            return hit;
          }
          if (!confirmedEntry) clearFallback();
          break;
        }
      } catch (e) {
        // Storage may disappear during a cold launch.
        recordRouteError('navigate', e, trace.row);
      }
    }
    if (confirmedEntry) return null;
    trace.result = 'offline-page';
    return RF.router.offlinePage(url);
  }

  async function respondNav(event, trace) {
    // A preload can reject while the current-user read is still in flight.
    drainPreload(event);
    var cur = current.value;
    if (!current.loaded) {
      var currentStart = Date.now();
      try {
        cur = await loadCurrent();
      } finally {
        trace.loadCurrentMs = elapsed(currentStart);
      }
    }
    var forgetWindow = inForgetWindow();
    if (forgetWindow || !enabled(cur) || !cur.forceOffline) {
      var networkStart = Date.now();
      try {
        var res = await network(event, event.request, !forgetWindow && (!cur || enabled(cur)), trace);
        trace.networkOutcome = 'ok';
        trace.result = 'network';
        return res;
      } catch (e) {
        if (trace.networkOutcome !== 'timeout') trace.networkOutcome = 'error';
        // Offline: answer below, even when stepping aside.
      } finally {
        trace.networkMs = elapsed(networkStart);
      }
    }
    return answerNav(event, trace);
  }

  function rememberFallback(state, row) {
    if (row === 'R6' || row === 'L6') {
      fallbackState = state;
      return state.mirror.uid;
    }
    clearFallback();
    return null;
  }

  async function fallbackUid(trace) {
    if (inForgetWindow()) return null;
    var gen = current.gen;
    var state = fallbackState;
    while (true) {
      var decisionGen = fallbackGen;
      if (state) {
        // Reuse the selected cache evidence, but honor mirror demotions immediately.
        var mirror = await D().readMirror(root.caches);
        state = Object.assign({}, state, { mirror: mirror.value, mirrorState: mirror.state });
      } else {
        state = await launchState();
      }
      if (gen !== current.gen || inForgetWindow() || current.value) return null;
      if (decisionGen === fallbackGen) {
        trace.row = RF.decision.decide(state).row;
        return rememberFallback(state, trace.row);
      }
      // The cached evidence was invalidated while storage was being read.
      state = null;
    }
  }

  async function respond(event, kind, trace) {
    var request = event.request;
    if (kind === 'static') {
      if (!current.loaded) {
        var currentStart = Date.now();
        try {
          await loadCurrent();
        } finally {
          trace.loadCurrentMs = elapsed(currentStart);
        }
      }
      var exact = !!new URL(request.url).searchParams.get('v');
      var uid;
      var staticResponse;
      if (exact) {
        try {
          uid = current.value ? current.value.userId : await fallbackUid(trace);
          staticResponse = await staticHit(request, uid, true);
          if (staticResponse) {
            trace.result = 'cache';
            return staticResponse;
          }
        } catch (e) { /* Storage is optional. Try the network on a cache error. */ }
      }
      var networkStart = Date.now();
      try {
        var res = await root.fetch(request);
        trace.networkMs = elapsed(networkStart);
        trace.networkOutcome = 'ok';
        trace.result = 'network';
        return res;
      } catch (e) {
        trace.networkMs = elapsed(networkStart);
        trace.networkOutcome = 'error';
        if (exact) throw e;
        uid = current.value ? current.value.userId : await fallbackUid(trace);
        staticResponse = await staticHit(request, uid, false);
        if (staticResponse) {
          trace.result = 'cache';
          return staticResponse;
        }
        throw e;
      }
    }
    var cur = current.loaded ? current.value : await loadCurrent();
    var gen = current.gen;
    var userId = enabled(cur) && !inForgetWindow() ? cur.userId : cur ? null : await fallbackUid(trace);
    if (userId === null) return network(event, request, false);
    if (kind === 'media') {
      var cache = await mediaCache(userId);
      var hit = cache && await RF.media.match(cache, request.url);
      return hit || root.fetch(request);
    }
    if (kind === 'img') {
      try { return await root.fetch(request); } catch (e) {
        var images = await mediaCache(userId);
        var image = images && await RF.media.match(images, request.url);
        if (image) return image;
        throw e;
      }
    }
    // For /htmx/, the request body is gone once fetch has read it, so a
    // POST keeps a copy for the offline answer. A POST is never timed out: whether the
    // server applied it would be unknown, and the queued op would apply it twice.
    var isGet = request.method === 'GET';
    var spare = isGet ? request : request.clone();
    if (!cur || !cur.forceOffline) {
      try { return await network(event, request, isGet); } catch (e) { /* offline: answer below */ }
    }
    return offline(spare, userId, gen, trace);
  }

  async function staticHit(request, uid, exact) {
    var cs = root.caches;
    if (!cs) return null;
    var names = (await cs.keys()).filter(function (n) { return n.startsWith(D().SHELL_PREFIX); });
    if (uid !== null) names.unshift(D().PAGES_PREFIX + uid);
    for (var i = 0; i < names.length; i++) {
      var hit;
      if (typeof cs.match === 'function') {
        hit = await cs.match(request.url, { cacheName: names[i] });
        if (!hit && !exact) hit = await cs.match(request.url, { cacheName: names[i], ignoreSearch: true });
      } else if (await cs.has(names[i])) {
        var c = await cs.open(names[i]);
        hit = await c.match(request.url);
        if (!hit && !exact) hit = await c.match(request.url, { ignoreSearch: true });
      }
      if (hit) return hit;
    }
    return null;
  }

  async function offline(request, userId, gen, trace) {
    var R = RF.router;
    var fallback = function () { return R.needsConnection(''); };
    if (gen !== current.gen || inForgetWindow()) return fallback();
    var lease;
    try {
      lease = await acquire(userId);
      if (!lease || gen !== current.gen || !D().alive(lease.db)) return fallback();
      var res = await R.handle(request, lease.db);
      return res || fallback();
    } catch (err) {
      recordRouteError('htmx', err, trace.row);
      if (root.console) root.console.warn('offline router failed:', err);
      return fallback();
    } finally {
      if (lease) lease.release();
    }
  }

  function onMessage(event) {
    var data = event && event.data;
    if (!data || !flagged()) return;
    if (data.type === 'rf-forget-user') {
      forget();
      return;
    }
    if (data.type === 'rf-current-user') {
      clearFallback();
      // The mirror lock is also used by wipeAll. Keep this retry outside any
      // router lease so a request never needs the lock in order to release.
      var p = resetCurrent().then(function () { return D().syncMirror(root.caches); });
      if (event.waitUntil) event.waitUntil(p);
    }
    if (data.type === 'rf-test-launch' && event.ports && event.ports[0]) {
      var reply = launchState().then(function (state) {
        event.ports[0].postMessage(Object.assign(RF.decision.decide(state), {
          pages: state.pages.map(function (entry) { return entry.name; }),
          legacy: state.legacy.map(function (entry) { return entry.name; }),
          recordState: state.recordState,
          mirrorState: state.mirrorState,
        }));
      });
      if (event.waitUntil) event.waitUntil(reply);
    }
  }

  policy.flagged = flagged;
  policy.classify = classify;
  policy.onFetch = onFetch;
  policy.onActivate = onActivate;
  policy.onMessage = onMessage;
  policy.launchState = launchState;
  policy.routeDiagnostics = routeDiagnostics;
  policy.reload = resetCurrent;
  policy._current = current;
  RF.policy = policy;
})(self);

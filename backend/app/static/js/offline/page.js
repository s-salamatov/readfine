// Offline mode, page side: the per-device switch, sync, "Ready for offline", the
// offline banner and the controls that need a connection.
//
// Plain script, loaded (deferred, after db/media/sync/templates/overlay/sw-register)
// on pages of a signed-in reader, who carry <body data-rf-user="{id}" data-rf-name>.
// Runs once per document: boosted settings pages keep the document, so the controller,
// its listeners and its timer outlive every swap; preferences.js binds the settings
// section to it again each time it runs.
//
// Where the switch lives: the current-user store (RFOffline.db.setCurrentUser), which
// the service worker reads too. Per device, off by default; nothing is written for a
// reader who never switched it on.
//
// Sync runs only here (iOS suspends the worker in the background): on load, when the
// page becomes visible, on `online`, every 5 minutes while visible, and from "Sync now".
// Never two at once. Automatic syncs are skipped under "Work offline" (the reader said
// the connection is not worth using) and while the browser says it is offline; "Sync
// now" always tries.
//
// States (see task-11-report.md):
//   off      enabled=false. Worker unflagged, no sync, status hidden.
//   on       enabled=true, database open. Syncs on the triggers above.
//   missing  enabled=true, database gone (wiped elsewhere): reopened (created) only by
//            "Sync now" or the switch, and only while the store still says so.
//   force    on + forceOffline: the worker answers everything from the device.
// Offline (banner, controls disabled) = force, or navigator.onLine false, or the last
// answer came from the worker (X-Readfine-Offline: 1) / the last sync hit the network
// error, until an online answer or a successful sync.
//
// Logout and account safety (task-12-report.md): a [data-rf-logout] submit wipes every
// offline database and cache before POST /logout (logout()); a start for another reader
// than the stored one wipes before anything shows; a 401 stops syncing from this page
// but keeps data and outbox.
(function (root) {
  'use strict';
  var RF = root.RFOffline = root.RFOffline || {};

  var SYNC_EVERY_MS = 5 * 60 * 1000;
  var BUSY = { busy: true }; // the sync lock is held by another tab

  // Markers kept outside the wiped databases, in localStorage. Neither holds user data.
  // Both are set the moment the reader commits to logging out and each is cleared when
  // its step succeeds, so a crash or a closed app mid-logout is finished by the next start.
  //   rf-logout-pending  POST /logout not confirmed yet: the next start posts it before
  //                      anything else, or shows "Logged out on this device" (never the
  //                      app). logout-guard.js hides the page while it is set. The login
  //                      page clears it (app.js): no session there, nothing to end.
  //   rf-wipe-pending    the device wipe not confirmed yet (crash, blocked database): the
  //                      next start, or the next switch-on, wipes first.
  var PENDING_KEY = 'rf-logout-pending';
  var WIPE_KEY = 'rf-wipe-pending';
  var HIDE_CLASS = 'rf-hide';       // set by logout-guard.js in <head>
  var LOGOUT_WAIT_MS = 1000;        // a running sync / download (wipeAll waits too)
  var REGISTER_WAIT_MS = 3000;      // re-registering the plain worker (fails offline)
  var HAS_DATA_WAIT_MS = 3000;      // "anything offline here?" (timeout: assume yes)
  var STORE_WAIT_MS = 2000;         // the "off" write before the wipe
  var LOGOUT_WATCHDOG_MS = 15000;   // then: markers stay, plain POST /logout

  // -> Promise<value of p, or `fallback` on timeout or rejection>
  function bounded(p, ms, fallback) {
    return new Promise(function (resolve) {
      var t = setTimeout(function () { resolve(fallback); }, ms);
      Promise.resolve(p).then(function (v) { clearTimeout(t); resolve(v); },
        function () { clearTimeout(t); resolve(fallback); });
    });
  }

  function noop() {}

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function bytes(n) {
    if (!(n >= 0)) return '?';
    if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    if (n >= 1024 * 1024) return Math.round(n / (1024 * 1024)) + ' MB';
    return Math.round(n / 1024) + ' KB';
  }

  function cookie(doc, name) {
    var parts = String((doc && doc.cookie) || '').split('; ');
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].indexOf(name + '=') === 0) return parts[i].slice(name.length + 1);
    }
    return '';
  }

  // opts: userId (required), displayName, doc, win, nav, db (RFOffline.db), sync, sw,
  // templates, overlay, fetchFn (sync and POST /logout), caches, intervalMs, confirm,
  // storage (localStorage, null = none), navigate(url) (default location.replace),
  // hasDataWaitMs, logoutWatchdogMs (logout bounds, for tests).
  function create(opts) {
    var doc = opts.doc || root.document;
    var win = opts.win || root;
    var nav = opts.nav || root.navigator || {};
    var D = opts.db || RF.db;
    var S = opts.sync || RF.sync;
    var W = opts.sw || RF.sw;
    var T = opts.templates || RF.templates;
    var O = opts.overlay || RF.overlay;
    var userId = opts.userId;
    var displayName = opts.displayName || '';
    var intervalMs = opts.intervalMs || SYNC_EVERY_MS;
    var esc = T && T.esc ? T.esc : function (s) { return String(s); };

    var st = {
      enabled: false,
      force: false,
      db: null,
      missing: false,
      running: null,
      progress: null,
      media: null,          // the detached image download, while it runs
      mediaProgress: null,
      autos: new Set(),     // automatic sync attempts still deciding
      error: null,
      netDown: false,
      storageFull: false,
      lastSync: null,
      counts: { articles: 0, images: 0, pending: 0, stuck: [] },
      stuckOpen: false,
      timer: null,
      deviceData: false,
      mediaNext: null,      // a queue that arrived while a download ran
      mediaBudget: undefined, // bytes, from the last sync's manifest (limits)
      storeUnreadable: false,
      leaving: false,       // logging out: nothing syncs, downloads or switches on again
      loggingOut: null,
    };
    var ctl = { state: st };

    function supported() {
      return !!(win.indexedDB || root.indexedDB) && !!(nav && nav.serviceWorker);
    }

    function offline() {
      return st.force || nav.onLine === false || st.netDown;
    }

    function dbAlive() { return !!st.db && D.alive(st.db); }

    // The store says offline mode is on for this reader. A stale record (a sign-in
    // started on this browser, offline/boot.js) is on for nobody until a start of the
    // same reader restores it.
    function isOn(cur) {
      return !!cur && cur.userId === userId && !!cur.offlineEnabled && !cur.stale;
    }

    function storage() {
      try { return opts.storage !== undefined ? opts.storage : (win.localStorage || null); } catch (e) { return null; }
    }

    function marked(key) {
      try { var s = storage(); return !!s && s.getItem(key) === '1'; } catch (e) { return false; }
    }

    function mark(key, on) {
      try {
        var s = storage();
        if (!s) return;
        if (on) s.setItem(key, '1');
        else s.removeItem(key);
      } catch (e) { /* private mode: the marker is best effort */ }
    }

    function navigate(url) {
      if (opts.navigate) opts.navigate(url);
      else win.location.replace(url);
    }

    function here() {
      return (doc.location && doc.location.href) || (win.location && win.location.href) || '/app';
    }

    function unhide() {
      var el = doc.documentElement;
      if (el && el.classList) el.classList.remove(HIDE_CLASS);
    }

    // Every wipe names the databases it knows of: where indexedDB.databases() is
    // missing (older Safari), wipeAll deletes only the names it is given.
    function wipe(otherIds) {
      var names = [D.dbName(userId), D.CURRENT_DB];
      (otherIds || []).forEach(function (id) {
        if (Number.isInteger(id) && id > 0 && id !== userId) names.push(D.dbName(id));
      });
      return D.wipeAll({ names: names });
    }

    async function wipeOrMark(otherIds) {
      try { await wipe(otherIds); mark(WIPE_KEY, false); return true; } catch (e) { mark(WIPE_KEY, true); return false; }
    }

    async function writeName() {
      if (dbAlive() && displayName) {
        try { await D.setMeta(st.db, D.META.displayName, displayName); } catch (e) { /* cosmetic */ }
      }
    }

    // The database if it exists; with `create`, (re)creates it, but only while the store
    // still says this reader has offline mode on (a logout in another tab wiped both).
    async function openDb(create) {
      if (dbAlive()) return st.db;
      st.db = null;
      var db = await D.openExisting(userId);
      if (!db && create) {
        var cur = await D.getCurrentUser().catch(function () { return null; });
        if (isOn(cur)) db = await D.open(userId);
        else goOff(); // logged out or switched off in another tab
      }
      st.db = db;
      st.missing = st.enabled && !db;
      if (db) await writeName();
      return db;
    }

    async function refreshCounts() {
      if (!dbAlive()) {
        st.counts = { articles: 0, images: 0, pending: 0, stuck: [] };
        return st.counts;
      }
      var db = st.db;
      try {
        var r = await Promise.all([
          D.readyIds(db), D.getMeta(db, D.META.media), D.outboxEntries(db), D.stuckOps(db),
          D.getMeta(db, D.META.lastSync),
        ]);
        st.counts = {
          articles: r[0].length,
          images: Object.keys(r[1] || {}).length,
          pending: r[2].filter(function (e) { return !D.isBlocked(e.op); }).length,
          stuck: r[3].map(function (e) { return e.op; }),
        };
        if (r[4] && r[4].finishedAt) st.lastSync = r[4].finishedAt;
      } catch (e) { /* a wipe closed it; next render shows zeros */ }
      return st.counts;
    }

    // Articles on screen: the detail panel, or the detail expanded in the list on a
    // small screen (#inline-article-detail-content); story members shown with it count
    // too. A sync never removes these.
    function openArticleIds() {
      var out = [];
      doc.querySelectorAll('#article-detail [data-rf-article], #inline-article-detail-content [data-rf-article]')
        .forEach(function (el) {
          var id = parseInt(el.getAttribute('data-rf-article'), 10);
          if (id > 0 && out.indexOf(id) < 0) out.push(id);
        });
      return out;
    }

    // ---- the store is the truth --------------------------------------------------------

    // Another tab may have switched offline mode off (or on), logged out, or changed
    // "Work offline". Before acting, this tab takes the store's word for it.
    // -> Promise<bool>: on for this reader.
    async function reconcile() {
      if (st.leaving) return false;
      var cur;
      try {
        cur = await D.getCurrentUser();
      } catch (e) {
        // A transient read failure is not "off": try once more, then keep what this tab
        // has and say so, rather than drop the reader's offline mode on a hiccup.
        try {
          cur = await D.getCurrentUser();
        } catch (e2) {
          st.storeUnreadable = true;
          render();
          return st.enabled && !st.leaving;
        }
      }
      if (st.leaving) return false;
      if (st.storeUnreadable) { st.storeUnreadable = false; render(); }
      var on = isOn(cur);
      if (!on && st.enabled) {
        goOff();
        if (st.db) { st.db.close(); st.db = null; }
        render();
      } else if (on && !st.enabled) {
        st.enabled = true;
        st.force = !!cur.forceOffline;
        await openDb(false);
        await refreshCounts();
        startTimer();
        render();
      } else if (on && st.force !== !!cur.forceOffline) {
        st.force = !!cur.forceOffline;
        render();
      }
      return on;
    }

    // ---- sync --------------------------------------------------------------------------

    // One sync per device at a time, across tabs (Web Locks, where the browser has
    // them): a tab that finds another one syncing skips its turn. -> fn()'s value or BUSY
    function exclusive(fn) {
      var locks = nav && nav.locks;
      if (!locks || typeof locks.request !== 'function') return fn();
      return locks.request('rf-sync', { ifAvailable: true }, function (lock) {
        return lock ? fn() : BUSY;
      });
    }

    function syncNow(explicit) {
      if (st.leaving) return Promise.resolve(null);
      if (st.running) return st.running;
      st.progress = null;
      st.running = (async function () {
        if (!(await reconcile())) return null;
        var db = await openDb(!!explicit);
        if (!db) { render(); return null; }
        render();
        var rep;
        try {
          rep = await exclusive(function () {
            return S.run(db, {
              fetchFn: opts.fetchFn,
              caches: opts.caches || win.caches || root.caches,
              csrfToken: function () { return cookie(doc, 'csrftoken'); },
              keepIds: openArticleIds(),
              // Images download detached (startMedia), so ops and new articles never
              // wait for a long image queue.
              downloadMedia: false,
              onProgress: function (p) { st.progress = p; render(); },
            });
          });
        } catch (err) {
          rep = { error: dbAlive() ? 'failed' : 'wiped' };
        }
        if (rep === BUSY) return null; // another tab is syncing this device right now
        await settle(rep || { error: 'failed' });
        if (rep && rep.mediaBudgetBytes) st.mediaBudget = rep.mediaBudgetBytes;
        if (rep && !rep.error && rep.mediaQueue && rep.mediaQueue.length) startMedia(db, rep.mediaQueue);
        return rep;
      })().finally(function () {
        st.running = null;
        st.progress = null;
        render();
      });
      return st.running;
    }

    // Off in memory only: the store already says so (a logout or switch-off elsewhere).
    function goOff() {
      st.enabled = false;
      st.force = false;
      st.missing = false;
      stopTimer();
    }

    // The image queue of a clean sync, in the background. One per database (sync.js
    // shares a running download, and tracks it so a wipe waits for it). A sync may run
    // while it does; "Sync now" stays available. A queue that arrives meanwhile is kept
    // (the newest wins: it reflects the latest sync) and downloaded when this one ends.
    function startMedia(db, queue) {
      if (st.leaving || !st.enabled) return null;
      if (st.media) { st.mediaNext = queue; return st.media; }
      st.mediaProgress = { done: 0, total: queue.length };
      st.media = Promise.resolve().then(function () {
        return S.downloadMedia(db, queue, {
          caches: opts.caches || win.caches || root.caches,
          fetchFn: opts.fetchFn,
          budgetBytes: st.mediaBudget, // the server's (manifest), else media.js's default
          onProgress: function (p) { st.mediaProgress = p; render(); },
        });
      }).then(function (res) {
        var stop = res && res.stoppedReason;
        if (stop === 'wiped') return settle({ error: 'wiped' });
        st.storageFull = stop === 'quota' || stop === 'budget';
        return refreshCounts();
      }, function () {
        return dbAlive() ? refreshCounts() : settle({ error: 'wiped' });
      }).finally(function () {
        st.media = null;
        st.mediaProgress = null;
        var next = st.mediaNext;
        st.mediaNext = null;
        if (next && next.length && dbAlive() && st.enabled && !st.leaving) startMedia(st.db, next);
        render();
      });
      render();
      return st.media;
    }

    async function settle(rep) {
      var err = rep.error || null;
      if (err === 'wiped') {
        st.db = null;
        var cur = await D.getCurrentUser().catch(function () { return null; });
        if (!isOn(cur)) {
          // Switched off or logged out (in this tab or another): stay off.
          goOff();
        } else {
          await openDb(false);
        }
        st.error = null;
      } else if (err === 'network') {
        st.netDown = true;
        st.error = null;
      } else {
        st.error = err;
        if (!err) {
          st.netDown = false;
          st.lastSync = rep.finishedAt || st.lastSync;
          if (st.enabled && !st.leaving) startTimer();
        } else if (err === 'account') {
          // The session is another reader's (signed in elsewhere in this browser); the
          // server refused before doing anything. This tab's reader is gone from here:
          // wipe, then reload as whoever is signed in now.
          await accountGone(here());
          return;
        } else if (err === 'auth') {
          // Session expired: data and outbox stay, nothing more is sent from this page
          // (the cookie jar is shared, so whoever signs in next would get these ops).
          // A new page load, after signing in again, starts over; another reader's load
          // wipes this one's data (the mismatch check in start).
          stopTimer();
        }
      }
      await refreshCounts();
    }

    // -> Promise<report | null>. Kept in st.autos until settled, so idle() sees it.
    function autoSync() {
      var p = (async function () {
        if (!(await reconcile())) return null;
        if (st.missing || st.force || nav.onLine === false || st.error === 'auth') return null;
        return syncNow(false);
      })();
      st.autos.add(p);
      var drop = function () { st.autos.delete(p); };
      p.then(drop, drop);
      return p;
    }

    // ---- switch ------------------------------------------------------------------------

    async function enable() {
      var persisted = null;
      try {
        if (nav.storage && nav.storage.persist) persisted = await nav.storage.persist();
      } catch (e) { persisted = false; }
      if (st.leaving) throw new Error('logging out');
      // A wipe still owed (an earlier logout or account switch left a database) runs
      // first: done later, on the next start, it would delete what this switch stores.
      if (marked(WIPE_KEY) && !(await wipeOrMark())) {
        render();
        throw new Error('offline data from before could not be removed');
      }
      st.force = false;
      st.netDown = false;
      try {
        // The store first: a reconcile (a broadcast) that ran between "on here" and "on
        // in the store" would switch this tab off again.
        await D.setCurrentUser(userId, { offlineEnabled: true, forceOffline: false });
        st.enabled = true;
        if (!dbAlive()) st.db = await D.open(userId);
        st.missing = false;
        await writeName();
        await W.register({ offline: true });
      } catch (err) {
        // Without the flagged worker nothing would be answered offline: back to off, in
        // the store and here, rather than "on" in name only.
        goOff();
        if (st.db) { st.db.close(); st.db = null; }
        await D.setCurrentUser(userId, { offlineEnabled: false, forceOffline: false }).catch(noop);
        render();
        throw err;
      }
      startTimer();
      render();
      syncNow(true);
      return { persisted: persisted };
    }

    async function disable() {
      st.enabled = false;
      st.force = false;
      st.missing = false;
      st.netDown = false;
      st.error = null;
      // A running sync or image download stops at its next step (its handle is closed)
      // and keeps what it has.
      if (st.db) { st.db.close(); st.db = null; }
      stopTimer();
      render();
      // Store first: a flagged worker that reads "off" steps aside, so if registering the
      // plain worker fails the safe state still holds.
      await D.setCurrentUser(userId, { offlineEnabled: false, forceOffline: false });
      await W.register({ offline: false });
    }

    // Deletes every offline database and cache on this device (all readers'), and the
    // current-user record. Only while switched off.
    async function removeData() {
      if ((await reconcile()) || st.enabled) throw new Error('switch offline mode off first');
      if (st.db) { st.db.close(); st.db = null; }
      await wipe();
      await D.setCurrentUser(null);
      st.lastSync = null;
      st.storageFull = false;
      await refreshCounts();
      render();
    }

    // Never turns offline mode on: only a reader the store says is on can change it.
    async function setForceOffline(on) {
      if (!(await reconcile())) return;
      st.force = !!on;
      await D.setCurrentUser(userId, { offlineEnabled: true, forceOffline: st.force });
      render();
      if (!st.force) autoSync();
    }

    // ---- logout and account safety (design 5.7) -----------------------------------------
    //
    // logout(form), from the submit of any [data-rf-logout] form:
    //   nothing offline on this device  -> a plain POST /logout form (no-op here);
    //   unsent actions (pending + stuck, -> in-page dialog: "Sync and log out" (online,
    //   or uncountable)                     offline mode on), "Discard and log out",
    //                                       "Cancel"; after a sync that left actions,
    //                                       the dialog comes back with the new count;
    //   committed: both markers set, "Logging out…" overlay; syncs stop, the store says
    //   off, the plain worker is registered, the wipe (rf-wipe-pending cleared), POST
    //   /logout (rf-logout-pending cleared) -> /login (?offline_wipe=incomplete if a
    //   database stayed); not reached -> "Logged out on this device" in place.
    //   Watchdog: past LOGOUT_WATCHDOG_MS the markers stay and a plain POST /logout goes.

    // Anything offline here: the switch, a current-user record (also when switched off:
    // the data stays until a logout), any offline database, or a wipe still owed.
    // Undecidable in time -> yes.
    function hasDeviceData() {
      return bounded((async function () {
        if (st.enabled || marked(WIPE_KEY)) return true;
        var cur;
        try { cur = await D.getCurrentUser(); } catch (e) { return true; }
        if (cur) return true;
        var f = win.indexedDB || root.indexedDB;
        if (!f || typeof f.databases !== 'function') return false;
        try {
          var dbs = await f.databases();
          return dbs.some(function (d) { return d && String(d.name || '').indexOf(D.DB_PREFIX) === 0; });
        } catch (e) { return true; }
      })(), opts.hasDataWaitMs || HAS_DATA_WAIT_MS, true);
    }

    // -> {pending, stuck, unknown}: actions not on the server yet. Never creates the
    // database. unknown: the outbox could not be read (asked about, never assumed empty).
    async function unsynced() {
      var db = dbAlive() ? st.db : null;
      var temp = false;
      try {
        if (!db) { db = await D.openExisting(userId); temp = !!db; }
        if (!db) return { pending: 0, stuck: 0, unknown: false };
        var all = await D.outboxEntries(db);
        var stuck = all.filter(function (e) { return D.isBlocked(e.op); }).length;
        return { pending: all.length - stuck, stuck: stuck, unknown: false };
      } catch (e) {
        return { pending: 0, stuck: 0, unknown: true };
      } finally {
        if (temp && db) db.close();
      }
    }

    // The modal shell of the logout dialog and the "Logging out…" overlay.
    function modal(attr, inner) {
      var el = doc.createElement('div');
      el.setAttribute(attr, '');
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-labelledby', 'rf-logout-title');
      el.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4';
      el.innerHTML = '<div class="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg text-sm text-gray-800 space-y-3 dark:bg-gray-800 dark:text-gray-100">'
        + inner + '</div>';
      (doc.body || doc.documentElement).appendChild(el);
      return el;
    }

    // -> Promise<'sync' | 'discard' | 'cancel'>
    function logoutDialog(c, canSync, note) {
      return new Promise(function (resolve) {
        var n = c.pending + c.stuck;
        var btn = 'block w-full rounded px-4 py-2 text-sm font-medium cursor-pointer border-0';
        var title = c.unknown ? 'Unsent changes could not be counted' : plural(n, 'change', 'changes') + ' not synced yet';
        var el = modal('data-rf-logout-dialog',
          '<p id="rf-logout-title" class="font-semibold">' + esc(title) + '</p>'
          + (c.stuck ? '<p data-rf-logout-stuck class="text-amber-700 dark:text-amber-400">' + esc(plural(c.stuck, 'action', 'actions')) + ' could not be sent and ' + (c.stuck === 1 ? 'needs' : 'need') + ' attention.</p>' : '')
          + (note ? '<p data-rf-logout-note class="text-red-600">' + esc(note) + '</p>' : '')
          + '<p class="text-gray-500 dark:text-gray-400">Logging out removes offline data from this device. Changes not synced are lost.</p>'
          + (canSync ? '<button type="button" data-rf-logout-choice="sync" class="' + btn + ' bg-blue-600 text-white hover:bg-blue-700">Sync and log out</button>' : '')
          + '<button type="button" data-rf-logout-choice="discard" class="' + btn + ' bg-red-600 text-white hover:bg-red-700">Discard and log out</button>'
          + '<button type="button" data-rf-logout-choice="cancel" class="' + btn + ' bg-transparent text-gray-700 hover:bg-gray-100 dark:text-gray-200">Cancel</button>');
        function finish(choice) {
          el.removeEventListener('click', onChoice);
          doc.removeEventListener('keydown', onKey);
          if (el.parentNode) el.parentNode.removeChild(el);
          resolve(choice);
        }
        function onChoice(e) {
          var b = e.target && e.target.closest && e.target.closest('[data-rf-logout-choice]');
          if (b) finish(b.getAttribute('data-rf-logout-choice'));
          else if (e.target === el) finish('cancel');
        }
        function onKey(e) { if (e.key === 'Escape') finish('cancel'); }
        el.addEventListener('click', onChoice);
        doc.addEventListener('keydown', onKey);
        var first = el.querySelector('[data-rf-logout-choice]');
        if (first && first.focus) first.focus();
      });
    }

    function showBusy() {
      if (doc.querySelector('[data-rf-logout-busy]')) return;
      modal('data-rf-logout-busy', '<p id="rf-logout-title" class="font-semibold">Logging out…</p>'
        + '<p class="text-gray-500 dark:text-gray-400">Removing offline data from this device.</p>');
    }

    // -> true once the server answered (the session is gone, or there was none).
    async function postLogout() {
      var f = opts.fetchFn || (win.fetch ? win.fetch.bind(win) : root.fetch);
      try {
        var res = await f('/logout', { method: 'POST', credentials: 'same-origin', redirect: 'manual' });
        return !!res && (res.type === 'opaqueredirect' || (res.status >= 200 && res.status < 400));
      } catch (e) {
        return false;
      }
    }

    // A plain POST /logout navigation, from a fresh form (the original may be gone from
    // a swapped sidebar). form.submit() fires no submit event, so this is not intercepted.
    function nativeLogout() {
      var f = doc.createElement('form');
      f.method = 'POST';
      f.action = '/logout';
      f.setAttribute('data-rf-logout-native', '');
      f.hidden = true;
      (doc.body || doc.documentElement).appendChild(f);
      f.submit();
    }

    // Nothing can serve /login while offline, and the reader's articles must not stay
    // on screen (nor be revealed by a later start for a session logged out here).
    function showLoggedOut(incomplete) {
      if (doc.body) {
        doc.title = 'Logged out – Readfine';
        doc.body.removeAttribute('data-rf-user');
        doc.body.removeAttribute('data-rf-name');
        doc.body.hidden = false;
        doc.body.innerHTML = '<div data-rf-logged-out class="min-h-screen flex items-center justify-center p-4">'
          + '<div class="w-full max-w-sm text-center space-y-3 text-sm text-gray-700">'
          + '<h1 class="text-2xl font-semibold text-gray-900">Readfine</h1>'
          + '<p class="font-medium">Logged out on this device.</p>'
          + '<p>' + (incomplete ? 'Some offline data could not be removed yet; it will be removed the next time Readfine opens here.'
            : 'Offline data was removed from this device.')
          + ' You will be signed out on the server when you are back online.</p>'
          + '<p><a href="/login" class="text-blue-600 underline">Sign in</a></p></div></div>';
      }
      unhide();
    }

    // Stops everything this tab does with offline data: no new sync, download or
    // switch-on from here; running ones abort at their next step (the handle closes).
    function stopAll() {
      st.leaving = true;
      goOff();
      st.netDown = false;
      st.error = null;
      st.mediaNext = null;
      if (st.db) { st.db.close(); st.db = null; }
      render();
    }

    // This tab's reader is no longer the session's (another sign-in in this browser, or
    // the account was deleted): wipe, then go to `url`.
    async function accountGone(url) {
      stopAll();
      await wipeOrMark();
      await D.setCurrentUser(null).catch(noop);
      navigate(url);
    }

    // After the reader committed. -> 'done' | 'offline' (unless abandoned).
    async function finishLogout(run) {
      stopAll();
      var running = [st.running, st.media].concat(Array.from(st.autos)).filter(Boolean);
      await bounded(Promise.all(running.map(function (p) { return p.catch(noop); })), LOGOUT_WAIT_MS);
      // The store says off first (as in disable): if the wipe leaves it, a flagged
      // worker reading it steps aside.
      await bounded(D.setCurrentUser(userId, { offlineEnabled: false, forceOffline: false }), STORE_WAIT_MS);
      await bounded(Promise.resolve().then(function () { return W.register({ offline: false }); }), REGISTER_WAIT_MS);
      var incomplete = false;
      try { await wipe(); } catch (e) { incomplete = true; }
      await D.setCurrentUser(null).catch(noop);
      st.lastSync = null;
      st.storageFull = false;
      st.counts = { articles: 0, images: 0, pending: 0, stuck: [] };
      if (run.abandoned) return 'abandoned';
      if (!incomplete) mark(WIPE_KEY, false);
      var reached = await postLogout();
      if (run.abandoned) return 'abandoned';
      if (reached) {
        mark(PENDING_KEY, false);
        navigate('/login' + (incomplete ? '?offline_wipe=incomplete' : ''));
        return 'done';
      }
      showLoggedOut(incomplete);
      return 'offline';
    }

    function logout(form) {
      if (st.loggingOut) return st.loggingOut;
      st.loggingOut = (async function () {
        if (!(await hasDeviceData())) {
          // Never used offline here: the plain logout, nothing created or registered.
          nativeLogout();
          return 'native';
        }
        var note = '';
        for (;;) {
          var c = await unsynced();
          if (!c.unknown && !c.pending && !c.stuck) break;
          var canSync = (c.pending > 0 || c.unknown) && st.enabled && !offline() && st.error !== 'auth';
          var choice = await logoutDialog(c, canSync, note);
          if (choice === 'cancel') return 'cancelled';
          if (choice === 'discard') break;
          await syncNow(true).catch(noop);
          note = 'Sync did not send everything.';
        }
        // Committed: from here a crash or a closed app is finished by the next start.
        mark(WIPE_KEY, true);
        mark(PENDING_KEY, true);
        showBusy();
        var run = { abandoned: false };
        var r = await bounded(finishLogout(run), opts.logoutWatchdogMs || LOGOUT_WATCHDOG_MS, 'timeout');
        if (r === 'timeout') {
          // Stuck somewhere (a hung database or worker): leave it to the next start,
          // which the markers drive, and end the session the plain way.
          run.abandoned = true;
          nativeLogout();
          return 'watchdog';
        }
        return r;
      })().then(function (r) {
        if (r === 'cancelled' || r === 'native') st.loggingOut = null;
        return r;
      }, function (err) {
        st.loggingOut = null;
        throw err;
      });
      return st.loggingOut;
    }

    function onSubmit(e) {
      var form = e.target && e.target.closest && e.target.closest('form[data-rf-logout]');
      if (!form) return;
      // The decision needs the store (async): hold the submit; with nothing to wipe a
      // plain POST /logout goes out after all.
      e.preventDefault();
      logout(form).catch(function (err) {
        if (root.console) root.console.warn('offline logout failed:', err);
      });
    }

    // Deleting the account (Settings → Profile, a boosted form) ends with a redirect to
    // /login?deleted=1: wipe before showing it. (login.html also wipes when this did
    // not run, and the response carries Clear-Site-Data.)
    function onBeforeSwap(e) {
      var xhr = e.detail && e.detail.xhr;
      var url;
      try { url = new URL((xhr && xhr.responseURL) || '', here()); } catch (err) { return; }
      if (!xhr || !xhr.responseURL || url.pathname !== '/login' || !url.searchParams.get('deleted')) return;
      e.detail.shouldSwap = false;
      if (st.leaving) return;
      accountGone('/login?deleted=1');
    }

    // ---- render ------------------------------------------------------------------------

    function statusLine() {
      var c = st.counts;
      if (st.running) {
        var p = st.progress;
        var what = p && p.stage === 'articles' ? 'Syncing articles… ' : p && p.stage === 'snapshots' ? 'Syncing pages… ' : null;
        return { text: what && p.total ? what + p.done + '/' + p.total : 'Syncing…' };
      }
      if (offline()) return { text: 'Offline · ' + plural(c.pending, 'action', 'actions') + ' waiting' };
      if (st.error === 'auth') return { html: '<a href="/login" class="underline">Session expired – log in to sync</a>' };
      if (st.missing) return { text: 'Offline data is not on this device. Sync now to store it again.' };
      if (st.error === 'csrf') return { text: 'Sync stopped – reload the page' };
      if (st.error) return { text: 'Sync failed – will try again' };
      if (!st.lastSync) return { text: 'Not synced yet' };
      return {
        text: 'Ready for offline · ' + plural(c.articles, 'article', 'articles') + ' · '
          + plural(c.images, 'image', 'images') + ' · ' + c.pending + ' pending',
      };
    }

    // "Last synced 14:05" (today) or "Last synced 12 Nov, 14:05": visible, since a
    // phone has no hover for a title.
    function lastSyncedText() {
      if (!st.lastSync) return '';
      var d = new Date(st.lastSync);
      if (isNaN(d.getTime())) return '';
      var hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      var today = new Date().toDateString() === d.toDateString();
      return 'Last synced ' + (today ? hm : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ', ' + hm);
    }

    function mediaText() {
      var m = st.mediaProgress;
      return m ? 'Images ' + m.done + '/' + m.total : '';
    }

    function stuckHtml() {
      var k = st.counts.stuck.length;
      if (!k) return '';
      var out = '<button type="button" data-rf-offline-action="stuck" class="block mt-1 text-amber-700 underline bg-transparent border-0 p-0 cursor-pointer dark:text-amber-400">'
        + plural(k, 'action needs', 'actions need') + ' attention</button>';
      if (!st.stuckOpen) return out;
      out += '<ul data-rf-offline-stuck class="mt-1 space-y-1">';
      st.counts.stuck.forEach(function (op) {
        var what = op.type + (op.article_id ? ' · article ' + op.article_id : '')
          + ' · ' + (op.poison ? 'refused' : 'failed ' + (op.attempts || 0) + '×')
          + (op.last_error ? ' (' + op.last_error + ')' : '');
        out += '<li class="flex items-center gap-2"><span class="flex-1 truncate" title="' + esc(what) + '">' + esc(what) + '</span>'
          + '<button type="button" data-rf-offline-action="retry" data-rf-op="' + esc(op.op_id) + '" class="text-blue-600 bg-transparent border-0 p-0 cursor-pointer">Retry</button>'
          + '<button type="button" data-rf-offline-action="discard" data-rf-op="' + esc(op.op_id) + '" class="text-red-600 bg-transparent border-0 p-0 cursor-pointer">Discard</button></li>';
      });
      return out + '</ul>';
    }

    // keyOnly: the progress texts left out, which renderProgress updates in place; two
    // equal keys mean the block need not be rebuilt.
    function statusHtml(keyOnly) {
      var line = statusLine();
      var lineText = keyOnly && st.running ? '' : (line.html || esc(line.text));
      var html = '<p data-rf-offline-line>' + lineText + '</p>';
      if (st.storeUnreadable) html += '<p data-rf-offline-warn class="text-amber-700 dark:text-amber-400">Offline settings could not be read on this device – reload the page if this stays</p>';
      if (st.media) html += '<p data-rf-offline-media>' + (keyOnly ? '' : esc(mediaText())) + '</p>';
      var last = st.running ? '' : lastSyncedText();
      if (last) html += '<p data-rf-offline-last class="text-gray-400">' + esc(last) + '</p>';
      if (st.storageFull && !st.media) html += '<p data-rf-offline-full class="text-amber-700 dark:text-amber-400">Storage full: images partly saved</p>';
      html += stuckHtml();
      html += '<div class="flex gap-3 mt-1">'
        + '<button type="button" data-rf-offline-action="sync" class="text-blue-600 bg-transparent border-0 p-0 cursor-pointer disabled:opacity-60"' + (st.running ? ' disabled' : '') + '>Sync now</button>'
        + '<button type="button" data-rf-offline-action="work-offline" aria-pressed="' + (st.force ? 'true' : 'false') + '" class="text-blue-600 bg-transparent border-0 p-0 cursor-pointer">'
        + (st.force ? 'Back online' : 'Work offline') + '</button></div>';
      return html;
    }

    // A progress tick changes the first line only: rebuilding the block per image would
    // swap its buttons out from under the pointer during a long download.
    function renderProgress() {
      var q = '[data-rf-slot="offline-status"] ';
      var lines = doc.querySelectorAll(q + '[data-rf-offline-line]');
      var media = doc.querySelectorAll(q + '[data-rf-offline-media]');
      if (!lines.length || (st.media && !media.length)) return;
      var text = statusLine().text;
      var mtext = mediaText();
      lines.forEach(function (el) { if (text !== undefined && el.textContent !== text) el.textContent = text; });
      media.forEach(function (el) { if (el.textContent !== mtext) el.textContent = mtext; });
    }

    function bannerHost() {
      var host = doc.querySelector('[data-rf-slot="offline-banner"]');
      if (!host && doc.body && st.enabled && offline()) {
        host = doc.createElement('div');
        host.setAttribute('data-rf-slot', 'offline-banner');
        host.className = 'fixed top-0 inset-x-0 z-50 flex justify-center pointer-events-none';
        doc.body.appendChild(host);
      }
      return host;
    }

    function render() {
      if (!doc || !doc.querySelectorAll) return;
      var off = st.enabled && offline();
      var key = st.enabled ? statusHtml(true) : '';
      var status = null;
      var kept = false;
      doc.querySelectorAll('[data-rf-slot="offline-status"]').forEach(function (el) {
        // Compared with the key of what was written last (innerHTML reads back
        // serialised differently, e.g. disabled=""), so an unchanged block is never rebuilt.
        el.hidden = !st.enabled;
        if (el.__rfKey !== key) {
          if (status === null) status = st.enabled ? statusHtml(false) : '';
          el.innerHTML = status;
          el.__rfKey = key;
        } else kept = true;
      });
      if (kept && st.enabled) renderProgress();
      var host = bannerHost();
      if (host) {
        var banner = off && T ? T.offlineBanner({ pending: st.counts.pending }) : '';
        if (host.__rfLast !== banner) { host.innerHTML = banner; host.__rfLast = banner; }
      }
      if (O) {
        if (off) O.disableOnlineOnly(doc.documentElement || doc);
        else O.restoreOnlineOnly(doc.documentElement || doc);
      }
      renderSettings();
    }

    // ---- settings section (Settings → Preferences, "This device") -----------------------

    var settingsRoot = null;

    function renderSettings() {
      var el = settingsRoot;
      if (!el || !el.isConnected) return;
      var box = el.querySelector('[data-rf-offline-toggle]');
      var remove = el.querySelector('[data-rf-offline-remove]');
      if (box) box.checked = st.enabled;
      if (remove) remove.hidden = st.enabled || !st.deviceData;
    }

    // Whether this device holds any offline data (any reader's): what "Remove" offers to
    // delete. Without indexedDB.databases() (older Safari) it is assumed so.
    async function checkDeviceData() {
      var f = win.indexedDB || root.indexedDB;
      if (!f || typeof f.databases !== 'function') { st.deviceData = true; return; }
      try {
        var dbs = await f.databases();
        st.deviceData = dbs.some(function (d) { return d && String(d.name || '').indexOf(D.DB_PREFIX) === 0; });
      } catch (e) { st.deviceData = true; }
    }

    function note(text) {
      var n = settingsRoot && settingsRoot.querySelector('[data-rf-offline-note]');
      if (n) n.textContent = text || '';
    }

    function showStorage() {
      var out = settingsRoot && settingsRoot.querySelector('[data-rf-offline-storage]');
      if (!out || !nav.storage || !nav.storage.estimate) return Promise.resolve();
      return Promise.resolve(nav.storage.estimate()).then(function (e) {
        out.textContent = 'Storage on this device: ' + bytes(e.usage) + ' used of ' + bytes(e.quota) + ' available.';
      }, noop);
    }

    function bindSettings(container) {
      var el = (container || doc).querySelector('[data-rf-offline-settings]');
      if (!el) return null;
      settingsRoot = el;
      var box = el.querySelector('[data-rf-offline-toggle]');
      var remove = el.querySelector('[data-rf-offline-remove]');
      if (!supported()) {
        if (box) box.disabled = true;
        note('Not available in this browser.');
        return ctl.ready;
      }
      if (box) {
        box.addEventListener('change', function () {
          box.disabled = true;
          var p = box.checked
            ? enable().then(function (r) {
              note(r.persisted === false
                ? 'On. The browser may still clear stored articles when it runs short of space.'
                : 'On. Articles are being stored on this device.');
            })
            : disable().then(function () { note('Off. Articles already stored stay until you remove them.'); });
          p.catch(function () { note('That did not work. Reload the page and try again.'); })
            .then(checkDeviceData)
            .then(function () { box.disabled = false; render(); return showStorage(); });
        });
      }
      if (remove) {
        remove.addEventListener('click', function () {
          if (!ask('Remove all offline data from this device? Actions not synced yet are lost.')) return;
          remove.disabled = true;
          removeData().then(function () { note('Offline data removed from this device.'); },
            function () { note('Some offline data could not be removed. Close other Readfine tabs and try again.'); })
            .then(checkDeviceData)
            .then(function () { remove.disabled = false; render(); return showStorage(); });
        });
      }
      return ctl.ready.then(checkDeviceData).then(function () { render(); return showStorage(); });
    }

    // ---- events ------------------------------------------------------------------------

    function ask(question) {
      var fn = opts.confirm || (win.confirm ? win.confirm.bind(win) : function () { return true; });
      return fn(question);
    }

    function onClick(e) {
      var t = e.target && e.target.closest && e.target.closest('[data-rf-offline-action]');
      if (!t) return;
      e.preventDefault();
      var action = t.getAttribute('data-rf-offline-action');
      var opId = t.getAttribute('data-rf-op');
      if (action === 'sync') syncNow(true);
      else if (action === 'work-offline') setForceOffline(!st.force);
      else if (action === 'stuck') { st.stuckOpen = !st.stuckOpen; render(); }
      else if ((action === 'retry' || action === 'discard') && dbAlive()) {
        if (action === 'discard' && !ask('Discard this action? It will not be sent to the server.')) return;
        (action === 'retry' ? D.retryStuck(st.db, opId) : D.discardStuck(st.db, opId))
          .then(refreshCounts).then(function () {
            render();
            if (action === 'retry') autoSync();
          });
      }
    }

    function onAfterRequest(e) {
      if (!st.enabled) return;
      var xhr = e.detail && e.detail.xhr;
      if (!xhr || !xhr.getResponseHeader) return;
      if (xhr.getResponseHeader('X-Readfine-Offline') === '1') {
        // The worker answered: offline, and an action may just have been queued.
        st.netDown = true;
        refreshCounts().then(render);
      } else if (xhr.status > 0 && st.netDown) {
        st.netDown = false;
        render();
        autoSync();
      }
    }

    function startTimer() {
      if (st.timer) return;
      st.timer = win.setInterval(function () {
        if (doc.visibilityState === 'hidden') return;
        autoSync();
      }, intervalMs);
    }

    function stopTimer() {
      if (st.timer) win.clearInterval(st.timer);
      st.timer = null;
    }

    function listen() {
      doc.addEventListener('click', onClick);
      // Capture: the logout form sits in swapped sidebar HTML.
      doc.addEventListener('submit', onSubmit, true);
      // autoSync reconciles with the store first.
      doc.addEventListener('visibilitychange', function () {
        if (doc.visibilityState === 'visible') autoSync();
      });
      // setCurrentUser / wipeAll in any tab post here (db.js): take the store's word.
      var Channel = opts.channel !== undefined ? null : (win.BroadcastChannel || root.BroadcastChannel);
      var channel = opts.channel !== undefined ? opts.channel : (Channel ? new Channel(D.CHANNEL) : null);
      if (channel) {
        channel.addEventListener('message', function (e) {
          if (e && e.data && e.data.type === 'rf-current-user') reconcile();
        });
        ctl.channel = channel;
      }
      doc.addEventListener('htmx:afterRequest', onAfterRequest);
      doc.addEventListener('htmx:beforeSwap', onBeforeSwap);
      // A swapped-in sidebar brings an empty status slot; new controls may need a connection.
      doc.addEventListener('htmx:afterSettle', render);
      win.addEventListener('online', function () {
        st.netDown = false;
        render();
        autoSync();
      });
      win.addEventListener('offline', render);
    }

    // ---- start -------------------------------------------------------------------------

    // Offline databases other than this reader's and the current-user store.
    async function foreignData() {
      var f = win.indexedDB || root.indexedDB;
      if (!f || typeof f.databases !== 'function') return false;
      try {
        var mineName = D.dbName(userId);
        var dbs = await f.databases();
        return dbs.some(function (d) {
          var n = String((d && d.name) || '');
          return n.indexOf(D.DB_PREFIX) === 0 && n !== mineName && n !== D.CURRENT_DB;
        });
      } catch (e) { return false; }
    }

    async function start() {
      // 1. A wipe a logout or a switch left unfinished.
      if (marked(WIPE_KEY)) await wipeOrMark();
      // 2. A logout this server never heard of (offline, or the app closed mid-logout):
      // end the session before anything; failing that, the reader stays logged out
      // here: the app is never shown (logout-guard.js hid it until now).
      if (marked(PENDING_KEY)) {
        var el = doc.documentElement;
        if (el && el.classList) el.classList.add(HIDE_CLASS);
        st.leaving = true;
        if (nav.onLine !== false && await postLogout()) {
          mark(PENDING_KEY, false);
          navigate('/login');
          return;
        }
        showLoggedOut(marked(WIPE_KEY));
        return;
      }
      unhide();
      var cur = null;
      try { cur = await D.getCurrentUser(); } catch (e) { cur = null; }
      // 3. Another reader's data (their session ended without a logout here): wiped
      // before anything is shown or synced. This reader starts off; nothing is written
      // unless the old record survived the wipe.
      if (cur ? cur.userId !== userId : await foreignData()) {
        await wipeOrMark(cur ? [cur.userId] : []);
        cur = await D.getCurrentUser().catch(function () { return null; });
        if (cur) {
          await D.setCurrentUser(userId, { offlineEnabled: false, forceOffline: false }).catch(noop);
          cur = { userId: userId, offlineEnabled: false, forceOffline: false };
        }
      }
      // A stale record of this same reader (signed in again after the session ended) is
      // theirs again: restored by the write below.
      var mine = !!cur && cur.userId === userId;
      st.enabled = mine && cur.offlineEnabled;
      st.force = st.enabled && cur.forceOffline;
      if (st.enabled) {
        // Tells a controlling worker to re-read (it may have been started before).
        await D.setCurrentUser(userId, { offlineEnabled: true, forceOffline: st.force });
      } else if (cur && (!mine || cur.offlineEnabled || cur.forceOffline || cur.stale)) {
        // A stale record (another reader's that survived the wipe above, or stale
        // flags): this reader starts with offline mode off.
        await D.setCurrentUser(userId, { offlineEnabled: false, forceOffline: false });
      }
      // else: nobody switched it on here; nothing is written.
      try { await W.ensure(st.enabled); } catch (e) { /* no worker: offline answers unavailable */ }
      if (st.enabled) {
        await openDb(false);
        await refreshCounts();
        startTimer();
      }
      render();
      autoSync();
    }

    ctl.enable = enable;
    ctl.disable = disable;
    ctl.removeData = removeData;
    ctl.setForceOffline = setForceOffline;
    ctl.syncNow = function () { return syncNow(true); };
    ctl.autoSync = autoSync;
    ctl.render = render;
    ctl.refreshCounts = refreshCounts;
    ctl.bindSettings = bindSettings;
    ctl.isOffline = function () { return st.enabled && offline(); };
    // Resolves once nothing is running (for tests and callers that want to wait).
    ctl.idle = function () {
      var waits = Array.from(st.autos);
      if (st.running) waits.push(st.running);
      if (st.media) waits.push(st.media);
      return waits.length ? Promise.all(waits.map(function (w) { return w.catch(noop); })).then(ctl.idle) : Promise.resolve(null);
    };
    ctl.reconcile = reconcile;
    ctl.logout = logout;
    ctl.stop = function () {
      stopTimer();
      if (ctl.channel && ctl.channel.close) ctl.channel.close();
    };

    listen();
    ctl.ready = start().catch(function (err) {
      if (root.console) root.console.warn('offline mode failed to start:', err);
    });
    return ctl;
  }

  // One controller per document and reader.
  function init(opts) {
    var doc = opts.doc || root.document;
    var have = doc && doc.__rfOfflinePage;
    if (have && have.userId === opts.userId) return have.ctl;
    var ctl = create(opts);
    if (doc) doc.__rfOfflinePage = { userId: opts.userId, ctl: ctl };
    return ctl;
  }

  function current(doc) {
    doc = doc || root.document;
    return (doc && doc.__rfOfflinePage && doc.__rfOfflinePage.ctl) || null;
  }

  // Settings → Preferences calls this each time it runs (boosted saves rerun it).
  function bindSettings(container) {
    var ctl = current();
    if (ctl) return ctl.bindSettings(container);
    var el = (container || root.document).querySelector('[data-rf-offline-settings]');
    if (el) el.hidden = true;
    return null;
  }

  function autoInit() {
    var doc = root.document;
    var body = doc && doc.body;
    if (!body) return null;
    var id = parseInt(body.getAttribute('data-rf-user') || '', 10);
    if (!(id > 0) || !RF.db || !RF.sync || !RF.sw) return null;
    return init({ userId: id, displayName: body.getAttribute('data-rf-name') || '' });
  }

  // RFOffline.page.logout(form): the logout of the current page's controller; without
  // one (no signed-in reader), the form is submitted as it is.
  function logout(form) {
    var ctl = current(form && form.ownerDocument);
    if (ctl) return ctl.logout(form);
    if (form && form.submit) form.submit();
    return Promise.resolve('native');
  }

  RF.page = {
    init: init, create: create, current: current, bindSettings: bindSettings, autoInit: autoInit,
    logout: logout, PENDING_KEY: PENDING_KEY, WIPE_KEY: WIPE_KEY,
  };

  // Deferred, so the body is there: start now, before DOMContentLoaded listeners (the
  // settings page binds to the controller from one of those).
  if (root.document && typeof root.document.addEventListener === 'function') {
    if (root.document.body) autoInit();
    else root.document.addEventListener('DOMContentLoaded', autoInit);
  }
})(self);

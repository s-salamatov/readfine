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
(function (root) {
  'use strict';
  var RF = root.RFOffline = root.RFOffline || {};

  var SYNC_EVERY_MS = 5 * 60 * 1000;

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
  // templates, overlay, fetchFn, caches, intervalMs, confirm.
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
      error: null,
      netDown: false,
      storageFull: false,
      lastSync: null,
      counts: { articles: 0, images: 0, pending: 0, stuck: [] },
      stuckOpen: false,
      timer: null,
      deviceData: false,
    };
    var ctl = { state: st };

    function supported() {
      return !!(win.indexedDB || root.indexedDB) && !!(nav && nav.serviceWorker);
    }

    function offline() {
      return st.force || nav.onLine === false || st.netDown;
    }

    function dbAlive() { return !!st.db && D.alive(st.db); }

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
        if (cur && cur.userId === userId && cur.offlineEnabled) db = await D.open(userId);
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

    // ---- sync --------------------------------------------------------------------------

    function syncNow(explicit) {
      if (!st.enabled) return Promise.resolve(null);
      if (st.running) return st.running;
      st.progress = null;
      st.running = (async function () {
        var db = await openDb(!!explicit);
        if (!db) { render(); return null; }
        render();
        var rep;
        try {
          rep = await S.run(db, {
            fetchFn: opts.fetchFn,
            caches: opts.caches || win.caches || root.caches,
            csrfToken: function () { return cookie(doc, 'csrftoken'); },
            keepIds: openArticleIds(),
            downloadMedia: true,
            onProgress: function (p) { st.progress = p; renderProgress(); },
          });
        } catch (err) {
          rep = { error: dbAlive() ? 'failed' : 'wiped' };
        }
        await settle(rep || { error: 'failed' });
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

    async function settle(rep) {
      var err = rep.error || null;
      if (err === 'wiped') {
        st.db = null;
        var cur = await D.getCurrentUser().catch(function () { return null; });
        if (!cur || cur.userId !== userId || !cur.offlineEnabled) {
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
          var stop = rep.media && rep.media.stoppedReason;
          st.storageFull = stop === 'quota' || stop === 'budget';
        }
      }
      await refreshCounts();
    }

    function autoSync() {
      if (!st.enabled || st.missing || st.force || nav.onLine === false) return null;
      return syncNow(false);
    }

    // ---- switch ------------------------------------------------------------------------

    async function enable() {
      var persisted = null;
      try {
        if (nav.storage && nav.storage.persist) persisted = await nav.storage.persist();
      } catch (e) { persisted = false; }
      st.enabled = true;
      st.force = false;
      st.netDown = false;
      await D.setCurrentUser(userId, { offlineEnabled: true, forceOffline: false });
      if (!dbAlive()) st.db = await D.open(userId);
      st.missing = false;
      await writeName();
      await W.register({ offline: true });
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
      await W.register({ offline: false });
      await D.setCurrentUser(userId, { offlineEnabled: false, forceOffline: false });
      // A running sync stops at its next step (its handle is closed) and keeps what it has.
      if (st.db) { st.db.close(); st.db = null; }
      stopTimer();
      render();
    }

    // Deletes every offline database and cache on this device (all readers'), and the
    // current-user record. Only while switched off.
    async function removeData() {
      if (st.enabled) throw new Error('switch offline mode off first');
      if (st.db) { st.db.close(); st.db = null; }
      await D.wipeAll();
      await D.setCurrentUser(null);
      st.lastSync = null;
      st.storageFull = false;
      await refreshCounts();
      render();
    }

    async function setForceOffline(on) {
      if (!st.enabled) return;
      st.force = !!on;
      await D.setCurrentUser(userId, { offlineEnabled: true, forceOffline: st.force });
      render();
      if (!st.force) autoSync();
    }

    // ---- render ------------------------------------------------------------------------

    function statusLine() {
      var c = st.counts;
      if (st.running) {
        var p = st.progress;
        return { text: p && p.total ? 'Syncing… ' + p.done + '/' + p.total : 'Syncing…' };
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
        title: 'Last synced ' + new Date(st.lastSync).toLocaleString(),
      };
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

    function statusHtml() {
      var line = statusLine();
      var html = '<p data-rf-offline-line' + (line.title ? ' title="' + esc(line.title) + '"' : '') + '>'
        + (line.html || esc(line.text)) + '</p>';
      if (st.storageFull && !st.running) html += '<p data-rf-offline-full class="text-amber-700 dark:text-amber-400">Storage full: images partly saved</p>';
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
      var lines = doc.querySelectorAll('[data-rf-slot="offline-status"] [data-rf-offline-line]');
      if (!lines.length) { render(); return; }
      var text = statusLine().text;
      lines.forEach(function (el) { if (el.textContent !== text) el.textContent = text; });
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
      var status = st.enabled ? statusHtml() : '';
      doc.querySelectorAll('[data-rf-slot="offline-status"]').forEach(function (el) {
        if (!st.enabled) {
          el.hidden = true;
          if (el.innerHTML) el.innerHTML = '';
          return;
        }
        el.hidden = false;
        if (el.innerHTML !== status) el.innerHTML = status;
      });
      var host = bannerHost();
      if (host) {
        var banner = off && T ? T.offlineBanner({ pending: st.counts.pending }) : '';
        if (host.innerHTML !== banner) host.innerHTML = banner;
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
          var ask = opts.confirm || (win.confirm ? win.confirm.bind(win) : function () { return true; });
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
      doc.addEventListener('visibilitychange', function () {
        if (doc.visibilityState === 'visible') autoSync();
      });
      doc.addEventListener('htmx:afterRequest', onAfterRequest);
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

    async function start() {
      var cur = null;
      try { cur = await D.getCurrentUser(); } catch (e) { cur = null; }
      var mine = !!cur && cur.userId === userId;
      st.enabled = mine && cur.offlineEnabled;
      st.force = st.enabled && cur.forceOffline;
      if (st.enabled) {
        // Tells a controlling worker to re-read (it may have been started before).
        await D.setCurrentUser(userId, { offlineEnabled: true, forceOffline: st.force });
      } else if (cur && (!mine || cur.offlineEnabled || cur.forceOffline)) {
        // Another reader's record (their session ended without a logout here): this
        // reader starts with offline mode off. Their stored data is Task 12's to clear.
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
      return (st.running || Promise.resolve()).then(function () { return st.running ? ctl.idle() : null; });
    };
    ctl.stop = stopTimer;

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

  RF.page = { init: init, create: create, current: current, bindSettings: bindSettings, autoInit: autoInit };

  // Deferred, so the body is there: start now, before DOMContentLoaded listeners (the
  // settings page binds to the controller from one of those).
  if (root.document && typeof root.document.addEventListener === 'function') {
    if (root.document.body) autoInit();
    else root.document.addEventListener('DOMContentLoaded', autoInit);
  }
})(self);

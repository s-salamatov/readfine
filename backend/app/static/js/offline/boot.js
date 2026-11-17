// Offline mode bootstrap: the only part of offline mode every page loads. Parser-
// blocking (small), after sw-register.js and before app.js in base.html.
//
// 1. The full offline scripts (db, media, MiniSearch, search, sync, templates, overlay,
//    page; ~285 KB) load only for a reader who uses offline mode on this device. The
//    decision has to be synchronous for an opted-in reader, so that the overlay's htmx
//    hook and page.js run before app.js's first request, as deferred scripts do: a
//    localStorage hint (rf-offline-user, written by db.js setCurrentUser next to the
//    current-user record) or a pending logout / wipe marker makes this script write
//    the full set into the document as deferred scripts. The URLs come from
//    data-rf-scripts (with their static_url versions; sync.js also reads them for the
//    offline shell cache).
//    Without the hint, the page stays light and, once parsed, checks the device
//    (inspect): offline mode on for this reader after all, or another reader's data,
//    loads the full set and page.js takes over (the other reader's data is wiped
//    first). Otherwise the plain worker is made sure of (RFOffline.sw.ensure(false)),
//    as page.js would. A light page loads the full set on demand: a logout when the
//    device holds offline data (this reader's, kept while switched off: page.js wipes
//    it first), and the Preferences switch.
// 2. Sign-in on a browser whose worker is flagged for offline mode: the worker still
//    knows the previous reader, whose session may have ended without a logout here. If
//    the new reader's first page is slow, the worker would time out into the previous
//    reader's stored app. So on submit of any sign-in form (form[data-rf-login]) this
//    tells the controlling worker to forget its reader at once ('rf-forget-user', see
//    offline/policy.js) and marks the current-user record stale (db.js
//    forgetCurrentUser, never creating the database), then submits the form. The next
//    start of page.js restores the record for the same reader or wipes the old one's
//    data for another. Bounded: the sign-in goes out after FORGET_WAIT_MS regardless.
// 3. The delete-account form sets a sessionStorage marker that lets /login?deleted=1
//    wipe the device (deleted-wipe.js).
(function (root) {
  'use strict';
  var RF = root.RFOffline = root.RFOffline || {};
  var doc = root.document;
  var me = doc && doc.currentScript;

  var FLAG = /[?&]offline=1(?:&|$)/;
  var DB_PREFIX = 'readfine-offline-';
  var HINT_KEY = 'rf-offline-user';
  var MARKERS = ['rf-logout-pending', 'rf-wipe-pending'];
  var FORGET_WAIT_MS = 1500;
  var PROBE_WAIT_MS = 3000;

  function attr(name, fallback) {
    return (me && me.getAttribute(name)) || fallback;
  }

  var userId = attr('data-rf-user', '');
  var scripts = attr('data-rf-scripts', '').split(/\s+/).filter(Boolean);

  function storage() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }

  function stored(key) {
    var s = storage();
    try { return s ? s.getItem(key) : null; } catch (e) { return null; }
  }

  var loads = {};

  // Loads a same-origin script once, in insertion order. -> Promise
  function load(src) {
    if (!loads[src]) {
      loads[src] = new Promise(function (resolve, reject) {
        var s = doc.createElement('script');
        s.src = src;
        s.async = false;
        s.onload = function () { resolve(); };
        s.onerror = function () { delete loads[src]; reject(new Error('could not load ' + src)); };
        (doc.head || doc.documentElement).appendChild(s);
      });
    }
    return loads[src];
  }

  // -> Promise<RFOffline.db>
  function loadDb() {
    if (RF.db) return Promise.resolve(RF.db);
    var src = scripts.filter(function (u) { return /\/offline\/db\.js(\?|$)/.test(u); })[0]
      || attr('data-rf-db', '/static/js/offline/db.js');
    return load(src).then(function () { return RF.db; });
  }

  var full = null;

  // The full set (page.js last), loaded once. -> Promise<RFOffline.page controller | null>
  function loadFull() {
    if (!full) {
      full = (RF.page ? Promise.resolve() : Promise.all(scripts.map(load))).then(function () {
        var ctl = RF.page && (RF.page.current() || RF.page.autoInit());
        return ctl ? ctl.ready.then(function () { return ctl; }) : null;
      });
      full.catch(function () { full = null; });
    }
    return full;
  }

  function bounded(p, ms, fallback) {
    return new Promise(function (resolve) {
      var t = setTimeout(function () { resolve(fallback); }, ms);
      Promise.resolve(p).then(function (v) { clearTimeout(t); resolve(v); },
        function () { clearTimeout(t); resolve(fallback); });
    });
  }

  // ---- 1. which scripts ------------------------------------------------------------

  // Synchronous: this reader has offline mode on here (the hint), or a logout or wipe
  // is owed. Then the full set goes into the document now, deferred like app.js.
  function wantFullNow() {
    if (!userId || !scripts.length) return false;
    if (MARKERS.some(function (k) { return stored(k) === '1'; })) return true;
    return stored(HINT_KEY) === userId;
  }

  // What this device holds, for this reader. -> Promise<'none' | 'kept' | 'full'>
  //   none: no offline data at all;
  //   kept: only this reader's, with offline mode off (switched off, data kept): the
  //         page stays light, a logout loads the full set to wipe it;
  //   full: offline mode on for this reader (the hint was missing), or another
  //         reader's data or record (page.js wipes it before anything else), or it
  //         could not be told in time.
  // Reads the current-user record (db.js, ~27 KB) only when some offline database
  // exists, or where indexedDB.databases() is missing.
  function inspect() {
    var f = root.indexedDB;
    if (!f) return Promise.resolve('none');
    var me = Number(userId);
    var names = typeof f.databases === 'function'
      ? f.databases().then(function (dbs) { return dbs.map(function (d) { return String((d && d.name) || ''); }); })
      : Promise.resolve(null);
    var p = names.then(function (list) {
      var ours = list && list.filter(function (n) { return n.indexOf(DB_PREFIX) === 0; });
      if (ours && !ours.length) return 'none';
      return loadDb().then(function (D) {
        return D.getCurrentUser().then(function (cur) {
          if (cur && cur.userId !== me && !cur.stale) {
            // Another reader's record, not yet marked (the sign-in skipped the forget:
            // no controller then, or no sign-in form): the worker must stop answering
            // for them now, not only once the full set has loaded and page.js wiped.
            return bounded(forgetUser(), FORGET_WAIT_MS).then(function () { return 'full'; });
          }
          if (cur && (cur.userId !== me || cur.offlineEnabled)) return 'full';
          var foreign = ours && ours.some(function (n) { return n !== D.dbName(me) && n !== D.CURRENT_DB; });
          if (foreign) return 'full';
          if (cur || (ours && ours.length)) return 'kept';
          return 'none';
        });
      });
    });
    return bounded(p, PROBE_WAIT_MS, 'full');
  }

  var light = false;

  function startLight() {
    light = true;
    check();
    // Another tab switched offline mode on (db.js broadcasts every record change):
    // this tab takes the full set too, as page.js would reconcile.
    try {
      if (typeof root.BroadcastChannel === 'function') {
        channel = new root.BroadcastChannel('readfine-offline');
        channel.addEventListener('message', function (e) {
          if (e && e.data && e.data.type === 'rf-current-user') check();
        });
      }
    } catch (e) { /* no channel: the next page load decides */ }
  }

  var channel = null;

  function check() {
    if (RF.page && RF.page.current()) return Promise.resolve();
    return inspect().then(function (what) {
      if (what === 'full') {
        return loadFull().then(function () {
          // page.js listens from here on.
          if (channel) { channel.close(); channel = null; }
          return bindLoadedSettings();
        });
      }
      var W = RF.sw;
      if (W) return W.ensure(false);
      return null;
    }).catch(function (err) {
      if (root.console) root.console.warn('offline bootstrap failed:', err);
    });
  }

  // A light page: the logout waits for the probe; with offline data on the device the
  // full set wipes it first (page.js logout), else the plain POST /logout goes out.
  function onLogoutSubmit(e) {
    var form = e.target && e.target.closest && e.target.closest('form[data-rf-logout]');
    if (!form || !light || (RF.page && RF.page.current())) return;
    e.preventDefault();
    inspect().then(function (what) {
      if (what === 'none') return nativeLogout(form);
      return loadFull().then(function (ctl) {
        if (ctl) return RF.page.logout(form);
        return nativeLogout(form);
      });
    }).catch(function () { nativeLogout(form); });
  }

  // form.submit() fires no submit event; a fresh form when the original is gone (a
  // swapped sidebar).
  function nativeLogout(form) {
    var f = form;
    if (!f || !f.isConnected) {
      f = doc.createElement('form');
      f.method = 'POST';
      f.action = '/logout';
      f.hidden = true;
      (doc.body || doc.documentElement).appendChild(f);
    }
    f.submit();
  }

  // Settings → Preferences (preferences.js calls this each time it runs). With the full
  // set loaded it is page.js's; on a light page the switch loads it when turned on,
  // then hands the change over.
  function bindSettings(container) {
    container = container || doc;
    if (RF.page) return RF.page.bindSettings(container);
    var el = container.querySelector('[data-rf-offline-settings]');
    if (!el) return null;
    var box = el.querySelector('[data-rf-offline-toggle]');
    var note = el.querySelector('[data-rf-offline-note]');
    if (!scripts.length || !box) { el.hidden = true; return null; }
    if (!root.indexedDB || !(root.navigator && root.navigator.serviceWorker)) {
      box.disabled = true;
      if (note) note.textContent = 'Not available in this browser.';
      return null;
    }
    box.checked = false;
    // Data kept here ("Remove offline data from this device" is offered): page.js's.
    inspect().then(function (what) {
      if (what !== 'none' && !RF.page) return loadFull().then(bindLoadedSettings);
      return null;
    }).catch(function () {});
    box.addEventListener('change', function onFirst() {
      if (RF.page || !box.checked) return; // page.js has its own handler once loaded
      box.disabled = true;
      loadFull().then(function () {
        return pageBind(container);
      }).then(function () {
        box.disabled = false;
        box.checked = true;
        box.dispatchEvent(new root.Event('change', { bubbles: true }));
      }, function () {
        box.disabled = false;
        box.checked = false;
        if (note) note.textContent = 'That did not work. Reload the page and try again.';
      });
    });
    return null;
  }

  // The full set arrived after preferences.js bound the light switch: page.js takes it.
  function bindLoadedSettings() {
    if (!RF.page || !doc.querySelector('[data-rf-offline-settings]')) return null;
    return pageBind(doc);
  }

  // page.js's settings binding, once per settings element (it adds listeners).
  function pageBind(container) {
    var el = container.querySelector('[data-rf-offline-settings]');
    if (!el) return null;
    if (!el.__rfPageBound) el.__rfPageBound = RF.page.bindSettings(container) || Promise.resolve();
    return el.__rfPageBound;
  }

  // ---- 2. sign-in --------------------------------------------------------------------

  function controller() {
    var sw = root.navigator && root.navigator.serviceWorker;
    return (sw && sw.controller) || null;
  }

  // The page is controlled by a worker registered for offline mode.
  function flaggedWorker() {
    var c = controller();
    return !!c && FLAG.test(c.scriptURL || '');
  }

  // -> Promise: the worker told, the record marked stale (or nothing to mark).
  function forgetUser() {
    var c = controller();
    try { if (c) c.postMessage({ type: 'rf-forget-user' }); } catch (e) { /* gone */ }
    return loadDb().then(function (D) { return D.forgetCurrentUser(); });
  }

  function onLoginSubmit(e) {
    var form = e.target && e.target.closest && e.target.closest('form[data-rf-login]');
    if (!form || form.__rfForgot || e.defaultPrevented) return;
    if (!flaggedWorker()) return; // a plain worker knows nobody
    e.preventDefault();
    form.__rfForgot = true;
    bounded(forgetUser(), RF.boot.FORGET_WAIT_MS).then(function () {
      // form.submit() fires no submit event and skips validation (already passed).
      form.submit();
    });
  }

  // ---- 3. account deletion -----------------------------------------------------------

  function onDeleteAccountSubmit(e) {
    var form = e.target && e.target.closest && e.target.closest('form[data-rf-delete-account]');
    if (!form) return;
    try { root.sessionStorage.setItem('rf-account-deleting', String(Date.now())); } catch (err) { /* no storage */ }
  }

  RF.boot = {
    load: load,
    loadDb: loadDb,
    loadFull: loadFull,
    inspect: inspect,
    // Stops listening for record changes (tests; a page's channel closes with it).
    stop: function () { if (channel) { channel.close(); channel = null; } },
    bindSettings: bindSettings,
    forgetUser: forgetUser,
    flaggedWorker: flaggedWorker,
    HINT_KEY: HINT_KEY,
    FORGET_WAIT_MS: FORGET_WAIT_MS,
  };

  if (!doc || typeof doc.addEventListener !== 'function') return;
  doc.addEventListener('submit', onLoginSubmit, true);
  doc.addEventListener('submit', onDeleteAccountSubmit, true);
  doc.addEventListener('submit', onLogoutSubmit, true);

  var now = wantFullNow();
  if (now) {
    // Parser-inserted, deferred: they run in order after sw-register.js and before
    // app.js, before DOMContentLoaded, exactly as if they were in the template.
    // Marked as loaded, so loadFull() never adds them a second time.
    doc.write(scripts.map(function (u) {
      return '<script src="' + u.replace(/"/g, '&quot;') + '" defer></' + 'script>';
    }).join(''));
    scripts.forEach(function (u) { loads[u] = Promise.resolve(); });
  }

  var parsed = false;
  function afterParse() {
    if (parsed) return;
    parsed = true;
    if (userId && !now) startLight();
    // A sign-in page under a flagged worker: have db.js ready before the submit.
    if (flaggedWorker() && doc.querySelector('form[data-rf-login]')) loadDb().catch(function () {});
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', afterParse);
  else afterParse();
})(self);

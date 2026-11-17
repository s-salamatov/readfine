// Offline mode bootstrap: the small part every page loads (deferred, before app.js).
//
// Sign-in on a browser whose worker is flagged for offline mode: the worker still
// knows the previous reader, whose session may have ended without a logout here. If
// the new reader's first page is slow, the worker would time out into the previous
// reader's stored app. So on submit of any sign-in form (form[data-rf-login]) this
// tells the controlling worker to forget its reader at once ('rf-forget-user', see
// offline/policy.js) and marks the current-user record stale (offline/db.js
// forgetCurrentUser, never creating the database), then submits the form. The next
// start of page.js restores the record for the same reader or wipes the old one's
// data for another. Bounded: the sign-in goes out after FORGET_WAIT_MS whatever
// happened.
(function (root) {
  'use strict';
  var RF = root.RFOffline = root.RFOffline || {};
  var doc = root.document;
  var me = doc && doc.currentScript;

  var FLAG = /[?&]offline=1(?:&|$)/;
  var FORGET_WAIT_MS = 1500;

  function attr(name, fallback) {
    return (me && me.getAttribute(name)) || fallback;
  }

  var loads = {};

  // Loads a same-origin script once. -> Promise (rejects when it fails to load)
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
    return load(attr('data-rf-db', '/static/js/offline/db.js')).then(function () { return RF.db; });
  }

  function bounded(p, ms) {
    return new Promise(function (resolve) {
      var t = setTimeout(resolve, ms);
      Promise.resolve(p).then(function () { clearTimeout(t); resolve(); },
        function () { clearTimeout(t); resolve(); });
    });
  }

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

  // The delete-account form (Settings → Profile) was submitted from this tab: lets
  // /login?deleted=1 wipe the device (offline/deleted-wipe.js), and only then.
  function onDeleteAccountSubmit(e) {
    var form = e.target && e.target.closest && e.target.closest('form[data-rf-delete-account]');
    if (!form) return;
    try { root.sessionStorage.setItem('rf-account-deleting', String(Date.now())); } catch (err) { /* no storage */ }
  }

  RF.boot = {
    load: load,
    loadDb: loadDb,
    forgetUser: forgetUser,
    flaggedWorker: flaggedWorker,
    FORGET_WAIT_MS: FORGET_WAIT_MS,
  };

  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('submit', onLoginSubmit, true);
    doc.addEventListener('submit', onDeleteAccountSubmit, true);
    // A sign-in page under a flagged worker: have db.js ready before the submit.
    if (flaggedWorker() && doc.querySelector && doc.querySelector('form[data-rf-login]')) loadDb().catch(function () {});
  }
})(self);

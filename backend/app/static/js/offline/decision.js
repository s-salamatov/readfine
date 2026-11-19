// Offline navigation decisions shared by the service worker and diagnostics.
(function (root) {
  'use strict';
  var RF = root.RFOffline = root.RFOffline || {};

  function offline(row) {
    return { row: row, answer: 'offline', cache: null };
  }

  function shell(row, entry) {
    return { row: row, answer: 'shell', cache: entry.name };
  }

  function decide({ record, recordState, mirror, mirrorState, forgetWindow, pages, legacy }) {
    var current = recordState === 'ok' ? record : null;
    var mirrored = mirrorState === 'ok' ? mirror : null;

    // A mirror demotion takes effect before the IndexedDB record changes. It
    // also applies to anonymous markers and when IndexedDB is unavailable.
    if (forgetWindow || (current && current.stale) || (mirrored && (
      mirrored.stale || mirrored.logoutPending || mirrored.wipePending || mirrored.offlineEnabled !== true
    ))) return offline('R2');
    if (current && !current.offlineEnabled) return offline('R3');
    if (!current && (mirrorState === 'missing' || mirrorState === 'unreadable')) return offline('R4');
    if (mirrorState !== 'missing' && !mirrored) return offline('R7');

    // Serving uses the readable record's uid first. Cleanup separately checks
    // for disagreement between the two stores in RF.db.currentUid().
    var uid = current ? current.userId : mirrored.uid;
    if (!Number.isInteger(uid) || uid <= 0) return offline('R7');
    var ownsApp = function (entry) { return entry.hasApp && entry.appUser === uid; };
    var ownName = RF.db.PAGES_PREFIX + uid;
    if (current || pages.length === 1) {
      var own = pages.find(function (entry) { return entry.name === ownName && ownsApp(entry); });
      if (own) return shell(current ? 'R1' : 'R6', own);
    }
    if (pages.length === 0) {
      var previous = legacy.find(ownsApp);
      if (previous) return shell(current ? 'L1' : 'L6', previous);
    }
    return offline(current ? 'R1-miss' : 'R7');
  }

  async function readRecord(db, tries, delayMs) {
    for (var attempt = 1; attempt <= tries; attempt++) {
      try {
        var record = await db.getCurrentUser();
        return { record: record, recordState: record ? 'ok' : 'missing' };
      } catch (e) {
        if (attempt < tries) await new Promise(function (resolve) { root.setTimeout(resolve, delayMs); });
      }
    }
    return { record: null, recordState: 'unreadable' };
  }

  async function inspectCache(db, caches, name) {
    var entry = { name: name, hasApp: false, appUser: null };
    try {
      var response;
      if (typeof caches.match === 'function') {
        response = await caches.match('/app', { cacheName: name, ignoreSearch: true });
      } else if (await caches.has(name)) {
        response = await (await caches.open(name)).match('/app', { ignoreSearch: true });
      }
      if (response) {
        entry.hasApp = true;
        entry.appUser = db.shellUser(await response.text());
      }
    } catch (e) { /* An unreadable entry cannot prove who owns its shell. */ }
    return entry;
  }

  async function gather({ db = RF.db, caches = root.caches, forgetWindow = false, tries = 3, delayMs = 100 } = {}) {
    var current = await readRecord(db, tries, delayMs);
    var names;
    try {
      names = caches ? await caches.keys() : [];
    } catch (e) {
      names = [];
    }
    function inspectGroup(prefix) {
      return Promise.all(names.filter(function (name) { return name.startsWith(prefix); })
        .map(function (name) { return inspectCache(db, caches, name); }));
    }
    var [pages, legacy] = await Promise.all([inspectGroup(db.PAGES_PREFIX), inspectGroup(db.SHELL_PREFIX)]);

    var mirror = await db.readMirror(caches);
    return {
      record: current.record, recordState: current.recordState,
      mirror: mirror.value, mirrorState: mirror.state,
      forgetWindow: forgetWindow, pages: pages, legacy: legacy,
    };
  }

  RF.decision = { decide: decide, gather: gather };
})(typeof self !== 'undefined' ? self : globalThis);

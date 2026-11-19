// Service worker registration, page side.
//
// Offline mode is opted into per device, and the worker has to know it synchronously
// (policy.js): a reader with it on gets "/sw.js?offline=1", everyone else plain
// "/sw.js", which never answers a request. Registering the other URL replaces the
// worker in place (same scope "/").
//   - page.js calls ensure(enabled) on every authenticated load (registers only when
//     there is no registration or its flag is the wrong one) and register({offline})
//     when the switch changes;
//   - app.js calls ensure() on every load: registers plain "/sw.js" only when nothing is
//     registered yet, and never re-registers an existing worker.
// Calls are queued one after another, so app.js and page.js cannot race each other into
// registering plain and flagged at the same time.
(function (root) {
  'use strict';
  var RF = root.RFOffline = root.RFOffline || {};

  var FLAG = /[?&]offline=1(?:&|$)/;
  var ERROR_KEY = 'rf-sw-error';
  var queue = Promise.resolve();
  var observedRegistrations = new WeakSet();
  var observedWorkers = new WeakSet();

  function container() {
    return (root.navigator && root.navigator.serviceWorker) || null;
  }

  function scriptUrl(offline) {
    return offline ? '/sw.js?offline=1' : '/sw.js';
  }

  function serial(fn) {
    var p = queue.then(fn, fn);
    queue = p.then(function () {}, function () {});
    return p;
  }

  function registration(sw) {
    return sw.getRegistration('/').then(function (reg) { return reg || null; }, function () { return null; });
  }

  function newest(reg) {
    return reg && (reg.installing || reg.waiting || reg.active);
  }

  // A worker installing for a switch just made wins over the one still active.
  function flagOf(reg) {
    var w = newest(reg);
    if (!w) return null;
    return FLAG.test(w.scriptURL || '');
  }

  function lastError() {
    try {
      return JSON.parse(root.localStorage.getItem(ERROR_KEY));
    } catch (_) { return null; }
  }

  function saveError(script, message) {
    try {
      root.localStorage.setItem(ERROR_KEY, JSON.stringify({ at: Date.now(), script: script, message: message }));
    } catch (_) {}
  }

  function clearError() {
    try { root.localStorage.removeItem(ERROR_KEY); } catch (_) {}
  }

  function recordRejection(script) {
    return function (error) {
      saveError(script, (error && error.message) || String(error));
      throw error;
    };
  }

  function doRegister(sw, offline) {
    // updateViaCache 'none': the worker imports the offline scripts from /static
    // without a version query, and the update check must see a new one at once.
    var script = scriptUrl(offline);
    return sw.register(script, { updateViaCache: 'none' }).catch(recordRejection(script));
  }

  function recordOutcome(w, offline) {
    if (w.state === 'redundant') {
      saveError(w.scriptURL, 'install failed');
    } else if (w.state === 'activated') {
      if (FLAG.test(w.scriptURL || '') === offline) clearError();
    } else {
      return false;
    }
    return true;
  }

  // The caller's wait is bounded. Keep tracking the update for diagnostics even if
  // it finishes later, including updates started by the browser.
  function observeWorker(w, offline) {
    if (!w || typeof w.addEventListener !== 'function' || observedWorkers.has(w)) return;
    observedWorkers.add(w);
    function check() {
      if (recordOutcome(w, offline)) w.removeEventListener('statechange', check);
    }
    w.addEventListener('statechange', check);
    check();
  }

  function observeRegistration(reg, offline) {
    if (!reg || typeof reg.addEventListener !== 'function') return;
    if (!observedRegistrations.has(reg)) {
      observedRegistrations.add(reg);
      reg.addEventListener('updatefound', function () {
        observeWorker(reg.installing, flagOf(reg));
      });
    }
    observeWorker(reg.installing || reg.waiting, offline);
  }

  // The new worker takes over only once the old one has no event in flight. Requests
  // sent meanwhile restart the old worker, and Chrome then may keep the new one waiting
  // (seen after switching on, with the first sync's requests) or leave a navigation
  // handed to the old one as it goes unanswered (seen after switching off, with the
  // POST /logout and the move to /login). So a switch waits for the new worker to be
  // active, or redundant, for at most ACTIVATE_WAIT_MS, before the caller goes on.
  function untilActive(reg, offline) {
    observeRegistration(reg, offline);
    var w = reg && (reg.installing || reg.waiting);
    if (!w || typeof w.addEventListener !== 'function') return Promise.resolve(reg);
    return new Promise(function (resolve) {
      var timer = null;
      function finish() {
        clearTimeout(timer);
        w.removeEventListener('statechange', check);
        resolve(reg);
      }
      function check() {
        if (w.state === 'redundant' || w.state === 'activated') {
          if (!observedWorkers.has(w)) recordOutcome(w, offline);
          finish();
        }
      }
      timer = setTimeout(finish, RF.sw.ACTIVATE_WAIT_MS);
      w.addEventListener('statechange', check);
      check();
    });
  }

  // opts.offline: true / false, or absent to keep the current registration's flag.
  // Always registers, and resolves once the new worker is active (bounded, see
  // untilActive). -> Promise<ServiceWorkerRegistration | null>
  function register(opts) {
    var sw = container();
    if (!sw) return Promise.resolve(null);
    var want = opts && typeof opts.offline === 'boolean' ? opts.offline : null;
    return serial(function () {
      var known = want !== null ? Promise.resolve(want)
        : registration(sw).then(function (reg) { return !!flagOf(reg); });
      return known.then(function (offline) {
        return doRegister(sw, offline).then(function (reg) { return untilActive(reg, offline); });
      });
    });
  }

  // offline: true / false to make sure the registered worker has that flag, or absent
  // to only make sure some worker is registered. Never re-registers a worker that is
  // already right. -> Promise<ServiceWorkerRegistration | null>
  function ensure(offline) {
    var sw = container();
    if (!sw) return Promise.resolve(null);
    var want = typeof offline === 'boolean' ? offline : null;
    return serial(function () {
      return registration(sw).then(function (reg) {
        var flag = flagOf(reg);
        var offline = want === null ? !!flag : want;
        var ready = reg && flag !== null && flag === offline;
        return (ready ? Promise.resolve(reg) : doRegister(sw, offline)).then(function (registered) {
          observeRegistration(registered, offline);
          return registered;
        });
      });
    });
  }

  function update() {
    var sw = container();
    if (!sw) return Promise.resolve(null);
    return serial(function () {
      return registration(sw).then(function (reg) {
        if (!reg) return null;
        var offline = flagOf(reg);
        var worker = newest(reg);
        var script = (worker && worker.scriptURL) || scriptUrl(offline);
        observeRegistration(reg, offline);
        return reg.update().catch(recordRejection(script)).then(function (updated) {
          return untilActive(updated, offline);
        });
      });
    });
  }

  // -> Promise<true | false | null>: the newest worker's flag, null with none.
  function currentFlag() {
    var sw = container();
    if (!sw) return Promise.resolve(null);
    return registration(sw).then(flagOf);
  }

  RF.sw = {
    register: register, ensure: ensure, update: update, lastError: lastError,
    currentFlag: currentFlag, scriptUrl: scriptUrl, ACTIVATE_WAIT_MS: 3000
  };
})(self);

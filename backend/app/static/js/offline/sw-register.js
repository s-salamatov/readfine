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
  var queue = Promise.resolve();

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

  // The newest worker decides: one installing (a switch just made) wins over the one
  // still active. -> true / false, or null with no registration.
  function flagOf(reg) {
    var w = reg && (reg.installing || reg.waiting || reg.active);
    if (!w) return null;
    return FLAG.test(w.scriptURL || '');
  }

  function doRegister(sw, offline) {
    // updateViaCache 'none': the worker imports the offline scripts from /static
    // without a version query, and the update check must see a new one at once.
    return sw.register(scriptUrl(offline), { updateViaCache: 'none' });
  }

  // opts.offline: true / false, or absent to keep the current registration's flag.
  // Always registers. -> Promise<ServiceWorkerRegistration | null>
  function register(opts) {
    var sw = container();
    if (!sw) return Promise.resolve(null);
    var want = opts && typeof opts.offline === 'boolean' ? opts.offline : null;
    return serial(function () {
      var known = want !== null ? Promise.resolve(want)
        : registration(sw).then(function (reg) { return !!flagOf(reg); });
      return known.then(function (offline) { return doRegister(sw, offline); });
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
        if (reg && flag !== null && (want === null || flag === want)) return reg;
        return doRegister(sw, want === null ? false : want);
      });
    });
  }

  // -> Promise<true | false | null>: the newest worker's flag, null with none.
  function currentFlag() {
    var sw = container();
    if (!sw) return Promise.resolve(null);
    return registration(sw).then(flagOf);
  }

  RF.sw = { register: register, ensure: ensure, currentFlag: currentFlag, scriptUrl: scriptUrl };
})(self);

// Service worker registration, page side.
//
// Offline mode is opted into per device, and the worker has to know it synchronously
// (policy.js): a reader with it on gets "/sw.js?offline=1", everyone else plain
// "/sw.js", which never answers a request. Registering the other URL replaces the
// worker in place (same scope "/"). Task 11 calls register({offline}) when the switch
// changes; app.js calls register({}) on every load, which keeps whichever of the two
// is registered now.
(function (root) {
  'use strict';
  var RF = root.RFOffline = root.RFOffline || {};

  var FLAG = /[?&]offline=1(?:&|$)/;

  function scriptUrl(offline) {
    return offline ? '/sw.js?offline=1' : '/sw.js';
  }

  // opts.offline: true / false, or absent to keep the current registration's flag.
  // -> Promise<ServiceWorkerRegistration | null>
  function register(opts) {
    var sw = root.navigator && root.navigator.serviceWorker;
    if (!sw) return Promise.resolve(null);
    var want = opts && typeof opts.offline === 'boolean' ? opts.offline : null;
    var known = want !== null ? Promise.resolve(want)
      : sw.getRegistration('/').then(function (reg) {
        var w = reg && (reg.active || reg.waiting || reg.installing);
        return !!w && FLAG.test(w.scriptURL || '');
      }, function () { return false; });
    return known.then(function (offline) {
      // updateViaCache 'none': the worker imports the offline scripts from /static
      // without a version query, and the update check must see a new one at once.
      return sw.register(scriptUrl(offline), { updateViaCache: 'none' });
    });
  }

  RF.sw = { register: register, scriptUrl: scriptUrl };
})(self);

// Offline mode, /login?deleted=1: the account was just deleted. Removes this device's
// offline databases and caches (offline/db.js wipeAll), in case the page that deleted
// it did not (offline/page.js normally does, before the redirect; the response also
// carries Clear-Site-Data). Names come from the current-user record, since wipeAll can
// only enumerate databases where indexedDB.databases() exists.
(function (root) {
  'use strict';
  var D = root.RFOffline && root.RFOffline.db;
  if (!D) return;
  function mark(on) {
    try {
      if (on) root.localStorage.setItem('rf-wipe-pending', '1');
      else root.localStorage.removeItem('rf-wipe-pending');
    } catch (e) { /* best effort */ }
  }
  // Kept on RFOffline for tests: the promise of this page's wipe.
  root.RFOffline.deletedWipe = D.getCurrentUser().catch(function () { return null; }).then(function (cur) {
    var names = [D.CURRENT_DB];
    if (cur && cur.userId) names.push(D.dbName(cur.userId));
    return D.wipeAll({ names: names });
  }).then(function () { mark(false); }, function () { mark(true); });
})(self);

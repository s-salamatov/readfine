// Service worker. It exists for two reasons.
//
// 1. Chrome fires beforeinstallprompt only for a page whose worker has a fetch handler,
//    and that event is what the Install button in Settings → Preferences hangs on.
//    (Installing from the browser's own menu has not needed a worker since Chrome 108
//    on mobile / 112 on desktop.)
// 2. Offline reading, for a reader who switched it on for this device: with no network
//    (or "Work offline"), the offline router answers the app's own requests from the
//    device store (static/js/offline/router.js).
//
// It caches nothing it fetches. A worker outlives logout and account switches on a
// shared browser, so anything it stored would sit outside the Cache-Control: no-store
// rule that keeps one account's rendered pages from reaching the next person at this
// browser (CWE-525). What offline mode keeps is written by the page's sync, into
// per-user stores that logout wipes (offline/db.js wipeAll), and only after the reader
// opted in.

// Same-origin, so the worker's own script-src allows them. A failure here (a deploy
// mid-update, a 404) must not take the worker down with it: without the scripts the
// worker still installs and stays the plain no-op it was.
try {
  importScripts(
    '/static/js/vendor/minisearch.js',
    '/static/js/offline/db.js',
    '/static/js/offline/search.js',
    '/static/js/offline/media.js',
    '/static/js/offline/lists.js',
    '/static/js/offline/templates.js',
    '/static/js/offline/router.js',
    '/static/js/offline/policy.js'
  );
} catch (e) {
  // Offline mode is unavailable in this worker; online behaviour is unchanged.
}

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  // Claim open pages right away. Without this the very first visit stays uncontrolled
  // until the next navigation, and the install prompt would only appear after a reload.
  event.waitUntil(Promise.all([
    self.clients.claim(),
    self.RFOffline && self.RFOffline.policy ? self.RFOffline.policy.onActivate() : null,
  ]));
});

// Offline mode is opted into per device, and shows in the worker's own URL: the page
// registers "/sw.js?offline=1" for such a reader and plain "/sw.js" otherwise
// (offline/sw-register.js). The plain worker's handler returns at once, without
// respondWith and without touching IndexedDB, so the request goes to the network as if
// there were no worker, range requests included. It is not an empty function, though,
// so the browser can no longer skip dispatching the fetch event altogether (Chrome's
// "no-op fetch handler" optimisation): every request pays a short trip through it. One
// worker file cannot avoid that, since listeners must be registered when the script
// runs. With offline mode on, only the app's own requests (pages, /htmx/, /static/,
// media) go through the worker, network first (offline/policy.js); a pass-through for
// everything is still avoided, as it can break the video players' range requests.
//
// Keep the handler: taking it away removes beforeinstallprompt, and with that the
// Install button in Settings.
self.addEventListener('fetch', function (event) {
  if (self.RFOffline && self.RFOffline.policy) self.RFOffline.policy.onFetch(event);
});

// The page tells the worker when the signed-in user or the offline switch changed.
self.addEventListener('message', function (event) {
  if (self.RFOffline && self.RFOffline.policy) self.RFOffline.policy.onMessage(event);
});

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
    '/static/js/offline/db.js',
    '/static/js/offline/media.js',
    '/static/js/offline/lists.js',
    '/static/js/offline/templates.js',
    '/static/js/offline/router.js'
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
  event.waitUntil(self.clients.claim());
});

// For a reader without offline mode the handler returns without calling respondWith,
// so the request goes to the network as if there were no worker, range requests
// included. It is no longer an empty function, though, so the browser can no longer
// skip dispatching the fetch event altogether (Chrome's "no-op fetch handler"
// optimisation): every request pays a short trip through this function. One worker
// file cannot avoid that, since listeners must be registered when the script runs.
// A pass-through (`event.respondWith(fetch(event.request))`) for everything is still
// avoided on purpose: routing every request through the worker can break range
// requests, which is how the video players in article bodies fetch. With offline mode
// on, only the app's own requests (pages, /htmx/, /static/, media) go through it,
// network first.
//
// Keep the handler: taking it away removes beforeinstallprompt, and with that the
// Install button in Settings.
self.addEventListener('fetch', function (event) {
  if (self.RFOffline && self.RFOffline.router) self.RFOffline.router.onFetch(event);
});

// The page tells the worker when the signed-in user or the offline switch changed.
self.addEventListener('message', function (event) {
  if (self.RFOffline && self.RFOffline.router) self.RFOffline.router.onMessage(event);
});

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
//
// Offline mode is opted into per device, and shows in the worker's own URL: the page
// registers "/sw.js?offline=1" for such a reader and plain "/sw.js" otherwise
// (offline/sw-register.js). Listeners must be registered when the script first runs,
// so the flag decides here, once, which worker this is:
//   plain:   exactly upstream's worker. No scripts imported, an empty fetch handler
//            (Chrome then skips dispatching fetch events to it altogether, the "no-op
//            fetch handler" optimisation), navigation preload off.
//   flagged: the offline scripts and the real fetch / message handlers
//            (offline/policy.js): only the app's own requests (pages, /htmx/, /static/,
//            media) go through it, network first; never a pass-through for everything,
//            which can break the video players' range requests.
var flagged = /[?&]offline=1(?:&|$)/.test(self.location.search);
var startedAt = Date.now();
var offline = null;
var importError = null;

if (flagged) {
  // Reject a new install if its scripts cannot load. An already installed worker can
  // restart at the same URL without an install event and still serve the built-in page.
  try {
    importScripts(
      '/static/js/vendor/minisearch.js',
      '/static/js/offline/db.js',
      '/static/js/offline/decision.js',
      '/static/js/offline/search.js',
      '/static/js/offline/media.js',
      '/static/js/offline/lists.js',
      '/static/js/offline/templates.js',
      '/static/js/offline/router.js',
      '/static/js/offline/policy.js'
    );
    if (!self.RFOffline || !self.RFOffline.policy) throw new Error('Offline policy did not load');
    offline = self.RFOffline.policy;
  } catch (e) {
    importError = e || new Error('Offline scripts did not load');
  }
}

self.addEventListener('install', function (event) {
  if (importError) {
    event.waitUntil(Promise.reject(importError));
    return;
  }
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  // Claim open pages right away. Without this the very first visit stays uncontrolled
  // until the next navigation, and the install prompt would only appear after a reload.
  // Navigation preload: on for the offline worker (policy.onActivate), off for the plain
  // one, which may be replacing an offline worker that turned it on.
  var np = self.registration && self.registration.navigationPreload;
  var preload = offline ? offline.onActivate()
    : (np ? np.disable().catch(function () {}) : null);
  event.waitUntil(Promise.all([self.clients.claim(), preload]));
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'rf-diag') {
    var port = event.ports && event.ports[0];
    if (port) port.postMessage({
      flagged: flagged,
      scriptsLoaded: !!offline,
      importError: importError ? (importError.message || String(importError)) : null,
      startedAt: startedAt,
      ...(offline ? offline.routeDiagnostics() : { routeErrors: [], routeErrorCount: 0 })
    });
  } else if (offline) {
    offline.onMessage(event);
  }
});

if (offline) {
  self.addEventListener('fetch', function (event) {
    offline.onFetch(event);
  });
} else if (importError) {
  self.addEventListener('fetch', function (event) {
    if (event.request.mode !== 'navigate') return;
    event.respondWith(new Response(
      '<!doctype html><html lang="en"><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<title>Offline files failed to load</title>'
      + '<main><p>Offline files failed to load. Open the app once online.</p></main></html>',
      { status: 503, headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"
      } }
    ));
  });
} else {
  // Empty on purpose. A pass-through (`event.respondWith(fetch(event.request))`) looks
  // equivalent but is worse on both counts: it defeats the browser's ability to skip a
  // no-op fetch handler entirely, and routing every request through the worker can
  // break range requests, which is how the video players in article bodies fetch.
  //
  // Chrome's console says so out loud: "Fetch event handler is recognized as no-op …
  // Consider removing the handler if possible." Do not. That message means the skip
  // optimization above is working, and taking the handler away removes
  // beforeinstallprompt with it, and with that the Install button in Settings.
  self.addEventListener('fetch', function () {});
}

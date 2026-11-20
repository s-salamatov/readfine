# Readfine instant launch: no white screen on the iPhone

Status: for owner approval (2026-11-20), revision 6 (owner: all platforms, animated mark, variant C chosen; round 4 findings addressed) after design review rounds 1–4 (round 1: 5 major, 3 minor; round 2: 2 major, 3 minor; all addressed; see §8–9).
Repo: `/projects/readfine/src`, branch `feat/instant-launch` from `selfhost` 5a08ddb (offline v2, offline freshness and the launch-timing hotfix deployed). Workflow run: arh-w-dev `run-20a3526c`.

## 1. Problem

Opening the home-screen app shows a white screen, online and offline.
- The server renders `/app` in about 80 ms.
- The hotfix 5a08ddb (versioned statics `Cache-Control: immutable`) made launch faster, but the white screen remains.

Today the flagged worker (`policy.js`) handles a launch like this:
- **Navigation:** `respondNav` first awaits `loadCurrent()`, which reads IndexedDB. That read is slow on a freshly started iOS worker.
- **Online:** it then fetches `/app` from the network: 0.36–0.7 s on the owner's phone.
- **Offline:** it answers from the stored copy only after that network attempt fails, which can take up to 8 s.
- **Statics:** it always fetches them from the network first.

Until the first HTML byte arrives, iOS shows a white launch surface: `base.html` has no `apple-touch-startup-image`.

Evidence: discovery report `stage.brainstorm.a1` (A–E) and the device diagnostics of 2026-11-20.

## 2. Owner decisions

- **D1 (2026-11-20).** On an online launch, nothing personal may appear before the server confirms the session; the first screen is neutral and branded. Offline launches keep using the stored copy, as today.
- **D2 (2026-11-20).** All three parts are in scope: instant shell, cache-first statics, branded launch screen.

## 3. Goals

- **G1. Something branded paints at once on every launch:** the launch page as the first web paint. This holds for a cold worker (killed app) and a warm one, online and offline. The system splash before it is branded within the limits stated in G5.
- **G5. The same branded, animated launch page on every platform:** iPhone, iPad, Android, desktop installs and browser tabs with offline mode on (owner request). The system splash before it is branded where the platform allows: iOS and iPadOS full-screen launches (the matrix in P3), and the browser-generated Android splash. iPad multitasking windows (Split View, Slide Over, Stage Manager) and desktop windows have no matching startup image. There the system surface may stay plain for the moment before the launch page paints, and this is accepted.
- **G2. Online: the interface follows within one authenticated round trip,** served from the stored copy. If the server rejects the session or answers with an error, the app behaves as today: sign-in, the mismatch path, or the server's answer.
- **G3. Offline (the network request fails at once):** the stored interface appears without an 8 s wait.
- **G4. All offline v2 guarantees hold:**
  - the decision table;
  - mirror and wipe ordering;
  - pending logout and wipe;
  - user switch and the forget window;
  - stale record and forceOffline;
  - account deletion.

Non-goals:
- Making the article list cache-first. The sidebar and list keep their current loading.
- A new background publisher of the stored shell. The page's existing sync (a6 `cachePages`) stays the only publisher; it already runs on every launch.
- Animating the system splash itself: no platform supports it (see P3).

## 4. Design

### P1. Neutral launch page for every plain launch

- **Which navigations get it.** The flagged worker answers a navigation request (mode `navigate`, GET, top-level) for path `/` or `/app` with no query string at once with `launch.html`.
- **What the worker does not wait for.** This answer does not depend on the record, IndexedDB or Cache Storage. It is built in memory, the same way `RF.router` builds the offline page.
- **Cold workers too.** The answer is the same for a worker that has just started. This is the case of the killed app, and it is what makes G1 hold there (fixes il1-1).
- **Neutral content.** The page contains no personal data: the animated app mark (P3) on the background color for `prefers-color-scheme`.
- **The page carries its own script.** No external file is needed (fixes il2-1).
  - The launch page's script and styles live in the worker's own code: a new module `offline/launch.js`, loaded by `sw.js` through `importScripts` like `router.js` and `diagnostics.js`. Whenever a flagged worker runs, so does the launch code. This holds before any a6 publish, after cache loss, and with no record at all.
  - The worker serves the page with its own CSP header: `default-src 'none'; script-src 'nonce-N'; style-src 'nonce-N'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'`. N is a fresh random nonce per response.
  - The mark is an inline SVG data image. The page loads nothing from the network and nothing from Cache Storage.
  - It works the same way as the existing worker-built pages.
- **One-time code.** The worker puts a random code (128 bit) into the page and remembers it in memory: `{ code, path, createdAt, clientId, state }`.
  - `path` is the original `/` or `/app`, and `clientId` is the navigation's `resultingClientId` when the browser provides it.
  - At most 16 entries, each expiring after 60 s.
- **What the code guarantees (il2-3).** The code is a random bearer value that exists only inside its own launch page.
  - Another tab never sees it. A confirmation can therefore only be used by the page whose confirmation request succeeded, and a tab without the code cannot use anyone's confirmation.
  - Where the browser gives `resultingClientId` and `clientId`, the worker also requires that `/__rf/launch/<code>` comes from the same client as the launch page.
  - We do not claim more than this.
- **What the page's script does.** It calls `GET /__rf/launch/<code>`, and the worker answers that route itself (§4.2). It then calls `location.replace`, always keeping the original path and hash (fixes il1-6, il2-4):
  - `{go: "shell"}` → `<path>?rf_launch=<code>`;
  - `{go: "server"}` → `<path>?rf_launch=server`;
  - `{go: "network"}` → `<path>?rf_launch=bypass`;
  - `{go: "login"}` → `/login`.
- **Cleaning the URL.** `page.js` removes `rf_launch` from the address bar on load with `history.replaceState`.
- **Without JavaScript.** If the script cannot run, a plain link to `<path>?rf_launch=bypass` appears after 3 s, through CSS animation and no script. `bypass` always takes today's path, so there is no loop back to the launch page (fixes il1-4).

### 4.2 The worker's confirmation route `/__rf/launch/<code>`

`/__rf/launch/<code>` is a fetch route the worker answers itself. The flagged worker owns the `/__rf/` prefix already, as for `/__rf/diagnostics`.

1. **Code check.** An unknown, expired or already used code → `{go: "network"}`. The code is marked used here.
2. **Current state.** The worker runs `loadCurrent()`; the launch page is already painted, so this wait is no longer white.
   - If the record is not enabled, or is forceOffline, or a logout or wipe marker is set, or the forget window is open → `{go: "network"}`. Today's path then decides: forceOffline goes to `answerNav`, and so on.
   - Note the record's uid and the current generation (`current.gen`, `fallbackGen`).
3. **Session confirmation.** The worker fetches `/sync/changes` itself, from the network, with the session cookie and `X-Readfine-User: <uid>`. It uses `NETWORK_TIMEOUT_MS` (8 s). Results:
   - **200 with a valid token** → session confirmed. Recheck that the generation, the record uid and the forget window have not changed. If any has → `{go: "network"}`. If not, mark the code `confirmed` for this uid and generation → `{go: "shell"}`.
   - **401, or a redirect to `/login`** → `{go: "login"}`.
   - **409, any other HTTP status (5xx, 429, 4xx), or an invalid body** → `{go: "server"}`. The server is reachable but has not confirmed the session. The code is marked `rejected`, and the next navigation is fail-closed (§4.3): it can never become an offline grant for the stored copy (fixes il1-2, il2-2).
   - **The fetch rejects (no network)** → offline. The code is marked `offline` → `{go: "shell"}`. The navigation then gets today's offline decision (`answerNav`). This is what offline mode already does today, without the 8 s wait (G3). In airplane mode the fetch rejects at once.
   - **Timeout** → treated like a rejection after 8 s. This is today's network-timeout behavior, but the launch page is visible instead of a white screen.

### 4.3 The `/app?rf_launch=…` navigation

- **`rf_launch=<code>` marked `confirmed`, same uid and generation, within 60 s:** the worker answers with the stored copy through the existing `answerNav` checks: rows R1/R6/L*, owner uid equal to the record uid, generations, forget window. If there is no owned shell, the answer is the network (`network()`), as today. The code is consumed.
- **`rf_launch=<code>` marked `offline`:** `answerNav` decides as today offline (stored copy or offline page). The code is consumed.
- **`rf_launch=server` (fail-closed):**
  - The worker fetches the navigation from the network with no timeout fallback to the stored copy and returns whatever the server answers.
  - If that fetch rejects, it returns the neutral offline page (`RF.router.offlinePage`), never the stored shell.
  - This is the only route for a reachable server that rejected the confirmation.
- **`rf_launch=bypass`, or a code that is unknown, expired or consumed:** today's `respondNav`, unchanged. These come only from the no-JS link, a worker restart, or a record that was not eligible. For that path today's behavior is the explicitly chosen one.
- **Query handling.** `answerNav` already ignores the query when it picks the shell. Server-side `/app` ignores the unknown `rf_launch` parameter.
- **Freshness.** The stored copy is as fresh as the last successful a6 publish. The page's startup sync runs right after load and republishes it for the next launch; no new publisher is added (fixes il1-7).

### P3. Branded launch on every platform, with an animated mark

Owner request (2026-11-20, design comment): the app runs on other devices and operating systems too, and the brand mark must be animated; the animation is approved from a live preview in the design page.

**What each platform can show.** System splash screens are static images or colors; no platform animates them. The animation therefore lives on the launch page (P1), which the worker serves the same way in every browser. Where the system splash is our image (iOS and iPadOS full-screen launches), it equals the animation's first frame, so the hand-over is seamless there. Elsewhere it is best effort (G5).

| Platform | System launch surface (static) | Then |
|---|---|---|
| iPhone and iPad, home-screen app | `apple-touch-startup-image` PNGs, portrait and landscape, light and dark (matrix below) | animated launch page |
| Android (Chrome, Samsung Internet), installed app | the browser-generated splash from the manifest (`name`, `background_color`, the 512 px icon). The browser decides its layout, so the hand-over to the launch page is best effort | animated launch page |
| Desktop installed app (Chrome, Edge, Safari "Add to Dock") | no system splash. `background_color` is a hint the browser may use for the window before the first paint, without a guarantee | animated launch page |
| Any browser tab with offline mode on (flagged worker) | none | animated launch page |

**The animated mark (on the launch page).**
- The mark is the existing app icon (`static/icons/icon.svg`: blue `#3b82f6` rounded square with the white "Rf"), inlined as SVG in the worker-built page.
- First frame equals the splash: the full mark centred on the scheme background. Nothing appears from empty, so the splash-to-page switch does not flash.
- **Owner feedback (2026-11-20).** A real logo animation is wanted, not a sheen or a pulse, and no progress bar. Three variants are shown live in the design page, each looping 4.2 s:
  - **A. R → book → R:** the bowl and leg of the R open into two pages on the stem as the spine, lines appear, and the book closes back into the R.
  - **B. R → article → R:** the R unfolds into a sheet with a headline and lines of text, and folds back.
  - **C. f → feed → f** (owner asked to detail it): the crossbar of the f itself grows into an article card. It grows first in width, then in height, keeping a constant corner radius (half the bar height), so nothing looks stretched. Meanwhile the stem and hook fade. When the card reaches full size, its title and text line fade in. The neighbouring cards slide in from above and below, and the feed scrolls by one card. Everything then folds back in mirror order: the cards leave, the centre card loses height and then width, back to the exact crossbar, and the stem and hook return.
  - **Chosen: variant C (owner, 2026-11-20 14:26).** The live preview of C in the design page (frames and timings of `variant_c`) is the approved reference. The implementation uses the same SVG and SMIL timings. Variants A and B are not implemented.
- **How each loop moves.** The real glyph cross-fades to a stroke-built stand-in of the same letter. The stand-in morphs into the object and holds it with details. Then it morphs back and cross-fades to the real glyph. No progress bar.
- **Technique.** Inline SVG with SMIL (`<animate>` on path `d`, `stroke-width`, `opacity`, rect `y`). Morphed paths share the same command structure. Supported by WebKit (iOS/macOS), Blink and Gecko.
- **CSP.** There is no script. Styles stay in the page's nonce style block.
- **Reduced motion.** Under `prefers-reduced-motion: reduce`, CSS hides the animated SVG and shows the static mark.
- **No minimum display time.** The page appears instantly. If the check finishes before the morph starts (80 % of the first 0.34 s is the static mark), no minimum time is added.

**Splash images (iOS / iPadOS).** `apple-touch-startup-image` links in `base.html`, one per row × orientation (portrait, landscape) × scheme (light, dark):

| CSS px (device-width × device-height) | DPR | Portrait PNG px | Devices |
|---|---|---|---|
| 440 × 956 | 3 | 1320 × 2868 | iPhone 16 Pro Max |
| 402 × 874 | 3 | 1206 × 2622 | iPhone 16 Pro |
| 430 × 932 | 3 | 1290 × 2796 | iPhone 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus |
| 393 × 852 | 3 | 1179 × 2556 | iPhone 14 Pro, 15, 15 Pro, 16 |
| 428 × 926 | 3 | 1284 × 2778 | iPhone 12/13 Pro Max, 14 Plus |
| 390 × 844 | 3 | 1170 × 2532 | iPhone 12, 12 Pro, 13, 13 Pro, 14 |
| 375 × 812 | 3 | 1125 × 2436 | iPhone X, XS, 11 Pro, 12 mini, 13 mini |
| 414 × 896 | 3 | 1242 × 2688 | iPhone XS Max, 11 Pro Max |
| 414 × 896 | 2 | 828 × 1792 | iPhone XR, 11 |
| 375 × 667 | 2 | 750 × 1334 | iPhone SE (2nd/3rd), 8 |
| 1032 × 1376 | 2 | 2064 × 2752 | iPad Pro 13" (M4) |
| 1024 × 1366 | 2 | 2048 × 2732 | iPad Pro 12.9" |
| 834 × 1210 | 2 | 1668 × 2420 | iPad Pro 11" (M4) |
| 834 × 1194 | 2 | 1668 × 2388 | iPad Pro 11" (1st–4th gen) |
| 820 × 1180 | 2 | 1640 × 2360 | iPad Air (4th/5th), iPad Air 11", iPad (10th) |
| 810 × 1080 | 2 | 1620 × 2160 | iPad (7th–9th) |
| 744 × 1133 | 2 | 1488 × 2266 | iPad mini (6th/7th) |

- Landscape PNGs swap width and height; media query `(device-width: Wpx) and (device-height: Hpx) and (-webkit-device-pixel-ratio: D) and (orientation: portrait|landscape) and (prefers-color-scheme: light|dark)`.
- 17 sizes × 2 orientations × 2 schemes = 68 PNGs, generated once by `scripts/gen_splash.py` (Pillow, rendering `static/icons/icon-512.png` centred at 22 % of the shorter side on `#f9fafb` / `#141414`), committed under `static/splash/`, palette-quantised; target aggregate under 4 MB. They are served only to iOS at install time and are never part of the offline shell.

**Manifest (Android, desktop).** We keep a single `background_color` of `#141414` (the current value) and `theme_color` `#141414`. This is the compatible choice: a dark-scheme variant (`color_scheme_dark` in the current W3C draft) is not established in shipping browsers.
- The value is a hint to the browser. Where the browser uses it, the Android splash and the desktop window match the dark launch page.
- Light-scheme users may see a dark system surface for a moment, then the light launch page. This is an accepted difference imposed by the platform.
- The hand-over from the system surface to the launch page is best effort on these platforms.

**Not part of the offline shell.** a6's asset discovery skips `<link rel="apple-touch-startup-image">`, so sync does not grow; a test pins this (fixes il1-8).

### P4. Cache-first versioned statics

- **Cache first.** For `kind === 'static'` with a non-empty `v` query, the flagged worker tries an exact URL match (no `ignoreSearch`):
  1. the record's pages cache;
  2. then the legacy shell caches.
- **On a hit:** return it, with no network.
- **On a miss:** today's behavior, network first.
- **Unversioned statics:** unchanged.
- **Unflagged worker:** unchanged, no `respondWith`.
- **No wrong bytes under a version.** When a6 stores an asset whose `?v=` does not equal the sha256 prefix of its bytes (an old URL answered by a new deploy), it does not store it. The publish then fails like any other asset failure: the previous shell is kept, as a6 already does.
- **Old versions are retained (fixes il1-5).** a6 records, with each publish, the shell's identity (`sha256` of the `/app` asset list) and its asset URLs. It prunes an asset only when it is referenced by none of the last 3 distinct shell identities. Publishing the same shell B again does not evict shell A's assets. A tab still running shell A keeps its bytes for at least two more different deploys.

## 5. Failure handling

- **`launch.js` does not run:** the no-JS link (`bypass`) appears after 3 s.
- **The worker restarts between the launch page and `/__rf/launch/<code>` or `/app?rf_launch=<code>`:** the code is unknown, so the answer is `network` or `bypass`, which is today's path. This is safe, just slower.
- **The stored copy is not owned by the uid:** network, as today.
- **A logout, wipe or user switch** between confirmation and navigation changes the generation or the record. The `/app?rf_launch` check then fails and today's path applies.

## 6. Tests

- **Worker (JS):**
  - a plain `/` or `/app` navigation on a cold worker gets the launch page without any IndexedDB or Cache Storage call;
  - every `/__rf/launch/<code>` outcome: 200, 401, login redirect, 409, 503, 429, rejection, timeout, forceOffline, markers, forget window, generation change, unknown, expired and used code;
  - `rf_launch=<code>` paths:
    - a `confirmed` code (same uid and generation, within 60 s) → the stored copy through `answerNav`;
    - an `offline` code → today's offline decision (stored copy or offline page);
    - any other code → today's path;
  - `rf_launch=server` → the server's answer; if the fetch rejects → the neutral offline page, never the stored shell, even when an owned shell exists;
  - the launch page works with empty Cache Storage, with no record, and before any a6 publish. A cold airplane-mode launch reaches the stored shell or the offline page by itself;
  - a tab without a code cannot use another tab's confirmation. Where `clientId` is available, a `/__rf/launch/<code>` request from a different client is rejected;
  - `bypass` takes today's path;
  - the hash is kept on every path;
  - `?v=` exact hits come from the cache without a fetch, and a miss goes to the network;
  - a6 does not store a mismatched hash;
  - three different shells A→B→B→C keep A's assets until three distinct newer ones exist.
- **Launch page (the worker module `offline/launch.js`):**
  - the CSP header with a per-response nonce, and no external loads;
  - navigation per answer, keeping the original path and hash;
  - the no-JS link exists and points to `<path>?rf_launch=bypass`.
- **Backend:**
  - the splash links follow the 17-size matrix in both orientations and both schemes (68 links);
  - the files exist with the declared pixel sizes, aggregate under 4 MB;
  - a6 discovery skips them.
- **Animation:** the launch page contains the SVG of variant C, identical to the approved preview. Its first and last frames equal the static mark. Under `prefers-reduced-motion: reduce` the animated SVG is hidden and the static mark is shown (computed style). There is no progress bar.
- **e2e (Chrome + WebKit):**
  - cold online launch: the first paint is the launch page, then `/app` from the cache, with no personal text before `/sync/changes` answers 200;
  - session revoked before launch → sign-in, with no personal text painted;
  - server answers 503 to `/sync/changes` → the server's answer, not the cached shell;
  - cold offline launch → stored shell quickly, timed under 1 s in the test environment;
  - the existing a9, a10 and freshness specs stay green.
  - Cold and warm workers are set up explicitly: a fresh persistent context versus the same context.
- **Device:** the owner's iPhone, killed and background-restored launches, read from the launch-timing report.

## 7. Rollout

- JS, templates and static files only. No migration.
- The splash shows after iOS re-reads the page head; the owner may need to remove the app and add it to the Home Screen again.
- Merge and deploy need the owner's approval.

## 8. Changes from revision 1

- **il1-1:** the launch page is answered without the record. The confirmation and the record read happen behind the painted page.
- **il1-2:** HTTP errors and 409 go to the network path. Only a fetch rejection counts as offline.
- **il1-3:** confirmation is bound to a one-time code per launch page.
- **il1-4:** the no-JS fallback uses `bypass`.
- **il1-5:** retention by the last 3 distinct shell identities.
- **il1-6:** the hash is kept on all paths.
- **il1-7:** there is no worker publisher; a6 stays the only one.
- **il1-8:** an exact splash matrix and the a6 exclusion.

## 9. Changes from revision 2

- **il2-1:** the launch page's script and styles are part of the worker (`importScripts`), served with a nonce CSP. No external file or cache is needed.
- **il2-2:** a reachable server that rejects the confirmation leads to the fail-closed `rf_launch=server` outcome. It never falls back to the stored copy.
- **il2-3:** the guarantee is stated as nonce isolation, plus a client check where `clientId` is available.
- **il2-4:** the original path (`/` or `/app`) is kept on every outcome.
- **il2-5:** acceptance states the `confirmed` and `offline` branches separately.

## 10. Changes from revision 3

- Owner comment on P3: launch branding for every platform (iPhone and iPad in both orientations, Android, desktop, browser tabs) and an animated mark on the launch page, approved from the live preview in the design page; new goal G5.
- Round 4 review: the system-splash claim is narrowed to iOS and iPadOS full-screen launches and the Android generated splash. iPad multitasking windows and desktop windows may show a plain surface until the launch page paints (il4-1). The iPad Air 11" label is corrected (il4-2). Android and desktop hand-over is best effort, and the single background_color is the compatible choice (il4-3).
- Owner comment on the animation preview: replaced the sheen, pulse and progress bar with three real logo-animation variants (A book, B article, C feed) for the owner to choose from; technique SVG + SMIL, no script.
- Owner chose variant C (2026-11-20 14:26) after it was detailed: the f crossbar grows into an article card, first in width, then in height, with a constant corner radius.

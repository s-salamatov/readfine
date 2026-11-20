# Readfine instant launch implementation plan

Status: plan / draft · 2026-11-20 · run `run-20a3526c-e5dd-4afc-ad51-1f9da1346a5b` · baseline `5a08ddb` (`feat/instant-launch` from `selfhost`)

**Goal:** Paint a neutral branded page immediately when the offline-enabled app opens, then show the stored interface after session confirmation online or the existing offline decision when the network fails.

**Architecture:** The flagged worker serves launch HTML from memory and redeems a short-lived, one-time capability to confirm the session before an online cached navigation. The existing a6 sync remains the only shell publisher and retains three asset generations by shell identity. Static startup PNGs cover the approved full-screen iOS and iPadOS matrix, and an inline SVG supplies the same web launch mark across platforms.

**Tech stack:** FastAPI, Jinja, plain-script JS, service workers, Cache Storage, IndexedDB, Web Crypto, SVG/SMIL, Pillow, pytest, node:test and Playwright (Chrome/WebKit).

**Design:** [Instant launch, revision 6](../designs/2026-11-20-instant-launch-design.md), approved by the owner on 2026-11-20 at 14:26. Approved copy `.arh-w-dev/plans/2026-11-20-instant-launch-design.md` has SHA-256 `b9515fedf959e67fbc0d62aad6e7f9ec6c307094cf7fb90f017bdfaedd36d29a`. The inline SVG instruction from il7-1 and the exact variant C reference take precedence over the earlier data-image sentence in P1.

**Execution:** `hc-fork`.

## Global Constraints

- D1 (2026-11-20). On an online launch, nothing personal may appear before the server confirms the session. The first screen is neutral and branded. Offline launches keep using the stored copy, as today. The explicitly approved bypass and unknown-code paths retain today's network-first decision.
- D2 (2026-11-20). All three parts are in scope: instant shell, cache-first statics, branded launch screen. The list and sidebar keep their existing loading. The page's existing a6 `cachePages` stays the only shell publisher.
- CSP is nonce-based. Any permitted inline app-page `<script>` needs `nonce="{{ request.state.csp_nonce }}"`. A cached app response keeps its original CSP header paired with its HTML nonce.
- Worker launch page CSP is exactly `default-src 'none'; script-src 'nonce-N'; style-src 'nonce-N'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'`. Use a fresh N per response on both the inline script and style. The mark is inline SVG, with no external loads, inline handlers or style attributes.
- Preserve the offline v2 decision table, mirror and wipe ordering, no-demotion guarantees, pending logout/wipe, user switching and the forget window, stale record, forceOffline and account deletion. Preserve the a11 exact `/healthz` response check. Only the existing explicit off/logout/wipe/account deletion paths may return registration to plain `/sw.js`.
- Registration stays off. `/logout` sends no `Clear-Site-Data` header. The app runs with one uvicorn worker (`--workers 1`).
- Exact launch copy: title `Readfine`, fallback link `Open Readfine`. Keep `Offline – Readfine`, `Needs a connection`, `Try again`, `Open offline reader` and `Why is this offline? Diagnostics` on the existing neutral offline page. Preserve `Full texts N of M`, `(server is fetching)` and `Full text not downloaded yet — showing the feed version.`
- After changing classes in templates, rebuild the stylesheet with `npm run build`. Expected: Tailwind completes with exit 0. The startup-image links introduce no classes. Manifest `background_color` and `theme_color` stay `#141414`. System splash branding covers the approved full-screen iOS/iPadOS matrix and browser-generated Android splash. iPad multitasking and desktop windows may have a plain system surface before the web paint.
- No migration, new production dependency or new shell publisher. Run Chrome only via the orchestrator outside the Codex sandbox. Merge and deployment each require owner approval.

**Backend commands.** From `backend/`, set `PGENV='DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4250/readfine_test SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd'`. Use `env $PGENV uv run pytest … -q` against the existing migrated test database. Run the JS and Playwright commands from the repo root.

## Review Focus

1. A different tab presents a live code while the original confirmation is pending. The wrong client cannot redeem it, and a replay cannot start another check. Test `launch confirmation is single-use and classifies every server and transport outcome` (`worker-launch`).
2. A logout or account change overtakes a confirmation or shell read. The result cannot grant the old reader's page. Test `launch navigation consumes grants and keeps rejected checks off the stored shell` (`worker-launch`).
3. A reachable server rejects confirmation and the follow-up navigation loses the connection. Even with an owned stored shell, this navigation gets the neutral offline page. Test `launch navigation consumes grants and keeps rejected checks off the stored shell` (`worker-launch`).
4. A stale versioned asset URL returns bytes from a newer deployment with HTTP 200. a6 keeps the previous publication and does not store the response at the old URL. Test `a failed asset leaves the previous /app in place` (`shell-publish`).
5. A same-version resync or failed publish occurs while a tab still needs an older asset. It must neither age out the older identity nor delete its dependencies. Test `pages retain the three most recent distinct published shell identities` (`shell-publish`).

## File map

| File | Writing task | Responsibility |
|---|---|---|
| `backend/app/static/js/sw.js` | worker-launch | Flagged worker import of the in-memory launch module |
| `backend/app/static/js/offline/launch.js` | worker-launch | Launch HTML/CSP, exact variant C, client script and one-time codes |
| `backend/app/static/js/offline/policy.js` | worker-launch | Route dispatch, confirmation, guarded shell navigation and exact static hits |
| `tests/js/offline-worker-nav.test.mjs` | worker-launch | New launch protocol tests and versioned static behavior |
| `tests/js/offline-router.test.mjs` | worker-launch | Existing decision/preload regression inputs |
| `tests/js/offline-worker-handle.test.mjs` | worker-launch | Existing diagnostic error regression input |
| `backend/app/static/js/offline/page.js` | clean-launch-url | Strip only the internal launch query key on app startup |
| `tests/js/offline-page.test.mjs` | clean-launch-url | URL cleanup and history preservation |
| `backend/app/static/js/offline/sync.js` | shell-publish | Splash exclusion, asset verification and shell history |
| `tests/js/offline-sync.test.mjs` | shell-publish | a6 hash, discovery, rollback, retention and wipe coverage |
| `scripts/gen_splash.py` | ios-splash | Deterministic local Pillow generator |
| `backend/app/static/splash/{device}-{d}x-{orientation}-{scheme}.png` (all 68 paths defined below) | ios-splash | Generated startup images tracked in git |
| `backend/app/templates/base.html` | ios-splash | Startup-image links and media queries |
| `backend/tests/test_pwa.py` | ios-splash | Rendered matrix, file dimensions and bytes |
| `tests/e2e/fixtures/freshness_app.py` | launch-e2e | Test-only controls for actual worker HTTP traffic |
| `tests/e2e/fixtures/seed.py` | launch-e2e | Revoke the seeded reader's live session |
| `tests/e2e/instant-launch.spec.mjs` | launch-e2e | Real-browser launch, paint ordering and offline timing |
| `tests/e2e/offline.spec.mjs` | launch-e2e | Existing a9/a10 assertions observe the final navigation |

The approved variant C fragment, its two glyph files and `gen_variant_c.py` are read-only inputs under `docs/arh-w-dev/designs/assets/2026-11-20-instant-launch/`. Line ranges below refer to `5a08ddb`.

## Tasks

### Task worker-launch: neutral launch, confirmation and cache-first reads

**Size** L · agent: worker · blocked_by: —

**Files:**

- Create `backend/app/static/js/offline/launch.js`.
- Modify `backend/app/static/js/sw.js:11-28,36-60` and `backend/app/static/js/offline/policy.js:29-45,94-98,221-301,324-426,460-489,518-535`.
- Test `tests/js/offline-worker-nav.test.mjs:5-17,35-152` plus the launch cases. Update existing fixtures in `tests/js/offline-router.test.mjs:411-417,475-575,613-640,750-769` and `tests/js/offline-worker-handle.test.mjs:89-106,189-256`.

**Interfaces.**

- Consumes `RF.db.getCurrentUser() -> Promise<Record|null>`, `RF.db.readMirror(caches) -> Promise<{state,value}>`, `RF.decision.gather(options?)`, `RF.decision.decide(state)`, `RF.router.shell(cacheName) -> Promise<Response|null>`, `RF.router.offlinePage(url) -> Response`, `network(event, request, timed, trace?) -> Promise<Response>`, and `GET /sync/changes` with cookie and `X-Readfine-User`. The endpoint's success is JSON with a token matching `/^[0-9a-f]{12}$/`.
- Produces `RF.launch.createPage(path, resultingClientId) -> Response`, `RF.launch.beginConfirmation(code, clientId) -> LaunchEntry|null`, `RF.launch.finishConfirmation(entry, state, context?) -> boolean`, `RF.launch.takeNavigation(code, path) -> LaunchEntry|null`. `LaunchEntry` holds `{code,path,createdAt,clientId,state,uid?,gen?,fallbackGen?}`, with state `issued|checking|confirmed|offline|rejected`. Policy owns the I/O in `confirmLaunch(event, code) -> Promise<Response>` and `respondLaunchNav(event, url, trace) -> Promise<Response>`. Extend `answerNav(event, trace, confirmedEntry?) -> Promise<Response|null>` with null only for a confirmed lookup that must go to the network. Extend `staticHit(request, uid, exact) -> Promise<Response|null>`. Browser contracts are `[data-rf-launch-page]`, `svg[data-rf-launch-animated]`, `svg[data-rf-launch-static]`, `[data-rf-launch-fallback]` and JSON `{go:"shell"|"login"|"server"|"network"}` from `GET /__rf/launch/<code>`.

- [ ] **RED:** `plain launch paints an isolated copy of the approved mark without storage`. Dispatch actual `sw.js` through `worker(...)` for `/` and `/app`, with a cold uninitialized worker, slow/rejecting preload, no record and empty caches. Make any IndexedDB read, Cache Storage access or worker fetch fail the test. Assert 200 HTML, `no-store`, zero storage and fetch calls, no reader marker, two nonces that differ across responses and match their HTML script/style. Extract the raw SVG fragment between the tile and closing SVG, and assert exact byte equality to `variant_c.svgfrag`. Assert no external loads, no progress element, and a bypass link to the original path revealed by CSS at 3 s. Evaluate the extracted script with mocked fetch/location/paint scheduling for each JSON answer. Assert a relative replacement preserving `#article-17` with both original paths for shell/server/bypass and `/login#article-17` for login. Assert iframe, non-GET, cross-origin, nonempty query and plain worker do not get the launch page.
- [ ] **RED:** `launch confirmation is single-use and classifies every server and transport outcome`. In one table-driven test, assert valid 200 → shell, 401 and a followed same-origin login redirect → login, 409/503/429/403/204 or non-login redirect and bad/malformed 200 JSON → server. Rejection and controlled 8000 ms timeout → shell as offline, with the pending fetch aborted on timeout. Inspect credentials/cache/header and assert one confirm fetch. Assert unknown/restarted, expired at exactly 60,000 ms, exceeded 16 entries, checking/used, and wrong client → network before I/O. For wrong client, the issuer still redeems successfully. Cover one missing browser id, forceOffline, absent/disabled/stale record, pending logout and wipe in record or mirror, and forget window. Resolve an in-flight 200 after `rf-forget-user` or a generation/mirror demotion and assert network.
- [ ] **RED:** `launch navigation consumes grants and keeps rejected checks off the stored shell`. Seed the real decision inputs. A live confirmed code yields the exact queued shell headers/body without a navigation fetch for R1 and an owned R6/L* case. With no owned shell, assert the server response. Assert offline grants use `answerNav` for both shell and neutral 503 without waiting on a second network attempt. Assert repeated, expired, unknown, wrong-path and bypass navigation use the old path with a network marker. Pause shell lookup after a confirmed grant, demote the mirror or change uid/gen, then verify no old shell. For `server` (including a still-known rejected code), assert a network 503 passes through, and a real rejection yields `Offline – Readfine` with no shell, including under forceOffline. Keep `server` behavior across a fresh worker.
- [ ] **RED (extend):** `launch timings distinguish the cold user read from static cache fallback`. Seed multiple exact and mismatched versions in pages and legacy caches. Assert pages beats legacy, legacy exact works, neither exact hit fetches, a different query misses and fetches, and a versioned miss plus rejection does not match the bare URL. Keep the cold-read and unversioned network-first/fallback assertions, including their timing outcomes. Keep unflagged `respondWith` count zero.
- [ ] Run: `node --test tests/js/offline-worker-nav.test.mjs`. Expected: failures on neutral HTML, confirmation/nav outcomes and cache-first assertions.
- [ ] **GREEN:** Import `launch.js` before policy in the flagged import array. In `onFetch`, route same-origin GET confirmation ahead of generic classification and route only top-level GET `navigate` with destination `document`, path `/` or `/app`, and no query to `createPage`. Ignore and drain any rejected preload promise without waiting for it. For private internal GETs match the `/__rf/launch/` route and return `network` for malformed or unknown codes. Respond synchronously via `respondWith`, preserve diagnostic timing rows and keep query values/code out of diagnostics. In existing JS tests where the subject is the old navigation decision/preload path, use `?rf_launch=bypass`, preserving the original assertions.
- [ ] **GREEN:** Issue 16 cryptographic random bytes as 32 lowercase hex digits, prune entries with age ≥60,000 ms, then evict oldest at capacity 16. Bind to `resultingClientId` and check the confirmation event's `clientId` when both exist. Set `checking` synchronously before I/O. Finalize only the same live entry. Delete a routed grant on navigation use, and keep a rejected entry through its bounded lifetime for fail-closed handling of that value. All confirmation responses use JSON and `Cache-Control: no-store`.
- [ ] **GREEN:** Build the launch page from constants and the issued path/code. Generate the independent CSP nonce with crypto randomness. Copy the approved raw fragment verbatim into `svg[data-rf-launch-animated]` inside the `0 0 512 512` icon tile, `rect rx="112"` filled `#3b82f6`. The static SVG uses the original white R/f paths and the same tile. Center both at `22vmin` on `#f9fafb` or `#141414` by scheme. Use only the nonce style block for layout, `prefers-reduced-motion: reduce` and the 3 s CSS reveal. The SMIL operations reviewed in il7-2 are path `d`/`stroke-width`/`opacity`, rect `x`/`y`/`width`/`height`, and `animateTransform` translate. Variant C specifically contains opacity on path/rect/group, the four rect geometry attributes and translate. Its `d` is static and it has no `stroke-width` animation. Keep its 4.2 s loop, per-element key times/splines and first/last mark as approved.
- [ ] **GREEN:** The nonce script starts `fetch('/__rf/launch/' + code)` immediately using same-origin credentials and no-store. Give the visible document a paint opportunity before replacing location, with no minimum display timer. Use the original path and current `location.hash` in the result table above. A failure to receive a usable JSON outcome navigates via `server` because the script has no transport verdict from the worker. The CSS link is a static `?rf_launch=bypass` link to the original path. The script preserves arbitrary fragments. A static no-JavaScript link has no access to the incoming fragment, which is absent from the worker request.
- [ ] **GREEN:** In `confirmLaunch`, reject an ineligible record or active forget window before fetch, and check pending restrictions in the current record and mirror. Include pending flags in the record comparison so a flag change advances the generation. Snapshot the uid, `current.gen` and `fallbackGen` after the initial state read. Use the existing 8 s timed `network()` with GET, `credentials:'include'`, `cache:'no-store'`, `redirect:'follow'` and `X-Readfine-User`. A 401 or same-origin redirected `/login` yields login. An unredirected valid 200 yields confirmed only after refreshing and rechecking uid, both generations, flags and forget window. Other HTTP/body outcomes set rejected. A transport rejection or timeout sets offline. A superseded or expired attempt yields network and never re-adds an entry.
- [ ] **GREEN:** For an eligible confirmed continuation recheck current record, uid, both generations, TTL and forget window. Run the existing decision inside `answerNav` and require the actual response's owner to equal the confirmed uid. Recheck the mirror's demotions after the cached response read, before returning its bytes. Check the generations again after the await and before mutating the fallback bookkeeping. Use untimed `network()` on no owned shell, or the old `respondNav` on an initially stale/superseded grant. An offline grant uses the existing `answerNav` semantics. Route `server` to untimed network and on rejection to `RF.router.offlinePage` directly. Route bypass and unknown/expired/consumed codes to `respondNav`. The path check and cleanup apply only to `/` and `/app`.
- [ ] **GREEN:** In `respond(...,'static',...)`, when `v` is nonempty, try exact full-URL match in the record's pages cache (or the existing guarded mirror fallback when appropriate), then legacy shell caches. A cache error or miss goes to network. Skip the second cache lookup after a network rejection on this path. For unversioned requests, preserve the existing network-first fallback and timing diagnostics. Put the exact requested version in existing versioned test fixtures that intentionally expect a cache hit.
- [ ] Run: `node --test tests/js/offline-worker-nav.test.mjs tests/js/offline-router.test.mjs tests/js/offline-worker-handle.test.mjs tests/js/offline-sw-update.test.mjs tests/js/offline-decision.test.mjs tests/js/offline-mirror.test.mjs tests/js/offline-logout.test.mjs && npm test`. Expected: both runs `ℹ fail 0`.

### Task clean-launch-url: remove the internal query key on app load

**Size** S · agent: worker · blocked_by: —

**Files:**

- Modify `backend/app/static/js/offline/page.js:1583-1590,1606-1612`.
- Test `tests/js/offline-page.test.mjs:34-115` plus the new startup case.

**Interfaces.**

- Consumes the launch URL key `rf_launch`, `root.location.href` and `root.history.state`. This is a literal URL contract shared with `worker-launch`, so the task can run independently.
- Produces page-internal `clearLaunchParam() -> void` called by `autoInit() -> Controller|null` before asynchronous startup work.

- [ ] **RED:** `page startup removes only the launch key and preserves history state`. Start a jsdom app page at `/app?feed_id=2&rf_launch=server&feed_id=3#article-17`. Assert one `replaceState` with the same state and URL `/app?feed_id=2&feed_id=3#article-17`; repeat without the key and assert no extra write. Check `/?rf_launch=bypass#section` and a hex code case as inputs, without waiting for IndexedDB or sync.
- [ ] Run: `node --test --test-name-pattern='page startup removes' tests/js/offline-page.test.mjs`. Expected: `not ok` with the launch key still present.
- [ ] **GREEN:** Parse the URL, delete only `rf_launch` if present and use `history.replaceState(history.state, '', pathname + search + hash)` on regular page.js startup. The call creates no history entry and triggers no navigation. Leave non-app paths alone. An already-published pre-feature shell may still run the older page.js until the existing startup sync republishes it.
- [ ] Run: `node --test tests/js/offline-page.test.mjs`. Expected: `ℹ fail 0`.

### Task shell-publish: integrity, splash exclusion and three distinct identities

**Size** M · agent: worker · blocked_by: —

**Files:**

- Modify `backend/app/static/js/offline/sync.js:532-656`.
- Test `tests/js/offline-sync.test.mjs:427-461,487-522,538-576,947-975` plus the new retention case.

**Interfaces.**

- Consumes `staticRefs(text, base, origin, cssOnly) -> string[]`, `openGuarded(cs, name, alive) -> Promise<Cache>`, `checkGuard(cs, name, alive) -> Promise<void>`, the existing `rf-sync` lock, Web Crypto SHA-256 and the eight-lowercase-hex `static_url(path: str) -> str` server convention.
- Produces unchanged `RF.sync.cachePages(opts) -> Promise<{stored:number,assets:number,savedAt:string}>`. The private `/__rf/pages-info` JSON adds `shellHistory: Array<{id:string,assets:string[]}>` (newest first, max 3). `shellIdentity(assets) -> Promise<string>` hashes the UTF-8 JSON of sorted distinct same-origin pathname+query references, including CSS dependencies and excluding `/app` and splash links.

- [ ] **RED (extend):** In `pages cache holds /app and its assets for this reader; the first v2 sync drops v1 shells and another reader's pages`, compute fixture versions with Node crypto over the actual CSS/JS bytes. Add startup links with `href` before and after `rel` and assert no splash URL is fetched or stored and its absence does not affect readiness. Keep CSS URL and `data-rf-scripts` dependencies and existing cleanup checks.
- [ ] **RED (extend):** In `a failed asset leaves the previous /app in place`, use real digest fixture URLs and keep the repeated HTTP failure assertions. Also return deliberately different bytes with HTTP 200 under a new expected digest. Assert `report.shell === 'failed'`, the mismatched key is absent, prior app/assets and `pages-info` are intact, and the prior successful `change_token` remains. Use digest-valid successes in the wipe fixture so a hash error cannot make it pass.
- [ ] **RED:** `pages retain the three most recent distinct published shell identities`. Start with a legacy `pages-info` without history and seeded shell A, including an A-only CSS dependency. Publish B, B again (change HTML/nonce and reorder asset references), C, a failed D, then D successfully. Assert A survives through failed D, B's repeat leaves one B entry, failed D does not change history or evict assets, and after successful D only A-only assets disappear. Assert shared/CSS dependencies still referenced by B/C/D stay. Pin recency with a subsequent republish of B and assert exact newest-first ids and asset count.
- [ ] Run: `node --test --test-name-pattern='pages cache holds|a failed asset|pages retain' tests/js/offline-sync.test.mjs`. Expected: failures for splash exclusion, wrong 200 bytes and missing retained assets/history.
- [ ] **GREEN:** Drop `link[rel~="apple-touch-startup-image"]` tags before HTML `src|href` collection regardless of attribute order. Keep existing `data-rf-scripts` and CSS traversal. For every versioned asset a6 writes, hash a clone of the decoded response bytes and reject if its lower-case SHA-256 prefix differs from the nonempty `v`. Keep exact cache key reuse. Enforce the guard across asynchronous validation as on normal writes. Treat mismatches as asset failures before publication.
- [ ] **GREEN:** Store the successful publication's canonical asset list and full digest in `shellHistory`, moving the published identity to the front after deduplication. Reconstruct the preceding identity from the previously published HTML and cached CSS when old metadata has no history. Use the existing metadata-then-shell write and rollback with the previous metadata response. On failure protect every previously retained asset and the published shell's dependencies from staged cleanup. Prune only after the app write succeeds, keeping the union of the three retained asset lists plus `/app` and `/__rf/pages-info`. If previous metadata or published dependencies cannot be read reliably, skip destructive cleanup for that publish. Preserve wipe guards, report counts and the successful-token commit gate.
- [ ] Run: `node --test tests/js/offline-sync.test.mjs tests/js/offline-mirror.test.mjs && npm test`. Expected: both runs `ℹ fail 0`.

### Task ios-splash: static startup images for the approved iOS and iPadOS matrix

**Size** M · agent: worker · blocked_by: shell-publish

**Files:**

- Create `scripts/gen_splash.py` and the 68 generated files under `backend/app/static/splash/`.
- Modify `backend/app/templates/base.html:20-39` and test in `backend/tests/test_pwa.py:17-21,53-59`.

**Interfaces.**

- Consumes `backend/app/static/icons/icon-512.png` and the approved CSS matrix. The complete `(device-width, device-height, DPR)` list is `(440,956,3), (402,874,3), (430,932,3), (393,852,3), (428,926,3), (390,844,3), (375,812,3), (414,896,3), (414,896,2), (375,667,2), (1032,1376,2), (1024,1366,2), (834,1210,2), (834,1194,2), (820,1180,2), (810,1080,2), (744,1133,2)`.
- Produces `python scripts/gen_splash.py`, entry point `main() -> None`. Each triple yields `backend/app/static/splash/WxH-Dx-O-S.png` for `O=portrait|landscape` and `S=light|dark`. This Cartesian product is the exact generated-file manifest. Each href is `/static/splash/WxH-Dx-O-S.png` and each media query is `(device-width: Wpx) and (device-height: Hpx) and (-webkit-device-pixel-ratio: D) and (orientation: O) and (prefers-color-scheme: S)`. Use unswapped CSS device dimensions for both orientations. PNG dimensions are `(W×D, H×D)` portrait and `(H×D, W×D)` landscape.

- [ ] **RED:** `test_apple_startup_images_match_the_device_matrix`. Render the real login head with `unauth_client`. Use stdlib `HTMLParser` and a test-owned expected matrix. Assert all 68 media/href pairs appear once, each file is served with 200, PNG IHDR pixel size and indexed color type match, and the aggregate is `< 4_000_000` bytes. Extend `test_manifest_start_url_is_inside_scope` to pin both existing color values.
- [ ] Run: `env $PGENV uv run pytest tests/test_pwa.py -k apple_startup_images -q`. Expected: `FAILED …::test_apple_startup_images_match_the_device_matrix` with zero links.
- [ ] **GREEN:** Create palette-quantised PNGs with Pillow. Composite the alpha icon at the center, squared to 22% of the shorter pixel side and resampled with LANCZOS, over RGB `#f9fafb` or `#141414`. Use a palette with undithered solid background and optimized PNG encoding. In the common base head loop over the same 17 triples, both orientations and both schemes for the matching links. Keep the manifest file byte-identical. The generator resolves inputs/outputs relative to its own location and reports the generated count and aggregate bytes.
- [ ] Run from the repo root: `backend/.venv/bin/python -c 'import PIL'`. Expected: exit 0 when Pillow is available there. Then `backend/.venv/bin/python scripts/gen_splash.py`. If the import fails, use the host interpreter: `python3 -c 'import PIL'` and, on exit 0, `python3 scripts/gen_splash.py`. The planning host has Pillow 10.2.0 in `python3`, while `backend/.venv` has no Pillow. If neither interpreter has it in the task runtime, the orchestrator runs the generator in its Pillow environment before verification. Expected from the generator: 68 indexed PNGs and aggregate `< 4_000_000` bytes. Deliver all 68 binaries for the orchestrator to commit with the task.
- [ ] Run: `env $PGENV uv run pytest tests/test_pwa.py tests/test_offline_page_shell.py -q`. Expected: `passed` with zero failures.

### Task launch-e2e: verify cold and warm launch in both browser engines

**Size** L · agent: worker · blocked_by: worker-launch, clean-launch-url, ios-splash

**Files:**

- Create `tests/e2e/instant-launch.spec.mjs`.
- Modify `tests/e2e/fixtures/freshness_app.py:13-26,49-55`, `tests/e2e/fixtures/seed.py:247-255,308-341` and `tests/e2e/offline.spec.mjs:154-159` for the final offline response.

**Interfaces.**

- Consumes `seed()`, `coldLaunch(playwright, testInfo, profileDir, {offline}) -> Promise<{context,page,setOffline}>`, `login(page, email, password)`, `enableOffline(page)`, `waitReady(page)`, launch DOM attributes, the `rf-diag` worker reply with `workerStartedAt` and `launchTimings`, and `APP_ENV.E2E_FIXTURE_DIR`.
- Produces test-only CLI `seed.py revoke-session <reader-id>` (stdout JSON `{revoked: true}`). For the first matching request, the fixture server reads `instant-launch.json` in `E2E_FIXTURE_DIR` with `{readerId,mode:"hold"|"observe"|"fail"}` and uses `instant-launch.release` to release a held request. The marker `instant-launch.seen` records `{status:null}` on arrival, then `{status:<HTTP status>}` when the response starts. These files exist only during a test inside the suite's existing ephemeral work directory.

- [ ] **RED:** `cold and warm online launch paint the mark before confirmation and reuse the stored shell`. Seed and close a persistent context. Capture the cached `/app` CSP after the seed shell is ready. Reopen the same profile to a blank page without a preparatory same-origin navigation. Arm the fixture and listeners before navigating `/app` with `waitUntil:'commit'`. While the actual worker's `/sync/changes` is held, assert the launch response is first, the inline mark has a visible rendered frame, and there is no personal text or signed-in DOM. In reduced motion assert computed `display:none` on animated SVG and visible static SVG. Under normal motion assert the SVG renders with the correct approved first/loop-end mark. Release the live request and assert its real 200, then compare final navigation CSP to the stored nonce and assert the signed-in app appears and the launch key is gone. Repeat from the same warm context without closing it, capture its last published CSP before relaunch, and verify the worker start timestamp is unchanged. The initial cold process must have a new worker start timestamp relative to seeding.
- [ ] **RED:** `revoked session paints login without a reader frame`. Seed and close the profile, keep the cookie and cached shell, revoke the session version via the fixture CLI, arm observe mode, reopen cold and navigate. Assert first neutral response, fixture-observed confirmation 401 and final sign-in form. Use response and per-document DOM observations installed before navigation to detect any intermediate signed-in body or seeded personal text.
- [ ] **RED:** `reachable 503 sends the browser to the server answer`. Seed an owned cache and reopen cold with fixture fail mode. Assert first neutral response, fixture-observed confirmation 503, final document navigation with `rf_launch=server` and the distinct fixture server body/status. Assert no stored-shell response or signed-in paint.
- [ ] **RED:** `cold airplane-mode launch paints the stored shell in under one second`. Seed and close a persistent context, then use `coldLaunch(...,{offline:true})` so WebKit is offline and the existing Chrome service-worker network abort is installed before the first navigation. Measure monotonic elapsed time from navigation start to the first visible cached shell frame, including the intermediate launch document. Assert `elapsedMs < 1000`, the launch response occurred first, a final cached-shell CSP match, and an offline read still yields the existing route marker. Keep a fresh cold process for this sample.
- [ ] Run against baseline with the test fixtures available: `npx playwright test tests/e2e/instant-launch.spec.mjs --project=webkit`. Expected: failures naming the four new tests because the first launch document or protocol is absent. Because this task starts after implementation, use an isolated baseline for RED if available. Otherwise record the upstream worker/sync RED evidence and run these browser cases as integrated regressions.
- [ ] **GREEN:** Expose the fixture controls only in the existing guarded loopback `readfine_e2e` launcher with one worker. Match only GET `/sync/changes` with the configured `X-Readfine-User`. On hold, record arrival and await release asynchronously for at most 6 s, then call the real app. Observe mode delegates immediately, and fail mode returns 503 and makes GET `/app?rf_launch=server` return a distinct 503 HTML sentinel. Record the actual status on the server because Playwright page routing misses WebKit worker-owned fetches. Implement revocation as a committed update of the seeded user's `session_token_version`, leaving browser storage intact. In browser tests register response/commit and frame observers before navigation so an immediate `location.replace` cannot elide observation. Let startup sync finish before reading the seeded cached CSP and worker timestamp. Use the cached CSP as response provenance, since a fresh server render creates a new nonce. Clear fixture files and remove each profile in `finally`.
- [ ] **GREEN:** In the existing `expectOfflinePage(page)` a9/a10 helper, listen for the final neutral 503 document before calling `goto`, and assert its status, title and absence of article rows. Allow that response to come from the first document when there is no launch hop. Where earlier `goto('/app')` assertions already wait for actual app DOM, retain those assertions. Keep freshness's real ingest, 35 s visible update and offline detail checks.
- [ ] Run: `npx playwright test tests/e2e/instant-launch.spec.mjs --project=webkit`. Expected: `4 passed`. The orchestrator runs `npx playwright test tests/e2e/instant-launch.spec.mjs --project=chrome` outside the Codex sandbox. Expected: `4 passed`.
- [ ] Integration: `npx playwright test --project=webkit`, orchestrator-only `npx playwright test --project=chrome`, and `npm test`. Expected: both browser suites report `passed` with zero failures, including existing a9, a10 and freshness, and JS reports `ℹ fail 0`. On integration, retain measured cold timings separately per browser. After separate merge/deploy approval, the owner checks cold killed-app and warm background-restored launches on iPhone, online and in airplane mode, and records the launch-timing report. Check the static splash in both schemes and orientations after iOS re-reads the page head, reinstalling the home-screen app if needed.

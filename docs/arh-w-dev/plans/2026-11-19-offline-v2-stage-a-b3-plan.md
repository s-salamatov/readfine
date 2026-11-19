# Readfine offline v2, Stage A + B3: Implementation Plan

Status: plan / draft · 2026-11-19 · run `run-d93c2098-b745-4339-b87e-74e58b153aa6`

**Goal:** a flagged service worker always answers a cold airplane-mode launch with the shell or our own offline page, and the device can say why when it doesn't (Stage A). Separately, the server fetches full text in the background for articles stored offline (B3).

**Architecture:** Stage A moves the navigation decision into one pure function, `RFOffline.decision.decide()`, in a new `offline/decision.js`. It reads the IndexedDB record plus a new Cache Storage mirror (`readfine-meta`, kept by `db.js`) and the per-user `readfine-pages-<uid>` cache. `sync.js` fills that cache, and `policy.js` serves from it. A new read-only `offline/diagnostics.js` on Preferences explains the state, even with a plain worker and no `page.js` controller. B3 is backend only. Migration 0128 adds the columns. `request_readable()` becomes the one trigger helper. The 1-minute readable job picks on-demand work first, then fills up to 30 newest-first backfill extractions, using `host_throttle`. A 15-minute marker job queues backfill for users who synced in the last 14 days.

**Tech stack:** plain-script JS (no modules) in the page and the service worker; node:test + jsdom + fake-indexeddb (`npm test`); Playwright 1.64.1 (Chrome `/usr/bin/google-chrome-stable` and WebKit 2370, both launch on this host); FastAPI, SQLAlchemy async, Alembic, APScheduler, pytest (`uv run pytest`).

**Design:** [docs/arh-w-dev/designs/2026-11-19-offline-v2-design.md](../designs/2026-11-19-offline-v2-design.md), revision 4 (sha256 `7c3eed64…`). Sections 4 (A1–A9) and 7 (B3). B1, B2 and B4 are not in this plan.

**Execution:** `native`.

**Owner fact (2026-11-19, answers design §12):** offline was switched on, and "Ready" was seen, *inside the home-screen app*. Candidate C (Safari/app storage split) is therefore not the cause. A7 stays a one-line note in a8. The diagnostics report (a8) must capture what explains a failed cold start inside the app: controller state, flagged vs plain worker, mirror contents, presence of the shell/pages cache, persist status, and the last update error.

## Global Constraints

Copied from the design.

- Cold launch in airplane mode always opens the app: the stored lists, articles and every screen below. It never shows Safari's error page.
- If something is broken, the device can say what. The owner can read it on the phone, without a Mac.
- No second copy of the UI in JavaScript beyond small templates. Screens stay server-rendered, as in v1.
- Under a flagged worker, no navigation path ends in a bare `network()` rejection. That includes the step-aside branch in `policy.js:150-154`.
- A failed read is never cached as "nobody". It is tried again on the next request.
- Write order: on switching off, logout, wipe and a sign-in forget, the mirror is written first (off / pending / stale), then the record, then the caches. On switching on, the record goes first, then the pages, then the mirror.
- The registration goes back to plain `/sw.js` only on: switching offline off, logout, account wipe, or account deletion.
- Ready needs all of: the last sync finished; the shell cached in `readfine-pages-<uid>`; the current-user record readable with offline on; a controller whose `scriptURL` contains `offline=1`; `storage.persisted()` asked for. Otherwise the status line says "Not ready: <reason>".
- A `versionchange`, a forget (sign-in) or a wipe still closes the worker's database handle at once, so `wipeAll` is never held up.
- Cleanup: the current user is the record's uid, or the mirror's when the record is unreadable or missing. If neither gives a uid, or they disagree, no pages cache is deleted.
- Wipe order is a tested invariant: the mirror is set to pending first, then caches are deleted, then the user databases, then `readfine-offline-current` last.
- Copy (exact): "Offline files failed to load. Open the app once online." · "update failed, previous version running" · "The Home Screen app keeps its own offline copy — turn this on inside the app." · "Not ready: <reason>".
- "Copy report": plain text with no article content.
- Deferred review minors: (d4m1) retry a failed mirror write on every `rf-current-user` and on every sync. (d4m2) If a mirror write fails during forget/off/logout/wipe, delete `readfine-meta`, or abort before touching the IndexedDB record. (d4m3) The legacy fallback uses the record's uid when the record is readable, otherwise the mirror's: the same rule as cleanup.
- B3: `readable_priority` (0 on-demand, 1 backfill) and `readable_queued_at`, with an index on `(readable_status, readable_priority, readable_queued_at)`. Backfill marks only `skipped` articles, at priority 1. Users: those whose device synced in the last 14 days. `users.offline_synced_at` is written at most once an hour. Batches of 200.
- B3 limits: backfill makes at most 30 extractions a minute. Each host gets a floor of one backfill request every 5 s. The picker reads up to 100 candidates and skips hosts that are waiting. On-demand work is not counted against the 30 (on-demand 20 plus backfill up to 30 per run). When a host is shared, feed fetches go before backfill.
- B3 AI: the pipeline runs after an extraction only if the re-read priority is 0. A plain backfill extraction does not run it.
- Project (CLAUDE.md): CSP is nonce-based, so an inline `<script>` needs the nonce and inline handlers live in external JS. After changing classes in templates, run `npm run build`.
- Workers do not commit. At most 5 new tests per task.

**Commands used below.** JS: from the repo root, `node --test tests/js/<file>`. Backend, from `backend/`, with `PGENV='DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4250/readfine_test SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd'`: `env $PGENV uv run pytest <file> -q`. The dev Postgres is `readfine-dev-pg` on `127.0.0.1:4250` (running), and `readfine_test` is at head `0127`. e2e: `npx playwright test tests/e2e/offline.spec.mjs` (uses `readfine_e2e`; its global setup migrates).

## Review Focus

1. **A shell asset fails mid-sync.** `/app` must not be replaced by a page whose CSS/JS is missing. The previous `/app` stays, and the sync reports `shell: 'failed'`. Test: a6 `a failed asset leaves the previous /app in place`.
2. **The mirror entry is corrupt (not JSON, or no `uid`).** Treat it as unreadable (offline page), never as "uid null, offline on". Test: a1 `readMirror: corrupt body reads as unreadable`.
3. **A cold launch at `/app?open_article_id=5` or `/app?utm=…`.** The shell is served via `ignoreSearch`. Test: a4 `query string on /app still gets the shell`.
4. **iOS evicted the article database but the record still says on.** The next online start re-syncs on its own instead of stopping at "Sync now to store it again". Test: a7 `own database gone with the record on: the next online start re-syncs`.
5. **"Test offline launch" with a plain worker, or no controller.** The answer comes within 2 s ("no flagged worker: Safari's page would show"), never a hang. Test: a8 `test launch without a flagged controller answers within 2 s`.

## File map

JS paths are under `backend/app/static/js/`. Tests are under `tests/js/` unless a path is given.

| File | Responsibility | Task(s) |
|---|---|---|
| `tests/js/harness.mjs` | exported worker harness, `fakeCaches` extras, loads `decision.js` | a0, a2 |
| `offline-router.test.mjs` | imports the moved harness; v1-shell worker cases updated to the new rows | a0, a4 |
| `offline/db.js` | mirror, write/wipe order, offline flags, cache names, cleanup, `shellUser` | a1 |
| `offline/decision.js` (new) | `decide()`, `gather()` | a2 |
| `sw.js`, `offline/sw-register.js` | install fails on an import error; missing-scripts page; `rf-diag`; last update error | a3 |
| `offline/policy.js` | navigations via `decide()`, fallback uid, activation cleanup, `rf-test-launch`; then the refcounted handle | a4, a5 |
| `offline/router.js` | `shell()` from `readfine-pages-<uid>` | a4 |
| `offline/sync.js` | `cachePages()`, cleanup, `syncMirror` on every run | a6 |
| `offline/page.js`, `offline/boot.js` | no demotion, record restore, honest Ready, logout/off order, long press, `rf-last-sync`; then the reconnect probe | a7, a11 |
| `offline/diagnostics.js` (new), `templates/settings/preferences.html`, `backend/app/templating.py`, `static/css/tailwind.css` (rebuilt) | diagnostics panel | a8 |
| new: `offline-mirror`, `offline-decision`, `offline-sw-update`, `offline-worker-nav`, `offline-worker-handle`, `offline-diagnostics` (`.test.mjs`) | unit tests | a1, a2, a3, a4, a5, a8 |
| `offline-sync.test.mjs` / `offline-page.test.mjs`, `offline-boot.test.mjs` | updated | a6 / a7 |
| `tests/e2e/helpers.mjs`, `tests/e2e/offline.spec.mjs` | `coldLaunch()`; the cold-start group, then the guards group | a9, a10 |
| `backend/alembic/versions/0128_readable_backfill.py` (new), `backend/app/models/{article,user}.py`, `backend/tests/test_migration_0128.py` | columns, index | b3-migration |
| `backend/app/services/readable_service.py` | `request_readable()`; then the picker, backfill and pipeline gate | b3-request-readable, b3-picker |
| `backend/app/routers/web/app/articles.py`, `backend/app/services/{article,filter_service,label_service}.py`, `backend/app/services/sync/ops.py`, `backend/tests/test_request_readable.py` | triggers | b3-request-readable |
| `backend/tests/test_readable_backfill_picker.py` | picker tests | b3-picker |
| `backend/app/services/readable_backfill.py` (new), `backend/app/fetcher/scheduler.py`, `backend/app/routers/web/sync.py`, `backend/tests/test_readable_backfill.py` | marker job, `offline_synced_at` | b3-marker |

No Stage A task writes a backend file that a B3 task lists. The B3 chain (`b3-migration` → {`b3-request-readable` → `b3-picker`, `b3-marker`}) can run in parallel with the whole Stage A chain.

## Tasks

### Task a0-test-harness: shared worker harness

**Size** S · agent: worker · blocked_by: —

**Files:**
- Modify: `tests/js/harness.mjs` (`fakeCaches` at 129-154; new exports)
- Modify: `tests/js/offline-router.test.mjs:394-457`: move `worker()` and `seedWorkerDb()` out (`rec`, `rowHtml`, `detailHtml` and `LISTS` move with them as exports)

**Interfaces.**
- Produces: `worker({fetchImpl, current, script, registration, imports})`. `registration` is merged into `ctx.registration`. `imports` maps a URL to a file body or to `null` for a 404, so `importScripts` throws a `NetworkError`-like `TypeError`. It returns `{ctx, listeners, calls, cacheStorage, preload, imported, userReads, dispatch(request, extra), activate(), install(), message(data) -> Promise<reply>}`. `install()` resolves or rejects with the `waitUntil` promises. `message()` passes a `MessageChannel` port and resolves with the first reply.
- Produces: `fakeCaches({putHook, failOpen})`. `match(r, {ignoreSearch})` compares URLs without their search when asked. `failOpen(name) -> bool` makes `open`/`put` on that cache reject.

- [ ] **RED:** none (no behaviour change). Guard: the move leaves the existing suite green.
- [ ] **GREEN:** move the harness and extend `fakeCaches` as above. `offline-router.test.mjs` imports them.
- [ ] Run: `npm test`. Expected: `ℹ fail 0`, and `ℹ pass 250`, the count measured on 2026-11-19 before any change.

### Task a1-db-mirror: the `readfine-meta` mirror, write order, wipe order

**Size** M · agent: worker · blocked_by: a0-test-harness

**Files:**
- Modify: `offline/db.js` (current-user section 172-298; `deleteCaches`/`wipeAll` 634-705; `RF.db` export)
- Test: `tests/js/offline-mirror.test.mjs` (new)
- Modify (existing assertions only, if the new order breaks them): `tests/js/offline-logout.test.mjs` (forget at 952-1006, wipe at 533 and 831)

**Interfaces.**
- Produces, on `RF.db`:
  - `META_CACHE = 'readfine-meta'`, `PAGES_PREFIX = 'readfine-pages-'`, `MIRROR_URL = '/__rf/meta'` (resolved against `location.origin`)
  - `META.offlineFlags = 'offline_flags'`: the user database stores `{offlineEnabled, forceOffline}`
  - `readMirror(cs) -> Promise<{state: 'ok'|'missing'|'unreadable', value: Mirror|null}>`, where `Mirror = {uid:number, offlineEnabled, forceOffline, logoutPending, wipePending, stale, at}`
  - `markMirror(cs, patch) -> Promise<'written'|'deleted'>`: read, merge, put. If the put fails, delete `readfine-meta` and resolve `'deleted'`. Reject only when the delete fails too (d4m2: the caller aborts).
  - `syncMirror(cs) -> Promise<boolean>`: rewrites the mirror from the current record when it is readable and present (d4m1). A missing or unreadable record leaves the mirror untouched and returns `false`, because that is exactly the case the mirror exists for. Only the explicit paths (`setCurrentUser(null)`, off, forget, wipe) demote it.
  - `currentUid({record, recordState, mirror, mirrorState}) -> number|null`: the cleanup rule from Global Constraints
  - `shellUser(html) -> number|null`: the `data-rf-user` of the `<body>` tag only. It lives here because both the page (`sync.js`) and the worker load `db.js`.
  - `cleanupCaches(cs, uid) -> Promise<string[]>` (deleted names): deletes each `readfine-pages-*` other than `uid`, and each `readfine-shell-*` only when `readfine-pages-<uid>` holds `/app`. A null `uid` deletes nothing.
  - `setCurrentUser(userId, opts)` keeps its signature. Off, null and `forceOffline` changes go mirror first (it awaits `markMirror`; a rejection aborts with the record untouched), then the record. On goes record first, then `syncMirror`, whose failure is swallowed and retried on the next call. Either way, `META.offlineFlags` is written to an existing user database (via `openExisting`; never created).
  - `forgetCurrentUser()`: `markMirror({stale:true})` first; a rejection returns `false` without touching the record.
  - `deleteCaches` also deletes `readfine-pages-*` and `readfine-meta`. `wipeAll` order: `markMirror({wipePending:true})`, then the caches, then the user databases, then `CURRENT_DB` last.

- [ ] **RED:** `switching on writes the record before the mirror; switching off writes the mirror first`. Record the order of calls to a spy `fakeCaches.putHook` and a wrapped `idbFactory`. `assert.deepEqual(order, ['record','mirror'])` for on and `['mirror','record']` for off. The mirror then reads `{state:'ok', value:{uid:7, offlineEnabled:false}}`.
- [ ] **RED:** `a failed mirror write is deleted, or aborts the forget (d4m2)`. With `failOpen('readfine-meta')` on put only, `forgetCurrentUser()` resolves, `caches.has('readfine-meta') === false`, and the record is `stale`. When the delete also fails, it returns `false` and `getCurrentUser()` still lacks `stale`.
- [ ] **RED:** `a mirror write that failed is retried by the next setCurrentUser (d4m1)`. On fails for the mirror once, then the same call is repeated: the mirror reads `uid:7, offlineEnabled:true`. Then delete `readfine-offline-current` and call `syncMirror`: it returns `false`, and the mirror still reads `uid:7, offlineEnabled:true`.
- [ ] **RED:** `wipe order: mirror pending, caches, user databases, current last`. The spy order equals `['mirror:wipePending','caches','readfine-offline-7','readfine-offline-current']`. Afterwards `keys()` has no `readfine-media-*`, `readfine-shell-*`, `readfine-pages-*` or `readfine-meta`.
- [ ] **RED:** `readMirror: corrupt body reads as unreadable` (Review Focus 2). A body `'not json'` gives `state:'unreadable'`, and `{"offlineEnabled":true}` without a `uid` also gives `'unreadable'`. Also `currentUid` cases: the record's uid 7 with the mirror's 9 gives `null`; record unreadable with mirror 9 gives `9`; both missing gives `null`.
- [ ] Run: `node --test tests/js/offline-mirror.test.mjs`. Expected: `ℹ fail 5`.
- [ ] **GREEN:** the functions above in `db.js`.
- [ ] Run: `node --test tests/js/offline-mirror.test.mjs && npm test`. Expected: `ℹ fail 0` on both. `offline-sync.test.mjs` "wipeAll deletes databases and caches" still passes.

### Task a2-decision-table: one pure decision function

**Size** M · agent: worker · blocked_by: a1-db-mirror

**Files:**
- Create: `offline/decision.js` (plain script, no DOM; `RF.decision`)
- Modify: `tests/js/harness.mjs`: add `'decision.js'` after `db.js` in `loadOffline`
- Test: `tests/js/offline-decision.test.mjs` (new)

**Interfaces.**
- Consumes: `RF.db.getCurrentUser`, `readMirror`, `PAGES_PREFIX`, `SHELL_PREFIX` (a1).
- Produces: `RF.decision.decide(input) -> {row, answer: 'shell'|'offline', cache: string|null}`. Input: `{record, recordState: 'ok'|'missing'|'unreadable', mirror, mirrorState, forgetWindow: bool, pages: [{name, hasApp, appUser}], legacy: [{name, hasApp, appUser}]}`. Row ids, in table order:
  - `R1`: the record's own pages
  - `R1-miss`
  - `R2`: stale, forget window, or mirror stale/logout/wipe pending
  - `R3`: record off
  - `R4`: no record and no mirror
  - `R5`: no record; the mirror says stale/pending/off
  - `R6`: mirror-only shell
  - `R7`: anything else
  - `L1`/`L6`: legacy `readfine-shell-*` under the conditions of R1/R6
- `L1`/`L6` apply only when no `readfine-pages-*` exists. They need `appUser` equal to the record's uid when the record is readable, else to the mirror's (d4m3).
- Interpretation: a mirror with `logoutPending`/`wipePending` is treated as R2 even when the record is readable and on. Logout writes the mirror first, so a record write that fails after it must not leave a shell.
- Produces: `RF.decision.gather({db: RF.db, caches, forgetWindow, tries: 3, delayMs: 100}) -> Promise<input>`. It reads the record up to 3 times, 100 ms apart. `appUser` is `RF.db.shellUser()` of the cached `/app` body.

- [ ] **RED:** `every row of the A1 table`. Table-driven, one `assert.deepEqual` per row:
  - `{recordState:'ok', record:{userId:7,offlineEnabled:true}, pages:[{name:'readfine-pages-7',hasApp:true,appUser:7}]}` → `{row:'R1',answer:'shell',cache:'readfine-pages-7'}`
  - the same with no pages → `R1-miss`/offline
  - `record.stale` → `R2`; `forgetWindow:true` → `R2`; `mirror.stale` → `R2`; `mirror.logoutPending` → `R2`
  - `offlineEnabled:false` → `R3`
  - unreadable with a missing mirror → `R4`
  - missing with `mirror.wipePending` → `R5`
  - missing with mirror `{uid:7,on}` and `pages:[readfine-pages-7 hasApp appUser 7]` → `R6`/shell
  - the same with a second `readfine-pages-9` → `R7`; with `appUser:9` → `R7`
- [ ] **RED:** `legacy shell only for the record's uid, else the mirror's (d4m3)`. With `legacy:[{name:'readfine-shell-2',hasApp:true,appUser:7}]` and no pages, record 7 on gives `L1`, and record 9 with mirror 7 gives `R1-miss`. With the record unreadable, mirror 7 gives `L6`; with a `readfine-pages-7` present (no `/app`), the answer is `R7`.
- [ ] **RED:** `gather retries an unreadable record 3 times, 100 ms apart, then reports unreadable`. Stub `getCurrentUser` to reject 3×. The result is `recordState === 'unreadable'`, with 3 calls and ≥200 ms elapsed. After 2 rejections and then a value, the result is `'ok'`.
- [ ] **RED:** `gather reads appUser from the cached /app body tag only`. A cached `/app` of `'<body class="x" data-rf-user="12">'` gives `appUser: 12`. `'<script data-rf-user="5">'` with no body tag gives `appUser: null`, and `decide` then answers R7/R1-miss.
- [ ] Run: `node --test tests/js/offline-decision.test.mjs`. Expected: `ℹ fail 4`.
- [ ] **GREEN:** `decision.js` as specified.
- [ ] Run: `node --test tests/js/offline-decision.test.mjs && npm test`. Expected: `ℹ fail 0`.

### Task a3-sw-update-safety: a broken update can't replace a good worker

**Size** M · agent: worker · blocked_by: a2-decision-table

**Files:**
- Modify: `sw.js:33-55` (imports, install), `sw.js:68-88` (message listener in both modes)
- Modify: `offline/sw-register.js` (`register`, `ensure`, export)
- Test: `tests/js/offline-sw-update.test.mjs` (new)

**Interfaces.**
- `sw.js` (flagged):
  - `importScripts` adds `'/static/js/offline/decision.js'` after `db.js`.
  - An import error is caught into `importError`, so `offline = null`. The `install` listener then calls `event.waitUntil(Promise.reject(importError))` and skips `skipWaiting`. The new worker's install fails and goes `redundant`, and the previous worker keeps control.
    - This distinguishes the cases by the install event, not by URL: a deploy update keeps the same URL `/sw.js?offline=1`, so a URL comparison can't tell an update from a restart. A restarted installed worker gets no install event.
    - Interpretation of design A3 "re-thrown": failing `install` gives the same outcome (the old worker stays) without breaking the restart case.
  - A running worker with `importError` set (a restart that found its scripts missing) answers every navigation with an inline 503 page: "Offline files failed to load. Open the app once online." Its CSP is `default-src 'none'; style-src 'unsafe-inline'`.
- `sw.js` (both modes): `message` `{type:'rf-diag'}` replies on `event.ports[0]` with `{flagged, scriptsLoaded: !!offline, importError: string|null}`.
- `sw-register.js`: `RF.sw.lastError() -> {at, script, message}|null`, persisted in `localStorage['rf-sw-error']`.
  - `untilActive` already watches the installing worker. When it ends `redundant` instead of `activated`, that writes `{message: 'install failed'}`, because `register()`/`update()` resolve in this case.
  - A rejected `doRegister` writes its error. An `activated` worker with the wanted flag clears it.
  - `RF.sw.update() -> Promise<reg>` (calls `reg.update()`, then `untilActive`) is exported for a10 and diagnostics.

- [ ] **RED:** `a deploy update whose import 404s fails install, even with an active worker at the same URL`. `worker({registration:{active:{scriptURL:'https://readfine.test/sw.js?offline=1'}}, imports:{'/static/js/offline/decision.js': null}})`: `await assert.rejects(w.install())`, and `skipWaiting` is not called.
- [ ] **RED:** `a running worker with a missing import answers navigations with the built-in page`. The same worker, without `install()`: `dispatch(navigate /app)` gives status 503, a body containing "Offline files failed to load. Open the app once online.", and the CSP header above.
- [ ] **RED:** `rf-diag answers in both modes`. A plain worker replies `{flagged:false, scriptsLoaded:false}`; a flagged one with good imports replies `{flagged:true, scriptsLoaded:true, importError:null}`.
- [ ] **RED:** `a failed update is kept as the last update error and cleared by the next success`. A fake container whose `register` resolves a registration with `installing` going `redundant`: `RF.sw.register({offline:true})` resolves, and `RF.sw.lastError().message === 'install failed'`. Then a registration whose worker goes `activated` gives `lastError() === null`.
- [ ] Run: `node --test tests/js/offline-sw-update.test.mjs`. Expected: `ℹ fail 4`.
- [ ] **GREEN:** as specified.
- [ ] Run: `node --test tests/js/offline-sw-update.test.mjs && npm test`. Expected: `ℹ fail 0`.

### Task a4-worker-nav: navigations via the decision table

**Size** L · agent: worker · blocked_by: a3-sw-update-safety

**Files:**
- Modify: `offline/policy.js` (`loadCurrent` 41-58, `onFetch` 133-156, `respond` 192-226, `staticHit` 228-239, `offline` 241-253, `onActivate` 160-164, `onMessage` 255-266)
- Modify: `offline/router.js:474-487` (`shell`), `router.js:571-575` (`handle`)
- Test: `tests/js/offline-worker-nav.test.mjs` (new)

**Interfaces.**
- Consumes: `RF.decision.gather/decide` (a2); `RF.db.currentUid`, `cleanupCaches`, `readMirror` (a1).
- `loadCurrent`: a rejected read leaves `current.loaded = false` (re-read on the next request) and sets `current.readError = true`. It never settles to `null`.
- A navigation (`kind === 'nav'`) with the network down, or with `forceOffline`, or with the current user unknown or null: `answerNav(event) -> Promise<Response>`, which does `decide(await gather({forgetWindow: Date.now() - forgotAt < FORGET_WINDOW_MS}))`. A shell answer is `cache.match('/app', {ignoreSearch:true})` from the decided cache. Anything else is `router.offlinePage(url)`.
- The step-aside branch (`current.loaded && !enabled()` with a nav) becomes `respondWith(network(...).catch(() => answerNav(event)))`. No navigation path rejects.
- `fallbackUid() -> Promise<number|null>`: the mirror's uid when `decide(await gather())` gives R6 or L6, memoised until the next `rf-current-user` or a readable record. Every request kind derives it, not only navigations, so a worker restarted mid-session still has it. While the record is missing or unreadable, `/htmx/` and media then use `userDb(fallbackUid)`.
- `staticHit(request, uid)`: look in `readfine-pages-<uid>` first (with `ignoreSearch` as a fallback, as today), then any `readfine-shell-*` (legacy). `uid` is the record's, else `fallbackUid()`. A `/static/` request whose network attempt fails always ends in `staticHit`, including when the record is unreadable; there is no bare network rejection for the shell's own assets.
- `router.shell(cacheName)` returns `/app` from that cache with `ignoreSearch`. `router.handle(request, db, {shellCache})` uses it for `/` and `/app`.
- `onActivate()` also runs `cleanupCaches(caches, currentUid(await gather()))`.
- `onMessage` `{type:'rf-test-launch'}` replies on the port with `decide(await gather(...))` plus `{pages: names, legacy: names, recordState, mirrorState}`. It never touches the network.

- [ ] **RED:** `record unreadable, mirror in place: a cold navigation gets the shell, and the failed read is not cached`. `getCurrentUser` rejects, the mirror is `{uid:1,on}`, and `readfine-pages-1` holds `/app` with `data-rf-user="1"`. `fetch` rejects. A nav to `/app` gives 200 and the shell body. A second nav calls `getCurrentUser` again (`userReads()` grows). `/htmx/sidebar` is answered from the user-1 database (status 200, `X-Readfine-Offline: 1`). `/static/css/tailwind.css?v=abc`, stored in `readfine-pages-1`, is answered 200 from that cache. This holds on a fresh `worker()` too (a restart), with no navigation before it.
- [ ] **RED:** `the step-aside branch never rejects`. The record says off, `fetch` rejects, and a nav with `preloadResponse` rejecting gives status 503 from the offline page, not a rejected promise.
- [ ] **RED:** `query string on /app still gets the shell` (Review Focus 3). `/app?open_article_id=5` and `/app?utm_source=x` both get the shell body.
- [ ] **RED:** `activation with IndexedDB unreadable keeps readfine-pages-U and drops another user's`. With the record unreadable and mirror uid 1, the caches `readfine-pages-1`, `readfine-pages-2` and `readfine-shell-2` (where pages-1 has `/app`) are left as `['readfine-meta','readfine-pages-1']` after `activate()`. With the mirror missing too, all three stay.
- [ ] **RED:** `rf-test-launch replies with the row and never fetches`. With record 1 on and pages-1 cached, `message({type:'rf-test-launch'})` gives `{row:'R1', answer:'shell'}` and the fetch spy is called 0 times.
- [ ] Run: `node --test tests/js/offline-worker-nav.test.mjs`. Expected: `ℹ fail 5`.
- [ ] **GREEN:** as specified. Existing `offline-router.test.mjs` worker tests that expected the v1 `readfine-shell-*` shell, or "unreadable = nobody", get updated to the new rows, each with a one-line comment naming the row.
- [ ] Run: `node --test tests/js/offline-worker-nav.test.mjs && npm test`. Expected: `ℹ fail 0`.

### Task a5-worker-handle: refcounted database handle (startup race)

**Size** M · agent: worker · blocked_by: a4-worker-nav

**Files:**
- Modify: `offline/policy.js` (`dropHandle`, `forget`, `resetCurrent`, `userDb`, `offline`, `onMessage`)
- Test: `tests/js/offline-worker-handle.test.mjs` (new)

**Interfaces.**
- The handle cache becomes `{userId, db, refs, retired}`. `acquire(userId) -> Promise<{db, release()}>` replaces the direct `userDb()` use in `offline()`, which releases in `finally`.
- `rf-current-user`: re-read the record. If `userId`, `offlineEnabled`, `forceOffline` and `stale` all equal the loaded value, do nothing (no handle drop, no cache clear). Otherwise swap the value and mark the old handle `retired`; it closes when `refs` reaches 0.
- Also on `rf-current-user`: `RF.db.syncMirror(caches)` (d4m1: retried on every message).
- `forget()`, `versionchange` and `wipeAll` close at once, whatever `refs` is.

- [ ] **RED:** `an unchanged rf-current-user leaves the handle open`. Start `/htmx/articles` (the router is slowed with a deferred promise) and send `rf-current-user` with an identical record. The request then resolves 200 with rows, and `db.closed === false`.
- [ ] **RED:** `a changed record retires the old handle only after its requests finish`. Same, but `forceOffline` flips. The in-flight request resolves 200, and afterwards the old `db.closed === true`.
- [ ] **RED:** `forget and versionchange close at once`. With a request in flight, `message({type:'rf-forget-user'})` makes `db.closed === true` synchronously after dispatch. `RF.db.wipeAll()` resolves within 1 s with a request still pending.
- [ ] **RED:** `rf-current-user retries the mirror (d4m1)`. `readfine-meta` is deleted and the record is on for 1. After the message, `readMirror` gives `{uid:1, offlineEnabled:true}`.
- [ ] Run: `node --test tests/js/offline-worker-handle.test.mjs`. Expected: `ℹ fail 4`.
- [ ] **GREEN:** as specified.
- [ ] Run: `node --test tests/js/offline-worker-handle.test.mjs && npm test`. Expected: `ℹ fail 0`.

### Task a6-sync-pages: the per-user pages cache

**Size** M · agent: worker · blocked_by: a1-db-mirror

**Files:**
- Modify: `offline/sync.js:497-578` (`cacheShell` → `cachePages`), `sync.js:660-668` (call site), the end of `runOnce`
- Test: `tests/js/offline-sync.test.mjs` (rewrite "shell cache stores /app…" at 373 and "…not written from a login redirect" at 401 for the new name; add the cases below)

**Interfaces.**
- Consumes: `RF.db.PAGES_PREFIX`, `cleanupCaches`, `currentUid`, `readMirror`, `syncMirror` (a1).
- Produces: `cachePages({caches, fetchFn, userId, templateVersion, alive}) -> Promise<{stored, assets, savedAt}>`. It writes into `readfine-pages-<userId>`. A redirect or non-200 is refused, as today. A body whose `shellUser()` is not `userId` throws `'shell: not this reader'`. The assets are fetched and stored **first**; `/app` is put last. So a failed asset leaves the previous `/app` in place. A `/__rf/pages-info` entry holds `{templateVersion, savedAt}`. It no longer deletes other caches itself.
- `RF.sync.cacheShell` is removed. The export becomes `cachePages`.
- Sync report: `report.shell: 'ok'|'failed'|'skipped'` plus `report.shellError: string|null`. After `'ok'`, run `cleanupCaches(cs, currentUid({record, mirror}))`. That is where v1 `readfine-shell-*` is dropped after the first v2 sync.
- Every run ends with `RF.db.syncMirror(cs)` (d4m1), failure ignored.
- The reader check uses `RF.db.shellUser` (a1). `sync.js` runs in the page, where `decision.js` isn't loaded.

- [ ] **RED:** `pages cache holds /app and its assets for this reader; the first v2 sync drops v1 shells and another reader's pages`. With `readfine-shell-2` and `readfine-pages-9` before the sync, the keys after `run()` are `['readfine-media-7','readfine-meta','readfine-pages-7']`. `/app` matches with `ignoreSearch`, and `report.shell === 'ok'`.
- [ ] **RED:** `a failed asset leaves the previous /app in place` (Review Focus 1). The second sync's `/static/css/x.css` returns 500, so `report.shell === 'failed'` and `/app` is still the first sync's body.
- [ ] **RED:** `another reader's /app is refused`. `/app` returns a body with `data-rf-user="9"` for user 7: `report.shell === 'failed'`, `shellError` matches `/not this reader/`, and there is no `readfine-pages-7` `/app`.
- [ ] **RED:** `every sync rewrites the mirror (d4m1)`. `readfine-meta` is deleted before `run()` and reads `{uid:7}` after it.
- [ ] Run: `node --test tests/js/offline-sync.test.mjs`. Expected: `ℹ fail 4` or more (the renamed tests also fail until GREEN).
- [ ] **GREEN:** as specified.
- [ ] Run: `node --test tests/js/offline-sync.test.mjs && npm test`. Expected: `ℹ fail 0`.

### Task a7-page-start: no demotion, honest Ready, mirror order on the page

**Size** L · agent: worker · blocked_by: a6-sync-pages, a3-sw-update-safety

**Files:**
- Modify: `offline/page.js`: `start` 1082-1144, `disable` 479-494, `removeData` 498-506, `logout` 713-750, `finishLogout` 686-711, `statusLine` 782-801, `refreshCounts` 218-240, `settle` 388-425, `listen` 1037-1067, `autoSync` 427-437
- Modify: `offline/boot.js:173-188` (`check`): drop `W.ensure(false)`
- Test: `tests/js/offline-page.test.mjs`, `tests/js/offline-boot.test.mjs`, `tests/js/offline-logout.test.mjs`

**Interfaces.**
- Consumes: `RF.db.markMirror`, `syncMirror`, `META.offlineFlags`, `PAGES_PREFIX` (a1); `report.shell` (a6).
- `start()`:
  - A read that fails twice sets `st.storeUnreadable = true` and makes no `W.ensure`/`register` call.
  - A missing record with `openExisting(userId)` non-null: read `META.offlineFlags`. If `offlineEnabled`, call `setCurrentUser(userId, flags)` and `W.ensure(true)`. Absent or false means off, with no demotion call.
  - `W.ensure(false)` only when the record positively says off, or after a foreign wipe, or when there is no record and no own database.
  - When enabled: `nav.storage.persist()` is asked once per start, and `st.persistAsked = true` once it settles (granted or not). A browser without `navigator.storage.persist` counts as asked, so it never blocks Ready. A missing own database runs `openDb(true)` and an auto sync (A9). `st.missing` no longer blocks `autoSync` when online.
- `disable()`: `setCurrentUser(off)` (mirror first, a1), then `caches.delete('readfine-pages-' + userId)`, then `W.register({offline:false})`.
- `logout()` at commit: `await D.markMirror(caches, {logoutPending:true, wipePending:true})` before the markers. A rejection means the d4m2 abort: no `setCurrentUser`/wipe, and the markers are left set, then `nativeLogout()`. It returns `'mirror-failed'`.
- `removeData()` goes through `wipeAll` (a1 order).
- Ready: `st.shellOk` comes from `caches.open('readfine-pages-'+userId)` and `.match('/app', {ignoreSearch:true})` in `refreshCounts`. `st.flaggedController` comes from `navigator.serviceWorker.controller.scriptURL` matching `offline=1`. `statusLine()` returns the existing "Ready for offline · …" only when `lastSync && shellOk && enabled && !storeUnreadable && flaggedController && persistAsked`. Otherwise it gives "Not ready: " + the first failing reason, in this order:
  - "not synced yet"
  - "app page not stored on this device"
  - "offline settings could not be read"
  - "this page is not under the offline worker"
  - "persistent storage not requested"
- After each `settle()`, `localStorage['rf-last-sync'] = JSON.stringify({finishedAt, error, shell, shellError, articles, snapshots, media: {done, failed}, pendingOps})`. No titles, no URLs.
- A long press (600 ms `pointerdown` without a move) on `[data-rf-slot="offline-status"]` navigates to `/settings/preferences#offline-diagnostics`.

- [ ] **RED:** `a failed read on an online start does not demote the worker` (A8 negative). `getCurrentUser` rejects twice, and the `W.ensure`/`W.register` spies stay at 0 calls.
- [ ] **RED:** `a missing record with the reader's own database: restored, worker stays flagged; a v1 database without the flags: off`. Case 1: `offline_flags = {offlineEnabled:true}` gives `getCurrentUser().offlineEnabled === true` and `ensure` called with `true`. Case 2: no flags gives `ensure` not called with `false`, and `st.enabled === false`.
- [ ] **RED:** `own database gone with the record on: the next online start re-syncs` (Review Focus 4). The record is on and there is no `readfine-offline-7`. After `ctl.ready` and `ctl.idle()`, the sync fetch spy has `/sync/v1/manifest`, and the database exists.
- [ ] **RED:** `Ready only with all five; shell missing says Not ready` (A8 negative "shell missing"). After a sync where `report.shell === 'failed'`, the status line is `"Not ready: app page not stored on this device"`. With all five true it starts with `"Ready for offline"`.
- [ ] **RED (offline-logout.test.mjs):** `a logout whose mirror write and delete both fail is aborted before the record (d4m2)`. With `fakeCaches` failing both put and delete for `readfine-meta`, `ctl.logout(form)` resolves `'mirror-failed'`. `getCurrentUser().offlineEnabled` is still `true`, both localStorage markers are set, and the native-logout spy is called once.
- [ ] **RED (offline-boot.test.mjs, an update, not a new case):** `a light page never demotes the worker`. Change "nothing offline on this device: light page, plain worker made sure of" so that `RF.sw.ensure` is called 0 times from `boot.js`, and rename it to `nothing offline on this device: light page, the worker is left alone`.
- [ ] Run: `node --test tests/js/offline-page.test.mjs tests/js/offline-boot.test.mjs tests/js/offline-logout.test.mjs`. Expected: `ℹ fail 6`.
- [ ] **GREEN:** as specified. Existing tests that asserted the v1 status copy or demotion are updated, each with a one-line reason.
- [ ] Run: `npm test`. Expected: `ℹ fail 0`.

### Task a8-diagnostics: the on-device report

**Size** M · agent: worker · blocked_by: a5-worker-handle, a7-page-start

**Files:**
- Create: `offline/diagnostics.js` (plain script; read-only; needs neither `db.js` nor `page.js`)
- Modify: `templates/settings/preferences.html:340-356`. Add `<div id="offline-diagnostics" data-rf-offline-diagnostics data-rf-app-version="{{ app_version }}" data-rf-template-version="{{ offline_template_version }}">` **after** (outside) `[data-rf-offline-settings]`, with buttons `data-rf-diag-action="test"`/`"copy"`, a `<pre data-rf-diag-out>`, and a `<p data-rf-offline-install-note hidden>`. In `{% block scripts %}` (447) add `<script src="{{ static_url('js/offline/diagnostics.js') }}" defer></script>`. Then `npm run build`.
- Modify: `backend/app/templating.py:208`: `templates.env.globals["offline_template_version"] = OFFLINE_TEMPLATE_VERSION` (from `app.services.sync`)
- Test: `tests/js/offline-diagnostics.test.mjs` (new)

**Interfaces.**
- Consumes: the `rf-diag` and `rf-test-launch` messages (a3, a4); `localStorage` `rf-sw-error` (a3), `rf-last-sync` (a7), `rf-logout-pending`, `rf-wipe-pending` and `rf-offline-user`.
- Produces: `RF.diagnostics.collect({win}) -> Promise<Report>`. Each source is guarded on its own, so one failure gives `{error}` for that field only. `Report` holds:
  - `displayMode`: `'home-screen app'|'Safari tab'|'browser tab'`, using the same test as `preferences.js:58`
  - `sw: {controller: scriptURL|null, controllerFlagged, registration: {active, waiting, installing}, diag: rf-diag reply|'no reply'}`
  - `lastUpdateError`, from `rf-sw-error`; shown as "update failed, previous version running" when set and the active worker is flagged
  - `record`: raw read with no create. `indexedDB.databases()` is checked first; without it, the open aborts its upgrade, as in `db.js` `withCurrent`.
  - `markers`; `mirror` as `{state, value}`
  - `databases` (names); `caches` (names)
  - `pages: [{name, entries, savedAt, hasApp, appUser}]`; `legacyShells`
  - `media: {entries, bytes}` (sum of `content-length`)
  - `persisted`, `estimate`
  - `lastSync`, from `rf-last-sync`
  - `appVersion`, `templateVersion`
- Produces: `RF.diagnostics.format(report) -> string`, plain text with one `key: value` per line.
- Produces: `RF.diagnostics.testLaunch({win, timeoutMs: 2000}) -> Promise<{row, answer} | {row: 'no-flagged-worker', answer: 'safari-error'}>`.
- Produces: `RF.diagnostics.bind(root)`, bound on `DOMContentLoaded`. It renders `format()` into `[data-rf-diag-out]`, wires the two buttons ("Copy report" via `navigator.clipboard.writeText`, falling back to selecting the `<pre>`), and shows the install note "The Home Screen app keeps its own offline copy — turn this on inside the app." only when `displayMode === 'Safari tab'`. That is all A7 needs (owner fact).

- [ ] **RED:** `the report explains a failed cold start inside the app`. Seed a jsdom window with no `page.js` and a plain controller `/sw.js` (with `diag` reply `{flagged:false}`), the `rf-sw-error` set, a mirror `{uid:7, offlineEnabled:true}`, `readfine-pages-7` with `/app`, and `persisted() → false`. `format()` then contains the lines `controller: /sw.js (plain)`, `last update: update failed, previous version running`, `mirror: ok uid=7 offline=on`, `readfine-pages-7: app=yes user=7` and `persisted: no`.
- [ ] **RED:** `the panel renders without a page.js controller`. With `RF.page` undefined and `[data-rf-offline-settings]` hidden, `bind()` leaves `[data-rf-offline-diagnostics]` visible and `[data-rf-diag-out]` non-empty.
- [ ] **RED:** `test launch without a flagged controller answers within 2 s` (Review Focus 5). With no controller, the result is `{row:'no-flagged-worker'}` in under 2100 ms. A controller that never replies gives the same after `timeoutMs`.
- [ ] **RED:** `Copy report has no article content`. A `rf-last-sync` with counts and a pages cache whose `/app` contains `<h2>Secret title</h2>`: `format()` doesn't include `Secret title`, and it has no `http` other than the origin.
- [ ] **RED:** `Safari tab shows the install note; the home-screen app does not`. `matchMedia('(display-mode: standalone)')` false with `navigator.standalone === false` leaves the note visible with the exact copy. Standalone true leaves it hidden.
- [ ] Run: `node --test tests/js/offline-diagnostics.test.mjs`. Expected: `ℹ fail 5`.
- [ ] **GREEN:** as specified.
- [ ] Run: `npm test && npm run build && git diff --stat backend/app/static/css/tailwind.css && (cd backend && env $PGENV uv run pytest tests/test_offline_page_shell.py tests/test_pwa.py -q)`. Expected: `ℹ fail 0`; the CSS diff only if new classes were added; pytest `passed`, with 0 failed.

### Task a9-e2e-cold-start: the test that would have caught v1

**Size** L · agent: worker · blocked_by: a8-diagnostics

**Files:**
- Modify: `tests/e2e/helpers.mjs`:
  - `coldLaunch(playwright, testInfo, profileDir, {offline: true}) -> Promise<{context, page}>` uses `playwright[testInfo.project.use.browserName].launchPersistentContext(profileDir, {...testInfo.project.use.launchOptions, baseURL, serviceWorkers: 'allow', offline})`, so the browser is restarted and set offline before the first page.
  - `seedOfflineDevice(playwright, testInfo, s) -> profileDir` (log in, enable, `waitReady`, close).
  - Profile dirs go under `WORK` and are removed in `afterAll`.
- Modify: `tests/e2e/offline.spec.mjs`: new `test.describe.serial('cold launch offline', …)` before group 1
- Test: the same file

**Interfaces.**
- Consumes: `waitReady` asserting the new Ready copy (a7); `RF.diagnostics` (a8).

- [ ] **RED:** `cold launch in airplane mode opens the app, 5 times`. One `test()` whose body loops 5 times: `coldLaunch(offline)`, `page.goto('/app')`. It asserts the following, then closes the context:
  - `page.url()` ends `/app`
  - `#article-list [data-article-id]` count ≥ 3
  - a sidebar unread count > 0 (`[data-rf-slot]` count element)
  - opening the first row shows `#article-detail .reading-area` with non-empty text and `X-Readfine-Offline: 1`
- [ ] **RED:** `IndexedDB record missing on a cold start, mirror in place: the shell opens`. Online first, delete `readfine-offline-current` via `page.evaluate`, then close and run `coldLaunch(offline)`. `/app` shows list rows.
- [ ] **RED:** `offline switched off: no shell offline, and no silent re-enable`. Switch off in Preferences, close, `coldLaunch(offline)`, then `/app`: the response status is 503 and the body contains our offline page title. Then go online: `registrationUrls().active` matches `/sw.js$`, and the toggle is unchecked.
- [ ] **RED:** `a v1 device offline before its first v2 sync still opens; afterwards the v1 shell cache is gone`. Online: rename the cache by copying `readfine-pages-<uid>` into `readfine-shell-2`, deleting `readfine-pages-*`, and setting the `/app` `data-rf-user`. Then `coldLaunch(offline)` makes `/app` show rows. Online with `waitReady` afterwards, `deviceStorage().caches` has no `readfine-shell-`.
- [ ] **RED:** `a sign-in by another reader with the record unreadable: cold offline launch shows the offline page`. Device seeded for reader A, then go to `/login`, submit B's credentials with the network cut by `context.setOffline(true)` (the sign-in fails, and the forget marks the mirror stale), and delete `readfine-offline-current`. `coldLaunch(offline)` with `/app` gives 503, the offline page, and no A rows.
- [ ] Run: `npx playwright test tests/e2e/offline.spec.mjs -g "cold launch"` with the specs written before the helpers. Expected: `5 failed` per project (`coldLaunch is not a function`).
- [ ] **GREEN:** helpers as specified. Product fixes found here go back to the owning task, not into the spec.
- [ ] Run: `npx playwright test tests/e2e/offline.spec.mjs`. Expected: `passed` for every test on both `chrome` and `webkit`, with `0 failed`. Then run the existing groups too.

### Task a10-e2e-guards: negative paths in a real browser

**Size** L · agent: worker · blocked_by: a9-e2e-cold-start

**Files:**
- Modify: `tests/e2e/offline.spec.mjs`: new `test.describe.serial('offline guards', …)` after the cold-launch group

- [ ] **RED:** `a worker update whose imported script 404s keeps the old worker` (Chrome only; `test.skip(browserName === 'webkit')`, because Playwright routes service-worker requests only in Chromium; WebKit is covered by a3's unit test). Route `/sw.js?offline=1` to the real body plus `\n// e2e bump`, route `/static/js/offline/decision.js` to 404, and call `RFOffline.sw.update()` (a3). The installing worker goes `redundant`, `registrationUrls()` shows the same `active` with no `waiting`, `RFOffline.sw.lastError().message === 'install failed'`, and the diagnostics `[data-rf-diag-out]` contains `update failed, previous version running`.
- [ ] **RED:** `logout marker: a cold offline launch shows the offline page`. Offline logout (as in "offline logout, then the pending logout…"), then `coldLaunch(offline)`: `/app` gives 503 or "Logged out on this device", never list rows.
- [ ] **RED:** `two readers' pages caches: the offline page`. Copy `readfine-pages-<A>` to `readfine-pages-999`, delete `readfine-offline-current`, and run `coldLaunch(offline)`: `/app` gives 503.
- [ ] **RED:** `a mirror write that fails during switching off: offline page, or the switch is refused`. `addInitScript` wraps `Cache.prototype.put` to reject for `readfine-meta`. Two cases:
  - (a) `caches.delete('readfine-meta')` works: switch off, close, `coldLaunch(offline)`. `/app` gives 503, and `deviceStorage().caches` has no `readfine-meta`.
  - (b) `caches.delete` also rejects for `readfine-meta`: switching off shows "That did not work. Reload the page and try again.", the toggle stays checked, and `getCurrentUser().offlineEnabled === true` (aborted before the record was touched; d4m2).
- [ ] **RED:** `Test offline launch on the device reports R1`. On `/settings/preferences` with the device ready, clicking `[data-rf-diag-action="test"]` makes `[data-rf-diag-out]` contain `row: R1` and `answer: shell`.
- [ ] Run: `npx playwright test tests/e2e/offline.spec.mjs -g "offline guards"`. Expected: `passed`, with `0 failed` (one skipped on webkit).
- [ ] Run (full): `npx playwright test`. Expected: `0 failed`.

### Task a11-reconnect-probe: automatic reconnect while offline

Owner request 2026-11-19 15:09 (amendment): with offline mode on, nothing should need a button. Online → sync and send the queue on their own; offline → work from the device and check periodically whether the connection is back.

**Size** S · agent: worker · blocked_by: a10-e2e-guards

**Files:**
- Modify: `backend/app/static/js/offline/page.js` (controller timers next to `startTimer`/`autoSync`)
- Test: `tests/js/offline-page.test.mjs`

**Interfaces.**
- Produces: `RECONNECT_PROBE_MS = 30 * 1000` (overridable through `opts.probeMs` for tests).
- While offline mode is on, the page is visible, forceOffline is off and the page is offline (`navigator.onLine === false` or `st.netDown`), the controller probes `fetch('/healthz', {cache: 'no-store'})` (GET) every `probeMs`, with a 5 s timeout, never two at once. `/healthz` passes through the flagged worker to the network (not answered from the device).
- A probe whose response is ok, application/json and `{"status":"ok"}` (a captive portal's HTML does not count; review a11r-1) clears `st.netDown`, renders, and runs a sync even if `navigator.onLine` still says false (the probe is the fresher evidence). A failed or non-matching probe changes nothing and waits for the next tick. Sync treats only 401/403 or a same-origin /login redirect as an expired session; other HTML/redirect responses are network failures, so automatic recovery continues.
- The probe stops when the page is hidden, online, forced offline or offline mode is off; it restarts on `visibilitychange`/`offline`/a failed request. "Sync now" stays as a fallback.

- [ ] **RED:** `offline and visible: a probe every 30 s; success syncs even with navigator.onLine false`. Fake timers; `nav.onLine = false`; probe fetch resolves 200 on the 2nd tick → exactly 2 probes, then `syncNow` runs once, the offline banner clears.
- [ ] **RED:** `no probe while hidden, forced offline, or online; a failed probe changes nothing`. Each case: 0 probes over 3 ticks (hidden / force / online); a rejecting probe → no sync, still offline, next tick probes again.
- [ ] Run: `node --test tests/js/offline-page.test.mjs`. Expected: `ℹ fail 2`.
- [ ] **GREEN:** as specified. Run `node --test tests/js/offline-page.test.mjs` and `npm test`. Expected: `ℹ fail 0`.

### Stage A gate (not a worker task)

After a0–a10 are integrated, deploying to `selfhost` needs the owner's approval. Then comes the owner's iPhone airplane-mode test: the home-screen app is cold-launched in airplane mode, and its Preferences → Offline "Copy report" is attached. Stage B starts only after this passes on the device (design §4 Gate). B3 may be integrated before the gate, since it is backend only.

### Task b3-migration: columns and index

**Size** S · agent: worker · blocked_by: —

**Files:**
- Create: `backend/alembic/versions/0128_readable_backfill.py` (`revision = "0128"`, `down_revision = "0127"`)
- Modify: `backend/app/models/article.py:43-47`: add `readable_priority: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0, server_default="0")` and `readable_queued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))`
- Modify: `backend/app/models/user.py:17-20`: add `offline_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))`
- Test: `backend/tests/test_migration_0128.py` (integration)

**Interfaces.**
- Produces: the columns above, and the index `ix_articles_readable_queue` on `(readable_status, readable_priority, readable_queued_at)`, built plain as in `0102_articles_count_index.py`. `server_default '0'` keeps existing pending and saved-by-URL rows on-demand. `downgrade()` drops all three columns and the index.

- [ ] **RED:** `test_new_columns_default_on_demand`. Insert an `Article` without a priority: `readable_priority == 0` and `readable_queued_at is None`. A new `User` has `offline_synced_at is None`.
- [ ] **RED:** `test_queue_index_exists`. `SELECT indexdef FROM pg_indexes WHERE indexname='ix_articles_readable_queue'` contains `(readable_status, readable_priority, readable_queued_at)`.
- [ ] **RED:** `test_priority_change_does_not_bump_content_version`. Updating `readable_priority` to 1 leaves `content_version` unchanged (the 0127 trigger list does not include it).
- [ ] Run: `cd backend && env $PGENV uv run pytest tests/test_migration_0128.py -q`. Expected: `3 failed`.
- [ ] **GREEN:** the migration and the model fields. Run `env $PGENV uv run alembic upgrade head`; expected: `Running upgrade 0127 -> 0128`.
- [ ] Run: `env $PGENV uv run pytest tests/test_migration_0128.py tests/test_sync_manifest.py -q`. Expected: `passed`, with 0 failed. Also `env $PGENV uv run alembic downgrade 0127 && env $PGENV uv run alembic upgrade head` succeeds.

### Task b3-request-readable: one helper for every trigger

**Size** M · agent: worker · blocked_by: b3-migration

**Files:**
- Modify: `backend/app/services/readable_service.py` (new helper beside `claim_queued_readable`, ~line 970)
- Modify:
  - `backend/app/routers/web/app/articles.py:1043-1083` (open)
  - `backend/app/services/article.py:1075-1076` (star)
  - `backend/app/services/filter_service.py:763-764` and `:1315-1316` (fetch-time and retroactive filters)
  - `backend/app/services/label_service.py:179-182` (label)
  - `backend/app/services/sync/ops.py:346-352` (sync op)
- Test: `backend/tests/test_request_readable.py`

**Interfaces.**
- Produces: `def request_readable(article: Article, reason: Literal["open", "star", "filter", "label", "sync_op"], *, now: datetime | None = None) -> bool`. It mutates the ORM object and does not commit:
  - `skipped` → `pending`, `readable_retries=0`, `readable_next_retry_at=None`, priority 0, `queued_at=now`. Returns True.
  - `pending` at priority 1 → priority 0, `queued_at=now`. Returns True when `readable_retries == 0` and `readable_next_retry_at is None`.
  - `pending` at priority 0 → no change. Returns False.
  - `failed`, only when `reason == "sync_op"` → `pending`, retries 0, `next_retry_at=now`, priority 0, `queued_at=now`. Returns True. This keeps the ops rule that anything not `success` goes to pending. For other reasons → False.
  - `success` → False.
- Callers keep their own `extract_readable` checks.
- The open route loads `Article` with `db.get` instead of the inline `sa_update`. It calls `request_readable(article, "open")`, commits, then for `pending` uses `claim_queued_readable` as the one "start now" gate, and spawns `_extract_readable_bg` when it is claimed. A backfill-marked article (retries 0, `next_retry_at` None) is therefore claimed and started.
- Saved-by-URL creation (`saved_article_service.py`) is unchanged: the server default puts it at priority 0.

- [ ] **RED:** `test_skipped_becomes_on_demand_pending`. It returns True, with status `pending`, priority 0, `queued_at == now` and retries 0.
- [ ] **RED:** `test_backfill_pending_is_lifted_and_startable`. Priority 1 pending: True, priority 0. With priority 0 pending already: False, no change.
- [ ] **RED:** `test_failed_only_retried_by_sync_op`. `failed` with `"label"` returns False and leaves it `failed`. With `"sync_op"`: True, `pending`, retries 0.
- [ ] **RED:** `test_open_starts_a_backfill_queued_article` (mocked db, as in `test_readable_claim.py`). `htmx_article_detail` on a priority-1 pending article spawns `_extract_readable_bg`, and the article's priority is 0.
- [ ] **RED:** `test_label_on_backfill_article_parks_scoring_at_priority_0`. `label_service` on a priority-1 pending article with extraction on gives priority 0, status pending, and no scoring job enqueued yet.
- [ ] Run: `cd backend && env $PGENV uv run pytest tests/test_request_readable.py -q`. Expected: `5 failed` (ImportError counts).
- [ ] **GREEN:** the helper plus the six call sites.
- [ ] Run: `env $PGENV uv run pytest tests/test_request_readable.py tests/test_readable_claim.py tests/test_readable_bg.py tests/test_filter_service.py tests/test_service_label.py tests/test_sync_ops.py tests/test_article_star.py -q`. Expected: `passed`, with 0 failed.

### Task b3-picker: on-demand first, then newest-first backfill

**Size** L · agent: worker · blocked_by: b3-request-readable

**Files:**
- Modify: `backend/app/services/readable_service.py`:
  - `_BATCH_SIZE` at 48 becomes `_ON_DEMAND_BATCH = 20`, `_BACKFILL_PER_RUN = 30`, `_BACKFILL_CANDIDATES = 100`, `_BACKFILL_HOST_FLOOR_S = 5.0`, `_BACKFILL_TIME_BUDGET_S = 50`
  - `process_pending_readable` 999-1105
  - `maybe_disable_readable_for_feed` 1216-1227 and `_disable_readable_for_feed` 1336-1354
- Test: `backend/tests/test_readable_backfill_picker.py`

**Interfaces.**
- Produces:
  - `async def _pick_on_demand(db, limit) -> list[Article]`: priority 0, ordered `readable_queued_at ASC NULLS FIRST, id ASC`, with today's filters.
  - `async def _backfill_candidates(db) -> list[Article]`: priority 1, `id DESC`, `LIMIT 100`, with today's filters.
  - `def _host_waiting(host, now) -> bool`: `host_throttle.blocked_until(host, now, include_block=True)` is set, which is how the feed scheduler's pacing gets priority, or `_backfill_next_at[host] > now`.
  - `async def _run_backfill(db, candidates, allowance, clock) -> int`. `clock` is injectable and defaults to `datetime.now(timezone.utc)`. It loops over the remaining candidates, taking the first whose host is not waiting at `clock()`. It is re-checked on every pass, so a host comes back once its 5 s are up. When every remaining host is waiting, it sleeps until the earliest `_backfill_next_at`, capped by the time budget. It stops at `allowance`, at `_BACKFILL_TIME_BUDGET_S`, or when the candidates run out.
  - `_backfill_next_at: dict[str, datetime]` is module-local and process-local, like `host_throttle`. After each backfill fetch it is set to `clock() + max(5 s, host_throttle.effective_spacing(host))`.
  - Backfill never calls `note_block`/`arm_after_fetch`, so it never delays a feed fetch. On `http_status == 429` it calls `host_throttle.note_rate_limited(host, now + host_throttle.FALLBACK_BLOCK_COOLDOWN)`.
- `process_pending_readable(db) -> int`: on-demand batch first (uncounted), then backfill. The backfill loop stops at 30 or after 50 s of wall time. The job stays sequential under `max_instances=1`, so 30 a minute is a cap, not a target.
- Pipeline gate: after an extraction, the existing `db.refresh(article)` is followed by `run_pipeline_for_article_all_users` only if `article.readable_priority == 0`. That applies to both the success and the terminal-failure branches.
- Disable paths: pending rows are split by priority. Priority 0 behaves as today. Priority 1 rows become `skipped`, `readable_priority=0`, `readable_queued_at=None`, and are excluded from `_queue_scoring_for_labelled` and from the pipeline loop.
- Check (no test): `grep -n "readable_status\s*=" app/services/readable_service.py` shows `readable_content` written only through `apply_readable_result`. Note the result in the report (design §7 Device).

- [ ] **RED:** `test_on_demand_runs_before_backfill_and_backfill_newest_first`. With 2 priority-0 articles (ids 5, 6) and 3 priority-1 articles (ids 10, 11, 12) on distinct hosts, the extraction order is `[5, 6, 12, 11, 10]`.
- [ ] **RED:** `test_backfill_capped_at_30_and_skips_waiting_hosts`. 40 priority-1 articles on 40 hosts give 30 extractions. When host `a.test` has `blocked_until` set, its article is skipped and the next candidate is taken. Two articles on one host, with a fake clock that advances 1 s per extraction and a mocked sleep that advances it: both are extracted, and the second fetch's clock is ≥ the first's + 5 s.
- [ ] **RED:** `test_backfill_extraction_does_not_run_the_ai_pipeline`. A priority-1 success leaves the `run_pipeline_for_article_all_users` mock with 0 calls. A priority-0 success gives 1 call.
- [ ] **RED:** `test_backfill_does_not_arm_feed_pacing`. After a backfill fetch, `host_throttle.blocked_until(host, now, include_block=True) is None`. After a 429, it is not None.
- [ ] **RED:** `test_feed_disable_drops_backfill_without_scoring`. `_disable_readable_for_feed` with one priority-0 and one priority-1 pending article gives both `skipped`, and the pipeline is called once (for the priority-0 article).
- [ ] Run: `cd backend && env $PGENV uv run pytest tests/test_readable_backfill_picker.py -q`. Expected: `5 failed`.
- [ ] **GREEN:** as specified.
- [ ] Run: `env $PGENV uv run pytest tests/test_readable_backfill_picker.py tests/test_readable_batch.py tests/test_readable_autodisable.py tests/test_readable_revival.py tests/test_host_throttle.py -q`. Expected: `passed`, with 0 failed.

### Task b3-marker: who gets backfill, and when it is queued

**Size** M · agent: worker · blocked_by: b3-migration

**Files:**
- Create: `backend/app/services/readable_backfill.py`
- Modify: `backend/app/fetcher/scheduler.py`: a job function next to `_process_readable` (565-571), and `add_job` after it (992-999)
- Modify: `backend/app/routers/web/sync.py:52-62` (manifest)
- Test: `backend/tests/test_readable_backfill.py` (integration, `pg` fixture as in `test_sync_manifest.py`)

**Interfaces.**
- Produces: `ACTIVE_DAYS = 14`, `MARK_BATCH = 200`, `STAMP_EVERY = timedelta(hours=1)`.
- Produces: `async def stamp_offline_synced(user: User, db: AsyncSession, *, now: datetime) -> bool`. It writes `users.offline_synced_at = now` when the value is None or older than 1 h, and the caller commits. The manifest route calls it and commits only when it returns True.
- Produces: `async def mark_backfill_for_user(user, db, *, now) -> int`. It takes `offline_scope_ids(user, db)` in chunks of 200 (`id_array`), with one `UPDATE articles SET readable_status='pending', readable_priority=1, readable_queued_at=:now` per chunk, limited to rows that meet all of:
  - `id = ANY(:ids)`
  - `readable_status = 'skipped'`
  - `url` is not null and not empty
  - `trimmed_at IS NULL`
  - `feed_id` is in that user's `user_feeds` with `extract_readable AND NOT readable_auto_disabled`
  It commits per chunk and returns the rows changed.
- Produces: `async def mark_backfill(db, *, now=None) -> int`, which covers users with `offline_synced_at >= now - 14 days`.
- Scheduler: `_mark_readable_backfill()` with `trigger="interval", minutes=15, id="mark_readable_backfill", max_instances=1, misfire_grace_time=60`.

- [ ] **RED:** `test_manifest_stamps_offline_synced_at_at_most_hourly`. `stamp_offline_synced` at `t0` returns True. At `t0 + 30 min` it returns False and the value is still `t0`. At `t0 + 61 min` it returns True.
- [ ] **RED:** `test_marks_only_skipped_in_scope_with_extraction_on`. A user synced 1 day ago has 4 in-scope articles: skipped on a feed with extraction on, skipped on a feed with extraction off, skipped with `readable_auto_disabled`, and `success`. Only the first becomes `pending`/priority 1/queued. There is also 1 out-of-scope (read, unkept) skipped article, which stays `skipped`.
- [ ] **RED:** `test_users_idle_over_14_days_are_not_marked`. With `offline_synced_at` 15 days ago, or None, `mark_backfill` returns 0 and the status is unchanged.
- [ ] **RED:** `test_marks_in_batches_of_200`. With 450 skipped in-scope articles (the unread limit raised for the test), it marks 450 and the commit spy is called 3 times.
- [ ] Run: `cd backend && env $PGENV uv run pytest tests/test_readable_backfill.py -q`. Expected: `4 failed`.
- [ ] **GREEN:** as specified.
- [ ] Run: `env $PGENV uv run pytest tests/test_readable_backfill.py tests/test_sync_manifest.py tests/test_scheduler_selection.py -q && env $PGENV uv run pytest -q`. Expected: `passed`, with 0 failed (the full suite as the last B3 check).

## Self-review notes

- **Coverage:** A1 → a2, a4. A2 → a7. A3 → a3, a10. A4 → a7. A5 → a5. A5b → a1, a4, a6, a9. A6 → a8. A7 → a8 (note only, per the owner fact). A8 → a9, a10, plus the unit tests in each task. A9 → a7 (persist and re-sync) and a8 (shown). §9 Stage A e2e list → a9/a10. The wipe order, another user's pages cache and activation with IndexedDB unreadable are unit-tested in a1/a4 rather than in e2e, because a browser can't observe the deletion order. §7 → b3-*. d4m1 → a1, a5, a6. d4m2 → a1, a7, a10. d4m3 → a2.
- **Consistency:** `shellUser` lives in `db.js` (a1) and is used by both a2 and a6.
- **Judgment calls the reviewer should check:**
  - A pending mirror with a readable "on" record is treated as R2 (a2).
  - The A3 install failure goes through `waitUntil` rejection rather than a top-level throw (a3).
  - The backfill floor is re-checked in the loop, which may sleep within the 50 s budget (b3-picker).
  - On a 429, backfill arms the shared rate-limit cooldown.

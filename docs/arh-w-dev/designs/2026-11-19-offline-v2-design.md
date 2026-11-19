# Readfine offline v2: the whole app opens and works offline on the iPhone

Status: draft for owner review (2026-11-19), revision 4 after three design reviews (round 1: 1 blocker, 8 major, 6 minor; round 2: 4 major, 6 minor; round 3: 2 major, 5 minor; all addressed below). Builds on [offline v1](2026-11-16-readfine-offline-design.md), deployed 2026-11-17 (`selfhost` ad5642d).
Repo: `/projects/readfine/src`, branch `feat/offline-v2` from `selfhost`. Workflow run: arh-w-dev `run-d93c2098`.

## 1. Intent

In airplane mode the home-screen app on the owner's iPhone shows Safari's own "not connected to the internet" page. Nothing opens, so the stored articles can't be reached, and none of the offline features can be used. The owner wants:

- the whole interface to open and work offline, not only the reading list;
- the full text of stored articles fetched in the background, not just what the RSS feed carries;
- catch-up briefings readable offline (deferred in v1).

Owner decisions on 2026-11-19:
- **Settings screens:** view everything offline, and queue edits of the owner's own data. The chosen option named unsubscribe explicitly, alongside labels, folders and feed rename/move; label and folder deletes fall under the same choice.
- **Briefings:** store them on the server, sync the last ones, and queue new requests.
- **Full text:** fetch it for every stored article.

## 2. What v1 got wrong (evidence)

Safari's own error page means the service worker did not answer the launch at all. A worker that answered but had no data would show our "Needs a connection" page instead. The code has four ways to end up there; none has been reproduced on iOS yet:

| # | Path | Where |
|---|---|---|
| A | The worker cannot read who the current user is, caches "nobody", and sends the launch to the network with no fallback. | `policy.js:41-58`, `:150-154`, `:192-195` |
| B | While online, the registration drops back to the plain worker. A failed read on startup turns into "offline off" and calls `ensure(false)`; a light page can do the same. | `page.js:1102,1117,1128`, `boot.js:185` |
| C | The home-screen app keeps storage separate from Safari. If offline was switched on in a Safari tab, the app itself has nothing. To be confirmed with the owner. | — |
| D | A worker update after a deploy whose `importScripts` fails at install: the `catch` plus `skipWaiting` installs a worker without its scripts over the good one. (Imported scripts are stored at install, not re-fetched at restart.) | `sw.js:36-55` |

Two more defects found on the way:
- **Startup race:** every page start sends `rf-current-user`, and the worker closes its database handle while the first list and sidebar requests are still being answered. Those requests come back as "Needs a connection". Reproduced in WebKit, 5 of 5 cold starts (`page.js:1120`, `policy.js:61,81`).
- **"Ready" shown without a shell:** a failed shell cache never reaches the status line (`sync.js:666` vs `page.js:388-425`).

v1's e2e test only reloaded a warm page on desktop and checked that the list container exists. It passed while the phone failed. v2 is staged so that this can't happen again: reliability first, proven on the device, then the rest.

## 3. Goals and non-goals

**Goals**
- Cold launch in airplane mode always opens the app: the stored lists, articles and every screen below. It never shows Safari's error page.
- If something is broken, the device can say what. The owner can read it on the phone, without a Mac.
- All app screens open offline (section 5). Edits that only change the owner's own data are queued and applied at sync.
- The full text of every stored article is on the device, when the publisher allows extraction.
- Stored briefings open offline, with links to the stored articles. A briefing requested offline is generated at the next sync.

**Non-goals**
- Signing in, registering or resetting a password offline.
- Admin pages offline: "Needs a connection".
- Background sync while the app is closed. iOS gives web apps none; this is unchanged from v1.
- Audio/video offline (stays in the backlog).
- Generating briefings or running AI chat on the device.

**Anti-goals**
- No second copy of the UI in JavaScript beyond small templates. Screens stay server-rendered, as in v1.
- No settings edit that needs the server to validate an outside resource, queued blindly: adding a feed by URL, OPML import, AI keys, API tokens.

## 4. Stage A: reliable cold start, plus on-device diagnostics (gate before Stage B)

### A1. A flagged worker always answers a navigation: one decision table

**What the worker can read.**
- The current-user record in `readfine-offline-current` (IndexedDB).
- **A mirror in Cache Storage**, `readfine-meta`: one synthetic JSON entry `{uid, offlineEnabled, forceOffline, logoutPending, wipePending, at}`. It is written by `setCurrentUser`, by switching offline on or off, by a sign-in forget (`forgetCurrentUser`, which sets it stale), and *before* a logout or wipe starts, alongside today's localStorage markers (`page.js:43-53`), which the worker cannot read. Cache Storage is a separate store from IndexedDB, so the case the reviews singled out still works: IndexedDB unreadable on a cold start (path A).
- **Write order, so that a failed write can only lead to the offline page:** on switching off, logout, wipe and a sign-in forget, the mirror is written first (off / pending / stale), then the record, then the caches. On switching on, the record goes first, then the pages, then the mirror.
- Its caches: `caches.keys()` lists the `readfine-pages-<uid>` caches.

**Per-user page cache.** The shell moves to a cache tied to one user, `readfine-pages-<uid>`, which also holds the page snapshots of Stage B1. Every cached page carries `data-rf-user` in its body. Matching ignores the query string for `/app` (`ignoreSearch`).

**Decision for a navigation the worker owns, with no network or "Work offline":**

| IndexedDB record | `readfine-meta` mirror | Other checks | Answer |
|---|---|---|---|
| readable, not stale, offline on | — | — | that user's page from `readfine-pages-<uid>`, or the offline page if it is not cached |
| readable, stale, or within the sign-in forget window; or the mirror is stale | any | — | offline page (a sign-in is under way: never someone's shell) |
| readable, offline off | — | — | offline page |
| unreadable after 3 tries 100 ms apart, or missing | missing or unreadable | — | offline page |
| unreadable or missing | stale, logout or wipe pending, or offline off | — | offline page |
| unreadable or missing | uid U, offline on, nothing pending | `caches.keys()` has exactly one `readfine-pages-*` and it is `readfine-pages-U`, it holds `/app`, and that page's `data-rf-user` is U | that shell |
| unreadable or missing | uid U, offline on, nothing pending | anything else | offline page |

- Under a flagged worker, no navigation path ends in a bare `network()` rejection. That includes the step-aside branch in `policy.js:150-154`.
- A failed read is never cached as "nobody". It is tried again on the next request.

### A2. The worker drops back to plain only on purpose

- The registration goes back to plain `/sw.js` only on: switching offline off, logout, account wipe, or account deletion.
- `page.js` `start()`:
  - A failed read: handled the way `reconcile()` handles it, keeping the current state.
  - The record is missing but this user's own `readfine-offline-<uid>` exists: the record is restored from that database's meta, which now also stores `offlineEnabled` and `forceOffline` (written on every `setCurrentUser`). The worker stays flagged only if `offlineEnabled` was on; a v1 database without the field counts as off.
  - **Switching offline off** deletes `readfine-pages-<uid>` and sets the mirror to offline off. The article database stays, as in v1, so turning offline back on is fast.
  - Only a reader with no database of their own and no record gets the plain worker.
- `boot.js:185` no longer calls `ensure(false)`.

### A3. A worker update can't replace a good worker with a broken one

- In the flagged worker, `importScripts` failures are re-thrown. The update's install fails, and the previous worker keeps control.
- The page sees the failed update from the rejected `register()`/`update()` promise (`sw-register.js`; a top-level throw leaves no installing worker), and diagnostics shows "update failed, previous version running".
- If a running worker still finds its scripts missing, it answers navigations with a built-in page that has no dependencies: "Offline files failed to load. Open the app once online."

### A4. "Ready for offline" means ready

Ready needs all of:
- the last sync finished;
- the shell is cached in `readfine-pages-<uid>`;
- the current-user record is readable, with offline on;
- the page is controlled by a worker whose `scriptURL` contains `offline=1`;
- `storage.persisted()` was asked for.

Otherwise the status line says "Not ready: <reason>".

### A5. Fix the startup race

- `rf-current-user` does nothing when the user and the flags are unchanged.
- The worker's database handle is reference-counted. When `rf-current-user` replaces a handle, the old one closes only after the requests using it finish. A `versionchange`, a forget (sign-in) or a wipe still closes the handle at once (`db.js:137`, `policy.js:72-79`), so `wipeAll` is never held up. Both behaviours get unit tests.

### A5b. Moving from v1 caches, and nothing left behind

- **Gap before the first v2 sync.** Until `readfine-pages-<uid>` exists, the worker serves the v1 `readfine-shell-*` `/app` under the same conditions as the matching decision-table row (offline on, nothing pending, not stale, no other `readfine-pages-*`), and only if its `data-rf-user` equals the record's or the mirror's uid. The first v2 sync then deletes every `readfine-shell-*`. Test: a v1 device upgraded online, then offline before its first v2 sync, still opens.
- **Cleanup.** On worker activation and on every sync, the device deletes `readfine-shell-*` (after the first v2 sync) and every `readfine-pages-<uid>` whose uid is not the current user's. The current user is the record's uid, or the mirror's when the record is unreadable or missing. If neither gives a uid, or they disagree, no pages cache is deleted. Test: activation with IndexedDB unreadable keeps `readfine-pages-U`.
- **Wipe.** `deleteCaches` (`db.js:634-641`) deletes the media, shell, pages and `readfine-meta` caches.
- **Wipe order** is a tested invariant: the mirror is set to pending first, then caches are deleted, then the user databases, then `readfine-offline-current` last (today it goes in parallel with the user databases, `db.js:686-695`).

### A6. Diagnostics panel

In Settings → Preferences → Offline, and from a long press on the status line.

**Shown:**
- display mode: home-screen app or Safari tab;
- the worker's script URL and state, and whether it controls the page;
- any failed update or missing scripts;
- the current-user record and markers;
- the databases;
- `readfine-pages-<uid>`: entries and saved-at;
- media count and bytes;
- `persisted()` and `estimate()`;
- the last sync report, including shell, pages, media and errors;
- app and template version.

**Buttons:**
- "Test offline launch": sends a message to the worker. The worker runs the A1 decision for `/app` with the network treated as down, and answers with the row of the table it took. (A page can't build a real navigation request.)
- "Copy report": plain text with no article content.

### A7. Home-screen app vs Safari

The panel and the opt-in switch say which one this is. In a Safari tab the help text reads: "The Home Screen app keeps its own offline copy — turn this on inside the app."

### A8. Tests that would have caught v1

- **Cold start:** e2e in WebKit and Chromium with a persistent profile. The browser is restarted and set offline before the first page. The test asserts list rows, sidebar counts and an opened article body. Each case runs 5 times.
- **Decision table (A1):** unit tests for every row.
- **Negative paths:**
  - stale record → offline page;
  - two databases → offline page;
  - a cached shell of another user → offline page;
  - logout marker → offline page;
  - a failed read during an online start → no demotion;
  - a missing record with the user's own database present → no demotion;
  - a worker update whose imported script returns 404 → the old worker stays;
  - shell missing → "Not ready".
- Playwright can't reproduce the home-screen app's separate storage, so the iPhone test stays the gate.

### A9. What Stage A can't fix

If iOS removes the registration or the site's storage (rare for a home-screen app; more likely with very low storage), nothing is left that can answer, and Safari's page comes back. To make this less likely and visible:
- the app asks for persistent storage;
- diagnostics shows whether it was granted;
- the next online start notices the loss and re-syncs.

**Gate:** deploy Stage A, then the owner runs the iPhone airplane-mode test with the diagnostics report. Stage B starts only after this passes on the device.

## 5. Stage B1: every screen offline

### Snapshots

**Fetching and storing**
- At sync, the device fetches each page below and stores the response as it came (CSP header and nonce kept together) in `readfine-pages-<uid>`.
- Responses that were redirected or are not 200 are refused, like the v1 shell (`sync.js:536-537`).
- Up to 2 pages are fetched at a time.
- A failed page shows in diagnostics. It blocks "Ready" only for `/app`.

**Refresh**
- A page is fetched again when the template version, the preferences version or the lists version in the manifest changes. Applied queued edits change those versions too. Any page older than 24 h is also fetched again.
- Pruning works only inside `readfine-pages-<uid>`. Its keep set is the shell, its static files and the current page list (`sync.js:563-575` changes accordingly).
- Logout and wipe delete the cache (`db.js` `deleteCaches`).

**Forms**
- Offline, the worker answers every request to these pages (A1 / B1 routing), so the CSRF token in a snapshot is never sent while offline.
- When the connection comes back, a page opened from a snapshot reloads itself from the network before its first form submission. No form is sent with an old token.

### Pages (real routes)

| Page | Offline |
|---|---|
| `/app`, `/` | shell |
| `/app?open_article_id=N` | the shell, then the page itself reads the parameter and opens the article from the device store. The cached shell has no server-rendered deeplink loader; v1 never tested this. |
| `/app/catch-me-up` | snapshot, plus the stored briefings (B4) |
| `/settings` | the server answers it with a 303. The worker maps it to the cached `/settings/preferences`. |
| `/settings/preferences`, `/settings/preferences/hidden` (hidden stories, links only; there is no unhide action), `/settings/profile`, `/settings/feeds`, `/settings/feeds-list`, `/settings/labels`, `/settings/filters`, `/settings/relevance`, `/settings/ai`, `/settings/tokens`, `/settings/opml`, `/settings/stats` | snapshot |
| `/settings/feeds/{id}/edit`, `/settings/folders/{id}/rename-form`, `/settings/filters/{id}/edit` | snapshot for each, at most 200 of each kind; above that, "Open once online" |
| `/help`, `/features`, `/changelog`, `/terms`, `/privacy` | snapshot |
| `/share-target` | queued `save_url` (v1 op), then a synthetic redirect (`Response.redirect`, 303) to `/app` with a "saved, fetched at next sync" toast. iOS Safari has no Web Share Target, so this helps Android/desktop only. |
| `/login`, `/register`, password reset, email verify, `/welcome*`, `/admin/*`, `/share/{token}` | offline page |

### What the worker intercepts

- `classify` (`policy.js:107-119`) is extended to every method to `/settings/*`, `/app/catch-me-up`, `/share-target`, `/help`, `/features`, `/changelog`, `/terms` and `/privacy`, plus the HTMX fragments these pages call.
- `router.handle` (`router.js:574-575`) gets routes for them:
  - **GET of a page:** its snapshot.
  - **Fragment GETs** (`/settings/feeds-list`, `/settings/ai/cost-partial`, `/settings/feeds-stats-partial`, `/settings/relevance/suggestions`, …): answered from the snapshot or local data where possible, otherwise "Needs a connection".
  - **A queued edit (B2) from HTMX** (`hx-post`/`hx-delete`): a local answer that HTMX swaps, with a "queued" toast.
  - **A queued edit as a plain form POST (navigation):** queued, then a 303 to the page.
  - **Everything else:** "Needs a connection". For HTMX it comes back as a toast with `HX-Reswap: none`; for a navigation it is the offline page.
- Online, these requests go to the network as before, through the v1 network-first path.

## 6. Stage B2: queued settings edits

### What gets queued

Each item is a new op type, run on the server through a service function shared with the online route.

| Edit | Route | Service work needed |
|---|---|---|
| Preferences form, every field | `POST /settings/preferences` | the save is inline in the router (`settings/preferences.py:90-163`): extract it into `apply_preferences()`, used by both |
| Labels: create, rename, recolour, delete | `POST /settings/labels`, `POST/DELETE /settings/labels/{id}` | check the routes; extract where inline |
| Folders: create, rename, move, delete | `POST /settings/folders`, `/folders/{id}/rename`, `/folders/{id}/move`, `DELETE /folders/{id}` | same |
| Feeds: rename, move to a folder, full text on/off | `POST /settings/feeds/{id}/edit` | same |
| Unsubscribe | `DELETE /settings/feeds/{id}` | same |

Destructive edits (unsubscribe, label/folder delete) were part of the owner's choice on 2026-11-19. Offline they ask for confirmation, and they can be cancelled from the pending list until the next sync.

**Disabled offline ("Needs a connection"):**
- add or test a feed by URL, feed scraping;
- OPML import/export;
- filters create/edit/apply/test;
- relevance tuning and suggestions;
- AI keys and preferences;
- API tokens;
- profile, email and password changes;
- account deletion;
- folder order.

### Ids for things created offline

- A create carries a client id `c-<uuid>`.
- The server keeps `sync_client_ids(user_id, client_id, kind, server_id, created_at)`, so the mapping holds across op batches and replays. It is returned with each ops answer.
- When resolving an op, the server looks a client id up in this table, which also covers v1 ops: `label_add`/`label_remove` (`sync/ops.py:265-268`) and `mark_scope_read` scopes with `label_id`/`folder_id` (`ops.py:75`). An unknown client id skips the op with reason `unknown_ref`.
- The device stores the map, rewrites its outbox and local lists from it, and keeps it until no pending op refers to the client id.

### Before sync, and conflicts

- **Before sync:** an overlay keyed by `data-rf-*` hooks shows the edit:
  - form values;
  - a renamed row;
  - a new row marked "pending";
  - a deleted row struck through, with "removed at sync".

  The sidebar and the label picker are JS templates already, so they show pending changes from the local lists.
- **Conflicts:**
  - The entity was deleted on the server: the op is skipped and listed under "Couldn't apply".
  - Otherwise the queued edit wins. It is the owner's own settings, with one writer in practice.

## 7. Stage B3: full text in the background

### Who it is for and which articles

- **Users:** those with offline in use. A manifest request sets `users.offline_synced_at`, written at most once an hour. Backfill covers users whose device synced in the last 14 days.
- **Articles:** those in that user's offline scope, joined to the user's own `user_feeds` row with `extract_readable` on and not auto-disabled. The switch lives on `UserFeed` (`models/feed.py:101-105`); `Article` is shared between users.
- **Queueing:** articles that pass are marked for extraction in batches of 200.

### Queue

The current picker takes `readable_status = 'pending'` in `Article.id` order (`readable_service.py:1004-1018`). New articles start as `skipped` (`rss.py:389`). Each trigger flips only `skipped` to `pending`: opening (`articles.py:1043-1061`), starring (`article.py:1075-1076`), filters (`filter_service.py:763-764`), labels (`label_service.py:179-182`), the sync op (`ops.py:346-352`). Changes:

- Two new columns on `articles`: `readable_priority` (0 on-demand, 1 backfill) and `readable_queued_at`, with an index on `(readable_status, readable_priority, readable_queued_at)`.
- **One helper, `request_readable(article, reason)`, used by every trigger above.** It sets priority 0 when the status is `skipped` or `pending`, which lifts a backfill-queued article. It also returns whether the caller should start the extraction now; the open path then starts it, even for an article backfill had already marked `pending`.
- Backfill marks only `skipped` articles, at priority 1.
- The picker orders by priority. On-demand work goes first, in queued order; backfill goes newest article first.

### Limits

- **Per host:** the existing `app/fetcher/host_throttle.py` is reused, so feed fetching, on-demand and backfill share one budget per host (learned spacing, which is persisted; `blocked_until` and 429 cooldowns, which live in memory and reset on restart). When a host is shared, feed fetches go before backfill. Backfill also keeps a floor of one request every 5 s per host. The picker reads up to 100 candidates and skips hosts that are waiting, so one slow site doesn't block the rest.
- **Overall:** backfill takes at most 30 extractions a minute. The 1-minute job runs on-demand work first, then fills the remaining backfill allowance (today's `_BATCH_SIZE = 20`, `readable_service.py:48`, becomes on-demand 20 plus backfill up to 30). On-demand work is not counted against it.
- **Failures:** `failed` follows the existing retry fields up to their maximum, then stops. A feed the existing logic marks `blocked` drops out of the backfill.

### AI pipeline

- Today every successful extraction runs `run_pipeline_for_article_all_users` (`readable_service.py:1082-1085`), which spends AI tokens.
- After an extraction finishes, the code re-reads the article's priority. The pipeline runs if:
  - the priority is 0. That covers on-demand work (today's behaviour) and a label or filter that parked its scoring until the full text arrives (`filter_service.py:770-772`, `label_service.py:179-189`), because those triggers go through `request_readable`, which sets priority 0.
- A plain backfill extraction does not run it: the article was already scored from its feed content.
- Tests cover both cases.

### Device

- `content_version` changes with `readable_content` (migration 0127). The article's manifest version changes and its snapshot is fetched again, and images in the full text are downloaded within the media budget.
- The plan checks that `readable_status` and `readable_content` are always written together.
- First run: about 3000 articles take a few hours. After that only new articles are fetched.

## 8. Stage B4: briefings stored and offline

### Storage

- New table `catchup_briefings`:
  - `user_id` (FK, `ON DELETE CASCADE`, included in account deletion);
  - `created_at`, config, manual or scheduled, title;
  - sanitized HTML, `article_ids`;
  - model/provider, tokens.
- Both generation paths save a row: the on-screen job (`catchup.py:289-321,419`) and the scheduled email (`briefing_service.py:306`).
- The last 20 per user are kept.

### Links to articles

Today the model sees only feed, title, date and snippet (`catchup_service.py:556-577`), so a briefing has no links.

- **Prompt:** source articles are numbered, and the model is asked to cite them as `[n]`.
- **Folded stories** (`catchup_service.py:374`): the number goes to the story's lead article.
- **Rendering:**
  - The row stores the sanitized HTML with `[n]` markers left in, plus the map from numbers to article ids. Links the model wrote itself (`[n](url)`) are reduced to `[n]` first.
  - Links are built when the briefing is shown: `/app?open_article_id=<id>` in the app, an absolute URL in the email. Numbers outside the map are dropped.
- **Token estimate:** updated for the extra numbering (`catchup_service.py:581`).
- **Offline:** a link opens the stored article, or shows "Not on this device".

### Offline

- `/app/catch-me-up` shows saved briefings, newest first. They arrive at sync as `lists.briefings`, rendered inside the page snapshot.
- **Generating a briefing offline:**
  - A `catchup_generate` op is queued with the chosen config, at most one waiting per config.
  - At sync the server starts the job, and the result arrives with the next sync.
  - It spends AI tokens like the online button; the pending list says "will be generated when online".

## 9. Testing

**Stage A**
- e2e:
  - cold start;
  - every row of the decision table;
  - the negative paths in A8;
  - a worker update with an import 404;
  - IndexedDB unreadable on a cold start with the mirror in place: the shell opens;
  - offline switched off: no shell offline, and no silent re-enable;
  - a v1 device offline before its first v2 sync: it still opens; afterwards the v1 shell cache is gone;
  - the wipe order;
  - another user's pages cache is deleted;
  - activation with IndexedDB unreadable keeps the user's pages cache;
  - a sign-in by another user with IndexedDB unreadable (mirror stale): a cold offline launch shows the offline page, never the previous user's shell;
  - a mirror write that fails during switching off, logout or forget: offline page.
- Unit tests for the decision function and for the reference-counted database handle.

**Stage B, e2e offline walk through every page of section 5 after a cold start:**
- each page opens;
- forms that are disabled say why;
- every queued edit:
  - shows before sync and applies after;
  - a deleted-entity conflict is skipped;
  - client-id remapping works across two batches, including a v1 `label_add` on a label created offline;
  - a destructive edit can be cancelled;
- after reconnect a snapshot page reloads before its first form submission;
- `/settings` maps to preferences;
- a redirected snapshot is refused;
- pruning keeps the snapshots.

**Backend**
- Full text:
  - priority order, including an open or label on a backfill-queued article (it moves to priority 0, extraction starts, scoring runs);
  - shared per-host limit with feed fetching;
  - skip-ahead;
  - the per-`UserFeed` switch;
  - no AI pipeline on backfill;
  - throttled `offline_synced_at`.
- Briefings (AI client faked):
  - saving;
  - citation links: in range, out of range, folded story, absolute in email;
  - cascade on account deletion;
  - queued generation, at most one per config.

**Release gate:** the owner's iPhone airplane-mode test after each stage, with the diagnostics report.

## 10. Order of work

1. **Stage A:** A1–A9. Deploy, then the iPhone test (gate).
2. **B1:** per-user page cache, snapshots and their refresh, worker interception and routing. Includes the `open_article_id` deeplink and share-target.
3. **B2:** service function extraction, settings ops, the client-id table and remapping, the overlay.
4. **B3:** full-text backfill. Backend only; can be built in parallel with B1/B2.
5. **B4:** briefings table, citations and sync, then the offline view and queueing.
6. As-built specs, backlog, the iPhone test.

The upstream PR (Task 16 of v1) is re-scoped: v1 plus Stage A is the natural first PR, and B1–B4 are follow-ups. Its text goes to the owner before anything is opened.

## 11. Calls I made (owner to check)

- **Stage A first:** it is gated on your iPhone test before any Stage B work.
- **Endpoint:** a branch (`feat/offline-v2` into `selfhost`), not a PR. Deploys stay a separate step you approve.
- **No-record fallback:** when IndexedDB can't be read, a mirror in Cache Storage says who is signed in. The worker serves a shell only when there is exactly one offline account on the device, offline is on for it, its cached page names that account, and no logout or wipe is pending. In every other case it serves the offline page.
- **Switching offline off** deletes the cached pages but keeps the article database, as v1 does.
- **Settings conflicts:** the queued edit wins unless the entity was deleted on the server. Destructive edits offline ask for confirmation and can be cancelled before sync.
- **Full-text backfill:**
  - 30 extractions a minute overall, 1 request per 5 s per host;
  - covers users who synced in the last 14 days;
  - does not run the AI pipeline.
- **Snapshots:** at most 200 edit pages of each kind (feeds, folders, filters).
- **Briefings:** the last 20 per user are kept.

## 12. Open for the owner

- **Where was offline switched on and "Ready" seen: in the home-screen app, or in a Safari tab?** This decides whether candidate C is a bug or only an onboarding gap. Stage A handles either answer.

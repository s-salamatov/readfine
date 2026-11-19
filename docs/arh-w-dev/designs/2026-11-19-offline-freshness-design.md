# Readfine offline freshness: full texts reach the phone fast

Status: draft for owner review (2026-11-19), revision 6 (round 5: fd5-1 major addressed — follow-up scheduled from an executor-completion listener; round 4: 1 major, 2 minor addressed); revision 4: F1 changed by the owner (queue every new article with full text available, start extraction at once; no offline-reader condition). Earlier: design review rounds 1–3 (round 1: 1 major, 4 minor; round 2: 1 major, 2 minor; round 3: 1 minor; all addressed).
Repo: `/projects/readfine/src`, branch `feat/offline-freshness` from `selfhost` c81977a (offline v2 deployed). Workflow run: arh-w-dev `run-291aeb42`.

## 1. Problem

After the offline v2 deploy the owner read about 250 articles in airplane mode, and they had only the RSS-truncated text.

- The full text (`readable_content`) is extracted on the server.
- An article is queued for extraction only by:
  - the 15-minute marker job (`mark_readable_backfill`), and only after the device has synced;
  - an online open of the article, which extracts on demand.
- The phone receives the new text only at its next sync. While the app is open and online, sync runs at launch, when the app becomes visible, on the `online` event and every 5 minutes.

So between a new article arriving and its full text being on the phone there are three waits:
1. up to 15 minutes until it is queued;
2. the extraction queue itself;
3. up to 5 minutes until the next sync.

Nothing tells the owner which articles have their full text on the phone.

Evidence: discovery report `stage.brainstorm.a1`. Key places:
- `fetcher/rss.py:366–435`, `fetcher/scrape.py:310–374` (insert);
- `services/readable_backfill.py:37–74` (marker);
- `services/readable_service.py:1127–1376` (picker);
- `static/js/offline/page.js:1180–1256` (sync triggers, a11 probe);
- `services/sync/manifest.py:41–73` (versions);
- `alembic/versions/0127_offline_sync.py:35–46` (`content_version` bump).

## 2. Goals

- **G1. Queue and extract on arrival.** A new article from a feed with full text on is queued for extraction as soon as the feed fetch saves it, and extraction starts at once. The phone's next sync then usually brings the full text together with the feed update.
- **G2. Deliver within about 30 s.** While the app is open and online, the phone learns of new or changed content in about 30 s and syncs. At launch and when the app comes to the foreground it syncs at once, as it does today.
- **G3. Show progress.** The menu's sync status shows "Full texts N of M". An offline article without its full text says that it shows the feed version.

Non-goals:
- Background sync while the iOS app is closed or suspended: iOS does not run it.
- Faster extraction per site: politeness limits stay as they are (a 5 s floor per host, learned spacing, 429 cooldown).
- Stage B features.

## 3. Design

### F1. Queue at ingest (backend)

Owner decision (2026-11-19): every new article whose full text is available is queued the moment the RSS update reaches the server, and the download starts at once. The phone's next sync then usually gets the full text together with the feed update.

- **Hook.** At the end of the new-article save block in `rss.py` and `scrape.py`, after filters and dedup and before the fetch's commit, one helper `queue_new_for_readable(feed_id, new_ids, db, now)` runs one set-based `UPDATE`.
- **The UPDATE.**
  - It sets `readable_status='pending'`, `readable_priority=1` and `readable_queued_at=now` for the new ids.
  - Each id must still be `skipped`, not trimmed, and have a non-empty URL.
  - The feed must have at least one subscriber with `UserFeed.extract_readable = true` and `readable_auto_disabled = false`. This is the existing per-feed "full text available" setting. Feeds that already carry full content are auto-disabled by it.
  - There is no offline-reader condition: whether anyone reads offline does not matter. Any reader who opens the article later gets the full text instantly, online too.
- **Start at once.**
  - **When a wake is sent.** After the fetch commits, the helper wakes extraction if any of the new ids is now `pending`. This covers rows its own `UPDATE` queued and rows a filter already queued at priority 0. Those keep their priority and retry schedule.
  - **How it wakes.** `wake_readable()` always does two things:
    1. It sets a process-local flag `wake_pending = True`.
    2. It pulls the 1-minute `process_readable` job forward (`modify_job(next_run_time=now)`, as `run_lexical_backfill_now` does).
    
    If the job is idle, it runs now. If a pass is running, APScheduler rejects the extra run (`max_instances=1`), and the flag stays set.
  - **Follow-up after a pass.** The follow-up is scheduled only after the executor has released the running instance, never from inside the job coroutine.
    - A design-review probe on APScheduler 3.11.2 showed that `modify_job` called from the coroutine's tail is rejected for max instances. In 3.11.2, `BaseExecutor._run_job_success` decrements the instance count before it dispatches the job's result event: `EVENT_JOB_EXECUTED`, or `EVENT_JOB_ERROR` for an exception raised by the job. `_run_job_error` only handles executor infrastructure failures; it decrements and logs, and dispatches no event.
    - So the scheduler gets one listener, scoped to job id `process_readable` and to those two events. If `wake_pending` is set, the listener runs `modify_job(next_run_time=now)` for exactly one follow-up.
  - **Clearing the flag.** `process_readable` clears `wake_pending` as its first step, before the picker takes its candidates.
    - A wake that arrives after that point keeps the flag set, so the listener schedules the follow-up.
    - A wake that arrives just before is already seen by this pass; at worst one extra short run follows.
    - A failed pass (`EVENT_JOB_ERROR`) still schedules the follow-up, and the flag is not lost.
  - **Limits.**
    - Runs never overlap (`max_instances=1` stays).
    - Pacing is not bypassed: the follow-up's picker applies the per-site floor and the cooldown as usual.
    - The app runs with one uvicorn worker (`--workers 1`), so the flag and the scheduler share one process.
  - **Test.** The ordering test runs the real APScheduler `AsyncIOScheduler` with the real executor: pass A takes its candidates, fetch B commits and wakes, A ends, and the follow-up run picks B within a second, not at the next minute tick. A second case covers the same ordering when A raises.
  - The picker's pacing still applies: a 5 s floor per site, learned spacing, and the 429 cooldown.
  - A big batch from one site therefore spreads over a few minutes. Smaller batches, from several sites, finish within seconds to a minute.
- **Marker job.** It stays as the safety net for older articles, which were already stored before this change, and for scope changes. It also runs right away when `stamp_offline_synced` records a new stamp, not on the next 15-minute tick.
- **Picker.** No change. Priority-1 rows are taken newest first, so fresh arrivals go ahead of an old backlog. On-demand opens (priority 0) still come first.
- **Load.** Extraction now runs for every new article of feeds with full text on, not only for offline readers. This is the owner-only instance with 13 feeds, and the volume equals the number of new articles per day. The per-site pacing bounds outgoing requests.

### F2. Fast delivery: a cheap change token, checked every 30 s (backend + page)

- **New endpoint `GET /sync/changes`.**
  - Authenticated, `no-store`, with a light rate limit.
  - Returns `{"token": "<12 hex>"}`, a short digest that changes on the fast-path changes listed below.
  - **What the token guarantees.** It is a fast path for the changes this work is about. Everything else is caught by the 5-minute safety sync, which stays.
    - In the fast path:
      - a new article in a subscribed feed;
      - a change to an article's body, full text, `readable_status` or trimming;
      - a change of this reader's read/star/archive/saved stamps;
      - a change of this reader's feed settings, including full-text eligibility (see F3).
    - Fast path not guaranteed, caught by the 5-minute sync:
      - AI summary, context and scores;
      - share tokens;
      - label membership;
      - hidden/suppressed changes;
      - deleting an article that is not the newest;
      - a transaction that commits later than a newer one.
  - **Implementation.**
    - A new `articles.changed_at` column, set on insert and by the existing `content_version` trigger. Its trigger columns are extended to cover `readable_status` (see F3).
    - The token is `sha1` over four values. Items 1–3 are three aggregate queries; item 4 reuses `prefs_version`, which itself runs a few small queries. Expected cost: a few milliseconds at the owner's data size. This is an estimate, to be measured in implementation.
      1. `max(a.changed_at)` over articles whose `feed_id` is in the reader's subscribed feeds. This uses a new index on `(feed_id, changed_at)` (index-only scan per feed). Kept articles of unsubscribed feeds are left out; they rarely change, and the 5-minute sync covers them.
      2. `max(greatest(read_changed_at, star_changed_at, archive_changed_at, saved_changed_at))` over this reader's `user_article_states` rows. This is a bounded scan of one reader's rows, which uses the existing `(user_id, article_id)` primary key.
      3. A digest of this reader's `user_feeds` rows `(feed_id, extract_readable, readable_auto_disabled)`. These are the reader's subscriptions only, a handful of rows.
      4. `prefs_version` (existing).
    - `list_versions` is not part of the token; the 5-minute sync covers list changes.
    - Query shape and timing are verified in implementation with `EXPLAIN ANALYZE` on a prod-sized copy.
  - **Migration 0129.**
    - Sets `lock_timeout` as 0127 does.
    - Adds the column (nullable), backfills it from `fetched_at` in one statement and then sets `NOT NULL` with default `now()`.
    - Adds the index and replaces the trigger function and trigger column list.
    - The downgrade restores the 0127 trigger before dropping the index and the column.
    - Prod has about 425 articles. Expect a lock of well under a second, with at most a brief stall of feed fetches while it runs; `lock_timeout` bounds it. This is an estimate, measured on a prod-sized copy in implementation.
  - **`/healthz` stays as it is.** It is public, has no account data, and a11 checks its payload exactly.
- **Page: one 30 s loop while the app is visible.**
  - **Online** (not forced offline): GET `/sync/changes`. If the token differs from the one stored after the last successful sync, run `autoSync` (single-flight as today).
    - A network failure or timeout switches to the offline branch; this replaces the reliance on `navigator.onLine`.
    - 401/403 or a same-origin `/login` redirect is the existing auth rule.
  - **Offline:** the a11 `/healthz` probe, unchanged. On success it runs `autoSync`.
  - Hidden page: no polling. On becoming visible: an immediate check, as today's `visibilitychange` sync.
- **5-minute interval.** It stays as a safety sync, so a missed token change still syncs within 5 minutes.
- **Launch and foreground.** `start()` and `visibilitychange` already sync when online (`page.js:1180–1203`). They are kept. Tests pin "launch online → sync starts without a button".
- **Stored token.** The token is stored with the device's sync state after a successful sync (the manifest response also returns the token), so a launch never re-syncs only because the token is unknown.

### F3. Show progress (backend + page)

- **Server: a full-text flag `full_text` in each article's snapshot.** It is computed per reader and decided in this order, first match wins:
  1. `true` if the article has a stored full body: `readable_status='success'` with non-empty `readable_content`. This includes feed-native full bodies that ingest already stores this way, such as YouTube.
  2. `null` (not expected) if:
     - the article has no URL or is trimmed;
     - the reader has no subscription to its feed (a kept article of an unsubscribed feed);
     - the reader's feed has `extract_readable = false` (whatever the reason: switched off, or auto-disabled because the feed already carries full content);
     - the feed has `readable_auto_disabled = true` (blocked);
     - `readable_status = 'failed'`, which is a terminal failure.
  3. `false` (expected, not there yet) otherwise: `pending`, or `skipped` on an eligible feed.
- **The flag travels in the record as well as in the snapshot, and a mismatch makes the snapshot stale.** The device has two version checks:
  - the record (`payload.py`), refetched when the manifest digest changes;
  - the snapshot, refetched only when `snapshotStale` (`sync.js:64–72`) sees a different `content_version`, template version or prefs version.
  
  So a digest change alone does not refresh the snapshot. The design therefore:
  1. Adds `readable_status` and the reader's eligibility for that article's feed (subscription present, `extract_readable`, `readable_auto_disabled`) to the manifest article digest (`article_versions`). A status-only or feed-setting-only change then refetches the record. This includes unsubscribing, after which a kept article becomes `null`.
  2. Puts the computed `full_text` value into the article record (`payload.py`) as well as into the snapshot (`snapshots.py`). Both are computed by one shared server helper, so they cannot disagree.
  3. Extends `snapshotStale`: the snapshot is stale when `snap.full_text !== record.full_text`. The comparison counts a missing key as `undefined`, so a legacy snapshot is always stale once the record carries the flag. The device stores the flag with the snapshot.
  
  End to end, switching extraction off for a feed changes the digest, then the record's `full_text` (false → null), then the snapshot is refetched without the offline note, and the counter drops the article from M. The token sees the feed-setting change within 30 s (F2, item 3). Without the token, the 5-minute sync does the same.
- **Old snapshots** stored before this change have no `full_text` key. The page treats a missing key as "unknown" and leaves it out of both N and M. The next sync refetches them, because the record now carries the flag (item 3 above).
- **Page: a menu line, "Full texts N of M".**
  - It sits in the offline status (`[data-rf-slot="offline-status"]`), next to "Images", patched in place the same way.
  - M counts the stored snapshots whose `full_text` is `true` or `false`; N counts those with `true`. A missing key or `null` is not counted.
  - When N < M and the device is online, the line adds "(server is fetching)". Offline it adds nothing; the counts speak for themselves.
- **Offline article view.**
  - If the stored snapshot's flag is `false`, a one-line note above the body says: "Full text not downloaded yet — showing the feed version."
  - Online behaviour is unchanged: an open still extracts on demand.

## 4. Failure handling and limits

- If queueing at ingest fails, the feed fetch must not fail: a failure is logged. The marker job catches up only for articles in an offline reader's scope; other articles stay `skipped` until someone opens them, which extracts on demand as before. The helper runs inside the fetch transaction, after the rows are saved. A failed `UPDATE` rolls back only through a savepoint (`begin_nested`), so the new articles are kept.
- A rejected `/sync/changes` call (rate limit, 5xx) is treated like a missed tick. The next tick, or the 5-minute safety sync, catches up. It never demotes offline mode and never shows an error.
- The extraction rate is unchanged. A site such as Habr gives about 10 extractions per minute, so a large first backlog still takes minutes. The counter shows that honestly.
- Load: one small authenticated request (a few aggregate queries) per open, visible page every 30 s. Owner-only instance; cost measured in implementation.

## 5. Tests and checks

- Backend:
  - the ingest helper queues every new article of a feed with full text on (no offline-reader condition), skips trimmed, URL-less and non-skipped rows, and keeps the fetch on failure (savepoint); a wake is sent when any new id is pending, including rows a filter queued at priority 0, and not when none is; a wake while `process_readable` runs sets `wake_pending`, and exactly one follow-up run starts right after the pass ends (no overlap, pacing applied) — pinned by the ordering "pass A captures candidates, fetch B commits, A ends → follow-up runs B";
  - the marker runs immediately on a new stamp;
  - the token changes on a new article, a full-text update, a `readable_status` change, a state change and a prefs change, and stays the same otherwise;
  - migration 0129 up and down;
  - the snapshot flag: true, false and null cases.
- Backend, failure paths and invalidation:
  - Real RSS and scrape saves where the queue `UPDATE` fails inside the savepoint. The new rows survive, and existing priority-0 and success rows are untouched.
  - The snapshot flag's precedence, one case per rule.
  - A feed-setting-only change (extraction off, auto-disable, unsubscribe) changes the article version and the token. A status-only change (pending → failed) changes the version.
- JS:
  - online, visible: a token change runs `autoSync` within one tick, an unchanged token does not;
  - an unchanged token still syncs at the 5-minute fallback;
  - timeout or network error on the token fetch switches to the offline probe;
  - a 429 or 5xx on the token fetch is a missed tick: no state change, no offline switch;
  - 401/403 or a same-origin `/login` redirect follows the existing auth rule; a token for a different account is ignored and the page syncs;
  - force-offline, hidden page or logout while a token request is in flight: the result is ignored;
  - the token is stored only after a successful sync; after a failed or partial sync it stays as it was;
  - hidden: no polling;
  - launch online: sync starts;
  - the counter: N/M from snapshots, legacy snapshots without the key excluded, the "(server is fetching)" suffix;
  - an eligibility-only change refreshes stored snapshots and the counter end to end: digest → record `full_text` false → null → `snapshotStale` true → refetched snapshot without the note → M decreases; a legacy snapshot without the key is refetched;
  - the offline note appears only when the flag is `false`.
- e2e (Chrome + WebKit): a new article gets its full text server-side, and the open page shows it within about 30 s without any action. Then it reads offline as full text.
- Real check after deploy: the owner's iPhone. Add a feed item, keep the app open about 1 minute, go to airplane mode, open the article.

## 6. Rollout

Migration 0129 runs at app start. Expect only the usual app restart plus a sub-second lock (estimate, measured on a prod-sized copy). Merging into `selfhost` and deploying both need the owner's approval, as before.

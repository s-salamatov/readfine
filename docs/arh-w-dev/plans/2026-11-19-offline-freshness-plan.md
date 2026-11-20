# Readfine offline freshness implementation plan

Status: plan / draft · 2026-11-19 · run `run-291aeb42-6a08-4c7d-96ff-7e69d9592cab` · baseline `c81977a`

**Goal:** Extract new articles on arrival, sync their full texts to the visible offline-enabled app within about 30 seconds of availability, and show which texts are stored.

**Architecture:** RSS and scrape queue work inside their ingest transactions and wake the existing scheduler after commit. An authenticated token lets the visible page detect changes between safety syncs. The manifest, records and snapshots carry the information needed to refresh and display the stored full-text status.

**Tech stack:** FastAPI, async SQLAlchemy, PostgreSQL, Alembic, APScheduler 3.11.2, pytest, Jinja, plain-script JS, IndexedDB, node:test and Playwright (Chrome/WebKit).

**Design:** [Offline freshness, revision 6](../designs/2026-11-19-offline-freshness-design.md), approved by the owner on 2026-11-19 at 19:25. Approved SHA-256 `50303ef456410f57c3d9726e55c49c2f972494684d283b6328529ad9593684f0`.

**Execution:** `hc-fork`.

## Global Constraints

- CSP is nonce-based. Any permitted inline `<script>` needs `nonce="{{ request.state.csp_nonce }}"`. This feature uses external JS and adds no inline scripts or handlers.
- After changing classes in templates, rebuild the stylesheet: `npm run build`.
- Registration stays off.
- `/logout` sends no `Clear-Site-Data` header.
- Preserve the offline v2 decision table, mirror ordering and no-demotion guarantees. Only explicit off/logout/wipe/account deletion paths may return registration to plain `/sw.js`. Keep the a11 `/healthz` response check exact.
- Exact copy: `Full texts N of M` · `(server is fetching)` · `Full text not downloaded yet — showing the feed version.`
- The app runs with one uvicorn worker (`--workers 1`), so the flag and the scheduler share one process.
- The picker's pacing still applies: a 5 s floor per site, learned spacing, and the 429 cooldown. `max_instances=1` stays.

**Backend commands.** From `backend/`, set `PGENV='DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4250/readfine_test SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd'`. Use `env $PGENV uv run pytest … -q`. After `f2-change-stamp` adds the migration, run `env $PGENV uv run alembic upgrade head` against `readfine_test`. Expected on a 0128 database: `Running upgrade 0128 -> 0129`. Run JS and Playwright commands from the repo root.

## Review Focus

1. A filter queued a new item at priority 0 and the ingest UPDATE failed. The fetch still commits, wakes once and preserves the retry time. Test `test_fetches_commit_through_queue_savepoint_failure` (`f1-ingest-queue`).
2. A wake arrives while pass A is holding the only executor instance and A raises. One follow-up picks the committed row within a second. Test `test_executor_completion_runs_one_queued_follow_up` (`f1-scheduler-wake`).
3. A new write arrives between the manifest's token read and version reads. The returned token stays the earlier one, so the next poll can still notice the change. Test `test_changes_route_requires_own_session_and_manifest_uses_early_token` (`f2-change-token`).
4. A token response resolves after the tab was hidden and made visible again, or during force-offline or logout. Its result has no effect. Test `freshness ignores obsolete replies and distinguishes outages from HTTP responses` (`f2-page-poll`).
5. An unsubscribe leaves a starred article on the device. Its eligibility and version change, and the old feed-version note must disappear. Tests `test_full_text_flag_tracks_reader_and_status` (`f3-server-flag`) and `eligibility-only change refreshes snapshots and the menu count` (`f3-page-status`).

## File map

| File | Task(s), in order | Responsibility |
|---|---|---|
| `backend/app/fetcher/scheduler.py` | f1-scheduler-wake | Wake flag, completion listener and marker wake |
| `backend/app/routers/web/sync.py` | f1-scheduler-wake, f2-change-token | Post-commit marker wake, new route and manifest token |
| `backend/tests/test_readable_backfill.py` | f1-scheduler-wake | Executor ordering and marker stamp |
| `backend/app/services/readable_backfill.py` | f1-ingest-queue | Ingest queue helper |
| `backend/app/fetcher/rss.py` | f1-ingest-queue | RSS queue and post-commit wake |
| `backend/app/fetcher/scrape.py` | f1-ingest-queue | Scrape queue and post-commit wake |
| `backend/tests/test_fetcher.py` | f1-ingest-queue | Existing RSS save contract |
| `backend/tests/test_scrape.py` | f1-ingest-queue | Existing scrape save contract |
| `backend/tests/test_readable_ingest.py` | f1-ingest-queue | Eligibility and real savepoints |
| `backend/alembic/versions/0129_offline_freshness.py` | f2-change-stamp | Column, index and trigger |
| `backend/app/models/article.py` | f2-change-stamp | Timestamp mapping |
| `backend/tests/test_migration_0129.py` | f2-change-stamp | Transactional migration round trip |
| `backend/app/main.py` | f2-change-token | Mount the exact `/sync/changes` route |
| `backend/app/services/sync/manifest.py` | f2-change-token, f3-server-flag | Token query and per-reader record digest |
| `backend/tests/test_sync_manifest.py` | f2-change-token, f3-server-flag | Token contract and article invalidation |
| `backend/app/static/js/offline/db.js` | f2-page-poll | Per-user token metadata |
| `backend/app/static/js/offline/sync.js` | f2-page-poll, f3-page-status | Poll client, token commit and snapshot invalidation |
| `backend/app/static/js/offline/page.js` | f2-page-poll, f3-page-status | Visible loop and status counter |
| `tests/js/offline-page.test.mjs` | f2-page-poll, f3-page-status | Loop and status assertions |
| `tests/js/offline-sync.test.mjs` | f2-page-poll, f3-page-status | Token persistence and snapshot refresh |
| `backend/app/services/sync/full_text.py` | f3-server-flag | Shared flag precedence |
| `backend/app/services/sync/payload.py` | f3-server-flag | Record flag |
| `backend/app/services/sync/snapshots.py` | f3-server-flag | Snapshot flag and detail render context |
| `backend/app/services/sync/__init__.py` | f3-server-flag | Offline template version |
| `backend/app/templates/app/partials/article_content.html` | f3-server-flag | Offline-only note |
| `backend/tests/test_sync_payload.py` | f3-server-flag | Record field |
| `backend/tests/test_sync_snapshots.py` | f3-server-flag | Snapshot field and offline detail |
| `tests/js/offline-router.test.mjs` | f3-page-status | Offline detail uses the refreshed snapshot |
| `tests/e2e/offline-freshness.spec.mjs` | freshness-e2e | Live feed to visible page to offline article |
| `tests/e2e/fixtures/seed.py` | freshness-e2e | Deterministic fresh feed, HTML and article lookup |
| `tests/e2e/fixtures/freshness_app.py` | freshness-e2e | Exact loopback fixture allowance in the test app |
| `playwright.config.mjs` | freshness-e2e | One-worker launcher for the browser test app |

## Tasks

### Task f1-scheduler-wake: wake the existing jobs after commit

**Size** M · agent: worker · blocked_by: —

**Files:**
- Modify: `backend/app/fetcher/scheduler.py:1-30,565-581,799-811,989-1017`, `backend/app/routers/web/sync.py:53-68`.
- Test: `backend/tests/test_readable_backfill.py:38-57` and the new ordering test.

**Interfaces.**
- Consumes: `_process_readable() -> None` (async), `process_pending_readable(db: AsyncSession)`, `stamp_offline_synced(user: User, db: AsyncSession, *, now: datetime) -> bool` (async).
- Produces in `app.fetcher.scheduler`: `wake_readable() -> None`, `wake_readable_backfill() -> None` and `create_scheduler() -> AsyncIOScheduler` with the readable completion listener. Module flag `wake_pending: bool` starts false.

- [ ] **RED:** `test_executor_completion_runs_one_queued_follow_up`. Run the production job and listener in a fresh real `AsyncIOScheduler` with its real executor and clock. At the picker seam pause A after its candidate read, commit B, call `wake_readable()` twice, and wait for `EVENT_JOB_MAX_INSTANCES` before releasing A. Exercise A returning normally and A raising. In both cases assert `wake_pending is True` while A is held, `picked == [A, B]` within 1 s of release, at most one active pass, one follow-up, and `wake_pending is False` at its picker entry. Reuse the existing picker pacing tests.
- [ ] **RED (extend):** `test_manifest_commits_only_when_stamp_changes` asserts the order `['commit', 'wake-marker']` across the first manifest and an immediate repeat. Assert the marker wake targets `mark_readable_backfill` with a UTC `next_run_time` of now.
- [ ] Run: `env $PGENV uv run pytest tests/test_readable_backfill.py -k 'executor_completion or manifest_commits' -q`. Expected: both selected tests `FAILED`.
- [ ] **GREEN:** Implement the two wake functions in `scheduler.py` using the `run_lexical_backfill_now` pattern. `wake_readable()` sets the flag first and advances `process_readable` if installed. Clear the flag as the first instruction of `_process_readable()`. Register one listener on `EVENT_JOB_EXECUTED | EVENT_JOB_ERROR` for `process_readable`. If the flag is set there, advance the next run once after the executor has released the instance. In `sync.py`, call `wake_readable_backfill()` only after a successful commit of a new stamp.
- [ ] Run: `env $PGENV uv run pytest tests/test_readable_backfill.py tests/test_readable_backfill_picker.py -q`. Expected: `passed` with zero failures.

### Task f1-ingest-queue: queue new RSS and scrape articles

**Size** M · agent: worker · blocked_by: f1-scheduler-wake

**Files:**
- Modify: `backend/app/services/readable_backfill.py:1-37`, `backend/app/fetcher/rss.py:227-248,279-296,405-437`, `backend/app/fetcher/scrape.py:240-255,277-289,351-374`.
- Test: create `backend/tests/test_readable_ingest.py`. Update direct private-save assertions at `backend/tests/test_fetcher.py:1784-1836` and `backend/tests/test_scrape.py:788-815`, and convert the scalar `0` return of the private-save mocks at `backend/tests/test_fetcher.py:1180,1196,1222,1410,1428` to `(0, False)` for the new `tuple[int, bool]` return.

**Interfaces.**
- Consumes: `wake_readable() -> None` from `f1-scheduler-wake` (lazy import from the fetchers to avoid their scheduler import cycle).
- Produces: `async queue_new_for_readable(feed_id: int, new_ids: list[int], db: AsyncSession, now: datetime) -> bool`. Return whether any of the batch's saved rows is pending. The private save functions return `(count, wake)` and the public fetch functions keep their `int` result:
  - `async _save_articles(feed: Feed, parsed: feedparser.FeedParserDict, db: AsyncSession, limit: int | None = None, published_cutoff: datetime | None = None, defer_stories: bool = False) -> tuple[int, bool]`.
  - `async _save_scrape_articles(feed: Feed, links: list[tuple[str, str, datetime | None, str | None]], fetched_at: datetime, db: AsyncSession, published_cutoff: datetime | None = None, defer_stories: bool = False) -> tuple[int, bool]`.

- [ ] **RED:** `test_queue_new_rows_for_any_eligible_subscriber`: all subscribers have `offline_synced_at is None`; one has extraction enabled and not auto-disabled. Assert eligible new rows get `('pending', 1, NOW)`. Trimmed, empty/NULL URL, existing ids outside the batch, other feeds, blocked/off-only feeds and non-`skipped` rows retain their values. With only filter-pending ids, `wake is True` and priority 0 and retry time survive. With no pending ids or an empty batch, `wake is False`.
- [ ] **RED:** `test_fetches_commit_through_queue_savepoint_failure`: exercise real `fetch_feed` and `fetch_scrape_feed` against Postgres, stubbing just outbound responses and injecting a database statement error in the queue UPDATE. Assert the fetch reports its inserted count, the new rows survive, a filter-pending row retains priority 0 and its retry time, and a success row retains its body. Assert one wake after commit with that pending row and no wake if commit fails. Cover successful ingest through both fetch entry points as a control.
- [ ] Run: `env $PGENV uv run pytest tests/test_readable_ingest.py -q`. Expected: two `FAILED` tests.
- [ ] **GREEN:** Implement `queue_new_for_readable(...)` in `readable_backfill.py`: one set-based UPDATE inside `db.begin_nested()` for the supplied ids, matching feed, `skipped`, untrimmed, nonempty URL and an eligible `UserFeed` via `EXISTS`. Use the three values in the test. Flush preceding writes before the savepoint. On queue failure log it and roll back the savepoint. Preserve the wake for any preexisting pending ids by checking the batch after the UPDATE or savepoint rollback, with the fallback read also isolated if it fails. At each private save tail call the helper after filters and dedup (and RSS auto-disable), return `(0, False)` for an empty batch, and signal only after the outer fetch commit. Stub the new queue helper in the existing mocked save tests, which have no real savepoint.
- [ ] Run: `env $PGENV uv run pytest tests/test_readable_ingest.py tests/test_fetcher.py tests/test_scrape.py -q`. Expected: `passed` with zero failures.

### Task f2-change-stamp: migration 0129 and model mapping

**Size** S · agent: worker · blocked_by: —

**Files:**
- Create: `backend/alembic/versions/0129_offline_freshness.py`. Modify: `backend/app/models/article.py:50-67`.
- Test: create `backend/tests/test_migration_0129.py`.

**Interfaces.**
- Consumes: revision `0128` and the 0127 `articles_bump_content_version()` / `trg_articles_content_version` contract (`backend/alembic/versions/0127_offline_sync.py:34-51,100-105`).
- Produces: `Article.changed_at: Mapped[datetime]`, `ix_articles_feed_changed_at` on `(feed_id, changed_at)`, Alembic `upgrade() -> None` and `downgrade() -> None`.

- [ ] **RED:** `test_freshness_schema_round_trip`. In a rollback-only transaction on `readfine_test`, invoke the revision on a SQLAlchemy connection bound through Alembic `Operations.context`. Start from 0128 schema (locally downgrade inside that transaction if the test database is at 0129). Seed a legacy row with a fixed old `fetched_at`. Assert upgrade backfills that exact value, new INSERTs get a non-null timezone-aware default, and the index exists. Status/body/trim changes advance `changed_at` and increment `content_version`; same-value and retry-only writes do neither. After downgrade assert the column/index are absent, a status-only write leaves `content_version` alone and a content write still bumps it.
- [ ] Run: `env $PGENV uv run pytest tests/test_migration_0129.py -q`. Expected: `FAILED …::test_freshness_schema_round_trip` on missing 0129.
- [ ] **GREEN:** Implement the revision and ORM mapping. Use `SET LOCAL lock_timeout = '5s'` in both directions. Add nullable `timestamptz`, backfill from `fetched_at`, set `NOT NULL DEFAULT now()`, then add the index. Retain the 0127 trigger columns and `IS DISTINCT FROM` checks and add `readable_status` to both. Set `NEW.changed_at = clock_timestamp()` in the same branch as the existing version bump. Restore the 0127 function and trigger before dropping the index and column.
- [ ] Run: `env $PGENV uv run alembic upgrade head && env $PGENV uv run pytest tests/test_migration_0129.py tests/test_offline_sync_schema.py tests/test_migration_0128.py -q`. Expected: upgrade to `0129` on first run and `passed` with zero failures.

### Task f2-change-token: authenticated poll endpoint and manifest token

**Size** M · agent: worker · blocked_by: f1-scheduler-wake, f2-change-stamp

**Files:**
- Modify: `backend/app/services/sync/manifest.py:29-40,76-90`, `backend/app/routers/web/sync.py:15-19,23-68,75-83`, `backend/app/main.py:142-150,186-205,232-248`.
- Test: `backend/tests/test_sync_manifest.py:190-220` and new token tests.

**Interfaces.**
- Consumes: `Article.changed_at`, `_digest(parts) -> str`, `async prefs_version(user_id: int, db: AsyncSession) -> str`, `_same_account(...)` and `_user_or_ip(request: Request) -> str`.
- Produces: `async changes_token(user_id: int, db: AsyncSession) -> str` in `manifest.py`. `GET /sync/changes` accepts `X-Readfine-User` like `/sync/v1`, returns exactly `{"token": "<12 lowercase hex>"}` with `Cache-Control: no-store`; mismatch is `409 {"error":"account_mismatch"}`. `/sync/v1/manifest` adds `token` with the same format.

- [ ] **RED:** `test_changes_token_tracks_only_reader_fast_path`. Assert `[0-9a-f]{12}` on an empty account and a stable repeat. Assert token changes for a new subscribed article, its body/full text/status/trim, each read/star/archive/saved stamp and a prefs change, and for extract off, auto-disable and unsubscribe. Use separate transactions for distinct state `now()` stamps, with targeted fixture cleanup. Assert unrelated account changes, unsubscribed kept article changes, dwell, label-only and AI state edits leave it unchanged.
- [ ] **RED:** `test_changes_route_requires_own_session_and_manifest_uses_early_token`. Assert `401` without a session, `409` with missing/wrong uid, exact JSON for the correct reader, `no-store` for all these responses and `429` above 30 requests per reader in a minute. Check the manifest token matches the idle poll. Change the underlying data after the manifest's token read but before its version read and assert the manifest's token is the earlier value while the next `/sync/changes` returns the new value. Pin the marker wake coverage from `f1-scheduler-wake`.
- [ ] Run: `env $PGENV uv run pytest tests/test_sync_manifest.py -k 'changes_token or changes_route' -q`. Expected: both selected tests `FAILED`.
- [ ] **GREEN:** In `changes_token(...)`, reuse SHA-1 truncated to 12 hex over four parts: (1) max of the top `changed_at` per subscribed feed using indexed `ORDER BY changed_at DESC LIMIT 1`; (2) max of `greatest(read_changed_at, star_changed_at, archive_changed_at, saved_changed_at)` for that user; (3) digest of `(feed_id, extract_readable, readable_auto_disabled)` for that user ordered by `feed_id`; (4) `prefs_version`. Obtain the manifest token before reading the scope and versions. Register a separate `/sync` router in `main.py` with `_same_account` and a 30/minute limit keyed by `_user_or_ip`. Apply `no-store` for `/sync/changes` in the existing security-header middleware so auth and limiter responses get it too. Use the same `/sync/changes` path in the existing limiter handler to return JSON `429`.
- [ ] Run: `env $PGENV uv run pytest tests/test_sync_manifest.py tests/test_sync_account_check.py tests/test_readable_backfill.py -q`. Expected: `passed` with zero failures.
- [ ] **Measurement, run by the orchestrator at integration (not a worker step; the worker sandbox has no Postgres client and no prod-sized copy).** Restore the pre-deploy dump `/var/backups/claude-ssalamatov/readfine-predeploy-20261119T1817Z/readfine.dump` into a throwaway `postgres:16-alpine` container, run `alembic upgrade 0129` against it and record the elapsed time (expected `Running upgrade 0128 -> 0129`; the sub-second lock is an estimate). Then run, with `docker exec <container> psql -U readfine -d readfine -v ON_ERROR_STOP=1 -c`, the two queries "EXPLAIN (ANALYZE, BUFFERS) SELECT max((SELECT a.changed_at FROM articles a WHERE a.feed_id=uf.feed_id ORDER BY a.changed_at DESC LIMIT 1)) FROM user_feeds uf WHERE uf.user_id=$FRESHNESS_READER_ID" and "EXPLAIN (ANALYZE, BUFFERS) SELECT max(greatest(read_changed_at,star_changed_at,archive_changed_at,saved_changed_at)) FROM user_article_states WHERE user_id=$FRESHNESS_READER_ID" with the reader id substituted. Expected: `Execution Time` for both, `Limit` over a backward index-only scan on `ix_articles_feed_changed_at` for the per-feed lookup, and the state scan confined to the reader. Finally time ten warm `GET /sync/changes` calls against an app served from that copy. Record plans and timings in the integration report; remove the container afterwards.

### Task f2-page-poll: visible freshness loop and successful-sync token

**Size** L · agent: worker · blocked_by: f2-change-token

**Files:**
- Modify: `backend/app/static/js/offline/db.js:33-44`, `backend/app/static/js/offline/sync.js:106-158,691-769,772-779`, `backend/app/static/js/offline/page.js:43-44,95-182,366-424,484-532,577-625,770-824,1180-1257,1289-1319,1384-1415`.
- Test: `tests/js/offline-page.test.mjs:34-115,153-167,325-569,755-771` and `tests/js/offline-sync.test.mjs:109-128,257-272,437-462`.

**Interfaces.**
- Consumes: `GET /sync/changes`, manifest `token`, existing `autoSync() -> Promise<report|null>`, `probeConnection() -> Promise<void>` and `RF.db.getMeta(db, key)`.
- Produces: `RF.db.META.changeToken = 'change_token'` (per-reader string); `RF.sync.readChanges(opts, alive, userId) -> Promise<string|null>` using the existing sync client and its typed stop reasons. Add `opts.signal` for the GET request and `opts.fetchFn` for the existing test seam. Page-internal `freshnessTick() -> Promise<void>` dispatches the online check or existing health probe.

- [ ] **RED:** `freshness ignores obsolete replies and distinguishes outages from HTTP responses`. With a controllable clock and signal-aware delayed responses, assert rejection and 5 s timeout each move to the a11 probe, and its exact success JSON triggers sync even with stale `navigator.onLine`. Assert 429, 5xx and invalid token replies leave state and sync counts alone. Assert 401/403 and same-origin `/login` set auth expiry and stop polling while keeping store/outbox. On 409 discard the reply and run normal `autoSync` to let the manifest verify the account. Release pending responses after force-offline, hide then show, or logout. Assert obsolete results cause neither sync nor state writes.
- [ ] **RED (extend):** `visibilitychange visible triggers sync` checks immediate foreground sync/check, one visible 30 s cadence, same token yields no extra sync and a different token yields one single-flight `autoSync`. Assert no hidden ticks, no extra sync for an unknown token at initial launch, and an unchanged token still gets the 300,000 ms safety sync. Pin existing automatic online launch in `own database gone with the record on: the next online start re-syncs`.
- [ ] **RED (extend):** `first run stores records, snapshots and lists; all ready` saves manifest token `0123456789ab`. Extend `test_partial_sync_hides_articles_without_snapshot` and `pages cache is not written from a login redirect` to assert a failed or partial sync leaves that prior token after receiving `fedcba987654`. An older server omitting `token` leaves it alone.
- [ ] Run: `node --test --test-name-pattern='freshness ignores|visibilitychange visible|first run stores|test_partial_sync|pages cache is not written' tests/js/offline-page.test.mjs tests/js/offline-sync.test.mjs`. Expected: failures naming the poll and token assertions.
- [ ] **GREEN:** Implement `readChanges(...)` in `sync.js` with the existing credentials/header and auth/409 handling. GET with `cache: 'no-store'` and the request signal. Return null for malformed token responses, 429 and 5xx. Surface actual fetch rejection/timeout as network failure, using the a11 threshold. In `run(...)`, persist only a valid manifest token after clean core article/snapshot/list/shell completion and a live database check. Keep the previous token on a failed shell or interrupted/partial apply, and keep detached image progress outside this gate.
- [ ] **GREEN:** In `page.js`, extend the a11 timer into one visible 30 s loop using `freshnessTick()`. Keep the independent 5-minute sync and launch/foreground/`online` triggers. Select offline with the existing offline state and use the exact a11 probe; an online request failure/timeout sets that state even when the navigator reports online. Give the token leg its own abort/identity guard through response parsing and IndexedDB reads. Invalidate on hide, force-offline, off, logout, wipe, account loss or expiry. Ignore a superseded attempt even if eligibility returns before it resolves. Compare the remote token with the current database token, because another tab may have synced. An unknown token leaves initial sync to the existing triggers. Update existing probe assertions to distinguish `/healthz` from the online token leg.
- [ ] Run: `node --test tests/js/offline-page.test.mjs tests/js/offline-sync.test.mjs && npm test`. Expected: `ℹ fail 0` in both runs.

### Task f3-server-flag: one full-text flag and reader-specific invalidation

**Size** M · agent: worker · blocked_by: f2-change-token

**Files:**
- Create: `backend/app/services/sync/full_text.py`.
- Modify: `backend/app/services/sync/manifest.py:41-73`, `backend/app/services/sync/payload.py:54-106`, `backend/app/services/sync/snapshots.py:198-224,271-305`, `backend/app/services/sync/__init__.py:3-5`, `backend/app/templates/app/partials/article_content.html:3-31`.
- Test: `backend/tests/test_sync_manifest.py:127-178`, `backend/tests/test_sync_payload.py:19-53`, `backend/tests/test_sync_snapshots.py:68-80`.

**Interfaces.**
- Consumes: user-scoped `UserFeed` joins and existing `article_versions(user_id: int, ids: list[int], db: AsyncSession) -> dict[int, str]` (async).
- Produces: `full_text_flag(*, readable_status: str, has_readable_content: bool, url: str | None, trimmed: bool, subscribed: bool, extract_readable: bool | None, readable_auto_disabled: bool | None) -> bool | None` in `full_text.py`. Records and snapshots each carry mandatory `full_text: true|false|null`. `render_snapshots(...)` passes the same flag as `rf_full_text` to the detail template.

- [ ] **RED:** `test_full_text_flag_tracks_reader_and_status`. Table-drive precedence: `success` with nonempty body → `True` even if ineligible; no URL, trimmed, unsubscribed, extraction off, auto-disabled, or `failed` → `None`; eligible `pending`, `skipped`, and `success` with an empty body → `False`. A kept starred row stays in scope after unsubscribe but changes digest. Assert off, auto-disable and unsubscribe each change `article_versions` and `changes_token` for the affected reader, and `pending → failed` changes the article digest. Include a second reader of the same article with different eligibility.
- [ ] **RED (extend):** `test_article_records_skip_out_of_scope_ids` and `test_snapshot_shape_and_versions` assert both APIs agree on `full_text` for available, expected and excluded rows. Assert the detail has the exact note above `.article-body` only when `full_text is False`, and that it is absent from the live detail render.
- [ ] Run: `env $PGENV uv run pytest tests/test_sync_manifest.py tests/test_sync_payload.py tests/test_sync_snapshots.py -q`. Expected: `FAILED` on the new helper and missing record/snapshot flags.
- [ ] **GREEN:** Implement the ordered rules in `full_text_flag(...)`. Add `readable_status`, subscription presence, `extract_readable` and `readable_auto_disabled` to the version digest, joining only the requested reader. In `payload.py`, select a SQL nonempty-body boolean to avoid loading HTML merely for the flag. In `snapshots.py`, compute from the original stored body (before HTML rewriting) and the same subscription fields. For snapshot renders in `article_content.html`, use a single `<p data-rf-full-text-note>` above `.article-body` when `rf_full_text is sameas false`. Keep the current extraction/retry messages in live renders and bump `OFFLINE_TEMPLATE_VERSION` from `"2"` to `"3"`.
- [ ] Run: `env $PGENV uv run pytest tests/test_sync_manifest.py tests/test_sync_payload.py tests/test_sync_snapshots.py tests/test_offline_page_shell.py -q`. Expected: `passed` with zero failures.

### Task f3-page-status: refresh legacy snapshots and show stored totals

**Size** M · agent: worker · blocked_by: f2-page-poll, f3-server-flag

**Files:**
- Modify: `backend/app/static/js/offline/sync.js:64-75,352-379`, `backend/app/static/js/offline/page.js:274-293,946-1005,1016-1033`.
- Test: `tests/js/offline-page.test.mjs`, `tests/js/offline-sync.test.mjs:274-317`, `tests/js/offline-router.test.mjs:127-143`.

**Interfaces.**
- Consumes: `record.full_text`, `snapshot.full_text` and the server-rendered `[data-rf-full-text-note]` from `f3-server-flag`, `RF.db.getAll(db, 'snapshots')`, `offline()` and `refreshCounts()`.
- Produces: `snapshotStale(record, snap, versions, mediaKnown, nowMs) -> boolean` with a strict flag comparison. Stored snapshot rows retain the server's `full_text` value. `fullTextText() -> string` renders to `[data-rf-offline-full-text]` in the existing offline status slot next to Images.

- [ ] **RED:** `eligibility-only change refreshes snapshots and the menu count`. Include snapshots with flags `true`, `false`, `null` and missing. Assert `Full texts 1 of 2 (server is fetching)` online and `Full texts 1 of 2` offline. Feed a changed article digest whose record changes from false to null with the same content/template/prefs versions, then assert the refreshed snapshot yields `Full texts 1 of 1`. Assert the status node survives progress updates and no note remains in the new offline detail.
- [ ] **RED (extend):** `a state-only version change keeps the snapshot and readiness` retains its existing assertion when both flags match. Make the legacy snapshot variant omit the flag while its record is now `null`, assert `/sync/v1/snapshots` is fetched and the store now has `full_text: null`. Extend `article detail served from snapshot with overlay` to assert only the `false` snapshot includes the exact note.
- [ ] Run: `node --test tests/js/offline-page.test.mjs tests/js/offline-sync.test.mjs tests/js/offline-router.test.mjs`. Expected: failures naming the counter and legacy snapshot assertions.
- [ ] **GREEN:** In `sync.js`, compare `snap.full_text !== record.full_text` and preserve `s.full_text` on snapshot writes. In `page.js`, count true as N, true/false as M from stored snapshots, and exclude null/missing. Add an in-place status text field next to Images with the exact suffix only when `N < M && !offline()`. Existing offline routing serves the snapshot HTML, including the conditional note.
- [ ] Run: `node --test tests/js/offline-page.test.mjs tests/js/offline-sync.test.mjs tests/js/offline-router.test.mjs && npm test`. Expected: `ℹ fail 0` in both runs.

### Task freshness-e2e: live extraction reaches a visible page and survives offline

**Size** M · agent: worker · blocked_by: f1-ingest-queue, f3-page-status

**Files:**
- Create: `tests/e2e/fixtures/freshness_app.py`, `tests/e2e/offline-freshness.spec.mjs`.
- Modify: `tests/e2e/fixtures/seed.py:82-149,223-272`, `playwright.config.mjs:32-42`.
- Test: the new spec in both existing projects.

**Interfaces.**
- Consumes: `seed()`, `login(page, email, password)`, `enableOffline(page)`, `waitReady(page)`, `coldLaunch(playwright, testInfo, profileDir, {offline})`, the real `POST /htmx/feeds/{feed_id}/refresh` and `GET /sync/changes`.
- Produces: `seed.py freshness-publish <reader-id>` (stdout JSON `{feed_id}`) and `seed.py freshness-status <feed-id>` (stdout JSON `{article_id, readable_status}` with nulls before ingest). `freshness_app.py --port <port>` boots the existing app with one worker and a fixture-only outbound allowance.

- [ ] **RED:** `new full text reaches the open app and reads offline`. Use the existing seeded reader and a fresh browser profile. Once Ready, publish a dedicated subscribed RSS feed with one new short excerpt and a fixture article with a distinctive full-body sentence. Trigger real ingest from a separate authenticated API request context or the browser context's HTTP client, with its session/CSRF headers. Keep the app tab visible with no click, reload, foreground event, or manual sync. Assert server `readable_status === 'success'` (query the e2e DB through `freshness-status`, never open the live article), then within 35 s assert the open page shows `Full texts 1 of 1` and its IndexedDB has `full_text === true` for that id. Use `setOffline(true)` from `coldLaunch`, open the article via the offline app, and assert the full-body sentence is present and the feed-version note is absent.
- [ ] Run on the fixture harness before the feature, when validating RED: `npx playwright test tests/e2e/offline-freshness.spec.mjs --project=webkit`. Expected: `1 failed` on server success or page freshness. On an integrated branch, confirm the upstream task RED evidence and run this spec as a regression.
- [ ] **GREEN:** Implement the fixture CLI alongside the existing seed commands, serving RSS and HTML via the existing fixture server. In the e2e-only launcher, allow the loopback fixture through the existing safe fetch function for the exact RSS/article URLs in this spec, preserving the real parser, readable extractor, scheduler and DB writes. Keep the allowance in the Playwright process and use the existing `readfine_e2e` database guard. Seed/publish only after the visible page's baseline is ready, so the safety sync cannot make the 35 s assertion pass.
- [ ] Run: `npx playwright test tests/e2e/offline-freshness.spec.mjs --project=webkit`. Expected: `1 passed`. The orchestrator runs `npx playwright test tests/e2e/offline-freshness.spec.mjs --project=chrome` outside the Codex sandbox. Expected: `1 passed`.
- [ ] Integration: `npx playwright test --project=webkit` and `npm test`. Expected: Playwright `passed` with zero failures and JS `ℹ fail 0`. After separate merge/deploy approval, add a feed item on the owner's iPhone, leave the app open for about one minute, then enable airplane mode and open the item. Expected: the stored full body opens.

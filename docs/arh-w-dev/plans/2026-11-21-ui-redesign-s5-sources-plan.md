# UI redesign s5 — Sources zone Implementation Plan

Status: plan / candidate · 2026-11-23 · run `run-7429291d-8129-432b-beab-c61fff1112cd`, segment `s5` · code base `selfhost` `b6ec385`; inspected HEAD `53bbde8`, branch `feat/ui-redesign-s5` (the intervening commit changes only the run handoff and track line)

**Goal:** make Sources a separate zone with one-click add-source discovery, a folder-grouped feeds table, inline folder management, feed-edit/OPML/scraping sheets and feed unsubscribe with Undo.

**Architecture:** reuse the existing feed, folder, OPML and scraping handlers and services. Server-rendered forms have both a full-page fallback and a fragment representation in one shared Basecoat sheet; a small `ui/sources.js` controller loads those fragments and preserves form/error/focus state across HTMX swaps. Move public URLs to `/sources` in one later routing task, retaining old non-GET aliases, and wire feed rows to the already shipped `RFPending` queue. Sources remains online-only; the reading shell's sidebar mirror changes with its online counterpart.

**Tech stack:** Python/FastAPI, SQLAlchemy async, Jinja2, HTMX 2.0.4, Tailwind 4.3.5, Basecoat 1.1.0, anime.js 4.5.0 through `RFMotion`, pytest, node:test/jsdom and Playwright. No new dependencies or migrations.

**Design:** `docs/arh-w-dev/designs/2026-11-19-ui-redesign-design.md`, §5.1, §5.2 Add source/Sources, §5.4 delayed delete/moved pages, §5.5 DOM contract/offline, §5.7 wave 5, §6 invariants/negative paths. The s4 owner decision Q3 remains binding: **Filter from this source belongs to s7**. Read the design and this plan together; historical source counts/line numbers in the design are not the current implementation.

**Execution:** `hc-fork`, inherited from this run's launcher assignment; workers do not choose another mode, commit, push or spawn agents. Publication, plan approval and task dispatch belong to the orchestrator. This candidate does not authorize implementation.

## Changes from the draft

- Six tasks in three waves instead of seven in four: keep the substantial add/table/edit/delete/routing units and fold CSS, contract, browser acceptance and repository docs into the final task. Visual acceptance happens **once**, after assembly of the segment.
- IDs are `s5-T1` through `s5-T6`. Draft S5-T6 + S5-T7 become s5-T6; project-level specs remain an orchestrator/spec-keeper handoff as in s4.
- s5-T1 owns all first-wave changes to `feeds.py`, including edit response plumbing consumed by s5-T3. s5-T3 owns edit markup, OPML and scraping. s5-T4 and s5-T5 run in parallel with disjoint files. Explicit later-wave ownership is listed below.
- s5-T5 extends the moved-pages helper for parameterized GETs. Its current redirect endpoint would emit literal `{user_feed_id}` in Location. Action-only routes retain aliases through stacked decorators; they do not acquire fictitious GET handlers.
- No batch splitting in s5-T4: retain the design's single keepalive request per flush, the server's limit of 50 and safe restore on 422. There is no bulk-delete UI in s5. A 51-entry regression test makes this limitation explicit.
- `feeds.py:493`, not :459, is the edit-success redirect today; subscribe also constructs a redirect at :229. `settings/filters.py:144,171` already redirect to `/settings/filters`, so there is **no filters.py edit** in s5.
- Snapshot version stays **6**, hash `60ff43c1c5f70e34`. Sources and sidebar markup are outside the row/detail snapshot closure; the stale carry hash `8e7b85969a19fcf1` is superseded. Do not bump or re-pin snapshots merely for Sources.

## Global Constraints

The following applicable design requirements are carried verbatim:

- **CSP:** `script-src 'self' 'nonce-…'`, no `unsafe-eval`; `style-src 'self' 'unsafe-inline'`. Basecoat JS and anime.js are vendored under `/static/js/vendor/`; no CDN. `htmx.config.allowEval=false` stays; no `hx-on`, no `js:` values, no trigger filters.
- **Asset versioning:** `static_url()` appends a content hash; new vendored files use it.
- HTMX stays the transport. The server renders partials. The client never builds article markup, except the offline mirror, which keeps doing so.
- Every action available today is still reachable, in no more steps than today. Frequent ones (add source, summary, theme, offline, search) take one step.
- The toast text is set through `textContent`, never `innerHTML` (feed titles are user data).
- old GET paths answer 308 to the new path with `Cache-Control: no-store`, so browsers do not keep the redirect and a revert works;
- old non-GET paths (forms and HTMX endpoints called from stale tabs or a cached offline shell) stay registered as aliases of the same handlers until wave 8, which removes them;
- Forms inside dialogs and sheets set their own `hx-swap`/`hx-target`.

Current implementation constraints and decisions:

- Reuse `ui/forms.html`, `ui/display.html`, `ui/overlay.html`, `ui/nav.html`, `ui/readfine.html` (`feed_icon`, `health_dot`). Use tokens; no new literal colours, inline handlers or additional UI framework. Health has accessible text, not colour alone. Feed icons use the existing fallback; no favicon service/schema.
- Application themes remain device-local `neutral|paper|graphite`, each light/dark; colour scheme stays `localStorage.colorScheme`. Motion uses `RFMotion`; reduced motion does not delay any action. Existing browser/phone support and keyboard handling are unchanged.
- Preserve all current subscription controls: custom title, folder, interval, privacy, Basic Auth, recent/latest import scope and limit. Preserve edit URL/auth permission gates, extraction, auto-summary, translation enable/backfill/help text, scraping selector and health/error details. Preserve Stats, folder ordering/reset/delete and OPML section switches/import reports. Do not flatten a functional screen into a mockup.
- Feed IDs have two domains: `uf.id` is **UserFeed/subscription ID**, used by edit/delete and `data-rf-delete-key="feed:<uf.id>"`; `uf.feed_id` is the underlying Feed ID, used for counts, scraping edit lookup and reading navigation. Never interchange them.
- One shared sheet per signed-in document: `#rf-source-sheet`, title `#rf-source-sheet-title`, content `#rf-source-sheet-body`. One form instance at a time. A form rendered as a full page is not also pre-rendered in a hidden sheet. This avoids duplicate `#selector-input`, `#preview-btn`, `#subscribe-folder-select` and credentials in unnecessary markup.
- Sheet GETs explicitly target `rf-source-sheet-body`, `hx-swap="innerHTML"`, `hx-push-url="false"`, `hx-boost="false"`; ordinary links still have real hrefs. The server chooses fragments **only** when `HX-Target == rf-source-sheet-body`, not for every `HX-Request` (boosted full pages need their layout). Use `Cache-Control: no-store` and `Vary: HX-Target` for dual representations.
- Shared template bases: new `sources/base.html` extends `base.html` and exposes `sources_content`; new `sources/sheet_content.html` exposes the same block without document chrome. Add/edit/OPML/scrape templates choose between them using the explicit target. The full Sources layout has Sources title, Back to Read and Settings links, Add source and OPML entry points; do not duplicate the reader's sidebar data-loading pipeline.
- Opening a sheet closes an open command palette or phone sidebar first, waits for the close event where needed, then uses the existing dialog opener/focus implementation. `ui/dialog.js` exports its existing operation as new `RFDialog.open(dialog, opener)`; do not introduce a second focus-trap implementation. Closing returns focus to the original visible trigger, or the Sources heading if that trigger disappeared.
- Explicit sheet save success event: `HX-Trigger: {"sidebarRefresh": true, "rf:sourceschanged": {"kind": "subscribe|edit|scrape|opml"}, "showToast": {"msg": "…", "type": "ok"}}`, JSON-encoded with `json.dumps`. Subscribe/edit/scrape success: 200 empty body, `HX-Reswap: none`, close sheet; non-sheet callers keep 303/HX-Redirect to the full Sources page. OPML keeps its result report **inside** the sheet and also sends refresh events after successful import. Validation never sends `rf:sourceschanged`.
- `ui/sources.js` listens for `rf:sourceschanged`; refresh `#feeds-list` if present and leave the active article/list intact elsewhere. `sidebarRefresh` uses the existing listener. Pending-delete keys hide rows again after any refresh. A successful delete itself is not simulated by a form-save event.
- Discovery continues to call the same `settings_feeds_test` handler and its 10/minute limiter. Live discovery: 800 ms after a changed non-empty valid address/auth input, only while the add form is visible; no request on initial render or unchanged input. Explicit Test/Enter cancels that debounce and sends once. Subscribe cancels pending discovery. Use form `hx-sync="this:replace"` and request-generation checks so older responses cannot replace the result/title for newer inputs. Do not auto-subscribe or require a successful test before subscribing. At 429 stop automatic retries until another user edit/Test; show the existing wait-a-minute explanation inline.
- Credentials are split **server-side** by existing `split_url_credentials`/`auth_pair` and existing subscription service logic, including explicit-field precedence. No JS reimplementation; no password in toast, history, sessionStorage or browser logs. Preserve the existing non-HTMX fallback and URL-redaction rules.
- All Sources entry points/forms carry `data-rf-online-only`. New sheet code also checks `navigator.onLine === false`, the existing offline controller (`RFOffline.page.current(document)` when available), (`state.force` / `state.netDown`) and `aria-disabled` before sending; force-offline must not send a Sources mutation. Report a dropped connection inline, not a blank sheet. Read-only sheet responses that are redirected to login or carry offline content are not inserted as forms; show an actionable connection/session error.
- **Online-only means no Sources cache/queue.** `offline/router.js.handle` currently returns null for `/settings/*` and `/sources/*`; `policy.js.classify` handles full GET navigations but passes non-HTMX Sources requests through. Online old navigation follows the server redirect; offline full navigation produces the existing 503 offline page, never the cached reader shell. Keep that policy. Old stale-tab POST/DELETE aliases work online, and network failures do not become queued offline operations.
- Delayed unsubscribe uses `RFPending.schedule({kind:'feed', id:uf.id, label})`, or its existing declarative `data-rf-delete="feed:<uf.id>"` listener. Hide the row immediately, Undo for 10 s; no separate delete controller, second countdown, inline confirm or new server state. Keep `/settings/deletes`, per-user lock, per-item results and existing `RFToast.fromTrigger` handling. Folder deletion remains immediate with its existing confirmation: folders are not a supported pending kind.
- Do not change `offline/router.js` autoAdvance/synced preferences, read-zone owner questions S4W-F1/F2, WebKit palette/offline flakes, s6, or s7 filter prefill. Snapshot roots/closure remain untouched; all drift and version tests must stay green after s5-T5.
- No git/worktree/commit steps in worker execution. At most **5 new test cases per task**; use the named cases below, retaining existing coverage. Stop after three unsuccessful approaches and report evidence. Selector changes go in task reports for s5-T6.

### Test environment and exact command conventions

Run from the repository root. `PY` below is this shell function, not a different runner; all task command lines use it literally after defining it. Credentials are test-only. Never use the repository's default 4250 DSN or production.

```bash
export SECRET_KEY=ci-test-secret-key-0123456789abcdef
export ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd
export DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_pytest
export E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e
PY() { (cd backend && .venv/bin/pytest -q "$@"); }
JS() { TMPDIR=/var/tmp node --test "$@"; }
```
Expected: definitions succeed, exit 0, no output. Backend files in `PY` commands are relative to `backend`; JS paths are root-relative. `TMPDIR=/var/tmp` avoids the host's unrelated `/tmp/.gitignore '*'` Tailwind-test problem.

Before backend work: `docker exec rf-int-pg-s3rb pg_isready -U readfine`. Expected: `accepting connections`. For the serial verifier DB: `(cd backend && .venv/bin/alembic upgrade head)`. Expected: exit 0, no pending migration; use the above environment. Missing container/dependencies are reported, never replaced with production.

Parallel backend workers each use a task-owned ephemeral database. This is the exact setup for s5-T1; replace **only** `s5_t1` by the current stable task slug for another worker:

```bash
RF_S5_DB="rf_s5_t1_${RANDOM}"
docker exec rf-int-pg-s3rb createdb -U readfine "$RF_S5_DB"
export DATABASE_URL="postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/$RF_S5_DB"
trap 'docker exec rf-int-pg-s3rb dropdb --if-exists -U readfine "$RF_S5_DB"' EXIT
(cd backend && .venv/bin/alembic upgrade head)
```
Expected: create succeeds, migrations reach head, exit 0; trap drops only this database at task exit. No worker drops `readfine_pytest`, `readfine_e2e` or the container. Full tests and browser/visual checks run serially in s5-T6. Pre-migrate `readfine_e2e` before Playwright starts its webServer:

```bash
(cd backend && DATABASE_URL="$E2E_DATABASE_URL" .venv/bin/alembic upgrade head)
```
Expected: exit 0. Existing configured test app/fixture ports are 4251/4252; consult the host registry for availability before starting them, do not assign new ports. Chrome executable remains `/usr/bin/google-chrome-stable`.

CSS/source checks before the final task:

```bash
node scripts/check-tw4-classes.mjs
node scripts/check-colours.mjs
```
Expected: both print `OK`, exit 0. Do not regenerate shared CSS/DOM fixtures in early workers. For optional local CSS inspection use `RF_S5_CSS=$(mktemp -d)`, build with `node scripts/build-css.mjs -i input.css -o "$RF_S5_CSS/tailwind.css"`, then `rm -r "$RF_S5_CSS"`. Expected: CSS written, exit 0, scratch removed. UI/browser acceptance waits for s5-T6.

## Review Focus

1. **Credentials in URL, explicit auth, a captcha/401 and overlapping discovery responses.** A response must describe the current address and never leak credentials. → s5-T1 `test_sources_discovery_credentials_and_errors`, JS `sources: discovery ignores stale results and surfaces transport failures`.
2. **Folders with no feeds, unread state belonging to another user, long titles and a 390 px screen.** Correct grouping/counts; scrolling stays inside the table, menu actions remain reachable. → s5-T2 `test_sources_counts_and_grouping`, `test_sources_table_contract`; s5-T6 browser `sources: table and folders at phone width`.
3. **Invalid edit/OPML/scraping submissions in a sheet.** Stay in the sheet, retain safe input, show the cause, preserve permission/SSRF/size limits. → s5-T3 tests 1–4; s5-T1 `test_sources_sheet_response_contract` for edit errors.
4. **Delete, Undo, navigation/reload, stale CSRF/session, 51 queued rows and cleanup side effects.** Never delete early or lie about a failed send; use subscription IDs and existing notice list. → s5-T4 tests 1–5 and existing `test_settings_deletes.py` concurrency tests; s5-T6 browser delete flow.
5. **Old bookmarks, parameterized edit URLs, old form submissions and an active service worker.** GET 308 + no-store preserves parameters/query, non-GET dispatches the same endpoint; offline Sources never renders the reader shell or queues writes. → s5-T5 tests 1–5; s5-T6 browser moved-page/offline flow.
6. **Boosted navigation followed by repeated sheet opens, or opening from palette/mobile sidebar.** No duplicate listeners/forms, inherited target, invisible focus or stacked modal. → s5-T1 JS `sources: sheet lifecycle survives boosted swaps`; s5-T6 browser add/edit flows and CSP collection.

## File map

All paths are repository-relative. Braces are finite expansions, not permission to edit neighbouring files. **Create** entries are deliberately new; all other paths were verified in the current tree. A cell names the sole writer in that wave. Later owners may change only the stated concern, then rerun predecessor checks. Read-only dependencies need no ownership entry.

| Exact files | Wave 1 | Wave 2 | Wave 3 |
|---|---|---|---|
| `backend/app/routers/web/settings/feeds.py` | s5-T1: sheet/add/edit response plumbing | s5-T5: URL decorators/redirects only | |
| **Create** `backend/app/templates/sources/{base,sheet_content,add}.html` | s5-T1 | s5-T5: canonical URLs only | |
| `backend/app/templates/base.html`, `backend/app/static/js/ui/dialog.js`; **Create** `backend/app/static/js/ui/sources.js` | s5-T1: shared host/API/script/controller | s5-T5: old-to-new path literals in sources.js only | |
| `backend/app/templates/settings/partials/feed_test_result.html` | s5-T1 | s5-T5: scrape link only | |
| **Create** `backend/tests/test_sources_add.py`, `tests/js/ui-sources.test.mjs` | s5-T1 | | |
| `backend/app/routers/web/settings/{common,folders}.py` | s5-T2: counts/folders | s5-T5: folders.py route paths only | |
| `backend/app/templates/settings/feeds.html` | s5-T2: full Sources page | s5-T5: canonical URLs only | |
| `backend/app/templates/settings/partials/feeds_list.html` | s5-T2: table/menu/row keys | s5-T4: feed delete action only | |
| `backend/app/templates/settings/partials/{folder_select,folder_rename_form,feeds_stats}.html`, `backend/app/static/js/feeds-settings.js` | s5-T2 | s5-T5: old/new folder/feed-list path recognition and URLs only | |
| `input.css`; **Create** `backend/tests/test_sources_table.py`, `tests/js/sources-folders.test.mjs` | s5-T2: all Sources layout CSS and table tests | | |
| `backend/app/templates/settings/{feed_edit,opml,scrape_setup}.html`, `backend/app/templates/settings/partials/{scrape_ai_error,scrape_ai_result,scrape_preview,scrape_prompt}.html`, `backend/app/routers/web/settings/{opml,scrape}.py`; **Create** `backend/tests/test_sources_forms.py` | s5-T3 | s5-T5: path literals/decorators in existing files only | |
| `tests/js/ui-pending.test.mjs`; **Create** `backend/tests/test_sources_delete.py` | | s5-T4 | |
| `backend/app/routers/web/moved_pages.py`, `backend/tests/test_moved_pages.py`, `backend/app/routers/web/settings/nav.py`, `backend/app/routers/web/app/welcome.py` | | s5-T5 | |
| `backend/app/templates/app/partials/{sidebar,mobile_bars,palette,user_menu_items}.html`, `backend/app/templates/settings/base.html` | | s5-T5: Sources entry points | |
| `backend/app/static/js/offline/templates.js`, `backend/tests/fixtures/offline_drift/sidebar-{rail,full,empty}.html`, `tests/js/offline-worker-nav.test.mjs`, `tests/js/offline-router.test.mjs` | | s5-T5: mirror and online-only proofs | |
| **Create** `tests/e2e/sources.spec.mjs`; `tests/visual/{gallery-pages,key-screens.spec,layout}.mjs`; **Create** `tests/visual/layout-allow/s5-T6.json` | | | s5-T6 |
| `backend/tests/test_dom_contract_pages.py`, `docs/ui-dom-contract.md`, `backend/tests/fixtures/dom_contract/{article_row,preferences,login,main,article_detail,sidebar,article_list,shortcuts}.html`; **Create** `backend/tests/fixtures/dom_contract/{sources,sources_add}.html`; generated `backend/app/static/css/tailwind.css` | | | s5-T6 |
| `README.md`, `CLAUDE.md`, `CHANGELOG.md` | | | s5-T6: final documentation |

`pending.js`, `toast.js`, `offline/{router,policy,page}.js`, snapshot constants/ledger, service implementations, schema and `app.js` are **read-only** in this plan. If a named regression exposes a necessary fix there, return to the owning task with an explicit scope amendment; do not silently extend ownership. Existing scrape `selectorGenerated` code in `app.js:483` remains usable because only one active form instance has its IDs.

## Tasks

| Wave | ID | Size | blocked_by | Deliverable |
|---|---|---|---|---|
| 1 | s5-T1 | L | — | Shared sheet and add-source discovery; feed handler response interface |
| 1 | s5-T2 | L | — | Sources table, counts and inline folders |
| 1 | s5-T3 | L | — | Feed edit, OPML and scraping sheet content |
| 2 | s5-T4 | M | s5-T1, s5-T2 | Feed delayed-delete consumer and failure proof |
| 2 | s5-T5 | L | s5-T1, s5-T2, s5-T3 | Canonical URLs, aliases and offline shell parity |
| 3 | s5-T6 | L | s5-T4, s5-T5 | Regeneration, browser/visual acceptance and final docs |

Wave 1 shares the fixed interfaces below, not write ownership. A worker can render its own template/controller fixture without another worker's unmerged template. Full page/combined sheet behaviour is proven on the assembled wave, then in s5-T6. One final verifier per assembled wave is additional to task checks; do not invent dependencies on that verifier. DOM contract/CSS freshness are expected red after canonical edits until s5-T6. Offline sidebar drift is expected red only during s5-T5's own edits and must be green before that task finishes.

### Task s5-T1: Shared Sources sheet and add-source discovery

**Size** L · agent: worker · **blocked_by:** —

**Files:** all s5-T1 entries in the file map; no `feeds-settings.js`, `feeds.html` or feed-edit-template writes.

**Interfaces.**
- Consumes existing `settings_feeds_test(request, url, fetch_auth_user, fetch_auth_pass, user)`, `subscribe(...)`, `_get_feeds_context(user, db)`, `_feed_edit_page(request, uf, user, db, **extra)`, `RFToast.show`, and `ui/overlay.html.sheet`.
- Produces `GET /settings/feeds/add` (moved to `/sources/add` by s5-T5), returning `sources/add.html` with folders and current interval defaults. `sources/base.html` and `sources/sheet_content.html` implement the shared `sources_content` block contract.
- Produces `RFDialog.open(dialog: HTMLDialogElement, opener: HTMLElement|null): void`, exposing the existing private `open`; export only, retain existing event delegation.
- Produces `RFSources.open(url: string, opener: HTMLElement|null): void` and `RFSources.refresh(): void`. Delegate `[data-rf-source-sheet]` links, and recognize existing `/settings/feeds#feed-url-input` links until s5-T5 updates them. On initial load or a boosted swap, an old `#feed-url-input` bookmark on the feeds/Sources page opens Add once; preserve that fragment through the 308 and consume it without creating another history entry. Only same-origin allowlisted add/edit/opml/scrape URLs may load the host. Render loading/error text with `textContent`; HTMX swaps server form HTML.
- Produces menu positioning `RFSources.positionMenus(): void`: observe open Sources dropdown panels, position fixed panels from their trigger rectangles, clamp within the viewport, and re-anchor on table scroll/resize. Use menu keyboard/Escape semantics from Basecoat and remove observers when their host leaves the DOM. s5-T2 provides `data-rf-source-menu` on the dropdown root and the panel CSS.
- Add-form result `#feed-test-result`, URL `#feed-url-input`, title `#feed-custom-title`, form `#feed-subscribe-form`, folder `#subscribe-folder-select` stay. Detected candidates retain `data-select-detected-feed`, `data-url`, `data-title`; successful preview retains `data-feed-title`.
- Edit `_feed_edit_page` retains all current context/extra error fields. Sheet-targeted edit POST failures return the form representation; success implements `rf:sourceschanged` above. This is the backend seam s5-T3 uses; do not rebuild edit business logic.

**RED — exactly 5 new cases:**
1. `test_sources_add_form_and_fallback` (`test_sources_add.py`): full GET has `#feed-subscribe-form`; targeted GET has no `<html>`/`<body>`; both contain all preserved field names and escaped custom title. Assert `response.headers['cache-control'] == 'no-store'` and `'HX-Target' in response.headers['vary']`.
2. `test_sources_discovery_credentials_and_errors`: mock only outbound transport; for URL credentials and explicit auth precedence assert the fetch receives the same clean URL/auth tuple as existing subscription rules; 401/captcha/no-RSS candidate/zero-candidate fixtures produce escaped inline feedback, not empty 200s or leaked passwords. Existing `test_feed_url_credentials.py` is the detailed credential matrix, not duplicated here.
3. `test_sources_sheet_response_contract`: subscribe and edit success with `HX-Target: rf-source-sheet-body` assert JSON event, status 200 and `HX-Reswap == 'none'`; ordinary callers retain 303/HX-Redirect. Edit invalid URL and other-user subscription assert existing denial/no mutation and no success event. The worker may use a minimal DictLoader edit-template fixture until s5-T3 applies; assembled verification uses the real template.
4. JS `sources: sheet lifecycle survives boosted swaps`: two opens after a body swap produce one request each, one dialog/form; Escape restores opener, palette/sidebar close before source sheet opens; a page GET is not mistaken for a fragment; full-page add fallback doesn't gain a duplicate add form; a legacy hash bookmark opens Add once. Open menu panels stay viewport-clamped after scroll/resize and detached hosts release observers. Offline/force-offline opens send zero requests and display a connection message.
5. JS `sources: discovery ignores stale results and surfaces transport failures`: fake timers assert zero requests at 799 ms, one at 800 ms; Test/Enter cancels the pending timer; older response cannot set the current title; candidate selection fills URL/title without another request; 429/network/redirect-to-login show inline errors; Subscribe cancels pending discovery; auth never enters persistent storage.

- [ ] Run `PY tests/test_sources_add.py` and `JS tests/js/ui-sources.test.mjs`. Expected RED: failures naming missing add route/shared sheet response and missing `RFSources`; not fixture/import errors.
- [ ] **GREEN:** add the two template bases, add form, signed-in-only shared host and versioned deferred `ui/sources.js` tag in `base.html`; export `RFDialog.open` after the existing dialog implementation. Implement the exact lifecycle/response contracts above. Move only the add-form title/candidate/error behaviour into the new controller; s5-T2 removes those old handlers from `feeds-settings.js` when its page switches to the new form. Until assembly, suppress new controller listeners unless the form has new `data-rf-source-form="add"`.
- [ ] Restyle `feed_test_result.html` with alert/button macros and inline explanation; the scraping link opens the same sheet, replacing add content. Retain SSRF checks, preview cache and the limiter; no extra detection endpoint.
- [ ] Run `PY tests/test_sources_add.py tests/test_feed_url_credentials.py tests/test_feed_auth_gate.py tests/test_feed_detect.py tests/test_feed_url_change.py` and `JS tests/js/ui-sources.test.mjs tests/js/ui-dialog.test.mjs`. Expected GREEN: `passed`, `# fail 0`.
- [ ] Run the two source checks from Global Constraints. Expected: `OK`, exit 0.

**Done:** the shared interface and add/discovery work against fixtures and real existing handlers; remaining table/edit content is supplied by the other wave-1 tasks. Report new/removed selectors and any transitional expected-red assertions separately.

### Task s5-T2: Sources table, unread counts and inline folders

**Size** L · agent: worker · **blocked_by:** —

**Files:** all s5-T2 entries in the file map. Own all new Sources CSS in `input.css`, including the shared sheet's responsive width/overflow; s5-T1/T3 use the hooks below rather than competing stylesheet edits.

**Interfaces.**
- `_get_feeds_context(user, db) -> dict` retains its existing keys and adds `feed_unread_counts: dict[int,int]`, keyed by **Feed.id**. Use existing `sidebar_counts(db, user.id, feed_ids=..., label_ids=[], story_dedup=...)` and `story_dedup_of(db, user.id)`; avoid one query per feed and do not count another user's state. Existing total `article_counts` retains its meaning.
- `settings/feeds.html` extends the new `sources/base.html`; `sources_content` renders heading/count, Add source, OPML, Feeds/Stats and folder controls, table, retention note. Remove the embedded add form and its duplicate `#feeds-list` wrapper: the partial already owns that ID.
- Table partial keeps `#feeds-list`, `#feeds-count`, `#folder-header-<id>`, `#folder-move-up/down-<id>`, `#subscribe-folder-select` OOB. Add `.rf-sources-table-scroll` (`overflow-x:auto; min-width:0; max-width:100%`), `#sources-main`, and row `id="source-row-<uf.id>"`, `data-rf-delete-key="feed:<uf.id>"`. Menu id `source-menu-<uf.id>`, root `data-rf-source-menu`; panel positioning consumes s5-T1's `RFSources.positionMenus()` contract.
- Keep a directly visible Edit link (one click, as today), alongside the per-feed menu. That Edit link carries `data-rf-source-sheet` and existing edit URL; a visibly labelled Remove action retains its old immediate endpoint until s5-T4 swaps only that button. No Filter from this source item.
- `feeds-settings.js` retains only table Stats/folder/OOB/focus behaviour, with an idempotent bootstrap and delegated handlers that survive boosted swaps. It relinquishes add-form handlers to s5-T1. Folder requests continue to return a single list root plus optional OOB select/count.

**RED — exactly 5 new cases:**
1. `test_sources_counts_and_grouping` (`test_sources_table.py`): two users with different read states, populated/empty folders and unfiled feed; `ctx['feed_unread_counts'][feed_id]` equals the existing sidebar counter for the same user; groups follow saved folder order and missing counts display 0.
2. `test_sources_table_contract`: render long hostile titles and each existing feed status/block tier; assert one `id="feeds-list"`, escaped text, `.rf-sources-table-scroll`, named health, unread/last-fetch cells, per-feed menu and subscription-ID row key. Preserve total/interval/next-fetch/last-publication details and Stats access. Missing fetch timestamp displays `Never`, not a formatting error.
3. `test_sources_folder_mutations_and_oob`: create/rename/move/reset/delete return one list root and updated folder select when requested; empty/duplicate name and invalid direction keep current 400/409/validation semantics and do not mutate data; inaccessible folder IDs cannot mutate another user. Exercise existing service behaviour, not a new ordering algorithm.
4. `test_sources_no_subscription_empty_state`: no subscriptions but existing empty folders still shows folder actions, Add source and OPML; no false health/count row and no lost retention note.
5. JS `sources folders: swaps preserve selection and keyboard focus` (`sources-folders.test.mjs`): OOB replacement preserves selected folder if present, clears it if deleted; moving to either end focuses the remaining arrow, scrolls the header, and repeated script/swap initialization causes one handler invocation. Stats → folder action or `rf:sourceschanged` list refresh returns to Feeds. Reduced motion suppresses only visual emphasis.

- [ ] Run `PY tests/test_sources_table.py` and `JS tests/js/sources-folders.test.mjs`. Expected RED: missing unread-context/table/empty-state contract and failing delegated lifecycle assertions.
- [ ] **GREEN:** reuse grouping/order services, add counts via `counts_service`, rebuild table/forms with macros and tokens, preserve current folder confirmation/reset semantics. Health mapping follows existing `partials/feed_status.html` status/block precedence and configured thresholds; keep its detailed tooltip/error content. `health_dot` is the compact visual, not a replacement for the health policy.
- [ ] Move add controls to links to the shared sheet; keep old `/settings/*` URLs until s5-T5. Restyle `feeds_stats.html` so the existing `/settings/feeds-stats-partial` remains usable in the Sources container; this endpoint itself does not move in s5.
- [ ] Add `.rf-sources-*` CSS for table scrolling, cell wrapping and sheet content at 390/1280 widths. Do not clip dropdown menus inside the horizontal scrolling region: use a fixed-position menu panel within each Basecoat dropdown, anchored to its trigger via the shared Sources controller and clamped to the viewport; no transform/contain ancestor may establish its containing block; final browser test must click an edge-row menu after scrolling.
- [ ] Run `PY tests/test_sources_table.py tests/test_folder_order.py tests/test_api_folders.py` and `JS tests/js/sources-folders.test.mjs`. Expected GREEN: `passed`, `# fail 0`.
- [ ] Run source checks. Expected: `OK`. Report intended Sources layout changes for s5-T6's single exemption file; do not capture a visual gallery here.

### Task s5-T3: Feed edit, OPML and scraping forms in the shared sheet

**Size** L · agent: worker · **blocked_by:** —

**Files:** all s5-T3 entries in the file map; no `feeds.py`, `base.html`, `input.css` or `app.js` edits.

**Interfaces.**
- Consumes s5-T1's explicit-target/template-block/response contract. `settings/feed_edit.html`, `settings/opml.html`, `settings/scrape_setup.html` select `sources/sheet_content.html` for the shared target and `sources/base.html` otherwise. Each remains the single source for its full-page and sheet form.
- Edit keeps current handler field names and permission gates, `#selector-input`, `#preview-btn`, `#html-sample`, `#conversation-history`, `#scrape-preview`, `#ai-refinement`, `#ai-prompt-area`, and `selectorGenerated` event. Scope helper `hx-include` to the active form and use `feed_id` for stored-feed scrape helpers rather than exposing a stored credential-bearing URL.
- `settings_opml`/`settings_opml_import` and `settings_scrape_setup`/`settings_scrape_subscribe` retain existing signatures. Their representation and success events follow Global Constraints. Form-local helper responses keep existing targets; do not substitute a whole sheet into `#scrape-preview`.
- OPML form sets explicit `hx-post`, `hx-encoding="multipart/form-data"`, target/swap and no history push; export stays an ordinary download (`hx-boost="false"`) with selected `include` values and `head` marker. Import-result sections and skipped/error counts remain visible.

**RED — 4 new cases in `test_sources_forms.py`:**
1. `test_sources_edit_forms_preserve_capabilities`: fixtures for sole/shared/private/RSS/scrape subscriptions render all permitted controls with correct values, secret password blank, forbidden fields absent/disabled as today; full/fragment versions have one form and preserve translation/extraction/backfill controls. Assert one active selector ID and form-scoped includes.
2. `test_sources_opml_sheet_roundtrip_and_limits`: upload valid OPML with section choices, then malformed and `MAX_UPLOAD_BYTES+1`; successful result stays in sheet with counts and refresh event, failures have no success event and retain explanatory report; selected export has attachment headers, XML and section semantics identical to existing service.
3. `test_sources_scrape_setup_errors_and_success`: mock outbound page fetch; no URL/invalid selector/blocked URL/captcha returns understandable inline feedback with safe entered values; success sends the sheet event or normal redirect according to explicit target. Preserve folder/interval/title choices and existing permission checks.
4. `test_sources_scrape_helpers_keep_targets_and_auth`: preview, AI generation, copy-prompt and refinement fragments work from setup and edit contexts; an owned private feed uses `_scrape_target`/stored auth without outputting secrets, an unowned feed is denied as today; missing AI configuration keeps the existing manual selector/prompt path and never starts an AI call.

- [ ] Run `PY tests/test_sources_forms.py`. Expected RED: fragment/full-layout, explicit-target and form capability assertions fail against old templates.
- [ ] **GREEN:** restyle all three forms and four scrape partials using existing macros, shared `sources_content` blocks and `.rf-sources-*` hooks. Keep tokenized error/success reports and existing business logic. Leave old URLs until s5-T5; new sheet-specific inputs include `data-rf-online-only` and explicit target/swap.
- [ ] Preserve user-entered safe values after errors; never refill stored passwords. For successful OPML keep the report open; for scrape subscribe follow the close/refresh response contract. No new scraping engine, OPML format or AI feature.
- [ ] Run `PY tests/test_sources_forms.py tests/test_opml.py tests/test_opml_roundtrip.py tests/test_opml_import_limits.py tests/test_scrape.py tests/test_scrape_ai_selector.py tests/test_feed_auth_gate.py tests/test_feed_url_change.py`. Expected GREEN: `passed`.
- [ ] Run source checks. Expected: `OK`. In the assembled wave also run s5-T1's sheet response tests against these real templates, without DictLoader stand-ins.

### Task s5-T4: Feed unsubscribe with the shipped delayed-delete queue

**Size** M · agent: worker · **blocked_by:** s5-T1, s5-T2

**Files:** `backend/app/templates/settings/partials/feeds_list.html` (feed action only), `tests/js/ui-pending.test.mjs`; create `backend/tests/test_sources_delete.py`. `pending.js` and the batch service/route remain read-only.

**Interfaces.**
- Consume s5-T2's subscription-ID row key and per-feed menu. Replace only the feed Remove button's `hx-delete`/target/swap/confirm attributes with `data-rf-delete="feed:<uf.id>"`, `data-rf-delete-label="<escaped display title>"`, `data-rf-online-only`. Keep folder Remove confirmation.
- Consume existing `RFPending` lifecycle and `/settings/deletes` `results`/`HX-Trigger.showToast` list. No second cleanup notice renderer for delayed feed deletion. Existing inline cleanup reporting stays for folder/direct legacy DELETE responses.
- **Batch decision:** do not split or raise `MAX_ITEMS=50`. If more than 50 pending entries reach one flush, the 422 fails the flush and restores all rows. A future bulk action must revisit the one-request exit guarantee with the owner; s5 introduces no bulk action. Preserve unload/hidden behaviour and 2-minute `rf.deletedKeys` expiry.

**RED — exactly 5 new cases:**
1. `test_sources_delete_uses_subscription_key` (`test_sources_delete.py`): render `uf.id != uf.feed_id`; assert key/action target is `feed:<uf.id>`, label escapes hostile text, no feed `data-confirm-text`/`hx-delete`; folder confirm remains.
2. `test_sources_delete_cleanup_notices`: actual batch delete of the last scope feed disables the relevant filter/briefing and empties its saved search; assert persisted scope state and one JSON `showToast` list with the existing cleanup categories. Other-user data unchanged. Reuse `test_settings_deletes.py` fixture patterns rather than mock the cleanup services.
3. JS `pending sources: menu action undo and swapped row use the same key`: click real rendered-shape action → hidden; Undo → visible and no fetch; after expiry/navigation flush reinsert row with same key → still hidden, no duplicate request.
4. JS `pending sources: 51 entries fail safely as one request`: schedule 51, `flush('unload')`; assert one POST, 51 body items, keepalive and CSRF. Answer 422; assert every row restored, every key removed from `rf.deletedKeys`, no Undo for entries already sent. Complement server's existing malformed-body limit test.
5. JS `pending sources: failed send restores only affected subscriptions and notices stay text`: mix done/failed results plus hostile title/notice; failed row returns, done row stays hidden; action/toast text contains literal text with no executable element. Existing response-failure tests still cover 401/403/429/5xx, redirected/non-JSON and rejected fetch.

- [ ] Run `PY tests/test_sources_delete.py` and `JS tests/js/ui-pending.test.mjs`. Expected RED: declarative feed-action assertion fails; limit/lifecycle characterization tests may already pass and must not be forced red by changing correct code.
- [ ] **GREEN:** switch feed action attributes only. Reuse automatic `htmx:afterSwap` pending hide pass. Do not add a refresh that would unhide a sending row or a page-unload awaited chain.
- [ ] Run `PY tests/test_sources_delete.py tests/test_settings_deletes.py tests/test_cleanup_user_feeds.py` and `JS tests/js/ui-pending.test.mjs tests/js/ui-toast.test.mjs`. Expected GREEN: `passed`, `# fail 0`, including per-user batch lock and mixed-result tests.
- [ ] Run source checks. Expected: `OK`. Report the deliberate >50 limitation as carry-over, not as a fixed batching bug.

### Task s5-T5: Sources URLs, old aliases and offline shell parity

**Size** L · agent: worker · **blocked_by:** s5-T1, s5-T2, s5-T3

**Files:** all s5-T5 map entries, restricted to paths/mirror/helper/tests; no s5-T4 table/delete writes. Update form action URLs in the listed form templates. **Keep table/folder-menu legacy action URLs in `feeds_list.html` during this segment** to avoid shared wave-2 ownership; their aliases are intentionally supported. Do not rewrite `filters.py`.

**Interfaces and exact routing table.** Keep current Python handler names/import locations. Change these sub-routers to explicit full paths (no blanket `/settings` prefix replacement across unrelated settings routers).

GET moves registered through `MOVED_PAGES`:

| Old | New | Methods registered by helper |
|---|---|---|
| `/settings/feeds` | `/sources` | GET, POST |
| `/settings/feeds/add` (introduced by s5-T1) | `/sources/add` | GET |
| `/settings/feeds-list` | `/sources/feeds-list` | GET |
| `/settings/feeds/{user_feed_id}/edit` | `/sources/feeds/{user_feed_id}/edit` | GET, POST |
| `/settings/feeds/scrape-setup` | `/sources/scrape` | GET |
| `/settings/folders/{folder_id}/rename-form` | `/sources/folders/{folder_id}/rename-form` | GET |
| `/settings/opml` | `/sources/opml` | GET |
| `/settings/opml/export` | `/sources/opml/export` | GET (download target) |

Action-only paths: stacked decorators on the **same** endpoint, preserving dependencies/limiter/form validation. Do not put these in the helper, which requires a GET target.

| Old alias | Canonical path | Method |
|---|---|---|
| `/settings/feeds/test` | `/sources/test` | POST |
| `/settings/feeds/{user_feed_id}` | `/sources/feeds/{user_feed_id}` | DELETE |
| `/settings/folders` | `/sources/folders` | POST |
| `/settings/folders/{folder_id}` | `/sources/folders/{folder_id}` | DELETE |
| `/settings/folders/{folder_id}/rename` | `/sources/folders/{folder_id}/rename` | POST |
| `/settings/folders/{folder_id}/move` | `/sources/folders/{folder_id}/move` | POST |
| `/settings/folder-order` | `/sources/folder-order` | POST |
| `/settings/folder-order/reset` | `/sources/folder-order/reset` | POST |
| `/settings/opml/import` | `/sources/opml/import` | POST |
| `/settings/feeds/scrape-preview` | `/sources/scrape-preview` | POST |
| `/settings/feeds/scrape-ai-selector` | `/sources/scrape-ai-selector` | POST |
| `/settings/feeds/scrape-show-prompt` | `/sources/scrape-show-prompt` | POST |
| `/settings/feeds/scrape` | `/sources/scrape` | POST |

- There is no existing GET `/settings/folders`; do not invent a moved folder page. `/settings/feeds-stats-partial` and `/settings/deletes` remain where they are.
- Extend `_redirect_endpoint(page: MovedPage)` to substitute route parameters from `request.path_params` into `page.new` using Starlette path URL construction/converters, then append the original query unchanged. Reject a table entry with mismatched old/new parameter names at registration. The helper still rejects an occupied old route or missing target and still registers aliases with the target endpoint/dependencies. Remove old page decorators before registering their helper entries.
- Move feed subscribe/edit and scrape success/empty-URL redirect targets to `/sources`; no HX-Redirect to old pages. Change `settings/nav.py` no-feed target to `/sources`; `app/welcome.py` import/manual exits to `/sources/opml` and `/sources/add`. Existing help/admin/article links may retain old GET URLs and are intentionally covered by redirects; do not modify article snapshot templates.
- Sidebar/rail/account/mobile Add and palette Add become real `/sources/add` links with `data-rf-source-sheet` and `data-rf-online-only`; Sources links become `/sources`. Settings navigation says Sources and links there; OPML links to `/sources/opml`. Mirror the sidebar links and attributes exactly in `offline/templates.js`, including its account-menu links. Reuse existing palette close/focus behaviour, no new command system.
- `sources.js` and `feeds-settings.js` recognize **both** old and canonical action URLs in HTMX error/folder hooks. New forms emit canonical paths. Old cached markup and bookmarks continue to work.

**RED — exactly 5 new cases:**
1. `test_sources_moved_get_matrix` (`test_moved_pages.py`): walk the production table using concrete owned IDs; assert 308/no-store, exact substituted Location/query, and authenticated target 200 for pages or XML export. Exercise `/settings/feeds/17/edit?x=a%2Bb` on a synthetic owned-ID fixture and assert no literal braces. Test mismatched parameter names rejected before partial registration within this case.
2. `test_sources_non_get_alias_matrix`: walk every POST/DELETE above, including helper-owned feed subscribe/edit aliases; assert old and new routes share endpoint and dependencies, then execute paired submissions against reset fixtures, comparing body/status/trigger and persisted effect. Invalid forms and inaccessible IDs keep the same result; a stale POST must never return 308.
3. `test_sources_redirect_targets_and_navigation`: subscribe/edit/scrape success and no-feed/welcome exits point to canonical URLs; actual sidebar/mobile/palette/settings links point to Sources/Add; all online-only and sheet attributes present. Ordinary boosted GET returns full layout, explicit sheet target returns fragment through old redirect and direct new URL.
4. JS `worker: moved Sources navigation stays online-only` (`offline-worker-nav.test.mjs`): enabled worker with a cached shell passes successful network/preload responses for old/new/edit URLs through unchanged; physical offline and forceOffline answer 503 for those full navigations, never cached `/app`. A followed same-origin Sources redirect is not mistaken for login/wipe. Backend test 1 supplies real 308 semantics; browser test in s5-T6 proves actual redirect following.
5. JS `router: Sources never queues offline mutations` (`offline-router.test.mjs`): for old/new GET/POST/DELETE request matrix assert `RFOffline.router.handle(...) === null` and zero ops added. The worker classifier also leaves action requests unclaimed; network errors stay failures.

- [ ] Run `PY tests/test_moved_pages.py` and `JS tests/js/offline-worker-nav.test.mjs tests/js/offline-router.test.mjs`. Expected RED: no Sources production table/new URLs and missing parameter interpolation assertions fail; existing offline characterization may already pass.
- [ ] **GREEN:** implement the explicit moves/aliases, helper parameter support and entry-point changes. Keep existing auth/CSRF/rate-limit wrappers and registration order in `app.main`; do not add a second router inclusion or weaken missing-target startup checks.
- [ ] Regenerate only owned sidebar drift fixtures: `RF_UPDATE_GOLDENS=1 PY tests/test_offline_drift.py -k sidebar`. Expected: `passed`; diff only `sidebar-rail.html`, `sidebar-full.html`, `sidebar-empty.html`; `sidebar-style.html` is unchanged. Then `PY tests/test_offline_drift.py tests/test_offline_template_version.py` and `JS tests/js/offline-drift.test.mjs`. Expected: `passed`, `# fail 0`; version/hash still 6/`60ff43c1c5f70e34`.
- [ ] Run `PY tests/test_moved_pages.py tests/test_sources_add.py tests/test_sources_table.py tests/test_sources_forms.py tests/test_feed_url_credentials.py tests/test_feed_url_change.py tests/test_opml_import_limits.py` and `JS tests/js/offline-worker-nav.test.mjs tests/js/offline-router.test.mjs tests/js/ui-sources.test.mjs tests/js/sources-folders.test.mjs tests/js/ui-shell.test.mjs`. Expected GREEN: `passed`, `# fail 0`. Existing tests using old POST paths remain valid through aliases; don't rewrite them just to hide compatibility regressions.
- [ ] Run source checks. Expected: `OK`. Report source selectors for the final contract and confirm no offline routing/autoAdvance/snapshot edits.

### Task s5-T6: Regeneration, segment acceptance and documentation

**Size** L · agent: worker · **blocked_by:** s5-T4, s5-T5

**Files:** all s5-T6 entries in the map. This is the only generated CSS/DOM-contract writer. Add tests to `tests/e2e/sources.spec.mjs`; extend `_pages()` in `test_dom_contract_pages.py` for Sources/add representations without adding new Python test functions. No canonical application changes: a failed flow returns to its owning task.

**Interfaces.**
- Consume task selector reports and exact routing/response contracts. Add `sources.html` and `sources_add.html` rendered fixtures with deterministic authenticated data; preserve existing contract coverage, especially runtime-generated prefix readers.
- Keep visual screen key `settings-feeds` stable for base comparisons but resolve its URL per side: base `/settings/feeds`, head `/sources`. `key-screens.spec.mjs` owns this side-aware navigation mapping, not the app. Other old gallery paths that moved similarly compare their full-page fallbacks. Add sheet shots for Add, edit, OPML report and scraping manual/error state; base may use its equivalent full-page form, labelled as such.
- `layout.mjs` currently keys Sources structure to `#feed-subscribe-form` (`settings-feeds@1280/@390`); replace with side-aware main/table anchors. Do not simply remove that screen from the structural pass. The new intentional Sources layout lives only in `layout-allow/s5-T6.json`, each exemption names the moved form/table and reason.

**RED — exactly 5 new browser cases (all collect `securitypolicyviolation`, use local fixtures and restore their data):**
1. `sources: add from reader palette and phone`: at 1280 and 390, open Add in one click from sidebar/mobile and palette; detect fixture feeds, select candidate, choose folder, subscribe, see success and refreshed navigation. Repeat after boosted Sources→Read navigation and close with Escape; assert one form, focus restored, no CSP violation. Stub deterministic browser responses only for discovery-error UI; verify at least one successful mutation against the local backend. No public network.
2. `sources: table and folders at phone width`: long title, health variants, empty/unfiled groups, unread count; create/rename/move and switch Stats; assert `document.documentElement.scrollWidth <= innerWidth + 1`, table viewport scrolls when necessary, edge-row menu opens and Edit is clickable, folder move keeps focus. Test both ends of ordering and reduced motion.
3. `sources: edit opml and scraping sheets retain errors`: edit owned feed/folder, preserve extraction/translation controls; OPML import valid fixture/report and malformed upload; export download; scrape manual selector invalid→valid preview and helper prompt. Verify form-local targets, retained input, single active form and no redirect away on validation; missing AI config leaves manual path usable.
4. `sources: delayed unsubscribe undo and cleanup`: seed a subscription with scope cleanup (use existing test fixture services through a test-owned local DB helper inside the spec), click Remove once, Undo before 10 s (subscription remains), remove again then navigate/back while sending; final state absent and expected cleanup notice when response is observed. Inject failed send to prove row restoration. Assert newest toast visible at 390; do not rewrite s4 toast logic.
5. `sources: old links with service worker and offline`: enable/sync offline, navigate old feed/edit/OPML URLs online and reach canonical pages, with network response evidence for 308/no-store; submit an old alias with valid CSRF and observe the normal effect. Switch context offline and force-offline separately: Sources full navigation is the offline page; Add action sends no request; reading offline still works. Reconnect and retry successfully. Existing s3/s4 offline regressions run alongside this test.

- [ ] With RED tests added, run `E2E_DATABASE_URL="$E2E_DATABASE_URL" npx playwright test tests/e2e/sources.spec.mjs --project=chrome`. Expected RED before assembly: failures at missing sheet/canonical/table actions; if canonical tasks are already applied this may be green. Record actual evidence, never manufacture a red result.
- [ ] **GREEN, regenerate last:** run `npm run build`. Expected: vendor summary, CSS written, exit 0. Run `(cd backend && RF_UPDATE_GOLDENS=1 .venv/bin/pytest -q tests/test_dom_contract_pages.py)` then `node scripts/check-dom-contract.mjs --write` then `node scripts/check-dom-contract.mjs`. Expected: `passed`, contract written, final check `OK`. Review all fixture/selector changes against reports; no unexplained deletions.
- [ ] Prove deterministic build with an ephemeral comparison:
  ```bash
  RF_S5_BUILD=$(mktemp -d)
  trap 'rm -r "$RF_S5_BUILD"' EXIT
  cp backend/app/static/css/tailwind.css "$RF_S5_BUILD/first.css"
  node scripts/build-css.mjs -i input.css -o "$RF_S5_BUILD/second.css"
  cmp "$RF_S5_BUILD/first.css" "$RF_S5_BUILD/second.css"
  ```
  Expected: `cmp` exit 0, no output; scratch removed at shell exit. No vendor/font change is expected because dependencies are unchanged.
- [ ] Run `npm run check:sources`, `TMPDIR=/var/tmp npm test`, `PY`, then `PY tests/test_offline_drift.py tests/test_offline_template_version.py tests/test_dom_contract_pages.py`. Expected: all source checks `OK`, Node `# fail 0`, pytest `passed`, version/drift/contract green. Full pytest must use migrated throwaway DB; record counts rather than predicting them.
- [ ] Run `E2E_DATABASE_URL="$E2E_DATABASE_URL" npx playwright test --project=chrome`. Expected: Sources plus existing shell/read/offline suites pass; existing explicit fixmes remain reported. Also run `E2E_DATABASE_URL="$E2E_DATABASE_URL" npx playwright test tests/e2e/sources.spec.mjs --project=webkit`. Expected: 5 Sources cases pass. Known palette/offline WebKit flakes are reported separately if encountered, never used to waive a new Sources failure. Missing WebKit runtime is a named limitation, not a pass.
- [ ] Run `E2E_DATABASE_URL="$E2E_DATABASE_URL" RF_VISUAL_BASE=b6ec385 RF_VISUAL_MODE=layout npm run test:visual`. Expected: `layout: A <n>/<n> strict` and `B <n>/<n> structural`, exit 0, reasoned s5 exemption entries only for intentional Sources changes. Verify unmodified screens retain prior structural checks.
- [ ] Run `E2E_DATABASE_URL="$E2E_DATABASE_URL" RF_VISUAL_BASE=b6ec385 RF_VISUAL_MODE=gallery RF_VISUAL_DEBUG=1 RF_VISUAL_GALLERY_BASE=1 npm run test:visual`. Expected: gallery covers Sources/full fallbacks/sheets at 1280 and 390, neutral/paper/graphite light/dark; no clipped menu/button/label, dark-patch probe 0 under Paper/Graphite dark. Hand one gallery/layout report to the orchestrator for **one end-of-segment owner visual acceptance**, not one per task. Automated passes do not imply that owner acceptance occurred.
- [ ] **Final docs after canonical/code checks:** README describes Sources, one-click Add, OPML/scraping and 10 s unsubscribe Undo; correct existing swipe wording to “toggles read”. CLAUDE records `ui/sources.js`, sheet target/response event, UserFeed-vs-Feed IDs, aliases until s8, online-only policy and unchanged snapshot version. CHANGELOG Unreleased records Sources and Q2 phone full-screen default only when no stored choice. Include the >50-delete limitation and exact remaining out-of-scope carry in the task report.
- [ ] **Specs handoff:** provide the final as-built behaviour, tests and next/carry lines to the orchestrator/spec-keeper for `specs/handoff-run-7429291d-8129-432b-beab-c61fff1112cd.md`, `specs/TRACKS.md` and `/projects/readfine/specs/backlog.md` before integration/whole review. These files are outside this worker's plan write map; the orchestrator owns the workflow completion markers. Do not create a second spec ledger.
- [ ] On the applied/committed product tree the orchestrator runs `npm run check:generated`. Expected: exit 0, no generated diff. In a worker tree this command compares to the old commit, so an intentional CSS diff is not a worker failure; the deterministic comparison above is its evidence.

**Done:** all task tests and assembled checks pass; one visual acceptance package is ready, regressions and limitations are explicit, CSS/contract fresh, no unnecessary snapshot bump, docs/spec handoff complete. Finalize only through the workflow's integration, whole-review and accepted Result gates.

## Carry-over and risk register

| Item | Disposition |
|---|---|
| pending queue >50 → 422 | s5-T4 pins safe restoration; no splitting/bulk UI. Future bulk-delete UX requires a new design decision. |
| `offline/router.js` autoAdvance; preference absent from snapshot | Out of scope. No router or synced-pref mutation. |
| Filter from this source (Q3) | s7 only, including prefill; no disabled placeholder in s5. |
| Existing shell/pending/toasts/moved helper | Reuse; extend only helper parameter substitution and source-sheet opening interface. |
| Sources offline + legacy paths | s5-T5 worker/route tests, s5-T6 actual SW browser flow; no offline Sources cache or write queue. |
| WebKit palette/offline flakes; S4W-F1/F2 | Backlog/owner decisions outside s5. Report if seen; no incidental fixes. |
| README swipe wording; missing CHANGELOG Q2 line | Cheap docs corrections in s5-T6. |
| s6 catchup/chat and s7 settings work | Out of scope. |
| s2 overflow-table carry | Sources table only in s5-T2/s5-T6; admin/privacy tables remain backlog. |
| Two-stage canonical move | Wave 1 deliberately uses working old routes; wave 2 moves them with aliases. Intermediate task states are not released. |
| 800 ms live discovery meets 10/min limiter | No polling/retry loop; inline 429, stale-response suppression, manual Test still works. Backend auth/SSRF rules unchanged. |
| Overflow menus and modal transitions | Highest visual risk; one shared sheet and fixed-position table-menu panel, tested at 390 and with keyboard. |
| Sheet failure during session expiry | Don't swap followed-login/offline document into form; show retry/session message, no false success. |
| Sidebar-only snapshot impact | Closure/version tests prove v6 is unchanged; shell script content hashes update through normal build/sync. Any closure-changing fix needs re-planning, not a silent version edit. |

## Open questions for the owner

None required to implement this candidate. The plan applies the approved live-discovery/sheet/Undo choices, keeps current Stats and folder-delete semantics, and leaves Q3 in s7. The deliberate no-splitting decision is visible above for plan approval; it does not promise successful deletion of more than 50 queued subscriptions in one flush.

## Verified versus execution-time checks

Verified from the current source on 2026-11-23:

- `settings/feeds.py`: list handler at :58; credential split in test handler :110–114; subscribe redirect construction :229; `_feed_edit_page` :272; edit-success redirect :493; direct delete :497; list fragment :516.
- `settings/common.py` supplies total article counts and folders but no unread counter; `counts_service.sidebar_counts` already exposes `feed_unread_counts` keyed by Feed ID.
- `settings/folders.py` has action routes and one rename-form GET, not a folders page. `settings/opml.py` supports selected sections and a bounded 1 MB upload. `_scrape_target` already reads stored auth by owned feed ID.
- `moved_pages.py` table is empty; target validation runs before registration, GET redirect uses literal `page.new` plus query, and non-GET aliases use the target endpoint. Parameter substitution is necessary for feed-edit redirects.
- `feeds-settings.js` installs its handlers only under DOMContentLoaded; sheet use requires delegated/idempotent initialization. `ui/dialog.js` already owns opener focus, with no public export yet. `base.html` already loads pending/toast/motion/dialog globally.
- `offline/policy.js` classifies full GET navigation separately from `/htmx/*`; `loginResponse` only treats redirected `/login` as logout. Non-launch offline navigation returns `offlinePage`, and router returns null for non-HTMX paths. No SW change is justified by the current routing evidence.
- `pending.js` sends one batch without splitting, with keepalive/CSRF, per-item failure restoration and persisted hidden keys; server `MAX_ITEMS = 50`. Existing tests cover queue lifecycle, malformed bodies, scope cleanup, foreign IDs and concurrent batches.
- Snapshot version/hash are 6/`60ff43c1c5f70e34`; RELEASED contains 3–5. Sidebar drift has rail/full/empty/style fixtures; only the first three need link changes.
- s4-carry and the run handoff were read. s3/s4 owner visual acceptance is recorded as pending; their historical test totals are not fresh s5 evidence.

Execution-time checks, not asserted here: throwaway DB/container availability and migrations; browser runtime availability; Basecoat menu placement at 390; new sheet lifecycle through actual HTMX/worker navigation. This planning attempt does not run implementation tests or claim runtime acceptance.

Artifact hygiene: worker test databases and scratch CSS are ephemeral and removed by scoped traps. s5-T6's visual package is short-lived evidence under `test-results/visual-report`, owned by the orchestrator until Result publication/owner acceptance, then removed; do not leave timestamped duplicate galleries. The plan and implementation/docs are persistent deliverables.

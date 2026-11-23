# UI redesign s4 — Read zone Implementation Plan

Status: plan / candidate · 2026-11-23 · run `run-7429291d-8129-432b-beab-c61fff1112cd`, segment s4 · base `selfhost` 95fdb64 (branch `feat/ui-redesign-s4`; tree equals 0e917a4)

**Goal:** the list and the article as designed.
- **List:** a header with the view title, a View menu and mark-all; folder chips; skeleton rows; swipe on rows; restyled story clusters.
- **Article:** a sticky toolbar; an AI panel (Summary / Context, plus Ask); a reading progress bar; a phone full-screen article with a floating action bar.
- **Mark all read with Undo,** keyed by a stamp.
- **Offline:** the banner, the diagnostics section and the worker offline page restyled; the offline mirror and the snapshot version follow the new markup.

The s3 carry-over that belongs to the read zone lands with it.

**Architecture:**
- **Server, mark-all.** `mark_scope_read` and `mark_saved_search_read` return `(stamp, count)`. The four mark-all routes send a JSON `HX-Trigger` with `rf:markedall`. A new service `undo_scope_read(user, stamp, db)` and the route `POST /htmx/articles/mark-read/undo` reverse one mark-all.
- **List and article partials** are rebuilt on tokens and the `ui/` macros. Every hook that `app.js`, the offline overlay, the tests or Playwright use stays (list under Global Constraints).
- **One small view endpoint,** `POST /htmx/list-view`, saves one View-menu choice. `POST /settings/preferences` cannot do it: it rewrites every field, and an absent checkbox becomes false.
- **Client code.** The new read-zone behaviour lives in a new `static/js/ui/read.js` (`window.RFRead`), loaded by a static `<script src>` in `app/main.html`. These self-contained read blocks of `app.js` move into it:
  - the list loading overlay, now skeleton rows;
  - the translated-title toggle;
  - the AI context panel, which the tabs replace;
  - the detail top-bar sync, whose buttons leave.

  The keyboard handler and the blocks that read `app.js` private state (`_activeNavGet`, `_saveNavSnapshot`, `_highlightNav`, `_markReadAutoAdvance`) stay in `app.js`.
- **Offline.** `offline/templates.js`, `overlay.js` and `router.js` mirror the new markup in one task, after the markup tasks. That task makes the drift test green again and bumps `OFFLINE_TEMPLATE_VERSION` 5 → 6 once, for both snapshot roots.

**Tech stack:** Jinja2, HTMX 2.0.4, Basecoat 1.1.0 (vendored: `dropdown-menu`, `tabs`, `toast`), anime.js 4.5.0 via `RFMotion`, FastAPI, SQLAlchemy async, pytest, `node --test` with jsdom, Playwright. No new dependencies.

**Design:** `docs/arh-w-dev/designs/2026-11-19-ui-redesign-design.md`:
- §2 goals 3–6 (View menu, AI panel, phone, Undo);
- §5.2 (list, article);
- §5.4 (mark-all undo, undo while offline, archive Undo);
- §5.5 (offline pages, stale snapshots);
- §5.7 wave 4;
- §6 (invariants and acceptance).

## Changes from the draft

1. **6 tasks in 3 waves**, down from 9 tasks in 5 waves. The user prefers fewer, bigger tasks, and visual acceptance runs once, at the end.

   | Draft id | New id | What changed |
   |---|---|---|
   | S4-T1 + S4-T2 | **s4-T1** | services and routes in one server task; the offline half of mark-all moves to s4-T4 |
   | S4-T3 | **s4-T2** | list; also owns `render_list` context, the View endpoint, `main.html` (skeleton) and the `row-*` online goldens |
   | S4-T4 | **s4-T3** | article; also owns `routers/web/app/ai.py`, `ui_fragments.py`, `chat.html` and the `detail-*` / `content-*` / `read-button-*` goldens |
   | S4-T6 + S4-T7 | **s4-T4** | all of `offline/*` in one owner: mirror, overlay, router (offline mark-all trigger), banner, offline page, drift goldens, the one template-version bump, diagnostics section |
   | S4-T5 | **s4-T5** | `ui/read.js` and every `app.js` change of the segment, including the S3W-F5 keyboard fix, the chat error hook and the toast-stack check |
   | S4-T8 + S4-T9 | **s4-T6** | CSS and contract regeneration, read e2e, visual acceptance, repo docs. Project specs (`/projects/readfine/specs`) stay with the orchestrator and spec-keeper, as in s3. |

   The carry text's "S4-T4 AI panel + S4-T5 read.js" now reads s4-T3 + s4-T5.
2. **One owner per hand-edited file per wave** (file map). No wave-1 task edits `app.js` or `offline/*`. New markup that needs JS is wired in wave 2 and works through existing paths until then (see each task).
3. **Snapshot version, drift goldens, CSS and contract each have a single late owner** (Global Constraints, "Generated and pinned files"). The online partial goldens are split by file between s4-T2 and s4-T3, because each reviewer must see the golden diff of their own partials.
4. **Mark-all response contract pinned for the offline case.** The offline worker sends `rf:markedall` with `"stamp": null`. An undo attempt offline arrives as a 200 needs-connection body (offline mode on) or a network error (offline mode off), and both are handled.
5. **Offline page colours** come from a constant pinned by a test against `styles/tokens.css`, not from a build-generated file. The design's goal (colours cannot drift) holds without a new generated file, a new `sw.js` import or a `check:generated` change. See Risks R5.
6. **The article footer bar stays at the end of the article on every bucket.** It becomes the floating bar only in phone full-screen. Copy and Share keep their one-tap path on desktop: today they are buttons in that bar, and moving them into "···" would add a step (design §6 invariant).

## Global Constraints

- **Mark-all trigger (s4-T1 ↔ s4-T4 ↔ s4-T5).**
  - Online: every mark-all route answers `HX-Trigger: {"sidebarRefresh": true, "rf:markedall": {"stamp": "<ISO 8601 with microseconds and offset>", "count": N}}`.
  - Build the stamp with `now.isoformat(timespec="microseconds")`: plain `isoformat()` drops the fraction when it is zero.
  - Offline (worker): the same shape with `"stamp": null`.
  - The client treats the stamp as an opaque string: it never builds a `Date` from it and posts it back byte for byte.
  - The bodies stay as they are: the badge-total fragment for `/htmx/articles/mark-read`, the feed route and the folder route; an empty body for the saved-search route.
- **Undo route (s4-T1 ↔ s4-T5).** `POST /htmx/articles/mark-read/undo`, form field `stamp`.
  - A stamp that does not parse, or has no offset: 400, empty body.
  - A stamp older than 10 minutes, or more than 60 s in the future: 410 with `HX-Trigger: {"showToast": {"msg": "Too late to undo", "type": "info"}}`.
  - Otherwise 200, empty body, with `HX-Trigger: {"sidebarRefresh": true, "showToast": {"msg": "Restored N", "type": "ok"}}`, or `"Nothing to restore"` when N = 0.
  - One `UPDATE user_article_state SET is_read=false, read_at=NULL, suppressed_at=NULL, suppressed_by=NULL WHERE user_id=:user AND read_at=:stamp AND suppressed_by='bulk' AND is_read=true`. Repeating it changes nothing. The 0127 trigger (`backend/alembic/versions/0127_offline_sync.py:52-66`) stamps `read_changed_at`, so offline devices pick the change up through the normal sync.
- **Client toasts (s4-T5).**
  - Online mark-all: `Marked N as read` with Undo, 10 s.
  - Offline (`stamp: null`): `Marked N as read · will sync`, no Undo.
  - Nothing marked (N = 0): `Nothing to mark as read`, no Undo.
  - An Undo that comes back offline (an `X-Readfine-Offline: 1` header, a `[data-rf-needs-connection]` body, or a rejected `fetch`): `Couldn't undo while offline`.
  - Any other failure: the server's `showToast` when one is in `HX-Trigger`, otherwise `Couldn't undo. Try again.`
  - All toast text goes through `RFToast` (`textContent`). Nothing calls `toaster.toast()` with actions.
- **View endpoint (s4-T2 ↔ s4-T5).** `POST /htmx/list-view`, form fields `field` and `value`.
  - `field` and its allowed values:
    - `density`: `DENSITY_VALUES`. It saves `list_density_mobile` when `_is_mobile(request)` is true, else `list_density_web`.
    - `sort`: `SORT_VALUES`, into `default_sort_order`.
    - `unread`: `UNREAD_FILTER_VALUES`, into `unread_filter`.
    - `stories`: `DEDUP_VALUES`, into `story_dedup`.

    The value sets come from `backend/app/services/preference_values.py:7-9` and `backend/app/services/story_service.py:37`.
  - Anything else: 400, and nothing changes.
  - Success: 200, empty body, `HX-Trigger: {"rf:viewchanged": {"field": "…", "value": "…"}}`. No other setting changes.
  - The menu items carry `data-rf-online-only`.
- **Folder chips** render in All articles and in folder views. They hold "All" plus the reader's folders, in the sidebar's folder order (`get_folder_order`, `backend/app/services/folder_service.py`). Each chip is `<button type="button" data-rf-nav="/htmx/articles?folder_id=N" aria-pressed="…">`; "All" uses `/htmx/articles`. `data-rf-nav` has the meaning `ui/palette.js` gave it: click the matching sidebar `.nav-item`, else `htmx.ajax` into `#article-list`.
- **Kept hooks.** Removing one needs the consumer change in the same wave and the selector in the task report.
  - **Rows:** `#article-row-*`, `.article-row`, `data-article-id`, `data-rf-article`, `data-rf-read-classes` / `data-rf-unread-classes`, `data-density`, `data-is-read`, `data-url`, `data-story-*`, `data-star-btn`, `data-rf-slot="star-button|labels|score-badge|related-count|archive-button"`, `data-archived-indicator`, `data-article-title`, `data-article-snippet`, `#article-labels-*`, `#chat-indicator-*`, `data-rf-time`, `hx-get="/htmx/articles/{id}"` with `hx-trigger="click"`.
  - **Translation (upstream 5c4bf90):** `data-title-original`, `data-title-translated`, `data-translation-mark`, `data-toggle-translation`, `data-detail-title`, and the snippet hidden under a translated title.
  - **List:** `data-list-header`, `data-search-header`, `data-saved-search-*`, `data-save-search-area`, `#save-url-form`, `#load-more-sentinel`, `#article-list-cfg`, `.article-list-end-spacer`, `#relevance-intro`.
  - **Detail:**
    - `#article-detail-root`, `.reading-area`, `article[data-article-id]` with `data-title` / `data-url` / `data-feed-title`, `.article-detail-title-row [data-external-link]` (key `v`);
    - `[data-header-read]` / `[data-header-star]` / `[data-header-archive]` (keys `m` / `s` / `e`, and `offline/overlay.js`), with their `data-label` span and `data-rf-slot`;
    - `#star-btn-*` / `#archive-btn-*` / `#read-btn-*` / `#share-btn-*` hidden targets;
    - `#mobile-detail-back-bar`, `#mobile-detail-back-btn`;
    - `.article-bottom-bar` with `data-bottom-star` / `-archive` / `-share` / `-next`, `data-copy-article`, `data-show-chat-modal`, `data-unsave`;
    - `#article-content-*`, `#detail-labels-*`, `#detail-labels-btn-*`, `#readable-poll-*`, `#story-block-*`;
    - `#chat-modal-*` and its parts.
  - **AI:** `#ai-summary-*` (outerHTML swap target of generate and poll), `#ai-context-area-*`, `#ai-context-*`, `#context-panel-*`, `#context-focus-*`, `data-rf-placeholder="ai"`, `data-rf-slot="ai-summary|ai-context|ai-summary-action|ai-context-action"`.
- **May leave in s4,** together with their `app.js` code in s4-T5:
  - `detail-topbar-star|archive|share|next`: the floating bar covers them;
  - the detail `data-menu-toggle` / `data-menu` / `data-menu-persist` / `data-close-menu`: a Basecoat `menu` replaces them, and the generic `data-menu-toggle` code stays for the settings and admin tables;
  - `data-show-context-panel`: the Context tab replaces it.
- **New hooks:**
  - `data-article-toolbar`, `data-rf-progress`, `data-bottom-read`;
  - `data-rf-view="<field>:<value>"`, `data-rf-chips`, `data-list-title`, `template#rf-list-skeleton`;
  - `data-chat-error` (the one chat error hook: the server writes it, `app.js` reads it);
  - `data-rf-swipe` (state class on a row during a swipe).
- **Every action keeps its step count or loses steps** (§6). On the phone, Share stays one tap (a toolbar icon in full-screen) and next stays one tap (the floating bar).
- **Keyboard.** Every shortcut of today keeps working and its existing test passes. An open Basecoat menu or popover covers the reader: `j/k/m/s/e/v/A` do nothing, and Escape closes only the menu (S3W-F5).
- **Mark-all confirmation** (Q1 recommendation, pinned in s4-T5's keyboard test): no `confirm()` while `navigator.onLine` is true, because Undo covers it. `confirm()` stays while offline, which has no Undo.
- **Swipe:** right stars, left toggles read. Only `pointerType === 'touch'`, and the axis locks after 10 px, so vertical scroll never swipes. The action runs through the row's own controls (`[data-star-btn]`, and `POST /htmx/articles/{id}/read` with `swap: 'none'`). Under reduced motion only the snap animation is off.
- **Motion** goes through `RFMotion` (`static/js/ui/motion.js:364`). Reduced motion leaves no running animation. Nothing waits on an animation before acting.
- **CSP unchanged:**
  - no inline handlers, no `hx-on`, no `js:`, no trigger filters;
  - `hx-vals` JSON is fine;
  - inline `style` set by JS is fine (`style-src 'unsafe-inline'`).
- **The phone full-screen article** keeps the per-device setting `detail_mode_small` (`static/js/app.js:179`). Q2 recommends making "fullscreen" the default for devices with no stored value; s4-T5 implements whatever the owner answers.
- **Not in s4:**
  - "Filter from this source" (Q3: deferred to s7, where the filter page gains a prefill);
  - the unified chat with a scope switch (s6: Ask opens today's article chat modal);
  - the general chat fragments in `routers/web/app/ai.py` (s6).
- **Generated and pinned files, single owners:**
  - **s4-T4 only:**
    - `OFFLINE_TEMPLATE_VERSION`, `OFFLINE_TEMPLATE_HASH` (`backend/app/services/sync/__init__.py:5,9`) and `LEDGER` / `RELEASED` in `backend/tests/test_offline_template_version.py`;
    - `backend/tests/fixtures/offline_drift/*`.
  - **Online partial goldens** (`backend/tests/fixtures/partials_online/`): `row-*` belongs to s4-T2; `detail-*`, `content-*` and `read-button-*` belong to s4-T3. Neither task edits `backend/tests/test_partials_online_unchanged.py`, so keep every `data-rf-*` hook its `test_hooks_present_online` asserts.
  - **s4-T6 only:** `backend/app/static/css/tailwind.css`, `docs/ui-dom-contract.md`, `backend/tests/fixtures/dom_contract/*`. Before that, a task builds CSS into `$(mktemp -d)`, runs `CONTRACT` to see its own diff, lists its selectors in the report, and restores both paths (`git checkout -- docs/ui-dom-contract.md backend/tests/fixtures/dom_contract`).
  - **For the orchestrator's verifier:** from the first wave-1 merge until s4-T4 merges, `tests/test_offline_drift.py` and `tests/test_offline_template_version.py` are expected red. Until s4-T6, `tests/test_dom_contract_pages.py` and `node scripts/check-dom-contract.mjs` are expected red. None of these is a reason to return a wave-1 or wave-2 task.
- **Read-zone CSS, one owner per file per wave.** Today the read-zone rules live in two places:
  - the inline `<style>` of `backend/app/templates/base.html` (:63-506): `.article-row*` at :140 and :183-187, `#inline-article-detail-content …` and `.detail-meta-*` at :191-199, `.reading-area` at :202-204, `.mobile-detail-open` and `#mobile-detail-back-bar` at :305-321, the story-overlay rules at :362-367, `.ai-score-*` at :370-375, `.article-list-loading` at :380;
  - `input.css`: `.translation-toggle` at :599-600, `.story-chip` at :640-650.

  Ownership:
  - **Wave 1:** new or changed **list** rules go into `input.css` (s4-T2 owns it). New or changed **article** rules go into the `base.html` inline style (s4-T3 owns it). Neither task edits the other's file, and no rule goes into a per-row partial (a `<style>` in `article_row.html` would repeat on every row and in every snapshot).
  - Each task lists in its report the old rules its markup no longer uses, including rules in the other task's file (for example `.translation-toggle` for s4-T3, `.article-row …` rules in `base.html` for s4-T2).
  - **Wave 2:** s4-T5 owns both files and deletes the rules the wave-1 reports list as dead. `.ai-score-*` stays while `templates.js` still emits those classes.
- **Layout exemptions:** a task that moves boxes on a key screen on purpose adds `tests/visual/layout-allow/s4-T<n>.json`, with a reason per entry (README in that folder).
- **Workers:**
  - no commits;
  - **at most 5 new test functions per task** (subtests inside one function are fine);
  - stop after 3 failed approaches;
  - out-of-scope findings go into the report as "noticed" lines;
  - every selector a task adds or removes goes into its report.
- **Test environment.** Never use `127.0.0.1:4250`, production (`/opt/readfine`, `readfine-app-1`) or git writes.
  - **Throwaway Postgres:** container `rf-int-pg-s3rb` on `127.0.0.1:4253`, user and password `readfine`, databases `readfine_pytest` and `readfine_e2e`, migrated to `0131`. Do not remove the container.
  - **Per-task database:** wave 1 and wave 2 run tasks in parallel, so each backend task makes its own database and drops it afterwards:
    ```
    DB=rf_s4_t<n>_$RANDOM
    docker exec rf-int-pg-s3rb createdb -U readfine "$DB"
    (cd backend && DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/$DB uv run alembic upgrade head)
    … tests …
    docker exec rf-int-pg-s3rb dropdb -U readfine "$DB"
    ```
  - **Backend tests** (the "PY env" below):
    ```
    cd backend && SECRET_KEY=ci-test-secret-key-0123456789abcdef \
      ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd \
      DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/$DB \
      uv run pytest -q <files>
    ```
  - **Node:** `npm test` and `node --test` need `TMPDIR=/var/tmp`.
  - **e2e and visual** (s4-T6 only, alone in its wave): `E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e`.
  - **CSS build:** `node scripts/build-css.mjs -i input.css -o <path>`.
- **Commands used below:**
  - `JS <files>`: `TMPDIR=/var/tmp node --test tests/js/<files>`.
  - `PY <files>`: the backend command above.
  - `PYFULL`: the whole backend suite with `--deselect tests/test_dom_contract_pages.py --deselect tests/test_offline_drift.py --deselect tests/test_offline_template_version.py`, in the expected-red window only.
  - `DRIFT`: `(cd backend && RF_UPDATE_GOLDENS=1 <PY env> uv run pytest -q tests/test_offline_drift.py) && JS offline-drift.test.mjs`.
  - `CONTRACT`: `(cd backend && RF_UPDATE_GOLDENS=1 <PY env> uv run pytest -q tests/test_dom_contract_pages.py) && node scripts/check-dom-contract.mjs --write && node scripts/check-dom-contract.mjs`. Expected: exit 0. Review `git diff docs/ui-dom-contract.md backend/tests/fixtures/dom_contract`, then restore both paths (every task but s4-T6).
  - `SOURCES`: `node scripts/check-tw4-classes.mjs && node scripts/check-css-vars.mjs && node scripts/check-colours.mjs`. This is `npm run check:sources` without the contract check, which is expected red until s4-T6. Expected: every check `OK`.
  - `GOLDENS <k>`: `(cd backend && RF_UPDATE_GOLDENS=1 <PY env> uv run pytest -q tests/test_partials_online_unchanged.py -k "<k>")`. Review `git diff backend/tests/fixtures/partials_online`: only the task's own files change, and they change as intended.

## Review Focus

1. **Another user's rows with the same stamp stay read after an undo.** → s4-T1 `undo: restores only the caller's bulk rows of that stamp`.
2. **An article read properly after mark-all stays read after the undo**, and so does one read by hand before it. → s4-T1, same test.
3. **The stamp survives the round trip unchanged; a repeat changes nothing; a stale stamp is refused.** → s4-T1 `undo: the stamp round-trips as text and a repeat changes nothing`, `undo: stale, future, naive and garbled stamps are refused`; s4-T5 `read: mark-all Undo posts the stamp unchanged …`.
4. **Offline mark-all shows no Undo; an Undo after the connection drops says so; the articles stay read.** → s4-T4 `offline-router: mark-all sends rf:markedall without a stamp and undo needs a connection`; s4-T5 test 1; s4-T6 e2e 4.
5. **The article without JS is readable and its actions are what they are today** (`hx-post` buttons, real links). → s4-T3 `detail: without JS the title, body and original link are not hidden`; s4-T6 e2e 5.
6. **A device with old snapshots shows the new markup after one sync.** → s4-T4 (the 5 → 6 bump, the ledger, the existing `offline-sync.test.mjs` "templates version change refetches all snapshots"); s4-T6 e2e 4.
7. **Keyboard j/k/s/m/v on the new list and article behave as today, and an open menu covers the reader.** → the existing `keyboard-shortcuts.test.mjs` stays green in s4-T5; s4-T5 `keyboard: an open menu covers the reader …`; s4-T6 e2e 1.
8. **Translated titles keep working** in rows, the detail and "Show original". → s4-T2 test 4, s4-T3 test 1, s4-T6 e2e 1.
9. **Swipe works with touch emulation, and the action survives reduced motion.** → s4-T5 `read: swipe …`; s4-T6 e2e 3 and 5.
10. **The newest toast is on top and fully visible when an Undo toast joins an older one.** The s3 carry lists this as a browser defect. `shell.spec.mjs:302-319` checks one case, and this run did not reproduce the defect. → s4-T5 checks it with the mark-all toast and fixes it if the check fails; s4-T6 e2e 2.
11. **No inline handler reaches the page.** → s4-T6: every e2e flow collects `securitypolicyviolation`.

## File map

Hand-edited files, one owner per wave. Paths are relative to the repo root; `backend/app/` is omitted inside the table for templates and static files.

| File | W1 | W2 | W3 |
|---|---|---|---|
| `backend/app/services/article.py`, `services/saved_search_service.py`, `services/sync/ops.py`, `routers/web/app/shell.py`, `routers/web/app/saved_searches.py`, `backend/app/utils/htmx.py`, `backend/tests/test_mark_all_undo.py` (new) | T1 | | |
| `templates/app/partials/{article_list,article_list_append,article_row,story_rows,score_badge,row_poll,error_bar}.html`, `backend/app/routers/web/app/articles.py`, `backend/tests/test_list_view.py` (new), `backend/tests/fixtures/partials_online/row-*.txt`, `tests/visual/layout-allow/s4-T2.json` | T2 | | |
| `templates/app/main.html` (W2: one `<script src>` line) | T2 | T5 | |
| `input.css` (W1: list rules; W2: dead-rule cleanup) | T2 | T5 | |
| `templates/app/partials/{article_detail,article_content,ai_blocks,chat,article_title,article_meta_date,story_block,story_members,saved_icons,readable_progress,read_button,star_icon,archive_button,share_button}.html`, `backend/app/routers/web/app/ai.py`, `backend/app/ui_fragments.py`, `backend/tests/test_article_redesign.py` (new), `backend/tests/test_sync_snapshots.py` (the AI-action assertions at :352-355 only), `backend/tests/fixtures/partials_online/{detail,content,read-button}-*.txt`, `tests/visual/layout-allow/s4-T3.json` | T3 | | |
| `templates/base.html` (W1: article rules in the inline style; W2: the `detail-topbar` rule at :362, dead-rule cleanup, and the `.toaster` rule only if the stack check fails) | T3 | T5 | |
| `static/js/offline/{templates,overlay,router,lists}.js`, `backend/tests/test_offline_drift.py`, `tests/js/offline-drift/adapters.mjs`, `backend/tests/fixtures/offline_drift/*`, `backend/app/services/sync/__init__.py`, `backend/tests/test_offline_template_version.py`, `templates/settings/preferences.html` (offline diagnostics block only), `tests/js/{offline-router,offline-overlay,offline-page}.test.mjs`, `tests/js/offline-page-tokens.test.mjs` (new) | | T4 | |
| `static/js/app.js`, `static/js/ui/read.js` (new), `static/js/ui/palette.js` (export `goTo` only), `static/js/ui/toast.js` (only if the stack check fails), `tests/js/ui-read.test.mjs` (new), `tests/js/keyboard-shortcuts.test.mjs`, `tests/js/harness.mjs` (only if a moved block needs it), `tests/js/ui-toast.test.mjs` (only with a `toast.js` change) | | T5 | |
| generated `backend/app/static/css/tailwind.css`, `docs/ui-dom-contract.md`, `backend/tests/fixtures/dom_contract/*`; `tests/e2e/read.spec.mjs` (new), `tests/visual/layout.mjs` (`KEY_STRUCTURE` only, if a key id changed), `tests/visual/gallery-pages.mjs` (the View-menu and AI-Context shots), `tests/e2e/offline.spec.mjs` (the `menuAction` helper at :78-83, only if the toolbar breaks it), `tests/visual/layout-allow/s4-T6.json`, `README.md`, `CLAUDE.md`, `CHANGELOG.md` | (checked and restored) | (checked and restored) | T6 |

## Tasks

| Wave | Tasks | Size |
|---|---|---|
| 1 | s4-T1, s4-T2, s4-T3 | M, L, L |
| 2 | s4-T4, s4-T5 | L, L |
| 3 | s4-T6 | L |

---

### Task s4-T1: Mark-all stamp and undo (server)

**Size** M · blocked_by: —

**Files:**
- Modify:
  - `backend/app/services/article.py`: `mark_scope_read` at :891, the early UPDATE branch at :949-961 and the upsert at :1010-1011; add `undo_scope_read`;
  - `backend/app/services/saved_search_service.py`: `mark_saved_search_read` at :283, execute at :319;
  - `backend/app/services/sync/ops.py`: :439 and :444 ignore the new return values explicitly (`_stamp, _count = …`); no behaviour change;
  - `backend/app/routers/web/app/shell.py`: routes at :138, :180, :202, triggers at :176, :198, :218; the new undo route;
  - `backend/app/routers/web/app/saved_searches.py`: route at :133, trigger at :148;
  - `backend/app/utils/htmx.py`: one helper `mark_all_trigger(stamp, count) -> str` returning the JSON header value.
- Create: `backend/tests/test_mark_all_undo.py`.

**Interface:** the mark-all trigger and the undo route in Global Constraints.

**Changes:**
- **Return values.** `mark_scope_read(...) -> tuple[str, int]` returns `(now.isoformat(timespec="microseconds"), result.rowcount)` from whichever statement ran. `mark_saved_search_read` does the same. Its caller still owns the commit.
- **`undo_scope_read(user, stamp: datetime, db) -> int`** runs the single UPDATE of Global Constraints, commits and returns the rowcount. The user filter is in the statement itself. It writes no story state, because mark-all writes none.
- **Undo route.** `POST /htmx/articles/mark-read/undo` (`get_current_user`, `get_db`):
  - parse with `datetime.fromisoformat`; refuse a missing offset;
  - compare the age with `datetime.now(timezone.utc)`;
  - answer as pinned.

  CSRF stays on through the middleware.
- **Routes.** Each mark-all route builds its header with `mark_all_trigger`. The bodies are unchanged.
- **No offline change here:** s4-T4 owns `offline/router.js`.

Steps:
- [ ] **RED** in `test_mark_all_undo.py`. Use the conftest client pattern with real commits on the throwaway DB, unique emails per test, and seeded feeds, articles and states.
  - `undo: restores only the caller's bulk rows of that stamp`. User A marks a feed read. User B gets rows with the same `read_at` and `suppressed_by='bulk'` through a direct UPDATE. One of A's articles is then read properly (`read_at` set to a later time, `suppressed_by` NULL, as the dwell handler leaves it). One was read by hand before the mark-all. After the undo, only A's bulk rows are unread. B's rows, the properly read row and the hand-read row stay read.
  - `mark-all: every route returns stamp and count and keeps sidebarRefresh`, parametrised over `/htmx/articles/mark-read` (all, `starred_only=1`, `label_id`), `/htmx/feeds/{id}/mark-read`, `/htmx/folders/{id}/mark-read` and `/htmx/saved-searches/{id}/mark-read`. Assert:
    - `HX-Trigger` is JSON with `sidebarRefresh: true`;
    - `rf:markedall.count` equals the rows that changed;
    - the stamp matches `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}\+00:00$`;
    - the badge body is unchanged in kind (badge fragment, or empty for a saved search).
  - `undo: the stamp round-trips as text and a repeat changes nothing`. Post the exact header string back: the count matches, the body is empty and `HX-Trigger` carries `sidebarRefresh` and `showToast` "Restored N". The second post answers "Nothing to restore" and leaves the rows as they were.
  - `undo: stale, future, naive and garbled stamps are refused`, parametrised:
    - 11 minutes old → 410 with the "Too late to undo" toast, nothing changed;
    - 2 minutes ahead → 410;
    - no offset → 400;
    - `"x"` → 400;
    - missing field → 422.


  That is 4 new test functions. The offline op path (`ops.py:439`, `:444`, reached through `apply_ops` at `ops.py:112`) is already covered by `tests/test_sync_ops.py` (`test_mark_scope_read_respects_max_article_id` :134, `test_mark_scope_read_saved_search` :146, `test_mark_scope_read_leaves_later_server_unread_alone` :536), which runs unchanged below.
- [ ] Run `PY tests/test_mark_all_undo.py`. Expected: the new tests fail (no stamp in the header; undo route 404).
- [ ] **GREEN:** implement.
- [ ] Run `PY tests/test_mark_all_undo.py tests/test_sync_ops.py tests/test_saved_searches.py tests/test_counts_service.py tests/test_story_suppression.py tests/test_article_pagination.py tests/test_dwell.py`, then `PYFULL`. Expected: green. At plan time no backend or node test compared `HX-Trigger` with the plain string `sidebarRefresh` (grep over `backend/tests` and `tests/js`). If the run finds one, this task updates it and names it in the report.

Done: tests green; every mark-all route sends the pinned trigger; the undo route and service exist; `ops.py` behaves as before.

---

### Task s4-T2: List redesign (header, View menu, chips, rows, skeleton, story rows)

**Size** L · blocked_by: —

**Files:**
- Modify:
  - `backend/app/templates/app/partials/article_list.html`, `article_list_append.html`, `article_row.html`, `story_rows.html`, `score_badge.html`, `row_poll.html` and `error_bar.html` (the last two only if restyled);
  - `backend/app/templates/app/main.html`: `#article-list` initial content and the skeleton `<template>`;
  - `backend/app/routers/web/app/articles.py`: `render_list` context at :601 and the new `/htmx/list-view` route;
  - `input.css`: list rules (header, chips, rows, swipe state `[data-rf-swipe]`, story chip at :640-650);
  - `backend/tests/fixtures/partials_online/row-*.txt` (through `GOLDENS row-`).
- Create:
  - `backend/tests/test_list_view.py`;
  - `tests/visual/layout-allow/s4-T2.json`.
- Do **not** edit `app.js`, `offline/*`, `templates/base.html` (s4-T3 owns it in this wave; list the dead `.article-row …` rules at :140 and :183-187 in the report), `saved_icons.html` (s4-T3), `badges.html` (mirrored by `_badge_html`; `.mark-read-badge.rounded-full` is selected by `offline.spec.mjs`), or `backend/tests/test_partials_online_unchanged.py`.

**Changes:**
- **List header** (`data-list-header`) for every sidebar view:
  - `<h1 data-list-title>` with the view title;
  - a count where the view has one today;
  - the View menu: `menu(id="list-view-menu", …)` from `ui/overlay.html`, caller block, `side="bottom"`, `align="end"`;
  - a mark-all `icon_button(label="Mark all as read", attrs={"data-action": "mark-all-read"})`. `app.js:2631` already wires that action to `_kbMarkAllRead` (s3), so it works in wave 1 through the sidebar row's button.
  - Search results keep their search header. They get no mark-all (today's rule: "Search results can't be marked read all at once"). Their View menu leaves out Sort, which search sets itself.
  - Saved view and saved search keep their headers and hooks, restyled on tokens.
  - Title: a small helper in `articles.py`, `list_view_title(...)`:
    - All articles, Starred, Saved, Archived, Labeled;
    - the feed title, folder name or label name, read from the reader's own rows (a foreign or missing id falls back to "All articles");
    - the saved search's name.
  - On `html[data-bucket="small"]` the header title is visually hidden, because the phone title bar already shows it. View and mark-all stay.
- **View menu items** are `role="menuitemradio"` with `aria-checked`, `data-rf-view="<field>:<value>"`, `data-rf-online-only`, `hx-post="/htmx/list-view"`, `hx-vals='{"field": "…", "value": "…"}'`, `hx-swap="none"`. There are four groups:
  - Density: Compact / Comfortable / Summary;
  - Sort: Newest / Oldest;
  - Show: Unread only / All / Adaptive;
  - Stories: Collapse / Off / Suppress, with the labels `settings/preferences.html` uses.

  The list reloads on `rf:viewchanged` once s4-T5 lands. Until then the choice is saved and shows on the next load.
- **`/htmx/list-view` route** in `articles.py`, as pinned (it reuses `_is_mobile`).
- **Folder chips** (`<div data-rf-chips role="toolbar" aria-label="Folders">`) as pinned, rendered from a `folder_chips` context value. They scroll horizontally on the phone. `data-rf-nav` is wired by s4-T5 (until then a chip does nothing).
- **Rows** (`article_row.html`, all three densities; the snapshot root):
  - `feed_icon` from `ui/readfine.html`: the letter fallback, because no favicon field exists;
  - source · time; the title (serif only in the detail, not in rows);
  - optional snippet (Summary density);
  - `score_badge.html` restyled on tokens (`--rf-ok` / `--rf-warn` / muted);
  - the source count for stories (`story_marker` / `story_line`);
  - a star marker;
  - the unread state as a dot (`--rf-unread`) plus weight.

  Every kept row hook stays. The `ui/readfine.html` `article_row` macro is **not** used for the real row: it cannot carry the row's hooks or densities. Its docstring gains one line saying it is the gallery and palette shape. Translation: the translated title, `translation_mark`, the original-title data and the hidden snippet stay as 5c4bf90 made them, restyled.
- **Story clusters** (`story_rows.html`, `story_line` chip): restyled on `--rf-story-*` tokens. `data-story-toggle` / `data-story-caret` and `aria-expanded` are unchanged.
- **Skeleton:**
  - `main.html` replaces the `Loading…` placeholder in `#article-list` with eight `skeleton` rows from `ui/display.html`;
  - `<template id="rf-list-skeleton">` holds the same rows for s4-T5's loading overlay;
  - both are `aria-hidden="true"`.
- **Empty states** use `empty_state` from `ui/display.html`, with today's texts.
- **Layout exemptions** (`s4-T2.json`, screens `list` and `article`): `#article-list *` row internals, `[data-list-header]*`, `[data-rf-chips]*`. Reason: "s4 list redesign". The list pane keeps its x and width.

Steps:
- [ ] **RED** in `test_list_view.py` (client pattern as in s4-T1):
  - `list: header shows the view title, View menu and mark-all for each sidebar view`, parametrised over all, feed, folder, label, starred and saved search; plus a search, which has no mark-all and no Sort group. A foreign feed id titles as "All articles".
  - `list: folder chips list the reader's folders in sidebar order and mark the active one`. Another user's folder is absent; `aria-pressed="true"` is on the open folder.
  - `list-view: saves one field and refuses unknown values`, parametrised over `density` (mobile User-Agent → `list_density_mobile`, desktop → `list_density_web`), `sort`, `unread` and `stories`. Assert `rf:viewchanged` in `HX-Trigger`. Bad field or value → 400, and every other settings column is unchanged.
  - `list: rows keep their hooks and the translated title in every density`. Use a translated article: `data-title-translated`, `data-translation-mark`, the snippet hidden in Summary, `data-star-btn`, `data-rf-slot="star-button"`, the letter feed icon.
  - `list: the skeleton is hidden from screen readers`: `/app` renders `template#rf-list-skeleton` and the initial skeleton, both `aria-hidden="true"`.
- [ ] Run `PY tests/test_list_view.py`. Expected: fail.
- [ ] **GREEN:** implement.
- [ ] Run `GOLDENS row-` and review the diff (row files only).
- [ ] Run `PY tests/test_list_view.py tests/test_partials_online_unchanged.py tests/test_story_list.py tests/test_saved_searches.py tests/test_sync_snapshots.py tests/test_offline_page_shell.py tests/test_welcome_onboarding.py tests/test_csp.py tests/test_base_dark_controls.py`, then `PYFULL`. Expected: green.
- [ ] Run `JS keyboard-shortcuts.test.mjs mark-read-on-scroll.test.mjs story-unfold.test.mjs story-overlay.test.mjs offline-drift.test.mjs`. Expected: green. The node drift half compares `templates.js` with the committed goldens and must stay green: neither changes in this task.
- [ ] Build CSS into `$(mktemp -d)` and run `SOURCES`, then `CONTRACT` (check, then restore). Expected: every `SOURCES` check `OK`; the report lists the selectors that changed.

Done: tests green; the `row-*` goldens are regenerated and reviewed; every kept hook is present; `app.js`, `offline/*` and `tailwind.css` are untouched.

---

### Task s4-T3: Article redesign (toolbar, AI panel, progress, phone bar, AI error fragments)

**Size** L · blocked_by: —

**Files:**
- Modify:
  - `backend/app/templates/app/partials/article_detail.html`, `article_content.html`, `ai_blocks.html`, `chat.html`, `article_title.html`, `article_meta_date.html`, `story_block.html`, `story_members.html`, `saved_icons.html`;
  - `read_button.html`, `star_icon.html`, `archive_button.html`, `share_button.html` and `readable_progress.html`, only if restyled (list each in the report);
  - `backend/app/routers/web/app/ai.py`: the AI panel fragments only;
  - `backend/app/ui_fragments.py`: `alert_html` gains `attrs`;
  - `backend/app/templates/base.html`: the article rules in the inline style (toolbar, progress, AI panel, floating bar, the `.mobile-detail-open` block at :305-321, the inline-detail rules at :191-199);
  - `backend/tests/test_sync_snapshots.py`: the AI-action assertions at :352-355 only. With the "Generate context" menu item gone, one `ai-context-action` remains, the panel button;
  - `backend/tests/fixtures/partials_online/{detail,content,read-button}-*.txt` (through `GOLDENS`).
- Create:
  - `backend/tests/test_article_redesign.py`;
  - `tests/visual/layout-allow/s4-T3.json`.
- Do **not** edit `app.js`, `offline/*`, `input.css` (s4-T2 owns it in this wave; list `.translation-toggle` at :599-600 in the report if the new meta line no longer uses it), `articles.py` (s4-T2), `score_badge.html` (s4-T2) or `backend/tests/test_partials_online_unchanged.py`.

**Changes:**
- **Sticky toolbar** (`<div data-article-toolbar class="article-detail-menu sticky top-0 …">` at the top of `#article-detail-root`). The `article-detail-menu` class stays because the `menuAction` helper in `tests/e2e/offline.spec.mjs:78-83` finds the article's controls through it. With read, star and archive visible in the toolbar, that helper never needs `[data-menu-toggle]`.
  - read, star, archive: icon buttons carrying `data-header-read|star|archive`, `data-rf-slot`, the same `hx-post` / `hx-target` / `hx-swap` as today's menu items, and a `data-label` sr-only span;
  - labels: the existing label picker trigger;
  - Ask: `data-show-chat-modal`, shown when `chat_available`, `data-rf-online-only`;
  - original link: `<a data-external-link target="_blank" rel="noopener noreferrer">`, when `article.url`;
  - "···": `menu(id="article-menu-{id}", …)` holding Share (`data-bottom-share` semantics), Copy (`data-copy-article`), Extract full content (when `readable_status == 'failed'`), and Remove from Saved (`data-unsave`, last and separated, as today).
  - A thin `<div data-rf-progress aria-hidden="true">` on the toolbar's bottom edge. s4-T5 drives it.
  - On the phone in full-screen (`html.mobile-detail-open`): the toolbar starts with `#mobile-detail-back-btn` (moved out of `#mobile-detail-back-bar`, which keeps its id as the toolbar's phone wrapper). It shows Share and Ask; read, star and archive move to the floating bar. `#detail-topbar-*` leave; their `app.js` code is dead and null-guarded until s4-T5 deletes it.
- **Header:**
  - the meta line: source · author · date · translation mark and "Show original" (kept) · read time;
  - the title in `--rf-serif` (`.article-detail-title-row [data-external-link]`, or `article_title`), keeping `data-detail-title`.
- **AI panel**, when `article.ai_summary or article.ai_context or ai_available or rf`, as today. It uses `tabs(id="ai-panel-{id}", …)` from `ui/nav.html` with two tabs:
  - **Summary** (selected): the stored summary, the pending spinner, or a "Generate summary" button (`hx-post …/ai-summary`, `data-rf-slot="ai-summary-action"`, `hx-target="#ai-summary-{id}"`). Summary is one step from the open article.
  - **Context:** the stored context, plus `#context-panel-{id}` (no longer `hidden`) with the focus field and Generate / Regenerate.
  - **Ask** sits next to the tabs: a button, not a tab. It opens today's chat modal.
  - Every AI hook stays. The snapshot slots (`data-rf-placeholder="ai"`, `data-rf-slot="ai-summary"`) keep their places, so `offline/overlay.js` still finds them. The Summary panel needs no JS to show.
- **`ai_blocks.html`** restyled on tokens (summary accent `--primary`, context `--rf-warn`). The macro signatures and outer ids are unchanged.
- **AI fragments** (carry, server half). In `routers/web/app/ai.py`, these become `alert_html(text, variant=…, live=True, attrs={"id": "<same id>"})`, with the text passed **unescaped**, because `alert_html` escapes:
  - the summary failure at :159-160 and :196-197 (`destructive`);
  - the context failure at :262-263 (`destructive`);
  - `_note` at :113-114 (`default`);
  - "Main AI model not configured." at :249 (`default`);
  - "Summary was skipped…" at :205 (`warning`).

  The empty `<div id="ai-summary-{id}"></div>` answers stay. **Deferred to s6:** the general and article chat-area wrappers at :325, :333, :434, :442.
- **`alert_html`** (`backend/app/ui_fragments.py:13`) gains `attrs: dict | None = None`, passed to the macro's `attrs`. The docstring names the id use.
- **Chat error hook** (carry, server half). `chat.html:32` becomes `alert(variant="destructive", text=error, live=true, attrs={"data-chat-error": true})`. s4-T5 changes the readers at `app.js:4064`, `:4240` and `:4391`.
- **Footer bar** (`article_content.html`, `.article-bottom-bar`):
  - restyled; it keeps every `data-bottom-*` hook and gains `data-bottom-read` (`hx-post …/read`, `hx-target="#read-btn-{id}"`);
  - in flow at the end of the article on every bucket (one-tap Copy and Share on desktop, as today);
  - under `html.mobile-detail-open` it is a floating bar fixed at the bottom with read, star, archive and next, the other buttons hidden there. The CSS goes in the `base.html` inline style, not in the partial: `article_content.html` is in every snapshot.
- **Story block and members** restyled on tokens. `story_members.html` keeps `member.translated_title or member.title`.
- **Layout exemptions** (`s4-T3.json`, screen `article`): `[data-article-toolbar]*`, `#ai-panel-*`, `.article-bottom-bar*`, `#mobile-detail-back-*`. Reason: "s4 article toolbar, AI panel and phone bar". The detail pane keeps its x and width.

Steps:
- [ ] **RED** in `test_article_redesign.py`. Render through `htmx_article_detail` with the client pattern, or through `templates.env` as `test_partials_online_unchanged.py` does.
  - `detail: toolbar keeps the keyboard and offline hooks`:
    - `[data-header-read|star|archive]` each with `hx-post` and a `data-label`;
    - `.article-detail-title-row [data-external-link]`;
    - Ask only with `chat_available`;
    - `data-rf-progress`;
    - for a translated article: `data-title-translated` on `<article>`, `data-toggle-translation`, and `data-detail-title` holding the translated title.
  - `detail: AI panel tabs show summary, context and the generate actions`, parametrised:
    - a stored summary: the Summary tab is selected and the summary is shown;
    - `summary_pending`: the spinner with `hx-trigger="every 5s"`;
    - none, with `ai_available`: a Generate button targeting `#ai-summary-{id}`;
    - AI off and nothing stored: no panel;
    - a stored context: the Context panel holds `#ai-context-{id}`.
  - `ai: failure and note fragments use the alert macro and keep the swap id`, parametrised:
    - summary failure: monkeypatch the summary service to raise → `class="alert"`, `data-variant="destructive"`, `id="ai-summary-{id}"`, `role="alert"`, text "Summary failed: …" escaped once (`<b>` in the error appears as `&lt;b&gt;`);
    - poll failure (job `failed`);
    - context failure;
    - AI disabled (`_note`), which renders a default alert.
  - `chat: an error renders the alert with data-chat-error`, through `_render_chat_area(…, error="boom")`.
  - `detail: without JS the title, body and original link are not hidden`. The rendered detail has the title link, the body text and the Summary panel outside any element with a `hidden` attribute or `hidden` class (BeautifulSoup walk). Toolbar actions are `<button hx-post>` or `<a href>`, as today.
- [ ] Run `PY tests/test_article_redesign.py`. Expected: fail.
- [ ] **GREEN:** implement.
- [ ] Run `GOLDENS "detail- or content- or read-button-"` and review the diff (those files only).
- [ ] Run `PY tests/test_article_redesign.py tests/test_partials_online_unchanged.py tests/test_ai_summary_context.py tests/test_ai_chat.py tests/test_ui_fragments.py tests/test_star_summary_wait.py tests/test_translation.py tests/test_sync_snapshots.py tests/test_csp.py tests/test_base_dark_controls.py tests/test_dev_ui.py`, then `PYFULL`. Expected: green.
  - The texts these tests assert stay as they are: `test_ai_summary_context.py:88/145/172/212/301`, `test_ai_chat.py:245`, `test_sync_snapshots.py:353` "Generate summary".
  - `test_ui_fragments.py:101,112,230` already require that the legacy classes are absent.
  - The only planned test edit is `test_sync_snapshots.py:354-355` (the `ai-context-action` count).
- [ ] Run `JS keyboard-shortcuts.test.mjs offline-overlay.test.mjs offline-drift.test.mjs story-overlay.test.mjs`. Expected:
  - `keyboard-shortcuts`: green, because its fixtures are its own markup;
  - `offline-drift`: green, because neither `templates.js` nor the committed goldens change here;
  - `offline-overlay`: green, or red only for header-menu markup, which then goes into the report for s4-T4.
- [ ] Build CSS into `$(mktemp -d)`, run `SOURCES` and `CONTRACT` (check, then restore). List the removed selectors (`detail-topbar-*`, the detail `data-menu*`, `data-show-context-panel`) and the new ones.

Done: tests green; the detail goldens are regenerated and reviewed; the AI fragments and the chat error use the alert macro with the `data-chat-error` hook; every kept hook is present.

---

### Task s4-T4: Offline: mirror, overlay, mark-all, banner, offline page, snapshot version

**Size** L · blocked_by: s4-T2, s4-T3

**Files:**
- Modify:
  - `backend/app/static/js/offline/templates.js`: `listHeader`, `listPage`, `scoreBadge`, `storyMarker`, `storyLine`, `storyBlock`, `storyMembers`, `aiSummary`, `aiContext`, `aiRequested`, the state buttons if s4-T3 restyled them, `offlineBanner`, `offlinePage`;
  - `backend/app/static/js/offline/overlay.js`: the header-button class lists and SVGs at :95-115, the AI slots at :150-170;
  - `backend/app/static/js/offline/router.js`: `markScopeRead` at :395-433 and `listResponse` header context at :156-163;
  - `backend/app/static/js/offline/lists.js`: only if the header needs a scope title or folder helper;
  - `backend/tests/test_offline_drift.py`, `tests/js/offline-drift/adapters.mjs`, `backend/tests/fixtures/offline_drift/*` (including `cases.json`);
  - `backend/app/services/sync/__init__.py` (`OFFLINE_TEMPLATE_VERSION` "5" → "6", the new hash), `backend/tests/test_offline_template_version.py` (append `("6", "<hash>")` to `LEDGER`; copy `("5", "2a128a49fc5f9cc4")` into `RELEASED`);
  - `backend/app/templates/settings/preferences.html`: only the `data-rf-offline-settings` and `#offline-diagnostics` blocks at :343-370;
  - `tests/js/offline-router.test.mjs`, `tests/js/offline-overlay.test.mjs` (its fixture at :82-97 uses `data-show-context-panel` and "Regenerate context", which s4-T3 removes; update it to the tabbed panel), `tests/js/offline-page.test.mjs`.
- Create: `tests/js/offline-page-tokens.test.mjs`.

**Changes:**
- **Mirror.** Each `templates.js` function renders what its Jinja source renders now, normalised as the drift harness does. The list header gets:
  - the title, from `state.lists` names with the same fallbacks as `list_view_title`;
  - the chips, from `lists.folders` in the sidebar mirror's order;
  - the View menu, with every item `data-rf-online-only`;
  - mark-all.

  `router.js` passes the title, chips and active folder in the `listHeader` context. Adapter differences are listed with reasons (for example: the offline View menu is rendered but online-only).
- **Drift cases.** Regenerate with `DRIFT`. Add cases for:
  - the plain header (title, View, mark-all);
  - the header with chips and an active folder;
  - the new AI blocks if their shape changed.

  Every existing case stays.
- **Overlay.** Header buttons now sit in the toolbar. `readButton`, `starButton` and `archiveButton` in `overlay.js` follow the new class and SVG sets of s4-T3's toolbar and `data-bottom-read`. `ai()` fills the slots in the tabbed panel.
- **Offline mark-all** (`router.js` `markScopeRead`): both answers send `trigger({ sidebarRefresh: true, 'rf:markedall': { stamp: null, count: changes.length } })` instead of the plain `'sidebarRefresh'` header. The bodies are unchanged.
- **Offline undo:** no route. The fallback at :583 answers `needsConnection('')` (200, `X-Readfine-Offline: 1`, `[data-rf-needs-connection]`). This task pins that with a test; s4-T5 reads it as "offline".
- **Banner** (`offlineBanner`): the `alert` macro's markup (`div.alert` with `role="status"`), `data-rf-offline-banner` kept, text unchanged ("Offline · N actions waiting"). It is JS-only, so a node test covers it, not drift.
- **Offline page** (`offlinePage`): one `PAGE_TOKENS` constant **inside** `offlinePage` holds `{light: {background, foreground, muted, primary, border}, dark: {…}}`, the Neutral values from `styles/tokens.css`. The page picks them with `@media (prefers-color-scheme: dark)`; the worker cannot read the device theme. It stays inside the `check-colours.mjs` ALLOW entry (`fn: 'offlinePage'`). `tests/js/offline-page-tokens.test.mjs` parses `styles/tokens.css` and fails when a value differs. Leave `sw.js:85` (the import-failure fallback) as it is and put it in the report as noticed (Risks R5).
- **Diagnostics section** (`preferences.html` :343-370): the buttons go through `button` (`ui/forms.html`), the output box through tokens. Every `data-rf-*` hook, `#offline-diagnostics` and `#offline-enabled` stay; `page.js` is not touched.
- **Snapshot version.** Run `PY tests/test_offline_template_version.py` and read the hash it prints. Set `OFFLINE_TEMPLATE_HASH`, bump the version to "6" and add the ledger row. No other task changes these.

Steps:
- [ ] **RED:**
  - `offline-router.test.mjs`: `offline-router: mark-all sends rf:markedall without a stamp and undo needs a connection` (feed and saved-search variants; `POST /htmx/articles/mark-read/undo` answers 200 with `X-Readfine-Offline` and a `[data-rf-needs-connection]` body).
  - `offline-overlay.test.mjs`: `overlay: toolbar and floating-bar buttons follow read, star and archive`.
  - `offline-page.test.mjs`: `offline banner: alert markup with the waiting count`.
  - `offline-page-tokens.test.mjs`: `offline page: colours equal the Neutral tokens in light and dark`.
- [ ] Run `JS offline-router.test.mjs offline-overlay.test.mjs offline-page.test.mjs offline-page-tokens.test.mjs`. Expected: the new tests fail.
- [ ] **GREEN:** implement. Then run `DRIFT` and review the golden diff against s4-T2's and s4-T3's markup.
- [ ] Run `PY tests/test_offline_drift.py tests/test_offline_template_version.py tests/test_sync_snapshots.py tests/test_offline_page_shell.py`. Expected: green.
- [ ] Run `TMPDIR=/var/tmp npm test`. Expected: `# fail 0` (`offline-sync.test.mjs` "templates version change refetches all snapshots" included).
- [ ] Run the full backend suite with only `--deselect tests/test_dom_contract_pages.py`, then `SOURCES` and `CONTRACT` (check, then restore). Expected: green; every `SOURCES` check `OK`.

Done: the drift test and the template-version test are green; the version is "6" with a ledger row; offline mark-all sends `rf:markedall` without a stamp; the banner, offline page and diagnostics are restyled.

---

### Task s4-T5: `ui/read.js`: undo toasts, swipe, View and chips, skeleton, progress; `app.js` read code; carry fixes

**Size** L · blocked_by: s4-T1, s4-T2, s4-T3

**Files:**
- Modify:
  - `backend/app/static/js/app.js`;
  - `backend/app/static/js/ui/palette.js`: add `goTo` to `window.RFPalette`, and nothing else;
  - `backend/app/templates/app/main.html`: one `<script src="{{ static_url('js/ui/read.js') }}" defer></script>` after `ui/shell.js` at :10;
  - `tests/js/keyboard-shortcuts.test.mjs`;
  - `tests/js/harness.mjs`, only if a moved block needs it;
  - `backend/app/templates/base.html` and `input.css`:
    - delete the `#detail-topbar-*` rule at `base.html:362`;
    - delete the rules that s4-T2's and s4-T3's reports list as dead (Global Constraints, "Read-zone CSS");
    - only if the stack check below fails: the `.toaster` rule at `base.html:295-297`, `backend/app/static/js/ui/toast.js` and `tests/js/ui-toast.test.mjs`.
- Create:
  - `backend/app/static/js/ui/read.js`;
  - `tests/js/ui-read.test.mjs`.

**Interface (`window.RFRead`):** `undoMarkAll(stamp)`, `goTo(url)` (delegates to `RFPalette.goTo`), `reloadList()` (calls `app.js`'s global `_kbReload()`, which handles search results and refreshes the sidebar). Delegated listeners do the rest.

**Behaviour:**
- **Mark-all toast.** A `body` listener for `rf:markedall` shows the toasts pinned in Global Constraints. Undo:
  - one `fetch('/htmx/articles/mark-read/undo', {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/x-www-form-urlencoded', 'HX-Request': 'true', 'x-csrftoken': <cookie>}, body: 'stamp=' + encodeURIComponent(stamp)})`. Read the `csrftoken` cookie the way `ui/pending.js` does it in its own `csrfToken()` (:70); `app.js` has the same rule in `getCsrfToken()` (:3).
  - On 200: `RFToast.fromTrigger(JSON.parse(header).showToast)`, then `reloadList()`.
  - Otherwise as pinned. The articles stay read on any failure.
- **Archive Undo** (§5.4). On `articleArchiveChanged` with `isArchived: true` from a user action, show `Archived` with Undo. Undo clicks the article's `[data-header-archive]` when the article is still open, else posts `/htmx/articles/{id}/archive` with `swap: 'none'`.
- **Mark-all confirmation** (`_kbMarkAllRead` at `app.js:2293`): `confirm()` only while `navigator.onLine === false` (Q1).
- **View menu.** On `rf:viewchanged`: `reloadList()`.
- **Chips.** Clicks on `#article-list [data-rf-nav]` call `goTo`.
- **Skeleton.** The "Article-list loading overlay" block (`app.js:831-877`) moves to `read.js`. After the same 150 ms delay it clones `template#rf-list-skeleton` into `.article-list-loading`. The contract class and the timing are kept; the spinner markup and the hard-coded `bg-white/80` go.
- **Swipe** on `.article-row` as pinned. A row follows the finger with `transform`, and a threshold (35 % of the width, or 96 px) commits on release:
  - right clicks the row's `[data-star-btn]`;
  - left posts `/htmx/articles/{id}/read` (`htmx.ajax`, `swap: 'none'`; the existing `articleReadChanged` handling updates the row);
  - below the threshold the row snaps back through `RFMotion`, instantly under reduced motion.

  A committed swipe never opens the article: the row's `hx-trigger="click"` is suppressed for that gesture.
- **Progress.** A passive scroll listener on the reading surface (`#article-detail`, or `#inline-article-detail-content` inline) sets `--rf-progress` (0–1) on `[data-rf-progress]` in a `requestAnimationFrame`. No transition under reduced motion.
- **Moved from `app.js` and adapted:**
  - "Translated titles" (`:4674-4707`), which now also toggles the toolbar's title;
  - "AI context panel" (`:3993-4036`): delete it, since the Context tab replaces it, and keep nothing of `data-close-menu`;
  - from "Mobile navigation": `syncDetailTopbar` and the topbar star and archive click handlers (`:3637-3702`) are deleted, because `#detail-topbar-*` are gone. The share picker (`:3703` on) stays: drop only its `#detail-topbar-share` selectors (`:3764`, `:3781`), and the phone toolbar's Share button triggers it with `data-bottom-share`. Drop `#detail-topbar-next` from the next handler (`:3932`) and the story-overlay rule in `base.html:362`;
  - `_syncBottomBar` (`:3955-3971`) also shows `[data-bottom-read]`.

  A block that reads `app.js` private state stays and is listed in the report.
- **Chat error hook** (carry, client half):
  - `_inlineChatError` (`:4062-4068`) builds `div.alert[data-variant="destructive"][role="alert"][data-chat-error]` with `textContent`;
  - the retry checks at `:4240` and `:4391` test `[data-chat-error]` instead of `.text-red-500`.
- **S3W-F5:**
  - `_anyModalOpen` (`:2178`) also returns true when any `[aria-haspopup][aria-expanded="true"]` trigger of a Basecoat dropdown or popover is in the document (account menu, View menu, article menu);
  - the Escape branch at `:2438` returns after the menu's own Escape and never reaches `history.back()`;
  - the chat modals' Escape listener (`:4360`) ignores Escape while such a menu is open.
- **Phone default** (Q2): when the owner accepts, `detail_mode_small` defaults to `fullscreen` at `app.js:179`, `:1051`, `:3670` and `:3980`. A stored value is kept.
- **Toast stack** (carry). Show the mark-all Undo toast while an older timed toast is up, and check in a browser what s4-T6's e2e 2 asserts: the newest toast is opaque, on top and not covered. Do it with a throwaway `npx playwright test` run, or leave it to s4-T6 and report.
  - If it fails, fix it in `toast.js` and the `.toaster` rule.
  - If it passes, report the carry item as closed, with the evidence.

Steps:
- [ ] **RED** in `ui-read.test.mjs` (harness `browser(html, {before, scripts: ['ui/read.js']})`, where `before` installs a stub `RFToast` that records calls, a stub `RFPalette.goTo`, a stub `fetch` and `matchMedia`; `node:test` mock timers):
  - `read: mark-all Undo posts the stamp unchanged and reloads the list; offline and stampless answers have no Undo`. Subtests:
    - the stamp `2026-11-23T03:16:00.000000+00:00` is posted exactly;
    - 200 shows "Restored 3" and calls `_kbReload`;
    - an `X-Readfine-Offline` 200 and a rejected fetch both show "Couldn't undo while offline";
    - 410 shows the server's toast;
    - `stamp: null` shows no action;
    - `count: 0` shows "Nothing to mark as read".
  - `read: swipe right stars, left marks read, vertical scroll does nothing, reduced motion keeps the action` (pointer events with `pointerType: 'touch'`).
  - `read: View change reloads the list, chips go through RFPalette.goTo, skeleton waits 150 ms, progress follows scroll, archive shows Undo`.
  - `chat: a reply with data-chat-error puts the message back for retry` (and `_inlineChatError` builds the alert with `textContent`).
- [ ] **RED** in `keyboard-shortcuts.test.mjs`, one test function with two subtests: `keyboard: an open menu covers the reader; Shift+A confirms only offline`.
  - `j`, `m`, `s` and `A` do nothing while `[aria-haspopup][aria-expanded="true"]` is present, and Escape does not call `history.back`.
  - Shift+A clicks the sidebar row's button without `confirm()` while `navigator.onLine` is true, and asks `confirm()` while it is false.

  That makes 5 new test functions in this task.
- [ ] Run `JS ui-read.test.mjs keyboard-shortcuts.test.mjs`. Expected: fail.
- [ ] **GREEN:** implement, move and delete.
- [ ] Run `grep -n "text-red-500\|detail-topbar-\|data-show-context-panel\|article-list-loading absolute" backend/app/static/js/app.js`. Expected: no matches (the loading class now lives in `read.js`).
- [ ] Run `TMPDIR=/var/tmp npm test`. Expected: `# fail 0`. Then run `PY tests/test_csp.py tests/test_offline_page_shell.py` and `CONTRACT` (check, then restore). Report the added and removed selectors.

Done: tests green; `read.js` is loaded by `main.html` and covers mark-all and archive Undo, swipe, View reload, chips, skeleton and progress; the S3W-F5, chat-error and toast-stack carry items are fixed or closed with evidence; the existing keyboard tests pass unchanged.

---

### Task s4-T6: Regenerate CSS and contract; read e2e; visual acceptance; repo docs

**Size** L · blocked_by: s4-T4, s4-T5

**Files:**
- Modify, generated: `backend/app/static/css/tailwind.css`, `docs/ui-dom-contract.md`, `backend/tests/fixtures/dom_contract/*`.
- Create:
  - `tests/e2e/read.spec.mjs`;
  - `tests/visual/layout-allow/s4-T6.json`, only for boxes inside the list header, rows, toolbar, AI panel or phone bars, each with a reason.
- Modify:
  - `tests/visual/layout.mjs`: `KEY_STRUCTURE` entries, only if a key id changed;
  - `README.md`, `CLAUDE.md`, `CHANGELOG.md`.

**`read.spec.mjs`** (Chrome project, role and label selectors for new UI, seeded accounts from `tests/e2e/fixtures`). Every test collects `securitypolicyviolation` through `page.addInitScript` and expects none.
1. `read: open, star and archive with Undo; j/k/s/m/v; Show original swaps row and pane titles`. A translated title is seeded through the fixtures. If the fixtures cannot seed one, say so in the report and cover it in jsdom instead.
2. `read: mark all read from the list header, Undo restores the rows, the newest toast is on top`. First show an older timed toast. Then assert what `tests/e2e/shell.spec.mjs:302-319` asserts for the Undo toast: opacity 1, `elementFromPoint` hits it, it sits above the others.
3. `read: phone — swipe star and read with touch, full-screen article with the floating bar and back`. Use `test.use({ viewport: {width: 390, height: 844}, hasTouch: true })`: the configured projects have no `hasTouch`. Seed `detail_mode_small=fullscreen` when Q2 keeps "inline" as the default.
4. `read: offline mark-all has no Undo; Undo after the connection drops says so; old snapshots are replaced after one sync`. Offline mode on, as `offline.spec.mjs` does it.
   - (a) `context.setOffline(true)`, mark-all → the toast has no Undo button.
   - (b) Online mark-all, then `setOffline(true)`, Undo → "Couldn't undo while offline", and the rows stay read after going back online.
   - (c) In IndexedDB, set one snapshot's `template_version` to "5" and its `row_html` to a marker string. Run one sync online; the row now renders the new markup (`[data-rf-article]` with the new row structure, no marker).
5. `read: reduced motion leaves no running animation after swipe, star and mark-all; the article partial reads without JS`.
   - (a) `emulateMedia({reducedMotion: 'reduce'})`, act, then `document.getAnimations().filter(a => a.playState === 'running')` is empty.
   - (b) A context with `javaScriptEnabled: false` opens `/htmx/articles/<id>`: the title, a body paragraph and the original link are visible.

Steps:
- [ ] Run `npm run build`. Expected: `vendor: … files` and a written `tailwind.css`. Then:
  ```
  O=$(mktemp -d) && cp backend/app/static/css/tailwind.css $O/a.css \
    && node scripts/build-css.mjs -i input.css -o backend/app/static/css/tailwind.css \
    && cmp $O/a.css backend/app/static/css/tailwind.css && echo deterministic; rm -r $O
  ```
  Expected: `deterministic`.
- [ ] Run `CONTRACT` and **keep** the result. Then run `DRIFT`. Expected: exit 0 and green. In the contract diff, the selectors that tasks T2–T5 reported appear or leave, and nothing else.
- [ ] Run `npm run -s check:sources`. Expected: every check `OK`.
- [ ] Run `TMPDIR=/var/tmp npm test && (cd backend && <PY env with DB=readfine_pytest> uv run pytest -q)`. Expected: `# fail 0`, `passed`.
- [ ] Run `E2E_DATABASE_URL=… npx playwright test --project=chrome`. Expected: passed, `read.spec.mjs`, `shell.spec.mjs` and `offline.spec.mjs` included. The known `offline.spec.mjs:809/886` logout flake (backlog) is reported, not fixed.
- [ ] Run `E2E_DATABASE_URL=… RF_VISUAL_BASE=95fdb64 RF_VISUAL_MODE=layout npm run test:visual`. Expected: `layout: A <n>/<n> strict` and `B <n>/<n> structural`, exit 0, with only the `s4-*.json` exemptions. A failure outside the list, the article or the phone bars goes back to its task through return-to-repair.
- [ ] Run `E2E_DATABASE_URL=… RF_VISUAL_BASE=95fdb64 RF_VISUAL_MODE=gallery RF_VISUAL_DEBUG=1 RF_VISUAL_GALLERY_BASE=1 npm run test:visual`. Expected:
  - `gallery.html` with base and head shots: `list` and `article` at 1280 and 390, light and dark, under each app theme;
  - one extra shot each with the View menu open and the AI panel on Context;
  - dark-patch probe `0` under Paper dark and Graphite dark.

  Hand `test-results/visual-report/{layout.md,gallery.html}` and the PNGs to the orchestrator for the Result page.
- [ ] **Docs:**
  - `README.md`: the View menu, mark all read with Undo, swipe on the phone, the AI panel.
  - `CLAUDE.md` "CSS / Tailwind conventions":
    - read-zone behaviour lives in `ui/read.js`;
    - the `rf:markedall` / undo contract;
    - `data-chat-error` is the chat error hook;
    - `/htmx/list-view` saves one View choice;
    - `data-rf-nav` is shared by the palette and the chips;
    - offline page colours are pinned by `offline-page-tokens.test.mjs`.
  - `CHANGELOG.md` `[Unreleased]`:
    - "Changed: new article list with a View menu, folder chips and swipe on the phone."
    - "Added: Undo after mark all as read and archive."
    - "Changed: article toolbar and an AI panel with Summary, Context and Ask; reading progress."
    - "Changed: offline banner and offline page restyled."
- [ ] `npm run check:generated` compares with the commit, so the orchestrator runs it on the applied tree. Expected there: exit 0.

Done:
- all suites green;
- the layout gate passes with reasoned exemptions only;
- the gallery and the dark-patch probe are clean;
- the §6 flows for the read zone pass: open, star, archive; mark all with Undo; phone full-screen and swipe with touch; reduced motion; no-JS article.

---

## Carry-over map (s3 carry, triaged 2026-11-23)

| Item | Where | Note |
|---|---|---|
| AI chat retry finds an error by `.text-red-500` (`app.js:4064`, `:4240`, `:4391`); `app/ai.py` fragments | s4-T3 (server: `alert_html`, `data-chat-error`), s4-T5 (client) | one hook, `data-chat-error`, between them |
| S3W-F5: account menu open lets list keys leak, and Escape runs `history.back` and the chat listener (`_anyModalOpen`, `app.js:2178`, used at :2400, :2438) | s4-T5 | covers every Basecoat menu and popover, since s4 adds the View and article menus |
| A newer Undo toast stacks behind the older one | s4-T5 (fix if the check fails), s4-T6 e2e 2 | s3-T12's jsdom test checks DOM order only; `shell.spec.mjs:302-319` checks the settled layout for one case |
| WebKit palette forced-error state (`shell.spec.mjs:104/118`) | backlog | s3 defect, not read zone |
| WebKit offline e2e flakes (`offline-freshness.spec.mjs:33`, `offline.spec.mjs:556`, `:886`) | backlog | s4-T6 reports them if they fire |
| s3-T12 F1–F4 and noticed items; S3W-F1–F4, F6 | backlog | not read zone |
| s6: `catchup.py` bare-text 404s, briefing test `<p>` | s6 | |
| `admin.py:10` unused `RedirectResponse` import | backlog | |
| `pending.js` does not split batches over 50 | backlog (s5 is the first real user) | |
| `offline/router.js` does not pass `opts.autoAdvance` to `sidebar()` | backlog | s4-T4 owns `router.js` and may fix it in one line if it comes for free; otherwise leave it |

## Open questions for the owner

Resolved by the owner on 2026-11-23: all four as recommended below.

1. **Mark all read: keep the confirmation?** Today Shift+A and the sidebar ✓ ask `confirm()`. Recommendation: no confirmation while online, because Undo covers it (design goal 6); keep it while offline, where there is no Undo. s4-T5 implements this.
2. **Phone default: full screen?** Design §5.2 shows the phone article full screen. Today a per-device setting picks it, and the default is "Expand in list". Recommendation: devices with no stored choice open articles full screen; a stored choice is kept. If you prefer to keep "Expand in list" as the default, the floating bar shows only for readers who chose full screen.
3. **"Filter from this source" in the article "···" menu.** The filter page has no prefill today. Recommendation: leave it out of s4 and add it in s7, when Relevance & filters is rebuilt and can take `?feed_id=`.
4. **View menu: saved per account, as Preferences are today, or per view?** Recommendation: per account, through `/htmx/list-view`. Density stays per device kind (phone or desktop), as in Preferences. Per-view settings would be new server state, which the design rules out.

## Risks

- **R1, wave-1 markup without wave-2 JS.** Between the wave-1 merges and s4-T5:
  - chips do nothing;
  - a View choice is saved but shows only on the next load;
  - the phone top bar has no star or archive (the floating bar has them in full-screen, the footer bar inline);
  - the old topbar code is dead.

  This is acceptable inside the segment, because the PR merges after s4-T6.
- **R2, snapshot churn.** Version 6 makes every offline device refetch all snapshots on its next sync: one larger sync per device, by design (§5.5).
- **R3, swipe and the row's click.** A committed swipe must not also open the article (the row has `hx-trigger="click"`). s4-T5 suppresses the click for that gesture. e2e 3 checks it.
- **R4, View menu and density offline.** Snapshots are rendered with the density current at sync time. A density change made online shows offline only after the next sync. Accepted.
- **R5, offline page tokens.** The design asks for a constant generated by the build script. A test-pinned constant gives the same guarantee without a new generated file, a new `sw.js` `importScripts` entry or a `check:generated` change, all of which would touch the offline boot path. The import-failure page in `sw.js` (:85) keeps its own minimal styling; it is reported, not changed.
- **R6, translated titles offline.** Sync records carry no `translated_title` (`services/sync/` and `offline/*` have no reference), so offline story members and rows mirror the original title. This predates s4 (upstream 5c4bf90). It is noticed for the backlog, not fixed here.

## Verified vs assumed (at plan time, 2026-11-23, tree 95fdb64)

**Verified in code:**
- **Mark-all, server:**
  - `mark_scope_read` is at `services/article.py:891`, with `now` at :927, the early UPDATE plus commit at :949-961 and the upsert plus commit at :1010-1011; it returns `None`.
  - `mark_saved_search_read` is at `saved_search_service.py:283` and executes at :319.
  - The other callers are `ops.py:439` and `:444`.
  - The mark-all routes are at `shell.py:138/180/202` with plain `"sidebarRefresh"` at :176/198/218, and at `saved_searches.py:133` with :148.
  - No test compares `HX-Trigger` with the plain string.
  - `SUPPRESSED_BY_BULK` is in `models/article.py:95`.
  - The 0127 trigger sets `read_changed_at` on every `is_read` change.
- **Mark-all, client and offline:**
  - `_kbMarkAllRead` (`app.js:2293`) calls `confirm()`; `data-action="mark-all-read"` is delegated at `app.js:2631`.
  - Offline `markScopeRead` (`router.js:395-433`) answers a plain `sidebarRefresh`.
  - Unknown `/htmx/` paths get `needsConnection` with status 200 and `X-Readfine-Offline: 1`.
- **List:**
  - `article_list.html` renders no header for plain views today; titles come from `data-nav-title` client-side.
  - No favicon field exists in `models/` or `schemas/`.
  - `POST /settings/preferences` (`settings/preferences.py:90`) rewrites every field.
- **Article:**
  - Key bindings: `m` / `s` / `e` / `v` use `_kbArticleControl` (`app.js:2279`) inside `_kbOpenArticle()`, whose root is `#article-detail-root` (`data-article-id`).
  - `_anyModalOpen` (`app.js:2178`) has no `aria-expanded` check.
  - `alert_html` (`ui_fragments.py:13`) has no `attrs`.
  - The `text-red-500` sites are `chat.html:32`, `app.js:4064/4240/4391`, `ai.py:160/197/263`.
  - Translation hooks (5c4bf90) live in `article_row.html`, `article_detail.html`, `article_title.html`, `story_members.html`, and the `app.js` block at :4674. No test covers the toggle.
- **Offline and snapshots:**
  - `OFFLINE_TEMPLATE_VERSION = "5"` and hash `2a128a49fc5f9cc4`, with ledger rows 3–5.
  - Both snapshot closures include `score_badge.html`, `chat.html`, `ai_blocks.html`, `saved_icons.html` and `story_block.html`.
  - `overlay.js` rewrites the header-menu buttons by class.
  - The offline page's hex colours sit under the `check-colours.mjs` `fn: 'offlinePage'` exception.
- **Toasts:** `shell.spec.mjs:302-319` asserts the settled stack for one Undo toast.
- **Test environment:**
  - The Playwright projects (`chrome`, `webkit`) have no `hasTouch`.
  - `harness.mjs` `browser()` takes `scripts`.
  - The 4253 container is up, with `readfine_pytest` and `readfine_e2e`, user `readfine`, at alembic head `0131`.

**Assumed (workers verify first):**
- Basecoat `tabs` and `dropdown-menu` initialise inside htmx-swapped detail and list markup through their MutationObserver (design §5.4 says the prototype verified it).
- The e2e fixtures can seed folders, a saved search and a translated title. If one cannot be seeded, s4-T6 reports it and covers that case in jsdom.
- `htmx` hands `rf:markedall` and `rf:viewchanged` to `body` listeners with the object as `event.detail` (an object arrives as itself: s3's trigger-shape note).

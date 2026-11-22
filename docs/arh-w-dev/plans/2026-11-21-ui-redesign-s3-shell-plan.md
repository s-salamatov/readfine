# UI redesign s3 — Shell and navigation Implementation Plan

Status: plan / candidate · 2026-11-22 · run `run-7429291d-8129-432b-beab-c61fff1112cd`, segment s3 · base `selfhost` 4ffd84e

**Goal:** the new frame of the reader:
- a sidebar with the four zones, "+" add source, a search entry and an account menu (theme, app theme, offline);
- a ⌘K command palette;
- a labelled phone tab bar;
- a shortcuts sheet;
- toasts on Basecoat's toaster;
- the shared delayed-delete machinery (client module and batch route) that s5 and s7 will use.

The s2 carry-over that belongs here lands with it.

**Architecture:**
- **Sidebar.** `templates/app/partials/sidebar.html` is rebuilt on tokens. The account menu uses the `ui/` `menu` macro. The reader keeps its own `<aside id="sidebar">` (in `app/main.html`, refreshed by an `innerHTML` swap, collapsed by `w-60`/`w-12` and `mobile-sidebar-open`). Basecoat's `sidebar` macro and `sidebar.js` are **not** used here: their 768 px breakpoint does not match the configurable small bucket, and the macro emits the `<aside>` that the swap does not own. `offline/templates.js` mirrors the new markup in the same task, and the drift test proves it.
- **New JS modules.** Each is loaded by a static `<script src>`, which the shell cache discovers.
  - `static/js/ui/shell.js`: account menu, theme items, offline item, tab bar, sidebar sheet focus.
  - `ui/toast.js`: `RFToast`, which builds the `.toast` nodes itself.
  - `ui/pending.js`: `RFPending`, the delayed delete.
  - `ui/palette.js`: `RFPalette`.
- **Palette.** A `command_palette` dialog with static actions. Server results come from `GET /htmx/palette`, are swapped in with a debounce and carry `data-force`, so `command.js` does not filter them out. `/`, ⌘K / Ctrl+K and every "Search" entry open the palette. The old search modal (filters, saved-search editing, offline search) stays reachable through the palette's "Advanced search…" item and the title-bar Edit.
- **Batch delete.** `POST /settings/deletes` is serialised per user by a session-level advisory lock on a dedicated connection (see Risks: the delete services commit per item).
- **Shell code.** Shell code leaves `app.js` for `ui/shell.js` in one late task (s3-T10), after every other `app.js` change of the segment.

**Tech stack:** Jinja2, HTMX 2.0.4, Basecoat 1.1.0 (vendored), anime.js 4.5.0 via `RFMotion`, FastAPI, pytest, `node --test` with jsdom, Playwright. No new dependencies.

**Design:** `docs/arh-w-dev/designs/2026-11-19-ui-redesign-design.md` §5.1 (IA, phone tab bar, account menu), §5.2 (shell, palette), §5.4 (toasts, delayed delete, palette, CSP), §5.5 (contract, drift, shell cache), §5.7 wave 3, §6 (invariants, acceptance).

## Changes from the draft

1. **11 tasks in 4 waves**, up from 8 tasks in 4 waves, because the s2 carry-over adds two hygiene tasks (s3-T1, s3-T2). Each task is one coherent change sized for one attempt.
2. **One owner per hand-edited file per wave.** The draft's wave 1 had three tasks editing `app.js` and `base.html`. Tasks are now cut along file ownership:
   - **`app.js`:** T5 (wave 1), T9 (wave 2), T10 (wave 3).
   - **`base.html`:** T5 (wave 1), T6 (wave 2), T10 (wave 3).
   - **`app/main.html`:** T3 only. T3 moves the overlays and phone bars into partials, which the wave-2 tasks then own.
3. **Palette split differently.** Draft S3-T2 ("palette") and S3-T4 ("shortcuts") become:
   - s3-T7: the palette, both its route and its client;
   - s3-T9: keyboard and shortcuts, because the keydown handler lives in `app.js`.
4. **Delayed delete split into server and client.** Draft S3-T6 becomes s3-T4 (route, wave 1) and s3-T6 (client, wave 2), joined by the JSON contract pinned below.
5. **Moving shell code out of `app.js` is its own late task** (s3-T10), not part of the tab bar task. Before T10, removed markup leaves null-guarded dead code in `app.js`, which T10 deletes.
6. **Specs task folded.** Draft S3-T8 (specs) becomes the docs part of s3-T10. Project specs (`/projects/readfine/specs`) stay with the orchestrator and spec-keeper.
7. **Visual acceptance runs once**, in s3-T11, against `RF_VISUAL_BASE=4ffd84e`: layout A/B, gallery shots and the dark-patch probe. Each task runs only targeted checks.
8. **Advisory lock mechanism pinned.** `pg_advisory_xact_lock` would be released by the first item's commit. A session-level lock on a dedicated connection keeps the design's intent (see Risks R1).
9. **Shortcuts overlay becomes a `dialog`** with id `shortcuts-dialog`. The keyboard test and the contract change together, an option the design allows.
10. **Delayed-delete Playwright flows move to s5**, the first wave with a real delete row (feeds). s3 covers every §6 delayed-delete case in jsdom tests and the route in pytest.

## Global Constraints

- **IA (§5.1).** The sidebar has these parts:
  - header: wordmark · "+" · search;
  - Read: All articles · Starred · Saved · Archived, then Labels (kept: an existing feature), Saved searches, Folders → feeds;
  - zone links: Sources (`/settings/feeds`), Assistant (`/app/catch-me-up`), Settings (`/settings`);
  - footer: account menu · offline status slot · refresh.

  Later waves repoint the zone links. "Top picks" is not an existing view, so s3 leaves it out (Q3).
- **Phone tab bar:** Feed · Search · Add · Assistant · Folders, labelled, always visible in the small bucket except over a full-screen article.
- **"+" add source** links to `/settings/feeds#feed-url-input` until s5's sheet replaces it.
- **Keyboard.** Every shortcut that works today keeps working. ⌘K / Ctrl+K and `/` open the palette, and the shortcuts sheet lists both. `?` and Esc behave as today.
- **Toasts.**
  - `showToast` stays the only toast event name and the global `showToast(msg, type)` stays: `share-target.js` and `catchup.js` call it.
  - Values with user text are built with `json.dumps`.
  - Toast text is set with `textContent`.
  - No code calls Basecoat's `toaster.toast()` with `action` or `cancel` (they emit inline `onclick`). The `/dev/ui` demo uses it without them.
- **Delayed delete (§5.4).**
  - 10 s window.
  - Flush on: an entry's timer; `htmx:beforeRequest` with `detail.boosted`; `htmx:beforeHistorySave`; `visibilitychange` to hidden; `pagehide`; `beforeunload`.
  - One `fetch` per flush with `keepalive: true`, JSON body and `x-csrftoken` from `getCsrfToken()`'s cookie rule.
  - Results are per item. Sent keys are kept in `sessionStorage` `rf.deletedKeys` for 2 minutes.
  - Normal flushes wait for the request in flight. Exit flushes send at once, and the server lock serialises them.
- **Batch route contract (T4 ↔ T6).**
  - Request: `POST /settings/deletes` with body `[{"kind": "feed"|"label"|"filter", "id": int}, …]`, 1–50 items. A malformed body answers 422.
  - Response: always 200 JSON `{"results": [{"kind", "id", "status": "done"|"failed"}], "notices": [{"msg", "type"}]}`, results in request order.
  - Notices: when there are any, the header `HX-Trigger: {"showToast": [{"msg", "type"}, …]}` carries the same list. T6 reads the header, so htmx and fetch share one path.
  - A missing or foreign id is `done` and changes nothing.
  - An expired session answers 401 (JSON branch in `main.py`), not a redirect.
- **htmx trigger shape.** A list under `showToast` reaches listeners as `event.detail = {value: [...]}`: htmx wraps non-objects (verified in `htmx.min.js`). An object arrives as itself.
- **Mirrored pairs change together.** `sidebar.html` (with its `<style>` block) and `sidebar()` / `SIDEBAR_STYLE` in `offline/templates.js` change in the same task, and the drift test must be green. No snapshot partial changes in s3: no `OFFLINE_TEMPLATE_VERSION` bump, and the online partial goldens stay untouched.
- **Kept hooks (contract).** The sidebar keeps all of these:
  - ids: `#sidebar`, `#sidebar-rail`, `#sidebar-full`, `#sidebar-chat-btn`, `#full-menu-container` (now the account menu wrapper, see T3);
  - nav rows: `.nav-item` with `hx-get`/`hx-target="#article-list"`/`hx-push-url="false"`, `span.flex-1` titles, `data-nav-title`;
  - mark-read rows: `.mark-read-row` + `[data-action="mark-read"]`;
  - collapsing: `.collapse-toggle[data-collapse]`, `.collapsible#collapse-*`;
  - badges and errors: `saved-count-*`, `label-badge-*` / `label-badge-all`, `feed-badge-*`, `feed-error-*`, `.ai-error-badge`. `app/partials/badges.html` itself is unchanged (`.mark-read-badge.rounded-full` is selected by `offline.spec.mjs`, and `_badge_html` mirrors it);
  - data attributes: `data-auto-advance`, `data-rf-online-only`, `data-rf-slot="offline-status"`, `data-action="toggle-sidebar-pin"`, `data-action="open-search"`;
  - the logout form, opening tag exactly `<form method="POST" action="/logout" data-rf-logout>` in `user_menu_items.html` (`test_logout_unchanged.py` reads the source);
  - widths: `#sidebar` stays 240 px (`w-60`) open and 48 px (`w-12`) collapsed, so the list and detail panes keep their x and width.
- **Generated files have single owners, as in s2.** Nearly every task changes the inputs of these files, so tasks in waves 1–2 do not keep them:
  - `docs/ui-dom-contract.md` and `backend/tests/fixtures/dom_contract/*.html`: committed by s3-T10 (first regeneration after waves 1–2) and s3-T11 (final). Before that, a task runs `CONTRACT` to see its own diff, lists the selectors it adds or removes in its report, then restores both paths (`git checkout -- docs/ui-dom-contract.md backend/tests/fixtures/dom_contract`). Its full `PY` run deselects `tests/test_dom_contract_pages.py`, which reports stale fixtures until T10.
  - **For the orchestrator's verifier:** from the first wave-1 merge until s3-T10, `node scripts/check-dom-contract.mjs` and `tests/test_dom_contract_pages.py` are expected red on the integrated tree. They are not a reason to return a task; T10 turns them green.
  - `backend/app/static/css/tailwind.css`: written only by s3-T11. Before that, a task that builds CSS writes to `$(mktemp -d)`, or restores the committed file before its report.
  - The offline drift goldens are not in this group: only s3-T3 changes a mirrored partial, and it owns `backend/tests/fixtures/offline_drift/sidebar-*`.
- **Layout exemptions.** A task that moves boxes on a key screen on purpose adds `tests/visual/layout-allow/<task>.json` (one file per task), with a reason for each entry (README in that folder).
- **CSP unchanged** (`main.py` security headers): `script-src 'self' 'nonce-…'`, no inline handlers, no `hx-on`, no `js:`, no trigger filters (`changed`/`delay:` modifiers are fine).
- **Workers:**
  - no commits;
  - at most 6 new test functions per task unless the task says otherwise;
  - stop after 3 failed approaches;
  - out-of-scope findings go into the report as "noticed" lines;
  - selectors a task adds or removes are listed in its report.
- **Test environment:**
  - `npm test` / `node --test` need `TMPDIR=/var/tmp` (`/tmp/.gitignore` makes Tailwind skip scratch sources).
  - Backend tests:
    ```
    cd backend && SECRET_KEY=ci-test-secret-key-0123456789abcdef \
      ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd \
      DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4250/<throwaway> \
      uv run pytest -q <files>
    ```
    `<throwaway>` is a database the worker creates on dev-pg (for example `rf_s3_t4_<rand>`), migrates (`cd backend && DATABASE_URL=… uv run alembic upgrade head`) and drops afterwards. Never use `readfine_test` or `readfine_e2e` on dev-pg. Note on the test setup (`backend/tests/conftest.py`): the app runs with a null lifespan, so `app.database.engine` is `None` in tests; DB tests build their own engine from `app_settings.database_url`; the `client` fixtures override `get_current_user` and `get_db`; CSRF is enforced only when a `session` cookie is present.
  - e2e and visual need a throwaway Postgres container on `127.0.0.1:4253` with a database named exactly `readfine_e2e`, passed as `E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e`. The container is removed afterwards.
  - CSS build: `node scripts/build-css.mjs` (what `npm run build` runs after vendoring).
  - Never touch production (`/opt/readfine`, container `readfine-app-1` on :4200), never log in to it, and never run git writes in `/projects/readfine/src`.
- **Commands used below:**
  - `JS <file>`: `TMPDIR=/var/tmp node --test tests/js/<file>`.
  - `PY <files>`: the backend command above.
  - `DRIFT`: `(cd backend && RF_UPDATE_GOLDENS=1 <PY env> uv run pytest -q tests/test_offline_drift.py) && JS offline-drift.test.mjs`.
  - `CONTRACT`: `(cd backend && RF_UPDATE_GOLDENS=1 <PY env> uv run pytest -q tests/test_dom_contract_pages.py) && node scripts/check-dom-contract.mjs --write && node scripts/check-dom-contract.mjs`. Expected: exit 0. Review the diff (`git diff docs/ui-dom-contract.md backend/tests/fixtures/dom_contract`): the task's own selectors and pages change as intended. In wave 2 the diff also carries wave 1's changes, which are not the task's to judge. Tasks before s3-T10 then restore both paths (see "Generated files").

## Review Focus

1. **Back/forward right after a delete does not show the deleted row.** → T6 `pending: sent keys hide re-rendered rows after reload`.
2. **Two deletes pending when the tab closes reach the server in one request.** → T6 `pending: beforeunload sends both in one keepalive request`.
3. **An expired session during a flush is a failure, not success.** A followed redirect, 401, 403 and 429 all restore the row. → T6 `pending: failed responses restore rows`; T4 `deletes: unauthenticated gets 401 JSON`.
4. **Concurrent batches for one user run one after the other, and the lock is released.** → T4 `deletes: concurrent batches are serialised`.
5. **The palette shows clear states:** no results, a server error, offline. → T7 node tests; T11 e2e (`page.route` forces 500).
6. **Focus is trapped in the palette and the shortcuts dialog** (native modal `<dialog>`) and returns to the opener. The phone sidebar sheet moves focus in and makes the panes inert. → T7, T8, T9, T11.
7. **No inline handler reaches the page from toasts.** → T5 `toast: no onclick attribute`; T11 e2e listens for `securitypolicyviolation`.
8. **The offline sidebar equals the online one** within the adapter's listed differences. → T3 drift goldens.
9. **Every shortcut still works.** ⌘K is handled before the modifier early return. → T9 keyboard test.
10. **`/` no longer loses offline search.** "Advanced search…" opens the old modal, which the worker still serves offline. → T7 node test; T11 offline e2e.

## File map

Hand-edited files, one owner per wave. A file may have a later owner in a later wave.

| File | W1 | W2 | W3 | W4 |
|---|---|---|---|---|
| `templates/ui/{forms,display,overlay,nav,readfine}.html`, `static/js/ui/dialog.js`, `static/js/ui/motion.js`, `tests/js/motion.test.mjs`, `backend/tests/test_ui_macros.py` | T1 | | | |
| `backend/app/ui_fragments.py`, `routers/web/admin.py`, `routers/web/app/{articles,catchup}.py`, `routers/web/settings/{feeds,filters,scrape}.py`, `styles/tokens.css`, `templates/settings/partials/{feeds_list,feeds_stats,ai_cost_table}.html`, `templates/settings/{opml,tokens,stats,labels}.html`, `tests/js/theme-tokens.test.mjs`, `backend/tests/test_ui_fragments.py` | T2 | | | |
| `templates/app/partials/{sidebar,user_menu_items}.html`, `templates/app/main.html`, `routers/web/app/shell.py`, `backend/app/templating.py`, `backend/app/themes.py` (new), `static/js/init.js`, `static/js/preferences.js`, `templates/settings/preferences.html`, `static/js/offline/templates.js`, `backend/tests/test_offline_drift.py`, `tests/js/offline-drift/adapters.mjs`, `backend/tests/fixtures/offline_drift/sidebar-*`, `tests/js/theme-bootstrap.test.mjs`, `backend/tests/test_app_themes.py` (new) | T3 | | | |
| `templates/app/partials/mobile_bars.html` (new in T3), `static/js/ui/shell.js` (new in T3), `tests/js/ui-shell.test.mjs` (new in T3) | T3 | T8 | T10 | |
| `templates/app/partials/palette.html` (new, placeholder in T3) | T3 | T7 | | |
| `templates/app/partials/shortcuts_dialog.html` (new in T3, moved markup) | T3 | T9 | | |
| `routers/web/settings/deletes.py` (new), `routers/web/settings/__init__.py`, `backend/app/main.py`, `backend/tests/test_settings_deletes.py` (new) | T4 | | | |
| `static/js/ui/toast.js` (new), `templates/dev/ui.html`, `tests/js/ui-toast.test.mjs` (new) | T5 | | | |
| `static/js/app.js` | T5 | T9 | T10 | |
| `templates/base.html` | T5 | T6 | T10 | |
| `static/js/ui/pending.js` (new), `tests/js/ui-pending.test.mjs` (new) | | T6 | | |
| `routers/web/app/palette.py` (new), `routers/web/app/__init__.py`, `templates/app/partials/palette_results.html` (new), `static/js/ui/palette.js` (new), `static/js/offline/router.js`, `backend/tests/test_palette.py` (new), `tests/js/ui-palette.test.mjs` (new) | | T7 | | |
| `templates/app/partials/shortcuts.html` | | T9 | | |
| `tests/js/keyboard-shortcuts.test.mjs` | | T9 | T10 (only if a moved function needs the new loader) | |
| `tests/visual/layout-allow/s3-T<n>.json` | one file per task (T3, T8; T11 adds its own) | | | |
| `tests/js/harness.mjs`, `README.md`, `CLAUDE.md`, `CHANGELOG.md` | | | T10 | |
| `backend/app/static/css/tailwind.css`, `tests/e2e/shell.spec.mjs` (new), `tests/visual/layout.mjs` (`KEY_STRUCTURE` only, if a shell id changed), `tests/visual/gallery-pages.mjs` (account-menu shot, only if no hook exists) | | | | T11 |
| generated: `docs/ui-dom-contract.md`, `backend/tests/fixtures/dom_contract/*` | (checked and restored) | (checked and restored) | T10 | T11 (final) |

Task ids run s3-T1 … s3-T11 without gaps. The batch route is s3-T4, toasts s3-T5, the delayed-delete client s3-T6, the palette s3-T7, the tab bar s3-T8 and keyboard/shortcuts s3-T9.

## Tasks

| Wave | Tasks |
|---|---|
| 1 | T1, T2, T3, T4, T5 |
| 2 | T6, T7, T8, T9 |
| 3 | T10 |
| 4 | T11 |

---

### Task s3-T1: Macro, motion and dialog fixes (C3 macro half, C5, C6c, C8)

**Size** M · blocked_by: —

**Files:** `backend/app/templates/ui/{forms,display,overlay,nav,readfine}.html`, `backend/app/static/js/ui/motion.js`, `backend/app/static/js/ui/dialog.js` (only if C6c needs it), `backend/tests/test_ui_macros.py`, `tests/js/motion.test.mjs`, `tests/js/ui-dialog.test.mjs` (only with C6c).

**Changes:**
- **C8, URL schemes.** A shared check in `forms.html`, used by `render_attrs` for the names `href`, `src`, `action`, `formaction`, and by every macro parameter that writes one (`button`/`icon_button`/`badge` `href`, `_menu_items`/`_command_items`/`_sidebar_items` `href`, `feed_icon` `src`, `article_row` `href`).
  - Allowed:
    - relative values (no `:` before the first `/`, `?` or `#`);
    - `http:`, `https:`, `mailto:`;
    - for `src` also `data:image/`.
  - Leading whitespace and case are ignored.
  - Anything else (`javascript:`, `data:text/html`, `vbscript:` …) drops the attribute. It does not raise: hrefs can be user data, such as feed site URLs.
- **C8, `style`.** `render_attrs` refuses a `style` name (raises `attrs_refuses_style`, like the `on*` rule). Existing callers pass none (grep at plan time: none in templates).
- **C5b.** `sidebar` in `nav.html` writes `data-breakpoint="{{ attrs.get('data-breakpoint', 768) }}"` and passes `"data-breakpoint"` in `render_attrs`'s skip list. An override then yields one attribute, not two.
- **C3, macro half.** `alert(live=true)` writes `role="alert"` for `destructive` and `warning`, and `role="status"` otherwise (`default`, `success`).
- **Public `command_items(items, prefix)`** in `nav.html`, a thin wrapper of `_command_items` for partials that render palette results (s3-T7). Document `data-force` in its docstring.
- **C5a.** `cap()` in `motion.js` caps every timing key: `duration`, `delay`, `endDelay`, function-valued forms, and per-keyframe `duration`/`delay` in array or object keyframes. The total is capped at `--t-slow`; reduced motion stays instant.
- **C6c, admin-nav overlay.** Verify by reading code, not in a browser: the `sidebar` macro, `dialog.js`, Basecoat's `sidebar.min.js`, plus a jsdom check in `ui-dialog.test.mjs` with the `admin-nav` markup. The question is whether opening the overlay sidebar below the breakpoint moves focus in and makes the page inert. If the fix fits in `nav.html` or `dialog.js`, do it with that one test. Otherwise report "defer to s8" with the evidence.

Steps:
- [ ] **RED** in `test_ui_macros.py`:
  - `macros: unsafe href and src schemes are dropped`, with parametrised `javascript:`, ` JaVaScRiPt:`, `data:text/html`, `vbscript:`. Each is gone; `/x`, `#a`, `https://e`, `mailto:a@b` and `data:image/png;base64,AA` on `src` are kept.
  - `macros: attrs refuses style`.
  - `macros: sidebar data-breakpoint override writes one attribute`.
  - `macros: live alert role follows the variant`.
  - `macros: command_items renders data-force items`.
- [ ] **RED** in `motion.test.mjs`: `motion: cap limits delay and keyframe durations` (a 5000 ms delay and a keyframe with `duration: 4000` end at ≤ `--t-slow`).
- [ ] Run `PY tests/test_ui_macros.py` and `JS motion.test.mjs`. Expected: the new tests fail.
- [ ] **GREEN:** implement.
- [ ] Run `PY tests/test_ui_macros.py tests/test_dev_ui.py tests/test_csp.py`, `JS motion.test.mjs`, `JS ui-dialog.test.mjs`. Expected: all pass.
- [ ] Run the full `PY` suite once (`--deselect tests/test_dom_contract_pages.py`). It must stay green: restyled s2 pages call these macros.

Done: the tests above are green; no template passes `style` in `attrs`; the C6c verdict (fixed, or deferred with evidence) is in the report.

---

### Task s3-T2: Fragments through `alert_html`, token collisions, dark table dividers (C1, C2 router half, C3 Python half, C6b, C7)

**Size** M · blocked_by: —

**Files:** `backend/app/ui_fragments.py`, `backend/app/routers/web/admin.py`, `backend/app/routers/web/app/{articles,catchup}.py`, `backend/app/routers/web/settings/{feeds,filters,scrape}.py`, `styles/tokens.css`, `backend/app/templates/settings/partials/{feeds_list,feeds_stats,ai_cost_table}.html`, `backend/app/templates/settings/{opml,tokens,stats,labels}.html`, `tests/js/theme-tokens.test.mjs`, `backend/tests/test_ui_fragments.py`.

**Changes:**
- **C3, `alert_html`:**
  - return annotation `Markup`;
  - raises `ValueError` when both `text` and `title` are empty or whitespace;
  - docstring: "never pass a `Markup` built from user data; plain strings are escaped".
- **C3, `admin_test_smtp`:** the `try` wraps only `send_email`; the success fragment is rendered after it, so a render error is no longer logged as an SMTP failure.
- **C2, router half:** every **message-shaped** hand-built fragment in these files becomes `alert_html(...)` with the same text and status code:
  - `variant="destructive"` for errors and not-found;
  - `"warning"` for amber/yellow;
  - `"default"` for neutral empty states;
  - `live=True` when swapped in after load.

  The sites, found by grep at plan time; re-grep `HTMLResponse(` and inline `class=` strings:
  - `articles.py`: the eight "Article not found." / "Article has no URL." responses;
  - `filters.py`: three "Filter not found.";
  - `feeds.py`: three "Feed not found.";
  - `scrape.py`: four error divs;
  - `catchup.py`: the error and empty-state messages: "not available", "Invalid scope" (×3), the interrupted-briefing constant, "Could not generate digest" (×2), "Could not fetch articles", "No articles match…", "No main model configured…" (keep the link: pass `Markup('… <a href="/settings/ai" class="underline">Settings → AI</a>.')` built only from literal text, never from user data), the empty-name message, and the SMTP/AI/email-config messages near the end.

  **Not converted, deferred:**
  - catch-up's job spinner, cost-estimate spans and the prose wrapper (not messages; s6 rebuilds that page);
  - `app/ai.py` (fragments carry swap-target ids of the AI panel; s4);
  - `settings/ai.py` (inline statuses next to buttons and a textarea form fragment; s7).
- **C1, tokens.** In Paper and Graphite:
  - dark: `--rf-story-divide` ≠ `--rf-row-open`;
  - light: `--rf-story-divide` ≠ `--rf-row-hover` and ≠ `--rf-story-top`.

  Keep Neutral's ordering (dark: hover < open < divide < top, one step apart). Pick values from the theme's own gray scale.
- **C1, tables.** The six settings tables get a dark divider matching their dark borders (`dark:divide-gray-800` or the partial's existing dark border step) next to `divide-gray-100`.
- **C6b.** Label colour swatches get `aria-label="{{ name | capitalize }}"` and `aria-pressed` on the selected one. Check the swatch JS in `app.js` ("Color swatches") only reads `data-color`. Do not edit `app.js` (T5 owns it in this wave).
- **C7.** Remove the stale `// until s2-T21` exemption at the sibling-selector assertion in `theme-tokens.test.mjs`. Keep the assertion passing against the committed CSS.

Steps:
- [ ] **RED** in `test_ui_fragments.py`:
  - `fragments: alert_html returns Markup and refuses an empty body`;
  - `fragments: smtp render error is not reported as smtp failure` (monkeypatch `alert_html` to raise only for the success call; expect a 500 from the render, not the "Failed to send" fragment, and no "SMTP test" warning logged);
  - `fragments: not-found responses render the alert macro`, parametrised over one route per router file (articles, filters, feeds, scrape): `class="alert"` and the old text.
- [ ] **RED** in `theme-tokens.test.mjs`: `tokens: story divide differs from row open/hover/top in every theme and scheme`.
- [ ] Run `PY tests/test_ui_fragments.py` and `JS theme-tokens.test.mjs`. Expected: the new tests fail.
- [ ] **GREEN:** implement.
- [ ] Run `JS theme-tokens.test.mjs tailwind-build.test.mjs`, then the full `PY` suite (`--deselect tests/test_dom_contract_pages.py`). Expected: green; tests asserting the old texts still pass.
- [ ] Run `npm run -s check:sources`. Expected: no new colour or Tailwind 4 finding (contract result reported, not fixed here).

Done: the listed fragments use `alert_html`; deferrals named per file in the report; tests green.

---

### Task s3-T3: Sidebar, account menu and offline mirror (C1 reader shell, C4)

**Size** L · blocked_by: —

**Files:**
- Modify:
  - `backend/app/templates/app/partials/sidebar.html` and `user_menu_items.html` (now the account menu body);
  - `backend/app/templates/app/main.html`;
  - `backend/app/routers/web/app/shell.py` (only if context is needed);
  - `backend/app/templating.py` (one global);
  - `backend/app/static/js/init.js`, `static/js/preferences.js`, `templates/settings/preferences.html`;
  - `backend/app/static/js/offline/templates.js` (`sidebar()`, `SIDEBAR_STYLE`, `OFFLINE_STATUS_SLOT`);
  - `backend/tests/test_offline_drift.py` (sidebar cases), `tests/js/offline-drift/adapters.mjs`, `backend/tests/fixtures/offline_drift/sidebar-*.html`;
  - `tests/js/theme-bootstrap.test.mjs`.
- Create:
  - `backend/app/themes.py`;
  - `backend/app/templates/app/partials/{mobile_bars,shortcuts_dialog,palette}.html`;
  - `backend/app/static/js/ui/shell.js`;
  - `tests/js/ui-shell.test.mjs`;
  - `backend/tests/test_app_themes.py`;
  - `tests/visual/layout-allow/s3-T3.json`.

**Changes:**
- **`main.html`, pure moves first.** These moves free `main.html` for wave 2. The rendered HTML is byte-identical: check with `CONTRACT`, whose `main.html` fixture must not change from the move alone.
  - Move `#mobile-bottom-bar`, `#mobile-title-bar` and `#mobile-sidebar-backdrop` into `app/partials/mobile_bars.html`.
  - Move `#shortcuts-modal-overlay` into `app/partials/shortcuts_dialog.html`.
  - Add `app/partials/palette.html` holding only a Jinja comment ("filled by s3-T7").
  - Include all three where the markup was.
  - Add `<script src="{{ static_url('js/ui/shell.js') }}" defer></script>` in the `scripts` block.
- **Reader shell surface (C1, reader part).** `.app-shell` and `#sidebar` use tokens (`bg-sidebar`, `border-sidebar-border`; list and detail `bg-background`) instead of `bg-gray-50`/`bg-white`. Keep `w-60`, `w-12` and the `hx-*` attributes on `#sidebar`. `base.html`'s `<body class="bg-gray-50">` stays (deferred to s7, see the carry-over map).
- **Sidebar markup** (keep every hook in Global Constraints):
  - **Header:** wordmark; "+" `<a href="/settings/feeds#feed-url-input" aria-label="Add source" data-rf-online-only>`; search button `data-action="open-search"` with `kbd` "⌘K" (`ui/display.html` `kbd`); `#sidebar-chat-btn` (icon button, `aria-label="AI chat"`, when `chat_available`, as today); collapse button. The catch-me-up icon link leaves the header; the Assistant zone link replaces it.
  - **Read:** All articles, Starred, Saved, Archived, then Labels, Saved searches, Folders → feeds, restyled with `sidebar-*` tokens. The active state lives in the sidebar `<style>` block: `.nav-item.active` on `--sidebar-accent`.
  - **Zone links:** Sources, Assistant (`/app/catch-me-up` when `catchup_available`, else omitted), Settings. Plain links with `data-rf-online-only`.
  - **Footer:**
    - the account menu: `menu(id="account-menu", side="top", align="start", …)` from `ui/overlay.html` with a caller block, wrapped in `<div id="full-menu-container">`. The trigger shows the initial, the display name and the `.ai-error-badge`.
    - the offline status slot, unchanged;
    - a refresh icon button `data-action="reload-list"` (wired by s3-T9) with `aria-label="Refresh"`.
  - **Rail:** the same entries as icon buttons with `aria-label`, plus "+" and search.
- **Account menu body (`user_menu_items.html`):**
  - group "Theme": three `role="menuitemradio"` buttons `data-rf-scheme="light|dark|system"`;
  - group "App theme": one `menuitemradio` per entry of the `app_themes` global, `data-rf-app-theme="<id>"`;
  - `role="menuitemcheckbox" data-rf-offline-menu` "Offline reading", hidden when offline mode is unsupported;
  - separator; Settings, Sources, Admin (admins only), Send feedback (`data-action="open-feedback-modal"`, as today), Keyboard shortcuts (`data-action="open-shortcuts"`, wired by T9), Help;
  - separator; the logout form (`form[data-rf-logout]`, submit button `role="menuitem"`);
  - the version line.

  Items needing the server keep `data-rf-online-only`.
- **C4, one source per runtime plus a parity test.** A single literal list across Python, JS and CSS is impossible without a build step.
  - `backend/app/themes.py`: `APP_THEMES = (("neutral", "Neutral"), ("paper", "Paper"), ("graphite", "Graphite"))`, `DEFAULT_APP_THEME = "neutral"`, registered as the Jinja global `app_themes`. The preferences radios and the account menu loop over it.
  - `init.js` keeps its `APP_THEMES` and exposes `window.RFTheme = { APP_THEMES: [...ids], appTheme(), colorScheme(), setAppTheme(name), setColorScheme(scheme) }`. `setColorScheme` moves from `preferences.js` (`applyColorScheme`) into `init.js`. `window.setAppTheme` stays as an alias.
  - `preferences.js` uses `RFTheme` for both pickers.
  - `test_app_themes.py` asserts that `themes.py`, `init.js`'s `APP_THEMES` literal and the `[data-rf-theme="…"]` blocks in `styles/tokens.css` name the same ids.
- **`ui/shell.js`** (`window.RFShell`):
  - delegated clicks on `[data-rf-scheme]` → `RFTheme.setColorScheme`, and `[data-rf-app-theme]` → `RFTheme.setAppTheme`;
  - `aria-checked` synced on load, after a `#sidebar` swap and on menu open;
  - `[data-rf-offline-menu]` calls `RFOffline.page.current().enable()` / `.disable()`. It reflects `.state.enabled`, is hidden when no controller exists, and notes the result with `window.showToast` when present. Do not edit `offline/page.js`; parallel offline work wins conflicts there.
  - One rule for sidebar refreshes: while the account menu is open (`#account-menu-trigger[aria-expanded="true"]`), `htmx:beforeRequest` on `#sidebar` calls `preventDefault()` for any trigger and records that one was dropped. When the menu closes, `shell.js` fires one `sidebarRefresh` on `body` if anything was dropped.
- **Offline mirror.** `sidebar()` renders the same structure. Differences are listed in the adapter with reasons:
  - the account menu has no Admin or feedback item offline;
  - the zone links and "+" are `data-rf-online-only`;
  - the theme and offline items work offline.

  The drift goldens are regenerated with `DRIFT`.
- **Layout exemptions** (`s3-T3.json`, screens `list` and `article`): `#sidebar*`, `.nav-item*`, `#full-menu*`, `#account-menu*`, `#collapse-*`, `#saved-count-*`, `#label-badge-*`, `#feed-badge-*`, `#feed-error-*`. Reason: "s3 sidebar restyle (zones, account menu)".

Steps:
- [ ] **RED:**
  - `test_app_themes.py`: `themes: python, init.js and tokens.css name the same app themes`; `themes: preferences and account menu render every theme`.
  - `ui-shell.test.mjs` (own small JSDOM loader, like `theme-bootstrap.test.mjs`; load `init.js` then `shell.js`): `shell: theme items set scheme and app theme and mark aria-checked`; `shell: offline item calls enable/disable on the page controller`; `shell: a sidebar refresh while the account menu is open is dropped and fired once on close`.
  - `theme-bootstrap.test.mjs`: `theme: RFTheme.setColorScheme persists and toggles .dark`.
- [ ] Run `PY tests/test_app_themes.py`, `JS ui-shell.test.mjs theme-bootstrap.test.mjs`. Expected: fail.
- [ ] **GREEN:** the moves (check `CONTRACT` shows no `main.html` fixture change), then the markup, `themes.py`, `RFTheme`, `shell.js` and the mirror.
- [ ] Run `DRIFT`. Expected: the regenerated `sidebar-*` goldens differ only as intended, and the node half passes.
- [ ] Run `JS keyboard-shortcuts.test.mjs mark-read-on-scroll.test.mjs offline-mirror.test.mjs offline-page.test.mjs offline-router.test.mjs offline-worker-nav.test.mjs story-unfold.test.mjs` and `PY tests/test_offline_drift.py tests/test_offline_page_shell.py tests/test_logout_unchanged.py tests/test_welcome_onboarding.py tests/test_app_themes.py`. Then run the full `PY` suite with `--deselect tests/test_dom_contract_pages.py`, then `CONTRACT` (check, then restore). Expected: green.

Done:
- the new sidebar renders online (`/htmx/sidebar`) and offline (`sidebar()`) with the drift test green;
- the account menu switches scheme, app theme and offline mode;
- every kept hook is present (contract check green);
- `tailwind.css` is untouched.

---

### Task s3-T4: Batch delete route `POST /settings/deletes`

**Size** L · blocked_by: — (up to 8 new tests)

**Files:** create `backend/app/routers/web/settings/deletes.py`, `backend/tests/test_settings_deletes.py`; modify `backend/app/routers/web/settings/__init__.py` (include the router), `backend/app/main.py` (the JSON-401 path tuple in `auth_redirect_handler`).

**Interface:** the batch route contract in Global Constraints.

**Behaviour:**
- **Validation.** Pydantic: `kind` in `feed|label|filter`, `id` a positive int, 1–50 items. Anything else answers 422.
- **Lock, per user.** An async context manager `batch_lock(engine, user_id)` in `deletes.py` opens `async with engine.connect() as lock_conn`, runs `SELECT pg_advisory_lock(:ns, :uid)` with a module constant `DELETE_BATCH_LOCK_NS` and the user id (two-int form), and unlocks in `finally` (`pg_advisory_unlock`).
  - The route takes the engine from the request session: `bind = db.bind; engine = getattr(bind, "engine", bind)`. It does not use `app.database.engine`, which is `None` under the tests' null lifespan.
  - The lock sits on a separate connection because every delete service commits itself, which would release an `xact` lock after the first item.
- **Items,** one after the other on the request session (`db`), each in `try`:
  - feed: `unsubscribe(user, id, db)`. `ValueError` (not found or foreign) → `done`. A `ScopeCleanupResult.has_changes` adds one notice (`type: "warning"`), worded like `settings/partials/feeds_list.html`'s block, shortened to one sentence per category.
  - label: `delete_label(user, id, db)`. `None` → `done`. A non-empty list adds the notice worded as `routers/web/settings/labels.py` does ("Turned off N filter(s) whose only action was this label: …").
  - filter: `delete_filter(user.id, id, db)`. `False` → `done`.
  - Any other exception: `await db.rollback()`, log with the user id, kind and id, status `failed`, continue.
- **Response.** `JSONResponse` 200 `{results, notices}`, plus `HX-Trigger: json.dumps({"showToast": notices})` when there are notices.
- **CSRF** stays on (the middleware covers it). `main.py` adds `"/settings/deletes"` to the paths answered with a JSON 401 instead of the login redirect.

**Test setup.** Route tests use the conftest pattern: override `get_current_user` with a real user row and `get_db` with an `AsyncSession` on a test engine built from `app_settings.database_url`. Use **real commits** on the throwaway DB (unique emails per test, cleanup at the end), not the `session.commit = session.flush` pattern of `test_label_delete_filters.py`: the route's per-item `rollback()` would otherwise discard the whole test transaction. No `session` cookie, so CSRF does not apply; one test sets a session cookie to show a missing `x-csrftoken` is refused (403).

Steps:
- [ ] **RED** in `test_settings_deletes.py`:
  - `deletes: mixed batch deletes each item and reports done`;
  - `deletes: foreign and missing ids are done and change nothing` (a second user's feed, label and filter survive);
  - `deletes: a failing item does not undo the others` (monkeypatch `delete_filter` to raise for one id);
  - `deletes: unsubscribing both feeds of a filter scope leaves the filter deactivated and not pointing at a deleted feed`;
  - `deletes: notices come back as a list under showToast` (two notices, header JSON equals body `notices`);
  - `deletes: unauthenticated gets 401 JSON` (no redirect), and with a session cookie but no `x-csrftoken` the answer is 403;
  - `deletes: malformed body is 422`;
  - `deletes: concurrent batches are serialised`, on the helper directly: two tasks under `asyncio.gather` each enter `batch_lock(engine, uid)`, record enter/exit and sleep 0.2 s inside; assert no overlap. A third task with another uid is not blocked. Afterwards `pg_try_advisory_lock(ns, uid)` from a fresh connection returns true. Plus one route-level assertion, via monkeypatch, that the route runs its items inside `batch_lock`.
- [ ] Run `PY tests/test_settings_deletes.py`. Expected: fail (404 route).
- [ ] **GREEN:** implement.
- [ ] Run `PY tests/test_settings_deletes.py tests/test_label_delete_filters.py tests/test_csp.py`, then the full `PY` suite (`--deselect tests/test_dom_contract_pages.py`). Expected: green.

Done: tests green; the existing `DELETE` routes are untouched; the module docstring explains the separate lock connection.

---

### Task s3-T5: Toasts on Basecoat's toaster (C5c, owner Q1 recommendation)

**Size** M · blocked_by: —

**Files:** create `backend/app/static/js/ui/toast.js`, `tests/js/ui-toast.test.mjs`; modify `backend/app/static/js/app.js` (the `showToast` block, the `showToast` listener, the `htmx:responseError` trigger check, `_showShareToast`), `backend/app/templates/base.html`, `backend/app/templates/dev/ui.html` (demo button for an Undo toast).

**Interface (`window.RFToast`):**
- `show({msg, type = 'info', action = null, duration})` returns a handle `{el, update({msg, type, action}), close()}`.
  - `type` maps `ok`→`success`, `error`, `warning`, `info`.
  - `action` is `{label, onClick}` or `null`.
  - `duration` in ms; `-1` keeps the toast until closed; the default is Basecoat's (3 s, 5 s for errors).
- `fromTrigger(value)` accepts `{msg, type}`, an array of them, or htmx's `{value: [...]}`, and shows each.

**Behaviour:**
- **Node.** `show` builds `div.toast[role][aria-atomic=true][data-category][data-duration] > div.toast-content > svg(icon) + section > h2` with `textContent`, plus an optional `footer > button.btn[type=button][data-toast-action]` with a listener. It appends the node to `#toaster` (created as `<div id="toaster" class="toaster" data-align="end">` if missing). Basecoat's `toast` registration initialises it: timers, pause on hover, close on footer click. `role` is `alert` for `error` and `status` otherwise. Icons are static SVG strings in `toast.js`, the same paths as Basecoat's.
- **Never emits `onclick`.** It never calls `toaster.toast()`.
- **`app.js`:**
  - `function showToast(msg, type)` stays global and delegates to `RFToast.show`. Without `RFToast` (JS failed to load) it does nothing.
  - The `showToast` listener calls `RFToast.fromTrigger(e.detail)`.
  - `htmx:responseError` parses `HX-Trigger` as JSON and claims the error only if the parsed object has a `showToast` key, or the plain-string header lists `showToast` as an exact comma-separated name. This replaces the regex.
  - `_showShareToast(msg)` calls `showToast(msg, 'ok')`.
- **`base.html`:** `{{ toast(align="end") }}` (import from `ui/overlay.html`) once before the scripts. Every page that loads `app.js` extends `base.html` (verified: only `base.html` includes `js/app.js`; `admin/base.html` extends it), so admin toasts are covered. Also add `<script src="{{ static_url('js/ui/toast.js') }}" defer></script>` after Basecoat's `toast.min.js` and before `app.js`.
- **Position.** An inline-style rule in `base.html` (in `@layer utilities`) places `.toaster` at `bottom: calc(var(--rf-bottom-inset, 0px) + 1rem)`. s3-T8 sets `--rf-bottom-inset` when the tab bar shows.

Steps:
- [ ] **RED** in `ui-toast.test.mjs` (JSDOM loading the vendored `basecoat.min.js`, `toast.min.js`, then `toast.js`):
  - `toast: text is set as text and role follows the type` (msg `<img src=x onerror=1>` stays text);
  - `toast: action runs its listener and no onclick attribute exists` (`#toaster [onclick]` is empty);
  - `toast: update drops the action and close hides the toast` (assert `aria-hidden="true"`: jsdom fires no `transitionend`, so the node is not removed);
  - `toast: fromTrigger shows an object, an array and htmx's {value: []}`.
- [ ] **RED** in `ui-toast.test.mjs` (harness `browser()` with `before` installing a stub `RFToast`):
  - `app: a showToast list trigger shows each notice`;
  - `app: responseError is claimed only for a real showToast key` (header `{"x":"showToast"}` is not claimed).
- [ ] Run `JS ui-toast.test.mjs`. Expected: fail.
- [ ] **GREEN:** implement.
- [ ] Run `JS ui-toast.test.mjs keyboard-shortcuts.test.mjs offline-page.test.mjs`, `PY tests/test_csp.py tests/test_dev_ui.py`, `CONTRACT` (check, then restore; `app-toast-*` leaves the contract). Expected: green.

Done: every toast in the app goes through `RFToast`; no `onclick` in toasts; the gallery shows an Undo toast.

---

### Task s3-T6: Delayed-delete client `ui/pending.js`

**Size** L · blocked_by: s3-T4, s3-T5 (up to 10 new tests)

**Files:** create `backend/app/static/js/ui/pending.js`, `tests/js/ui-pending.test.mjs`; modify `backend/app/templates/base.html` (one `<script src="{{ static_url('js/ui/pending.js') }}" defer>` after `toast.js`).

**Interface (`window.RFPending`, for s5 and s7):**
- **Markup:**
  - a trigger `button[data-rf-delete="<kind>:<id>"][data-rf-delete-label="…"]`;
  - every rendered row of that object carries `data-rf-delete-key="<kind>:<id>"`.

  A delegated click on the trigger calls `schedule`.
- **Functions:**
  - `schedule({kind, id, label})` returns the key;
  - `undo(key)`;
  - `flush(reason)`, where `reason` is `timer|nav|history|hidden|unload`;
  - `state(key)` returns `pending|sending|done|failed|undefined`.

**Behaviour** (Global Constraints, delayed delete):
- **`schedule`.** Hides the rows with that key (`hidden` attribute plus `data-rf-pending-delete`, per WR2-F2/F3) and shows `RFToast.show({msg: 'Deleted ' + label, action: {label: 'Undo'}, duration: -1})`. It starts a 10 s timer.
- **`undo`** (only while pending) removes the entry, unhides rows still in the DOM and closes the toast.
- **`flush`.**
  - Moves every pending entry to `sending`; each toast is updated to `Deleting <label>…` without action.
  - Writes the keys with `Date.now()` into `sessionStorage['rf.deletedKeys']`.
  - Sends one `fetch('/settings/deletes', {method:'POST', keepalive:true, credentials:'same-origin', headers:{'Content-Type':'application/json','x-csrftoken': <cookie csrftoken>}, body})`.
  - Flushes for `timer`, `nav` and `history` wait for a request in flight. `hidden` and `unload` send at once.
- **Success** is `r.ok && !r.redirected && JSON.results` is an array. Then:
  - each `done` item's toast reads `Deleted <label>` and closes after 3 s;
  - each `failed` item restores its rows, leaves `sessionStorage` and shows `Couldn't delete <label>` (`error`);
  - the notices come from `HX-Trigger` through `RFToast.fromTrigger(JSON.parse(header).showToast)`.
- **Failure:** anything else, meaning a network error, `r.redirected`, 401, 403, 429, 5xx or a non-JSON body. Every item of that request counts as failed.
- **Hide pass.** On `DOMContentLoaded` and every `htmx:afterSwap`, rows whose key is pending, sending or in `sessionStorage` (younger than 2 min) are hidden. Older keys are dropped.
- **Labels** go in through `textContent` only (inside `RFToast`).

Steps:
- [ ] **RED** in `ui-pending.test.mjs` (own JSDOM loader; stub `RFToast` recording calls; fake `fetch`; `node:test` mock timers):
  - `pending: undo restores the row and sends nothing`;
  - `pending: sent once after 10 s with csrf header, keepalive and JSON body`;
  - `pending: beforeunload sends both in one keepalive request`;
  - `pending: boosted navigation and beforeHistorySave flush` (`htmx:beforeRequest` with `detail.boosted`);
  - `pending: hidden tab removes Undo and reads Deleting…`;
  - `pending: sent keys hide re-rendered rows after reload` (new JSDOM with the same `sessionStorage` contents; and keys older than 2 min are dropped);
  - `pending: failed responses restore rows` (parametrised: redirected, 401, 403, 429, 500, network error, non-JSON);
  - `pending: a failed item restores only its row`;
  - `pending: notices from HX-Trigger are shown`;
  - `pending: a request in flight delays a timer flush, not an unload flush`.
- [ ] Run `JS ui-pending.test.mjs`. Expected: fail.
- [ ] **GREEN:** implement.
- [ ] Run `JS ui-pending.test.mjs ui-toast.test.mjs` and `CONTRACT` (adds the `data-rf-delete*` / `data-rf-pending-delete` entries, verified as JS literals). Expected: green.

Done: tests green; nothing in production markup uses `data-rf-delete` yet (s5, s7); the API is documented in the file header.

---

### Task s3-T7: Command palette (route, results, client)

**Size** L · blocked_by: s3-T1, s3-T3, s3-T5

**Files:**
- Create:
  - `backend/app/routers/web/app/palette.py`;
  - `backend/app/templates/app/partials/palette_results.html`;
  - `backend/app/static/js/ui/palette.js`;
  - `backend/tests/test_palette.py`, `tests/js/ui-palette.test.mjs`.
- Modify:
  - `backend/app/routers/web/app/__init__.py`;
  - `backend/app/templates/app/partials/palette.html` (T3's placeholder);
  - `backend/app/static/js/offline/router.js` (`featureOf` only).

**Server:**
- `GET /htmx/palette?q=` (`get_current_user`):
  - `q.strip()` shorter than 2 characters → empty 200 body;
  - otherwise `palette_results.html` with up to three `role="group"` sections, empty ones omitted:
    - Articles: `list_articles(user, db, q=q, search=True, limit=8)`;
    - Saved searches: name contains `q`, case-insensitive, ≤ 5;
    - Feeds and folders: from `list_user_feeds`, title or folder name contains `q`, ≤ 8.
- Items go through `command_items` (T1) with `attrs={"data-force": true, …}`:
  - articles: `href="/app?open_article_id=<id>"`;
  - saved searches, feeds, folders: `data-rf-nav="/htmx/articles?…"`, the same URLs the sidebar's `.nav-item`s use.

**Markup (`palette.html`):**
- `command_palette(id="rf-palette", label="Command palette", placeholder="Search articles, feeds, actions…")` with a caller block:
  - an empty `<div role="group" id="rf-palette-results" aria-live="polite">`;
  - a static group "Actions":
    - "Add source" (link);
    - "Mark all as read in this view" (`data-action="mark-all-read"`);
    - Theme light / dark / system (`data-rf-scheme`);
    - one item per app theme (`data-rf-app-theme`, from `app_themes`);
    - "Offline reading" (`data-rf-offline-menu`);
    - "Toggle sidebar" (`data-action="toggle-sidebar-pin"`);
    - "Keyboard shortcuts" (`data-action="open-shortcuts"`);
    - "Advanced search…" (`data-rf-palette-advanced`, `data-force` so the filter never hides it);
  - a static group "Go to": All articles, Starred, Saved, Archived (`data-rf-nav`), Sources, Assistant, Settings (links).
- `<script src="{{ static_url('js/ui/palette.js') }}" defer></script>` at the end of the partial.

**Client (`window.RFPalette`):**
- **`open(prefill)`.** Remembers the focused element, calls `showModal()` and focuses the input. Close restores focus.
- **`isOpen()`.**
- **Input.** Debounced 200 ms, it fetches `/htmx/palette?q=` with `HX-Request: true` through an `AbortController`; stale responses are dropped by a sequence number.
  - On 200: `#rf-palette-results.innerHTML = body`, `htmx.process`, then the `.command` element's `refresh()`.
  - A `HX-Redirect` header navigates.
  - On error: `<p data-rf-palette-state="error">Search failed. Try again.</p>`.
  - Offline: the worker's `data-rf-needs-connection` body or the `X-Readfine-Offline` header shows `Search needs a connection. Advanced search works offline.`
  - No results at `q.length ≥ 2`: `data-empty` from the macro, plus "Advanced search…" staying visible (`data-force`).
- **`[data-rf-nav]` click** clicks the matching `#sidebar .nav-item[hx-get="<url>"]`, else falls back to `htmx.ajax('GET', url, {target: '#article-list', swap: 'innerHTML'})`.
- **"Advanced search…"** closes the palette and calls `window.openSearchModal(input.value)`.
- **Other items** (`data-action`, `data-rf-scheme` …) are handled by their owners' delegated listeners (`app.js`, `shell.js`); `command.js` closes the dialog.
- **`router.js`:** `featureOf` maps `/htmx/palette` to `'Search'`.

Steps:
- [ ] **RED** in `test_palette.py`:
  - `palette: groups and limits`;
  - `palette: short query is empty`;
  - `palette: another user's feeds and searches do not appear`;
  - `palette: titles are escaped and items carry data-force`.
- [ ] **RED** in `ui-palette.test.mjs` (own JSDOM loader; dialog polyfill as in `ui-dialog.test.mjs`; stub `fetch`):
  - `palette: typing quickly sends one request and drops stale answers`;
  - `palette: error and offline answers show their state`;
  - `palette: results refresh the command list`;
  - `palette: Advanced search opens the search modal with the query`;
  - `palette: nav items click the sidebar entry`;
  - `palette: focus returns to the opener on close`.
- [ ] Run `PY tests/test_palette.py`, `JS ui-palette.test.mjs`. Expected: fail.
- [ ] **GREEN:** implement.
- [ ] Run `JS ui-palette.test.mjs offline-router.test.mjs offline-worker-handle.test.mjs`, `PY tests/test_palette.py`, then the full `PY` suite with `--deselect tests/test_dom_contract_pages.py`, then `CONTRACT` (check, then restore). Expected: green.

Done: the palette opens through `RFPalette.open()` (wired to keys by T9), finds articles, searches, feeds and folders, runs the static actions and shows the empty, error and offline states.

---

### Task s3-T8: Phone tab bar and sidebar sheet

**Size** M · blocked_by: s3-T3

**Files:** modify `backend/app/templates/app/partials/mobile_bars.html`, `backend/app/static/js/ui/shell.js`, `tests/js/ui-shell.test.mjs`; create `tests/visual/layout-allow/s3-T8.json`. Do **not** edit `app.js`, `base.html` or `main.html` (other owners this wave).

**Changes:**
- **Tab bar.** Replace `#mobile-bottom-bar` with `<nav id="tab-bar" aria-label="Main">` holding five labelled buttons and links (icon plus text, `aria-current` on the active one):
  - Feed: `data-rf-tab="feed"`. `shell.js` acts in this order:
    - if a full-screen article is open, it closes it through `#mobile-detail-back-btn`;
    - else, if Feed is already the active tab, it reloads the current view by clicking the sidebar footer's `[data-action="reload-list"]`, so refresh stays one tap (it was one tap on the old bottom bar);
    - else it clicks the All articles `.nav-item`.
  - Search: `data-action="open-search"`.
  - Add: `<a href="/settings/feeds#feed-url-input" data-rf-online-only>`.
  - Assistant: `id="mobile-bottom-chat-btn"` when `chat_available` (reuses `attachGeneralChat`); else a link to `/app/catch-me-up` when `catchup_available`; else left out.
  - Folders: `data-action="toggle-sidebar-pin"`. On the small bucket `app.js` opens the overlay; its existing capture handler stays.
- **Title bar and backdrop** stay as they are; s4 redesigns the list header. The bottom bar's refresh moves to the sidebar footer (T3) and its quicklink stays on the title bar.
- **CSS** in a `<style>@layer utilities{…}</style>` block in `mobile_bars.html` (the same pattern as `sidebar.html`):
  - The tab bar shows on `html[data-bucket="small"]` in both sidebar modes. It is fixed at the bottom, `height: calc(var(--mobile-bar-h) + var(--sab))`, `background: var(--background)`, with a top border on `--border`.
  - It is hidden under `.mobile-detail-open` and `.story-detail-open`.
  - While it shows, `#article-list` gets bottom padding and `html` gets `--rf-bottom-inset`, which T5's toaster reads. In the default inline phone mode the article's `.article-bottom-bar` is in flow inside `#article-list` (`article_content.html`, `mt-3`), so that padding keeps it above the tab bar. Any further fix stays CSS-only: `article_content.html` is in the snapshot closure.
  - The open overlay `#sidebar` reads as a left sheet: shadow, `--sidebar` surface, a transform transition under `@media (prefers-reduced-motion: no-preference)`.

  `base.html`'s old `#mobile-bottom-bar` rules become dead (T10 removes them).
- **Sheet focus.** `shell.js` observes the `mobile-sidebar-open` class on `html`. On open it moves focus to the first `.nav-item` in `#sidebar-full` and sets `inert` on `#article-list` and `#article-detail`. On close it removes `inert` and returns focus to the Folders tab when that opened it.
- **Layout exemptions** (`s3-T8.json`, `list` and `article`): `#tab-bar*`, `#mobile-bottom-*`, `#mobile-bottombar-open-btn`. Reason: "phone tab bar replaces the scroll-up bottom bar".

Steps:
- [ ] **RED** in `ui-shell.test.mjs`:
  - `shell: Feed tab closes a full-screen article, reloads when already active, else opens All articles`;
  - `shell: opening the sidebar sheet moves focus in and makes the panes inert, closing restores both`;
  - `shell: tab bar marks the active tab`.
- [ ] Run `JS ui-shell.test.mjs`. Expected: fail.
- [ ] **GREEN:** implement.
- [ ] Run `JS ui-shell.test.mjs keyboard-shortcuts.test.mjs`, `PY tests/test_offline_page_shell.py tests/test_welcome_onboarding.py`, `CONTRACT` (check, then restore). Expected: green; the `mobile-bottom-*` ids stay listed, since `app.js` still names them until T10.

Done: a 390 px reader shows the five labelled tabs at all times, outside full-screen articles; each tab works.

---

### Task s3-T9: Keyboard: ⌘K, `/`, the shortcuts dialog and the shell actions

**Size** M · blocked_by: s3-T3, s3-T5

**Files:** modify `backend/app/static/js/app.js` (the keydown handler, `openShortcutsModal`/`closeShortcutsModal`/`_shortcutsOpen`/`_anyModalOpen`, the `data-action` delegation), `backend/app/templates/app/partials/shortcuts_dialog.html`, `backend/app/templates/app/partials/shortcuts.html`, `tests/js/keyboard-shortcuts.test.mjs`.

**Changes:**
- **Shortcuts dialog.** `shortcuts_dialog.html` becomes `dialog(id="shortcuts-dialog", title="Keyboard shortcuts")` from `ui/overlay.html`, with `shortcut_list()` inside. `shortcuts.html` adds `[["⌘K"], ["Ctrl+K"]]` → "Command palette" and renames `/` to "Command palette" (first group). `kbd` comes from `ui/display.html`. `help.html` picks the rows up unchanged.
- **Open and close.**
  - `openShortcutsModal()` calls `showModal()` on `#shortcuts-dialog` and `closeShortcutsModal()` calls `close()`.
  - `_shortcutsOpen()` reads `open`.
  - `_anyModalOpen()` also returns true for any `dialog[open]`, which covers the palette and Basecoat dialogs, so `_kbCovered` and Escape keep working.
- **Keydown:**
  - Before the modifier early return, `(e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'` without AltGraph → `preventDefault`, then `RFPalette.open()` (or `openSearchModal(false)` when `RFPalette` is absent). This works even from inputs, and closes the palette when it is already open.
  - `/` opens the palette the same way.
  - `?` and Esc unchanged in behaviour.
- **`data-action` delegation:**
  - `open-search` → palette (fallback: search modal);
  - `open-shortcuts` → `openShortcutsModal()`;
  - `mark-all-read` → `_kbMarkAllRead()`;
  - `reload-list` → `_kbReload()`.

Steps:
- [ ] **RED** in `keyboard-shortcuts.test.mjs`; replace the `? opens the list` test's overlay with `<dialog id="shortcuts-dialog">` plus the polyfill:
  - `⌘K and Ctrl+K open the palette, also from an input`;
  - `/ opens the palette, falling back to the search modal`;
  - `? opens the shortcuts dialog and Escape closes it`;
  - `an open dialog covers the reader` (`j` does nothing while `dialog[open]` exists);
  - `shell actions: open-search, open-shortcuts, mark-all-read, reload-list`.
- [ ] Run `JS keyboard-shortcuts.test.mjs`. Expected: the new tests fail.
- [ ] **GREEN:** implement.
- [ ] Run `JS keyboard-shortcuts.test.mjs mark-read-on-scroll.test.mjs story-overlay.test.mjs ui-toast.test.mjs` and `CONTRACT` (check, then restore). Expected: green; in the diff, `shortcuts-modal-overlay` leaves and `shortcuts-dialog` enters the contract.

Done: every shortcut of today passes its existing test; ⌘K, `/` and `?` work as specified; the sheet lists ⌘K.

---

### Task s3-T10: Shell code into `ui/shell.js`, dead code, theme-color meta, as-built docs (C6a)

**Size** M · blocked_by: s3-T6, s3-T7, s3-T8, s3-T9

**Files:** modify `backend/app/static/js/app.js`, `backend/app/static/js/ui/shell.js`, `backend/app/templates/base.html`, `tests/js/harness.mjs`, `tests/js/ui-shell.test.mjs`, `tests/js/keyboard-shortcuts.test.mjs` (only if a moved function needs the new loader), `README.md`, `CLAUDE.md`, `CHANGELOG.md`; generated and kept: `docs/ui-dom-contract.md`, `backend/tests/fixtures/dom_contract/*` (first regeneration after waves 1–2, via `CONTRACT`).

**Changes:**
- **Delete dead code** (null-guarded since T3/T8):
  - the "User menu" block (`toggleUserMenu`, the `full-menu-dropdown` outside-click listener, the `toggle-user-menu` action);
  - the `#mobile-bottom-bar` scroll show/hide IIFE;
  - the `mobile-bottom-refresh-btn` handler;
  - the `#mobile-bottom-quicklink` and `#mobile-bottombar-open-btn` selectors in the remaining handlers;
  - in `base.html`, the `#mobile-bottom-bar` rules and their dark variant.
- **Move to `ui/shell.js`** the self-contained shell blocks of `app.js`:
  - "Sidebar pin toggle";
  - "Sidebar collapsible sections";
  - "Sidebar mark-read button: long-press";
  - from "Mobile navigation": the overlay open/close, the `toggle-sidebar-pin` capture intercept and the backdrop.

  A block that reads private `app.js` state (`_saveNavSnapshot`, `_activeNavGet`, `_highlightNav`) stays and is listed in the report. Moved code keeps its behaviour and globals (`window._closeMobileSidebarOverlay`).
- **`harness.mjs`:** `browser(html, {before, scripts: ['ui/shell.js']})` also evals the named files after `app.js`. Tests of moved behaviour pass `scripts`.
- **C6a.** Delete the empty static `<meta name="theme-color">` in `base.html`. `init.js` creates it with a value; there is no empty meta before JS.
- **Docs:**
  - `README.md`: themes are now chosen in the account menu (Preferences keeps the full pickers); the palette and keys; the tab bar.
  - `CLAUDE.md` "CSS / Tailwind conventions":
    - toasts go through `RFToast` / `showToast`, never `toaster.toast()` with actions;
    - delayed delete markup (`data-rf-delete`, `data-rf-delete-key`) and `RFPending`;
    - palette results carry `data-force` and call `refresh()`;
    - shell behaviour lives in `ui/shell.js`;
    - the reader sidebar keeps its own `<aside>`, not Basecoat's `sidebar`;
    - fix the "body is `bg-gray-50`" line to say the reader shell uses tokens and other pages keep `bg-gray-50` until s7.
  - `CHANGELOG.md` `[Unreleased]`: "Changed: new sidebar with zones, add-source button, search and account menu (theme, app theme, offline)." "Added: command palette (⌘K / Ctrl+K or /)." "Changed: phone tab bar Feed · Search · Add · Assistant · Folders, always visible." "Changed: notifications use the new toasts."

Steps:
- [ ] **RED:** `grep -n "toggleUserMenu\|bottom-bar-visible\|mobile-bottom-refresh-btn" backend/app/static/js/app.js backend/app/templates/base.html`. Expected: matches. Then `grep -c 'name="theme-color"' backend/app/templates/base.html`. Expected: 1.
- [ ] **GREEN:** delete, move, update `harness.mjs` and the docs.
- [ ] Run the same greps. Expected: no matches, and `0`.
- [ ] Run `CONTRACT` and **keep** the result: T10 is the first task to commit the regenerated contract and fixtures. Then run `TMPDIR=/var/tmp npm test` and the full `PY` suite, no deselect. Expected: exit 0, `# fail 0`, passed. The `mobile-bottom-*`, `full-menu-dropdown`, `shortcuts-modal-overlay` and `app-toast-*` entries are gone; every wave 1–2 selector the task reports listed is present.

Done: `app.js` no longer holds the moved or dead shell code; tests green; docs describe the as-built shell.

---

### Task s3-T11: Regenerate CSS and contract; shell e2e flows; visual acceptance

**Size** L · blocked_by: s3-T1, s3-T2, s3-T4, s3-T10

**Files:** modify (generated) `backend/app/static/css/tailwind.css`, `docs/ui-dom-contract.md`, `backend/tests/fixtures/dom_contract/*`. Create `tests/e2e/shell.spec.mjs`. Modify `tests/visual/layout.mjs`: `KEY_STRUCTURE`'s 390 shell entry `{ key: '#mobile-bottom-bar', fields: ['x', 'w', 'h'] }` (verified, `shell390`) becomes `#tab-bar` with the same fields and a new `why`. Pass B then compares head `#tab-bar` with base `#mobile-bottom-bar`'s absence, so list that key in `s3-T11.json` with the reason "replaced by the tab bar". Add or adjust `tests/visual/layout-allow/s3-T11.json`, but only for boxes inside the sidebar, account menu or phone bars, each with a reason.

**`shell.spec.mjs`** (Chrome project, role and label selectors, seeded accounts from `tests/e2e/fixtures`):
- `palette: ⌘K opens, a search finds an article and opens it; an action runs (app theme)`;
- `palette: no results and a forced server error show their states` (`page.route('**/htmx/palette*', r => r.fulfill({status: 500}))`);
- `account menu: scheme and app theme persist across reload` (`html.dark`, `data-rf-theme`, `meta[name=theme-color]` equals the computed `--background`);
- `phone: tab bar at 390 — Folders opens the sheet with focus inside, Search opens the palette, Feed returns to All articles`;
- `toasts: an HX-Trigger notice and an Undo toast raise no securitypolicyviolation`. Collect `securitypolicyviolation` events via `page.addInitScript`; click Undo in a `RFToast.show({action})` toast.

Steps:
- [ ] Run `npm run build`. Expected: `vendor: … files` and a written `tailwind.css`. Then `O=$(mktemp -d) && cp backend/app/static/css/tailwind.css $O/a.css && node scripts/build-css.mjs && cmp $O/a.css backend/app/static/css/tailwind.css && echo deterministic; rm -r $O`. Expected: `deterministic`.
- [ ] Run `CONTRACT` and `DRIFT`. Expected: exit 0 and green; review the contract diff against the selectors the task reports listed.
- [ ] Run `npm run -s check:sources`. Expected: every check `OK`.
- [ ] Run `TMPDIR=/var/tmp npm test && (cd backend && <PY env> uv run pytest -q)`. Expected: `# fail 0`, `passed`.
- [ ] Run `E2E_DATABASE_URL=… npm run test:e2e -- --project=chrome`. Expected: passed, including `offline.spec.mjs`: the shell works offline with `shell.js`, `toast.js`, `pending.js` and `palette.js`; "Advanced search…" opens the offline search window.
- [ ] Run `E2E_DATABASE_URL=… RF_VISUAL_BASE=4ffd84e RF_VISUAL_MODE=layout npm run test:visual`. Expected: `layout: A <n>/<n> strict` and `B <n>/<n> structural`, exit 0. Only the `s3-*.json` exemptions apply; the list and detail panes keep x and width at 1280. A failure outside the sidebar and phone bars goes back to its task through return-to-repair.
- [ ] Run `E2E_DATABASE_URL=… RF_VISUAL_BASE=4ffd84e RF_VISUAL_MODE=gallery RF_VISUAL_DEBUG=1 RF_VISUAL_GALLERY_BASE=1 npm run test:visual`. Expected:
  - `gallery.html` with the base shots beside the head shots;
  - dark-patch probe `0` under Paper dark and Graphite dark;
  - the reader (`list`, `article`) at 1280 and 390, with the account menu opened in one extra shot per theme (add it to `gallery-pages.mjs` setup only if no hook exists; report it).

  Hand `test-results/visual-report/{layout.md,gallery.html}` and the PNGs to the orchestrator for the Result page.
- [ ] `npm run check:generated` compares with the commit, so the orchestrator runs it on the applied tree. Expected there: exit 0.

Done:
- all suites green;
- the layout gate passes with reasoned exemptions only;
- the gallery and dark-patch probe are clean;
- the e2e flows of design §6 for palette, theme, tab bar and toasts pass (delayed-delete flows: s5).

---

## Carry-over map (backlog "[ui-redesign] s2 carry", triaged 2026-11-22)

| Item | Where | Note |
|---|---|---|
| C1 story-divide collisions (Paper/Graphite) | s3-T2 | plus a pairwise-distinct token test |
| C1 `body bg-gray-50` vs bars | s3-T3 (reader shell on tokens); `base.html` body → **s7** | Changing the body recolours every page not yet redesigned without layout gain; s7 rebuilds the settings surface |
| C1 dark `tbody divide-gray-100` (six settings tables) | s3-T2 | |
| C2 router fragments: `app/articles.py`, `settings/{feeds,filters,scrape}.py`, `app/catchup.py` messages | s3-T2 | message-shaped fragments only |
| C2 `app/ai.py` fragments | **s4** | They carry the AI panel's swap-target ids; s4 rebuilds that panel |
| C2 `settings/ai.py` fragments | **s7** | Inline statuses beside buttons and a textarea form fragment; s7 rebuilds the AI provider page |
| C2 catch-up spinner, cost spans, prose wrapper | **s6** | Not messages; s6 rebuilds the page |
| C2 `partials/{feed_status,feed_display,error_text}.html` | **s5** (feeds list and edit), admin fetch-logs use **s8** | Restyled with their screens; no colour literal today (lint green) |
| C2 `partials/public_footer.html`, `app.js` admin-feeds toggle classes | **s8** | Public and admin redesign |
| C3 `alert_html` role, Markup, empty guard, docstring | s3-T1 (macro role), s3-T2 (Python) | |
| C3 `admin_test_smtp` render inside `try` | s3-T2 | |
| C4 app-theme list in four places | s3-T3 | One list per runtime plus a parity test (no build step can share one literal) |
| C5 `motion.js` `cap()` | s3-T1 | |
| C5 `nav.html` duplicate `data-breakpoint` | s3-T1 | |
| C5 Basecoat toast inline `onclick` under CSP | s3-T5 (never used), s3-T11 (browser check) | |
| C6 empty static `theme-color` meta | s3-T10 | |
| C6 label swatch names | s3-T2 | |
| C6 admin-nav overlay focus and inert | s3-T1 verify; fix there or **s8** with evidence | |
| C7 stale `// until s2-T21` | s3-T2 | |
| C8 macro URL schemes, `style` in `attrs` | s3-T1 | Lands before s4 |
| Owner decision: one toast system or two | Q1 (recommendation implemented in s3-T5) | |
| Backlog 9 (s5), 10 (taste), 12–15 (tooling, offline) | not s3 | unchanged |

## Open questions for the owner

1. **One toast system or two** (backlog 11). Recommendation: **one**. Basecoat's toaster CSS and container, driven by Readfine's `RFToast` builder: `showToast` and the share toasts all go through it; Basecoat's `toaster.toast()` JS is used only in the gallery. Reasons:
   - one place and one style for every notice;
   - the Undo button needs our own DOM anyway (CSP);
   - `_showShareToast` duplicates `showToast` with a different position and colour.

   s3-T5 implements this. If you choose two, the only change is to leave `_showShareToast` alone (one function).
2. **Phone "Collapsible" sidebar mode** (`sidebar_mode_small`). With an always-visible tab bar, the collapsed rail on a phone duplicates navigation. Recommendation: keep both modes working in s3 (tab bar in both), and retire "Collapsible" on the small bucket in s7, when Preferences is regrouped.
3. **"Top picks"** (§5.1) is not an existing view. Recommendation: drop it from the sidebar until s4's View menu decides whether a score-sorted view is a sort option or a nav entry.
4. **Palette scope.** Recommendation: reader page only in s3. Settings and Sources pages get it when they join the shell (s5/s7). Today they have no sidebar to host the search entry.
5. **Labels in the IA.** §5.1's tree leaves Labels out, but it is an existing view with per-label counts. Recommendation: keep it under Read (as planned).

## Risks to the design

- **R1, lock semantics (design §5.4 says `pg_advisory_xact_lock`).** `unsubscribe`, `delete_label` and `delete_filter` each `commit()`, so a transaction-level lock taken before the first item is released by that item's commit. s3-T4 uses a session-level lock on a dedicated connection, released in `finally`. The intent (no two batches of one user at once) holds; the cost is a second pool connection per batch. A pooled connection keeping a lock after an unhandled error is prevented by `finally` plus the test that re-acquires it.
- **R2, `/` changes meaning.** Today `/` opens the search modal, which also works offline. Afterwards it opens the palette, whose server results need a connection. Mitigation: "Advanced search…" (pinned to the offline state) and the title-bar Edit still reach the modal; T11 runs the offline e2e.
- **R3, Basecoat toasts.** Basecoat's toast API writes `onclick` for action and cancel buttons. Relying on it would break under the nonce CSP. Mitigation: s3-T5 builds nodes; T11 listens for CSP violations.
- **R4, `keepalive` on exit.** iOS Safari does not reliably fire `beforeunload`, hence `pagehide` and `visibilitychange`. Keys kept in `sessionStorage` make the failure direction safe: the object reappears after 2 minutes.
- **R5, sidebar refresh vs open menu.** `#sidebar` is re-swapped every 300 s and on `sidebarRefresh`, which would close an open account menu. Mitigation: s3-T3 skips the poll while the menu is open and re-fires deferred events on close.
- **R6, palette article open is a full page load** (`/app?open_article_id=`). This is correct in every layout and bucket, but slower than an in-list open. s4 can swap in the list's own open once rows are rebuilt.
- **R7, wave 2 runs four tasks** on `main.html`-adjacent partials. This is safe only because T3 moves the markup into partials first; if T3 slips, wave 2 waits.

## Verified vs assumed (at plan time, 2026-11-22, tree 4ffd84e)

**Verified in code:**
- **Paths:** `app/partials/sidebar.html` (446 lines) includes `user_menu_items.html`; `offline/templates.js` `sidebar()` / `SIDEBAR_STYLE` / `OFFLINE_STATUS_SLOT`; `app.js` 4856 lines; drift cases `sidebar-{rail,full,empty,style}`.
- **Phone bars:** the mobile bars, backdrop, search, feedback and shortcuts overlays are in `app/main.html`, not `base.html`; `#mobile-bottom-bar` CSS is in `base.html`.
- **Keyboard:** the keydown handler in `app.js` returns early on meta/ctrl; `/` opens the search modal; `?` toggles `#shortcuts-modal-overlay`, pinned by `keyboard-shortcuts.test.mjs`.
- **Test harness:** `tests/js/harness.mjs` evals only `app.js`.
- **Toasts:**
  - `showToast` is defined in `app.js` with inline styles; `_showShareToast` is a separate one; `showToast` is called globally from `share-target.js` and `catchup.js`.
  - The `showToast` triggers in routers are JSON (`utils/htmx.py`, `articles.py`, `shell.py`, `admin.py`, `saved_searches.py`; `offline/router.js` too).
  - `htmx:responseError` detects `showToast` with a regex.
  - htmx wraps non-object trigger values as `{value: …}`; `htmx:beforeRequest` detail has `boosted`.
- **Basecoat:** `toast.min.js` writes `onclick` for action and cancel. `command.min.js` honours `data-force` and exposes `refresh()`.
- **CSP** is set in `main.py`'s security-headers middleware.
- **Delete flows:**
  - `POST /settings/deletes` does not exist. No advisory locks exist anywhere.
  - The existing delete routes are: settings feeds, labels, filters, folders (`DELETE`); saved searches (`POST …/delete`); catch-up configs; AI chat; admin users, invitations and feeds.
  - The design covers feeds, labels and filters; folders and the others keep their current deletes.
  - `unsubscribe`, `delete_label` and `delete_filter` each commit internally.
- **Auth:** the JSON-401 branch is the path tuple in `auth_redirect_handler` (`main.py`).
- **Offline:** unknown `/htmx/*` paths get `needsConnection`; offline mode is toggled through `RFOffline.page.current().enable/disable`; colour scheme has no global setter (it lives in `preferences.js`).
- **Macros:** they accept no `style` today only by convention, and the C5b duplicate is real.
- **Visual harness:** its default base is `1d7f2f4`; `KEY_STRUCTURE`'s 390 shell entry names `#mobile-bottom-bar`. `/app` already passes `chat_available` and `catchup_available`. Only `base.html` loads `app.js`, and `admin/base.html` extends it. Tests run with a null lifespan, so `app.database.engine` is `None`. `test_logout_unchanged.py` pins the logout form tag in `user_menu_items.html`.

**Assumed (workers verify first):**
- Basecoat's `toast` registration initialises nodes appended by our code (its MutationObserver; T5's first test proves it).
- The seeded e2e accounts have enough articles for a palette hit.

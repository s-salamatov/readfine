# UI redesign s7 — Settings zone Implementation Plan

Status: plan / draft · 2026-11-26 · run `run-7429291d-8129-432b-beab-c61fff1112cd`, segment `s7` · product base `selfhost` `12cc961` (s1–s6 merged and deployed); inspected HEAD `af0007e` on `feat/ui-redesign-s7` (the commit after the base changes only the s6 handoff and track line).

**Goal:** regroup Settings into Reading & appearance, Relevance & filters, Labels, AI provider, Account and Stats under one sub-navigation (tabs on the phone), with immediate-save choices, delayed delete for labels and filters, "Filter from this source" in the article menu, the phone "Collapsible" sidebar mode retired, and the s6 carry closed.

**Architecture:** the Settings pages stay server-rendered under `settings/base.html`, rebuilt from the `templates/ui/` macros and tokens. One narrow `POST /settings/field` endpoint plus one client module, `ui/settings.js`, save enumerated choices immediately and roll back on failure. Number fields and the timezone keep a sticky Save. Two pages move (Preferences → `/settings/reading`; the Filters list merges into `/settings/relevance`). Their 308s and aliases go through the shipped moved-pages helper in one wave-2 wiring task. That task also adds the article-menu entry together with the offline snapshot bump to version 7. One last code task regenerates CSS and DOM-contract fixtures and runs the browser and visual acceptance; the as-built docs come last.

**Tech stack:** Python 3.12 / FastAPI, SQLAlchemy async, Jinja2, HTMX 2.0.4, Tailwind 4 (`scripts/build-css.mjs`), Basecoat 1.1.0 (vendored), anime.js through `RFMotion`, pytest, node:test + jsdom, Playwright 1.64.1 (Chrome `/usr/bin/google-chrome-stable`, WebKit). No new dependencies or migrations.

**Design:** `docs/arh-w-dev/designs/2026-11-19-ui-redesign-design.md` §5.1 (IA and regrouping table), §5.2 Settings, §5.4 (moved pages, delayed delete), §5.5 (contract, offline snapshots), §5.7 wave 7, §6, §8a. Read it with `specs/handoff-run-7429291d-8129-432b-beab-c61fff1112cd.md` (s3–s6 sections and "Backlog (carried)") and `/projects/readfine/specs/backlog.md` (s6 carry). The s5 and s6 plans are the format reference and define the interfaces reused here: `RFPending`, `POST /settings/deletes`, `MOVED_PAGES` and `register_moved_pages`, `/assistant` routes, `RFToast`.

**Execution:** `native`, as persisted for this run. Workers do not commit, push, stash, spawn agents, publish, approve or change run state. The orchestrator applies patches, runs checks and reviews, and owns approval.

## Changes from the draft, and decisions this plan makes

Compared with the draft (task/wave level, 2026-11-21), the design, the predecessor interfaces and the code at HEAD:

1. **URL scheme decided** (the draft and design never named paths; `register_moved_pages` maps path to path only, with identical parameters and no query or fragment):

   | Old | New | Methods kept as alias until s8 | Why |
   |---|---|---|---|
   | `/settings/preferences` | `/settings/reading` | GET 308, POST alias (full legacy form) | page renamed and regrouped; `page.js:1383` diagnostics link follows |
   | `/settings/preferences/hidden` | `/settings/relevance/hidden` | GET 308 | hidden stories move to Relevance & filters (design table) |
   | `/settings/filters` (list GET only) | `/settings/relevance` | GET 308 | Filters list merges into Relevance & filters; `POST /settings/filters`, `/settings/filters/new`, `/settings/filters/{id}/edit` and the filter actions keep their URLs |
   | `/settings/profile`, `/settings/tokens`, `/settings/labels`, `/settings/ai`, `/settings/stats`, `/settings/relevance` | unchanged | — | label change only; moving them would cost aliases for every profile action, the dormancy email link (`dormancy_service.py:306`), `ai.py:137` and many tests, for no user gain |

   `/settings` (index) now answers 303 to `/settings/reading`, the first item every user can see. Today it goes to Stats, or to `/sources` for a user without feeds.
2. **Tokens.** The design's IA tree lists Tokens as a separate item, while its regrouping table and the draft put it under Account. This plan follows the table: one nav item, **Account** (`/settings/profile`), with a secondary row *Profile · API tokens* (`/settings/tokens`). Six nav items in all: Reading & appearance, Relevance & filters, Labels, AI provider (only while `app_ai_enabled()`), Account, Stats. Below them are links Back to Read, Sources, Assistant and, for admins, Admin; Sources and OPML stop being Settings items because s5 made Sources its own zone.
3. **Immediate save versus sticky Save.** Every switch, radio and select of a server preference saves on change through `POST /settings/field`. The full-form `POST /settings/preferences` rewrites every field and reads a missing checkbox as off, so it is not reused (same reason as `/htmx/list-view`, `articles.py:694`). The timezone, which reschedules briefings, and the three number fields (articles per page, small and medium breakpoints) stay in one form with a sticky Save posting to `POST /settings/reading/save`. The full legacy handler stays at `POST /settings/reading` for stale tabs (alias from `/settings/preferences`) until s8.
4. **Story grouping moves with hidden stories.** The design moves "hidden stories" to Relevance & filters. Its counter only makes sense next to the `story_dedup` choice that produces it, so the whole Stories block (the choice, the counter and the list) moves there.
5. **Delayed delete is already built** (s3 `ui/pending.js` with kinds `feed|label|filter`; s3 `deletes.py` with the "Turned off N filters" label notice). s7 only switches the label and filter rows to `data-rf-delete` markup and removes their two-click `.swap-confirm`. The draft's separate T4 is folded into the page tasks. `.swap-confirm` and its `app.js` handler stay for token revoke, folders and admin (`test_restyle_admin_lists.py`, `test_sources_delete.py`).
6. **"Filter from this source"** (owner Q3, deferred to s7) and **retiring phone "Collapsible"** (s3 plan, owner question 2) were not in the draft; both are added. The menu item lives in the snapshot partial `article_detail.html`, so its task owns the full snapshot bump (6 → 7), which cannot wait for the final task.
7. **s6 carry for s7** (absent from the draft) becomes one task, s7-T6. The CLAUDE.md phone note and the CHANGELOG Fixed line go to the docs task.
8. **The draft's T5 (moved pages) and T6 (contract, CSS)** become s7-T7 (wiring, wave 2) and s7-T8 (sole regeneration owner). The draft's T7 (specs) becomes s7-T9 (README/CLAUDE/CHANGELOG plus the spec handoff to the orchestrator). The draft's "depends on s1–s3 only" is obsolete: s5's helper and Sources and s6's Assistant are consumed.
9. **Wording:** "Settings → AI" becomes "Settings → AI provider" wherever a task touches it (`ai.py`, `catchup.py`, `scrape.py`, `briefing_service.py`). `help.html` and `legal/privacy.html` belong to s8, and their links keep working.

## Global Constraints

Design requirements, verbatim:

- Every action available today is still reachable, in no more steps than today. Frequent ones (add source, summary, theme, offline, search) take one step.
- No CDN script; CSP unchanged; no `on*` attributes in templates (CI check).
- No hard-coded colours outside the token file, except the listed offline page (CI check).
- `prefers-reduced-motion: reduce` removes all movement, View Transitions included.
- HTMX stays the transport. The server renders partials. The client never builds article markup, except the offline mirror, which keeps doing so.
- old GET paths answer 308 to the new path with `Cache-Control: no-store`, so browsers do not keep the redirect and a revert works;
- old non-GET paths (forms and HTMX endpoints called from stale tabs or a cached offline shell) stay registered as aliases of the same handlers until wave 8, which removes them;
- hard-coded targets such as `RedirectResponse("/settings/feeds", 303)` (`feeds.py:459`, `filters.py:170`) move to the new path in the same wave;
- The toast text is set through `textContent`, never `innerHTML` (feed titles are user data).
- **Settings:** a left sub-navigation (tabs on the phone). Each page is built from Basecoat `field`, `switch`, `select` and `card`, with sticky save where forms need it. Most toggles save immediately with a toast.
- The device-specific offline toggle moves to the account menu; its full settings (storage size, diagnostics) stay under Reading & appearance → This device, which keeps the `[data-rf-offline-settings]` hook and the `#offline-diagnostics` anchor, and `page.js:1277` is pointed at the new URL in the wave that moves the page.
- Delete adds an entry `{key, url, label}` to the queue, hides the row (`data-rf-pending-delete`) and shows "Deleted <label> · Undo" for 10 s. … The two-click inline confirmation is removed.
- UI language stays English; localization goes to the backlog.
- Light/dark/system and the app theme stay per device (localStorage), as today.

Note on the list above: at HEAD the `page.js` line the design calls 1277 is `page.js:1383`.

Project rules (CLAUDE.md) and execution constraints:

- Components come from the `templates/ui/` macros; no hand-written Basecoat markup; no `on*` attributes; dialogs and sheets open with `data-rf-open`. HTML returned from Python uses `app/ui_fragments.py`. Tailwind 4 class names only; gray utilities stay `var(--color-gray-*)`; colour literals only in `styles/tokens.css`.
- **WR2-F2/F3:** an element carries exactly one of `hidden` or an unprefixed display class; a runtime toggle swaps both.
- **The snapshot closure is read-only except for s7-T7.** The closure (printed from `tests/test_offline_template_version.py::snapshot_closure` at HEAD, hash `60ff43c1c5f70e34`) is: `app/partials/{ai_blocks,archive_button,article_content,article_detail,article_meta_date,article_row,article_title,chat,error_bar,read_button,readable_progress,row_poll,saved_icons,score_badge,share_button,star_icon,story_block}.html` and `ui/{display,forms,nav,overlay,readfine}.html`. No task edits a `templates/ui/*` macro. s7-T7 alone edits `article_detail.html` and bumps to version 7. Any other need returns for an amendment.
- **Generated files have one owner, s7-T8:** `backend/app/static/css/tailwind.css`, `docs/ui-dom-contract.md` and `backend/tests/fixtures/dom_contract/*`. Earlier tasks must not run `npm run build` into the tree or `--write` the contract. Expected gaps until s7-T8: in waves 1 and 2, `tests/test_dom_contract_pages.py`, `tests/test_base_dark_controls.py` and `node scripts/check-dom-contract.mjs` may fail (stale fixtures and contract), and so may e2e and visual runs (not run there). One more expected gap in wave 1 only: `tests/test_moved_pages.py::test_sources_redirect_targets_and_navigation` asserts at its line 316 that `GET /settings` goes to `/sources` for a user without feeds; s7-T1 changes that target and s7-T7 (the file's owner) updates the assertion. Wave verifiers list these gaps by name, and nothing else is excused.
- `input.css` has one writer in s7: s7-T6. Settings pages use utility classes and tokens only; any Settings rule that cannot be a utility is reported to s7-T8 instead of being added.
- `app.js`, `base.html` and `init.js` belong to s7-T1 only. `settings/base.html` is s7-T1's; the page tasks consume its interface and do not edit it.
- The Settings pages are online-only (their links already carry `data-rf-online-only`). The offline router, policy, sync and IndexedDB stay unchanged. `ui/settings.js` checks offline state before sending.
- Preserve every hook other code binds. On Reading & appearance: `#install-app-row`, `#install-app-title`, `#install-app-hint`, `#install-app-btn`, `[data-rf-offline-settings]`, `#offline-enabled`, `[data-rf-offline-toggle]`, `[data-rf-offline-storage]`, `[data-rf-offline-note]`, `[data-rf-offline-remove]`, `#offline-diagnostics`, `[data-rf-offline-diagnostics]` with its `data-rf-app-version`/`data-rf-template-version`, `[data-rf-diag-action]`, `[data-rf-diag-launch]`, `[data-rf-diag-out]`, `[data-rf-offline-install-note]`, `input[name=color_scheme_device]`, `input[name=app_theme_device]`, `#detail-mode-small`, `select[data-layout-bucket]`. On Labels: `.color-swatch-group`, `.color-swatch[data-color][aria-pressed]`, `.color-custom-input`, `.color-custom-preview`, `data-clear-on-swap`. Also `#filters-list`, `#labels-list`, `#tokens-list`, `[data-rf-delete-account]`, `.copy-from-btn[data-copy-from]`, `data-mobile-nav`, `data-mobile-nav-active`. A rename goes with every consumer and is reported to s7-T8 for the contract.
- At most 5 new test cases per task (one listed exception, with its reason). Existing tests may be updated without weakening them. Stop after 3 failed approaches and report. Out-of-scope findings go in the report as "noticed" lines.
- S4W-F1 and S4W-F2 are not decided here: no change to mark-all confirmation or to the View menu groups.

### Test environment

Checks run under `/bin/sh -c` from the repository root (`/projects/readfine/ui-redesign`), with `uv` (`~/.local/bin`), `node`, `npx` and `docker` on `PATH`. Backend checks use the throwaway container `rf-int-pg-s3rb` on `127.0.0.1:4253`. Each check drops and recreates its own fixed database `rf_s7_<check>`, migrates it and runs pytest from `backend/`. Pattern (shown for s7-T1):

```sh
docker exec rf-int-pg-s3rb dropdb --if-exists --force -U readfine rf_s7_t1 && docker exec rf-int-pg-s3rb createdb -U readfine rf_s7_t1 && cd backend && export SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_s7_t1 && .venv/bin/alembic -q upgrade head && .venv/bin/pytest -q -p no:cacheprovider <files>
```

Expected: alembic prints two INFO lines, then pytest `N passed`, exit 0. Never use port 4250 or the databases `readfine_pytest` or `readfine_test`. Node checks use `TMPDIR=/var/tmp PYTHON=backend/.venv/bin/python node --test <files>`; `TMPDIR=/var/tmp` avoids `/tmp/.gitignore`. E2E and visual runs use only `E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e`; `tests/e2e/db-guard.mjs` refuses anything else, and `global-setup.mjs`/`run.mjs` migrate it. They share `readfine_e2e` and ports 4251/4252, so they run only in s7-T8 and in `branchChecks`, never in parallel workers. Source checks before regeneration: `node scripts/check-tw4-classes.mjs && node scripts/check-css-vars.mjs && node scripts/check-colours.mjs`. The fourth `check:sources` step (`check-dom-contract.mjs`) waits for s7-T8.

## Review Focus

1. **An immediate save that fails**: offline, forced offline, stale CSRF (403), expired session (followed redirect to `/login`), 429, network error, an unknown value (400), or an older response arriving after a newer one. The control shows the last value the server confirmed, the toast says the choice was not saved, and no "Saved" toast appears. → s7-T1 `autosave: a failed save restores the last confirmed value and says so`, `autosave: an older response never overrides a newer choice`; s7-T8 `settings: immediate save, failure and offline`.
2. **Old bookmarks and stale tabs**: `/settings/preferences?x=1#offline-diagnostics`, a stale full-form POST to `/settings/preferences`, `/settings/filters`, and the offline status long-press while online. Each lands on the new page (the browser keeps the fragment), the stale form still saves, and nothing 404s. → s7-T7 `test_settings_moved_pages_redirect_and_alias`; s7-T2 updated `offline-page.test.mjs` long-press case; s7-T8 `settings: old bookmarks, stale form and diagnostics`.
3. **Deleting a label that is a filter's only action, deleting a filter, Undo, and two deletes inside 10 s.** The rows hide at once, Undo brings them back and sends nothing, the "Turned off N filters" notice appears after the send, and both deletes go out in one batch. → s7-T4 `test_labels_list_uses_delayed_delete`; s7-T3 `test_filters_list_uses_delayed_delete`; s7-T8 `settings: delayed delete of a label and a filter with Undo`.
4. **"Filter from this source" edge cases**: a saved article with no feed, a feed the user unsubscribed from, a forged or foreign `?feed=` id, and a non-integer id. The item is absent for a feedless article. The editor prefills only a feed the user subscribes to, and otherwise opens as a normal empty "New filter", with no error and no foreign feed name shown. → s7-T3 `test_filter_new_prefill_from_feed`; s7-T7 `test_article_menu_filter_from_source`; s7-T8 `settings: filter from this source`.
5. **A phone (390 px) with a stored `sidebar_mode_small=collapsible`, and the Settings tabs.** First paint is already `hideable-up` and storage is rewritten. The tabs scroll inside their row with the active tab visible and the page never scrolls sideways. A token created there is shown once, can be copied, and does not come back on back or reload. → s7-T1 `init: a stored collapsible sidebar mode boots as hideable-up`; s7-T4 `test_new_token_shown_once_and_not_cached`; s7-T8 `settings: phone tabs, stored collapsible mode and token shown once`.

## File map

Paths are repository-relative. **Create** marks a file that does not exist at HEAD and **Delete** one that is removed. Each file has exactly one writer in the segment; no file is written in two waves. Reading another task's file is allowed.

| File(s) | Responsibility | Owner (wave) |
|---|---|---|
| `backend/app/templates/settings/base.html`, `backend/app/templates/partials/side_nav.html` | Settings layout, sub-navigation, phone tabs, secondary row | s7-T1 (1) |
| `backend/app/routers/web/settings/nav.py` | `/settings` index → `/settings/reading` | s7-T1 (1) |
| **Create** `backend/app/routers/web/settings/fields.py`; `backend/app/routers/web/settings/__init__.py` | `POST /settings/field` and its allowlist; router inclusion | s7-T1 (1) |
| **Create** `backend/app/static/js/ui/settings.js` | `RFSettings` immediate save and rollback | s7-T1 (1) |
| `backend/app/templates/base.html`, `backend/app/templates/app/partials/mobile_bars.html`, `backend/app/static/js/init.js`, `backend/app/static/js/app.js` | script tag; retire phone Collapsible (CSS, boot, `applyBucket`, `configRequest`, `prefPairs`) | s7-T1 (1) |
| **Create** `backend/tests/test_settings_shell.py`, `tests/js/ui-settings.test.mjs`; `tests/js/theme-bootstrap.test.mjs` | T1 tests | s7-T1 (1) |
| `backend/app/routers/web/settings/preferences.py` | `/settings/reading` GET, legacy POST, `/settings/reading/save`; hidden route removed | s7-T2 (1) |
| **Create** `backend/app/templates/settings/reading.html`, **Create** `backend/app/templates/settings/partials/reading_form.html`; **Delete** `backend/app/templates/settings/preferences.html` | Reading & appearance page and its sticky form | s7-T2 (1) |
| `backend/app/static/js/preferences.js`, `backend/app/static/js/offline/page.js`, `tests/js/offline-page.test.mjs` | device section binding; diagnostics link and its test | s7-T2 (1) |
| **Create** `backend/tests/test_settings_reading.py` | T2 tests | s7-T2 (1) |
| `backend/app/routers/web/settings/relevance.py`, `backend/app/routers/web/settings/filters.py` | Relevance & filters page, `/settings/relevance/hidden`, filter redirects, `?feed=` prefill; filters list GET removed | s7-T3 (1) |
| `backend/app/templates/settings/relevance.html`, `backend/app/templates/settings/_relevance_{top,suggestions,suggestion_applied,term_stats,terms_textarea}.html`, `backend/app/templates/settings/filter_edit.html`, `backend/app/templates/settings/partials/{filters_list,hidden_stories}.html`; **Delete** `backend/app/templates/settings/filters.html` | page markup | s7-T3 (1) |
| **Create** `backend/tests/test_settings_relevance.py` | T3 tests | s7-T3 (1) |
| `backend/app/templates/settings/{labels,profile,tokens}.html`, `backend/app/templates/settings/partials/{labels_list,tokens_list}.html`, `backend/app/routers/web/settings/{labels,tokens}.py` | Labels, Account, API tokens | s7-T4 (1) |
| `backend/tests/test_label_palette.py`; **Create** `backend/tests/test_settings_account.py` | T4 tests | s7-T4 (1) |
| `backend/app/templates/settings/{ai,stats}.html`, `backend/app/templates/settings/partials/{ai_cost_table,feeds_stats}.html`, `backend/app/routers/web/settings/scrape.py`, `backend/app/services/briefing_service.py` | AI provider and Stats restyle; wording | s7-T5 (1) |
| **Create** `backend/tests/test_settings_ai_stats.py` | T5 tests | s7-T5 (1) |
| `backend/app/static/js/ui/assistant.js`, `backend/app/templates/assistant/{page,catchup}.html`, `backend/app/routers/web/app/{ai,catchup}.py`, `input.css` | s6 carry | s7-T6 (1) |
| `backend/tests/test_assistant_chat.py`, `backend/tests/test_assistant_catchup.py`, `tests/js/ui-assistant.test.mjs`, `tests/js/tailwind-layers.test.mjs` | T6 tests | s7-T6 (1) |
| `backend/app/routers/web/moved_pages.py`, `backend/tests/test_moved_pages.py` | three moves; `Feed(id=18)` flake | s7-T7 (2) |
| `backend/app/templates/app/partials/article_detail.html`, `backend/app/services/sync/__init__.py`, `backend/tests/test_offline_template_version.py`, `backend/tests/fixtures/partials_online/detail-{failed,full,pending-summary,plain,saved-desc,unread-starred}.txt` | menu item, snapshot v7 | s7-T7 (2) |
| `backend/app/templates/app/partials/briefing_modal.html`; **Create** `backend/tests/test_article_filter_from_source.py` | timezone link; T7 test | s7-T7 (2) |
| `backend/app/static/css/tailwind.css`, `docs/ui-dom-contract.md`, `backend/tests/test_dom_contract_pages.py`, `backend/tests/test_base_dark_controls.py` | generated CSS and contract | s7-T8 (3) |
| `backend/tests/fixtures/dom_contract/{article_detail,article_list,article_row,assistant,assistant_briefing,login,main,shortcuts,sidebar,sources,sources_add}.html`; **Delete** `…/dom_contract/preferences.html`; **Create** `…/dom_contract/{reading,relevance,labels,account,tokens}.html` | DOM fixtures | s7-T8 (3) |
| **Create** `tests/e2e/settings.spec.mjs`; `tests/e2e/{helpers,theme.spec,offline.spec,assistant.spec}.mjs` | acceptance flows; new URL and wording in existing specs | s7-T8 (3) |
| `tests/visual/{gallery-pages,key-screens.spec}.mjs`; **Create** `tests/visual/layout-allow/s7-T8.json` | visual screens and reasoned exemptions | s7-T8 (3) |
| `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `backend/app/content/features.yml`, `FEATURES.md` | as-built docs | s7-T9 (4) |

Read-only throughout: `templates/ui/*`, `static/js/ui/{pending,toast,dialog,shell,read,sources,palette}.js`, `routers/web/settings/deletes.py`, `offline/{router,policy,sync,templates}.js`, `.github/workflows/ci.yml`, `tests/e2e/db-guard.mjs`, `help.html` and legal pages (s8).

## Tasks

### Task s7-T1: Settings shell, immediate save and phone Collapsible retirement

**Size** L · agent: worker · blocked_by: — · verifierRequired: true

**Files:** the s7-T1 rows of the file map.

**Checks** `[{"id": "t1-py", "name": "shell and field endpoint", "cmd": "docker exec rf-int-pg-s3rb dropdb --if-exists --force -U readfine rf_s7_t1 && docker exec rf-int-pg-s3rb createdb -U readfine rf_s7_t1 && cd backend && export SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_s7_t1 && .venv/bin/alembic -q upgrade head && .venv/bin/pytest -q -p no:cacheprovider tests/test_settings_shell.py tests/test_app_themes.py tests/test_settings_deletes.py", "timeoutSec": 600}, {"id": "t1-js", "name": "autosave, boot and shell JS", "cmd": "TMPDIR=/var/tmp PYTHON=backend/.venv/bin/python node --test tests/js/ui-settings.test.mjs tests/js/theme-bootstrap.test.mjs tests/js/ui-shell.test.mjs tests/js/ui-sources.test.mjs tests/js/tailwind-layers.test.mjs", "timeoutSec": 300}, {"id": "t1-src", "name": "source checks", "cmd": "node scripts/check-tw4-classes.mjs && node scripts/check-css-vars.mjs && node scripts/check-colours.mjs", "timeoutSec": 120}]`

**Interfaces.**
- Consumes: `RFToast.show`, `RFToast.fromTrigger` (`ui/toast.js`); `RFOffline.page.current().isOffline()` when present; `htmx_list_view` as the pattern for a narrow save; the service constants `DENSITY_VALUES`, `SORT_VALUES`, `UNREAD_FILTER_VALUES`, `LABEL_DISPLAY_VALUES`, `DEDUP_VALUES`, `FONT_SIZE_VALUES`, `FONT_FAMILY_VALUES`, `is_valid_format` (imported where `preferences.py` imports them).
- Produces:
  - `settings/base.html`. Children set `active` to one of `reading|relevance|labels|ai|account|stats` and may set `settings_subnav` (a list of `{"label","url","active"}`), shown as a secondary row under the page title. Blocks `title`, `settings_content`, `settings_main_width` and `scripts` keep their names. The active nav link carries `aria-current="page"` and `data-mobile-nav-active`. On ≥ sm the sub-navigation is a left column; below sm it is one horizontally scrollable tab row inside `[data-mobile-nav]`, with no page-level horizontal overflow. The wrapper paints `bg-background`; `<body>` keeps `bg-gray-50` (CLAUDE.md, until s8).
  - The nav: Reading & appearance `/settings/reading`; Relevance & filters `/settings/relevance`; Labels `/settings/labels`; AI provider `/settings/ai` (only if `app_ai_enabled()`, with the `ai_error_fresh()` badge); Account `/settings/profile`; Stats `/settings/stats`. Footer links: Back to Read `/app`, Sources `/sources` and Assistant `/assistant` (both `data-rf-online-only`), Admin `/admin` for admins.
  - `settings_index()` returns `RedirectResponse("/settings/reading", 303)`.
  - `fields.py`: `@dataclass(frozen=True) class FieldSpec: column: str; parse: Callable[[str], object | None]` (`None` means invalid) and `FIELDS: dict[str, FieldSpec]` with exactly `mark_read_on_scroll`, `mark_read_auto_advance`, `open_original_when_empty` (`"true"`/`"false"` → bool), `list_density_web`, `list_density_mobile`, `default_sort_order`, `unread_filter`, `label_display`, `story_dedup`, `reading_font_size`, `reading_font_family` (each in its value set) and `format_profile` (`is_valid_format`). `POST /settings/field` with form `field`, `value` is handled by `settings_field_save(request, field: str = Form(""), value: str = Form(""), user, db) -> HTMLResponse`. For an unknown field or an invalid value it returns 400 with an empty body and writes nothing. Otherwise it writes the column, creating the settings row with `onboarded_at` as `htmx_list_view` does, and returns 200 with an empty body and `HX-Trigger: json.dumps({"showToast": {"msg": "Saved", "type": "ok"}, "rf:settingsaved": {"field": field, "value": value}})`. Timezone and number fields are not in `FIELDS`.
  - `ui/settings.js` is a classic script, loaded deferred once from `base.html` after `ui/toast.js`. It exposes `window.RFSettings = {init(root), save(control) -> Promise<boolean>}`. Markup: a checkbox, radio or select with `name=<field>` and `data-rf-autosave` (value: POST URL, empty means `/settings/field`), plus an optional `data-rf-autosave-label`. On `change` it POSTs `field=<name>&value=<v>` form-encoded (checkbox: `true`/`false`) with `x-csrftoken` from the `csrftoken` cookie. Success is `r.ok && !r.redirected`: it records the confirmed value and shows `HX-Trigger.showToast` through `RFToast.fromTrigger`. Anything else, or an offline state before sending, restores the last confirmed value (for radios, re-checks the confirmed radio) and shows `RFToast.show({msg: "Couldn't save <label>. Try again.", type: "error"})`, or `"You're offline. <label> was not saved."` when offline. The response to the newest change of a field wins; an older one is ignored. Confirmed values are read on `DOMContentLoaded` and `htmx:afterSwap`; delegated listeners are bound once.
  - Phone sidebar mode: on the small bucket, `init.js` and `applyBucket` always set `data-sidebar-mode="hideable-up"` and rewrite a stored value other than `hideable-up` to it. The `collapsible` CSS branches in `base.html` and `mobile_bars.html` and the `sidebar-mode-small` pair in `app.js` `prefPairs` are removed. `configRequest` sends `pinned=true` on small. `#detail-mode-small` stays bound.

- [ ] **RED** `tests/js/ui-settings.test.mjs`, three cases with jsdom, a stub `fetch` and a stub `RFToast`:
  1. `autosave: a change posts field and value with the CSRF header and shows the server toast`. A checkbox `name=mark_read_on_scroll data-rf-autosave` is toggled on: one POST to `/settings/field`, body `field=mark_read_on_scroll&value=true`, header `x-csrftoken` equal to the cookie; the toast from the `HX-Trigger` header is shown.
  2. `autosave: a failed save restores the last confirmed value and says so`. For each of 403, 429, 500, `redirected: true`, a rejected fetch and `navigator.onLine=false` (no fetch call): the select returns to its confirmed value, there is one error toast with the label text, and no "Saved" toast.
  3. `autosave: an older response never overrides a newer choice`. Two changes, where the second resolves ok first and the first then fails: the control keeps the second value and no error toast appears.
- [ ] **RED** `backend/tests/test_settings_shell.py`, two cases using the `_client` pattern of `tests/test_settings_deletes.py`:
  4. `test_settings_field_saves_allowlisted_and_rejects_others`. `mark_read_on_scroll=true` → 200, column True, `HX-Trigger` JSON has `showToast.msg == "Saved"`. `list_density_web=compact` → saved. `story_dedup=bogus`, `field=timezone` and `field=is_admin` → 400 and the row unchanged.
  5. `test_settings_index_and_nav`. `GET /settings` → 303 `/settings/reading`. A synthetic child template (`{% extends "settings/base.html" %}` with `active="account"` and a two-item `settings_subnav`, rendered with the same context helpers the settings pages use) lists exactly the six labels in order with AI provider present; exactly one nav link, "Account", has `aria-current="page"`; the secondary row shows both subnav links with the active one marked. With `app_ai_enabled` patched False, AI provider is absent. The test must not depend on any page template another wave-1 task rewrites.
- [ ] **RED** `tests/js/theme-bootstrap.test.mjs`, case 6: `init: a stored collapsible sidebar mode boots as hideable-up`. At 390 px with `localStorage.sidebar_mode_small = "collapsible"`, after `init.js` `documentElement.dataset.sidebarMode === "hideable-up"` and storage reads `hideable-up`. *Sixth case, reason:* retiring Collapsible is a separate owner-assigned behaviour and needs its own regression; the other five pin the shell and save contract.
- [ ] Run checks `t1-js` and `t1-py`. Expected: the new cases fail (`Cannot find module`/missing `RFSettings`, 404 on `/settings/field`, 303 to `/settings/stats`, `collapsible` kept).
- [ ] **GREEN:** implement the Produces items above. `settings/base.html` renders the nav through the rewritten `side_nav(nav_items, title, back_url, back_label, footer_links)` with tokens (`bg-sidebar`, `text-muted-foreground`, `bg-accent` for active), no gray literals.
- [ ] Run checks `t1-py`, `t1-js`, `t1-src`. Expected: `passed` / `# fail 0` / three `OK` lines. Existing `ui-shell` and `ui-sources` tests stay green with the new script tag.

### Task s7-T2: Reading & appearance page

**Size** L · agent: worker · blocked_by: — · verifierRequired: true

**Files:** the s7-T2 rows of the file map.

**Checks** `[{"id": "t2-py", "name": "reading page", "cmd": "docker exec rf-int-pg-s3rb dropdb --if-exists --force -U readfine rf_s7_t2 && docker exec rf-int-pg-s3rb createdb -U readfine rf_s7_t2 && cd backend && export SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_s7_t2 && .venv/bin/alembic -q upgrade head && .venv/bin/pytest -q -p no:cacheprovider tests/test_settings_reading.py tests/test_story_suppression.py", "timeoutSec": 600}, {"id": "t2-js", "name": "offline page and diagnostics", "cmd": "TMPDIR=/var/tmp PYTHON=backend/.venv/bin/python node --test tests/js/offline-page.test.mjs tests/js/offline-diagnostics.test.mjs tests/js/offline-boot.test.mjs tests/js/theme-bootstrap.test.mjs", "timeoutSec": 300}, {"id": "t2-src", "name": "source checks", "cmd": "node scripts/check-tw4-classes.mjs && node scripts/check-css-vars.mjs && node scripts/check-colours.mjs", "timeoutSec": 120}]`

**Interfaces.**
- Consumes (s7-T1, same wave, designed group): `settings/base.html` with `active="reading"`; `data-rf-autosave` markup and `FIELDS` names; `POST /settings/field`. The wave verifier checks them assembled.
- Produces:
  - `GET /settings/reading` → `settings/reading.html` with the context the old page had (`s`, `bookmarklet`, `app_themes`, `app_version`, `offline_template_version`, timezone choices). `_get_or_create_settings(user, db) -> UserSettings` keeps its name and signature.
  - `POST /settings/reading` is the unchanged full legacy handler (target of the s8-bound alias); it renders `reading.html` with `saved=True`.
  - `POST /settings/reading/save` with form `timezone`, `articles_per_page`, `bucket_small_max`, `bucket_medium_max` → `settings/partials/reading_form.html` (`<form id="reading-form" hx-post="/settings/reading/save" hx-target="#reading-form" hx-swap="outerHTML">`, Save button in a sticky bar). Valid input saves with today's clamps (`clamp_articles_per_page`, `clamp_buckets`, `reschedule_briefings` on a changed timezone) and answers 200 with the re-rendered form plus `HX-Trigger` `showToast` "Saved". A non-integer number answers 200 with the form, `field(error="Enter a whole number")` on that field, nothing written and no toast.
  - Cards in this order: **Reading** (switches `mark_read_on_scroll`, `mark_read_auto_advance`, `open_original_when_empty`; radio groups `reading_font_size`, `reading_font_family`); **Article list** (selects `unread_filter`, `default_sort_order`, `list_density_web`, `list_density_mobile`, `label_display`); **Date, time and layout** (`format_profile` select with autosave, plus `#reading-form`); **Save from other sites** (bookmarklet, desktop only as today); **This device** (install offer, offline settings and `#offline-diagnostics`, colour scheme, app theme, small-screen article detail, medium/large `data-layout-bucket`). Every server-backed choice carries `data-rf-autosave` and a `data-rf-autosave-label`. There is no `#sidebar-mode-small` and no `story_dedup` here (moved to s7-T3).
  - `GET /settings/preferences/hidden` is deleted (s7-T3 serves `/settings/relevance/hidden`; s7-T7 adds the 308).
  - `offline/page.js` long-press navigates to `/settings/reading#offline-diagnostics` online and to `/__rf/diagnostics` offline.
- [ ] **RED** `backend/tests/test_settings_reading.py`, three cases:
  1. `test_reading_page_autosave_controls_and_device_hooks`. `GET /settings/reading` → 200. The set of `[data-rf-autosave]` names equals the eleven reading/list/format names above (FIELDS minus `story_dedup`; the test lists the names literally and does not import `settings/fields.py`, which belongs to s7-T1). Every preserved hook from Global Constraints is present once. `#sidebar-mode-small` and `name=story_dedup` are absent. `<h1>` text is "Reading & appearance".
  2. `test_reading_save_clamps_and_rejects_non_integers`. POST `articles_per_page=100000, bucket_small_max=200, bucket_medium_max=150` → saved values equal `clamp_articles_per_page`/`clamp_buckets` of the inputs and `HX-Trigger` has "Saved". POST `articles_per_page=abc` → 200, body has "Enter a whole number", DB unchanged, no `HX-Trigger`.
  3. `test_reading_legacy_full_post_still_saves`. POST the old full form to `/settings/reading` with `mark_read_on_scroll=on` and `list_density_web=compact` → 200, both saved, `story_dedup` from the form saved (the stale-tab contract).
- [ ] **RED** update the existing `tests/js/offline-page.test.mjs` long-press expectations (lines 315/320) to `/settings/reading#offline-diagnostics`. Not a new case.
- [ ] Run checks `t2-py`, `t2-js`. Expected: 404 on `/settings/reading`; the long-press assertion fails on the old URL.
- [ ] **GREEN:** routes in `preferences.py`; `reading.html` from `card`, `field`, `switch`, `select`, `radio_group`; device-section markup with the same hooks; `preferences.js` binds the same elements (update its header comment to Reading & appearance); the `page.js` link.
- [ ] Run checks `t2-py`, `t2-js`, `t2-src`. Expected: `passed`, `# fail 0`, three `OK`.

### Task s7-T3: Relevance & filters, with delayed filter delete and source prefill

**Size** L · agent: worker · blocked_by: — · verifierRequired: true

**Files:** the s7-T3 rows of the file map.

**Checks** `[{"id": "t3-py", "name": "relevance and filters", "cmd": "docker exec rf-int-pg-s3rb dropdb --if-exists --force -U readfine rf_s7_t3 && docker exec rf-int-pg-s3rb createdb -U readfine rf_s7_t3 && cd backend && export SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_s7_t3 && .venv/bin/alembic -q upgrade head && .venv/bin/pytest -q -p no:cacheprovider tests/test_settings_relevance.py tests/test_relevance_suggest.py tests/test_relevance_lexical.py tests/test_filter_service.py tests/test_ui_fragments.py tests/test_story_suppression.py tests/test_api_filters.py", "timeoutSec": 600}, {"id": "t3-src", "name": "source checks", "cmd": "node scripts/check-tw4-classes.mjs && node scripts/check-css-vars.mjs && node scripts/check-colours.mjs", "timeoutSec": 120}]`

**Interfaces.**
- Consumes: s7-T1 `settings/base.html` (`active="relevance"`) and `data-rf-autosave` for `story_dedup`; `RFPending` markup (`data-rf-delete="filter:<id>"`, `data-rf-delete-label`, `data-rf-delete-key`); `list_suppressed`, `count_suppressed`, `SUPPRESSED_DAYS`, `DEDUP_SUPPRESS`.
- Produces:
  - `GET /settings/relevance` → `relevance.html` with three cards. **Relevance** has today's content. **Filters** is `id="filters"`: explanation, New filter button to `/settings/filters/new`, `#filters-list`. **Stories** is `id="stories"`: `story_dedup` radio group with autosave, and while it is `collapse_suppress` the counter `<details hx-get="/settings/relevance/hidden" hx-trigger="toggle once" hx-target="#hidden-stories">`.
  - `GET /settings/relevance/hidden` → `settings/partials/hidden_stories.html`, the same read-only list, per user, empty unless suppress mode.
  - `GET /settings/filters` is removed (s7-T7 adds its 308). Create and update redirect `303` to `/settings/relevance`. Filter pages set `active="relevance"` and link back to `/settings/relevance#filters`.
  - `filters_list.html` rows carry `data-rf-delete-key="filter:<id>"`. The delete control is `button(... attrs={"data-rf-delete": "filter:<id>", "data-rf-delete-label": f.name})`, with no `hx-delete` and no `.swap-confirm`. `DELETE /settings/filters/{id}` stays for other callers.
  - `GET /settings/filters/new?feed=<Feed.id>`: `_prefill_from_feed(user_feeds, feed: str | None) -> FilterCreate | None` returns `FilterCreate(name=uf.custom_title or uf.feed.title, scope_include=[f"feed:{uf.feed_id}"])` only when `feed` is a decimal integer equal to some `uf.feed_id` in the user's own `user_feeds`; otherwise `None` and the normal empty form. The page passes it as `form_values`; saving still goes through `create_filter` → `_validate_scope_list`.
- [ ] **RED** `backend/tests/test_settings_relevance.py`, five cases:
  1. `test_relevance_page_has_filters_and_stories`. `GET /settings/relevance` → `#filters #filters-list` lists the user's filters. `#stories` has `input[name=story_dedup][data-rf-autosave]` × 3. In suppress mode, `details[hx-get="/settings/relevance/hidden"]` is present.
  2. `test_filters_list_uses_delayed_delete`. Each filter row has `data-rf-delete-key="filter:<id>"` and one `[data-rf-delete="filter:<id>"][data-rf-delete-label=<name>]`. There is no `.swap-confirm` and no `[hx-delete]` in `#filters-list`.
  3. `test_filter_create_and_update_redirect_to_relevance`. POST a valid new filter → 303 `Location: /settings/relevance`; POST edit → same.
  4. `test_filter_new_prefill_from_feed`. For own `Feed.id`: the checkbox `value="feed:<id>"` is checked and the name input has the feed title. For another user's feed id, `abc`, `99999999999` and an unsubscribed feed: 200, no scope checkbox checked, empty name, the other user's feed title not in the body.
  5. `test_hidden_stories_moved_to_relevance`. `GET /settings/relevance/hidden` lists a suppressed article for its user in suppress mode, nothing for a second user, and nothing when `story_dedup` is `collapse`.
- [ ] Run check `t3-py`. Expected: the five cases fail (404, missing attributes, `Location: /settings/filters`).
- [ ] **GREEN:** the routes and templates above, from macros; keep `#filters-list` and the filter-edit form field names (`filter-edit.js` binds them).
- [ ] Run checks `t3-py`, `t3-src`. Expected: `passed`, three `OK`.

### Task s7-T4: Labels, Account and API tokens

**Size** L · agent: worker · blocked_by: — · verifierRequired: true

**Files:** the s7-T4 rows of the file map.

**Checks** `[{"id": "t4-py", "name": "labels, account, tokens", "cmd": "docker exec rf-int-pg-s3rb dropdb --if-exists --force -U readfine rf_s7_t4 && docker exec rf-int-pg-s3rb createdb -U readfine rf_s7_t4 && cd backend && export SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_s7_t4 && .venv/bin/alembic -q upgrade head && .venv/bin/pytest -q -p no:cacheprovider tests/test_settings_account.py tests/test_label_palette.py tests/test_label_delete_filters.py tests/test_delete_account.py tests/test_web_email_change.py tests/test_api_token_auth.py tests/test_session_invalidation.py", "timeoutSec": 600}, {"id": "t4-js", "name": "pending and shell JS", "cmd": "TMPDIR=/var/tmp PYTHON=backend/.venv/bin/python node --test tests/js/ui-pending.test.mjs tests/js/ui-shell.test.mjs", "timeoutSec": 300}, {"id": "t4-src", "name": "source checks", "cmd": "node scripts/check-tw4-classes.mjs && node scripts/check-css-vars.mjs && node scripts/check-colours.mjs", "timeoutSec": 120}]`

**Interfaces.**
- Consumes: s7-T1 `settings/base.html` (`active="labels"`; `active="account"` plus `settings_subnav` on profile and tokens); `RFPending`; the existing `.copy-from-btn[data-copy-from]` handler in `app.js`; the label notice from `deletes.py`.
- Produces:
  - Labels: an add form in a card (same names, swatch and custom-colour hooks) and `#labels-list`. Rows carry `data-rf-delete-key="label:<id>"` and the delete control `data-rf-delete="label:<id>"` with `data-rf-delete-label=<name>`, with no `hx-delete` or `.swap-confirm`. Edit (`POST /settings/labels/{id}`) is unchanged.
  - Account (`/settings/profile`): cards Name, Email, Password and Delete account, with the same form actions, names and `data-rf-delete-account`. `settings_subnav = [Profile (active), API tokens]`.
  - API tokens (`/settings/tokens`): the create form, and after create a card with the token in `<code id="new-token-value">` plus `button("Copy", attrs={"class": "copy-from-btn", "data-copy-from": "new-token-value"})`. `POST /settings/tokens` responses carry `Cache-Control: no-store`. The list uses token-coloured dividers (`divide-border`, closing the s2-carry dark `tbody divide-gray-100`). Revoke keeps its `.swap-confirm`.
- [ ] **RED** `backend/tests/test_settings_account.py`, four cases:
  1. `test_labels_list_uses_delayed_delete`. Each label row has `data-rf-delete-key="label:<id>"` and one `[data-rf-delete="label:<id>"][data-rf-delete-label=<name>]`. There is no `.swap-confirm` or `[hx-delete]` in `#labels-list`. Seven `.color-swatch[aria-label][aria-pressed]` remain.
  2. `test_new_token_shown_once_and_not_cached`. `POST /settings/tokens name=ci` → 200, `Cache-Control` contains `no-store`, `#new-token-value` text matches the stored hash's token, a `.copy-from-btn[data-copy-from=new-token-value]` is present, and the token value appears exactly once in the body. A following `GET /settings/tokens` does not contain it.
  3. `test_tokens_list_dividers_and_revoke`. `/settings/tokens` with two tokens: `#tokens-list` uses `divide-border` (no `divide-gray-100`), and each revoke control keeps its `.swap-confirm` posting to `/settings/tokens/{id}/revoke`. (The shared Account nav item and secondary row are rendered by s7-T1's `settings/base.html` and pinned by s7-T1 case 5 and s7-T8 case 5, so this task's checks pass on its own tree.)
  4. `test_account_forms_keep_actions`. The forms post to `/settings/profile/{name,email,password,delete-account}` with today's field names; `[data-rf-delete-account]` is present.
- [ ] Update `tests/test_label_palette.py` only where selectors changed (not a new case).
- [ ] Run check `t4-py`. Expected: the new cases fail.
- [ ] **GREEN:** templates from macros; `tokens.py` adds `no-store` on both create responses (success and error).
- [ ] Run checks `t4-py`, `t4-js`, `t4-src`. Expected: `passed`, `# fail 0`, three `OK`.

### Task s7-T5: AI provider and Stats pages

**Size** M · agent: worker · blocked_by: — · verifierRequired: false

**Files:** the s7-T5 rows of the file map.

**Checks** `[{"id": "t5-py", "name": "ai provider and stats", "cmd": "docker exec rf-int-pg-s3rb dropdb --if-exists --force -U readfine rf_s7_t5 && docker exec rf-int-pg-s3rb createdb -U readfine rf_s7_t5 && cd backend && export SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_s7_t5 && .venv/bin/alembic -q upgrade head && .venv/bin/pytest -q -p no:cacheprovider tests/test_settings_ai_stats.py tests/test_ai_provider_content.py tests/test_ai_preference.py tests/test_assistant_profile.py tests/test_traffic_stats.py tests/test_stats_gems.py tests/test_scrape.py", "timeoutSec": 900}, {"id": "t5-src", "name": "source checks", "cmd": "node scripts/check-tw4-classes.mjs && node scripts/check-css-vars.mjs && node scripts/check-colours.mjs", "timeoutSec": 120}]`

**Interfaces.**
- Consumes: s7-T1 `settings/base.html` (`active="ai"`, `active="stats"`).
- Produces: `ai.html` and `stats.html` regrouped into `card`s with `field`/`select`/`switch` where the control is a plain input, headings "AI provider" and "Stats". Every form action, input name, id and data hook that `ai-settings.js` and the existing tests bind stays as it is, as do the lazy `hx-get` to `/settings/feeds-stats-partial` and `/settings/ai/cost-partial` and the profile link to `/assistant?section=profile#assistant-profile`. Tables use `divide-border`. The setup messages in `scrape.py` (line 57) and `briefing_service.py` (line 281) say "Settings → AI provider".
- [ ] **RED** `backend/tests/test_settings_ai_stats.py`, three cases:
  1. `test_ai_provider_page_keeps_form_contract`. `GET /settings/ai` → `<h1>` "AI provider". The forms post to `/settings/ai/keys` and `/settings/ai/preferences` with the same `name` set as at `12cc961` (listed literally in the test). The profile link is present.
  2. `test_stats_page_cards_and_lazy_partials`. `GET /settings/stats` → `<h1>` "Stats". Both lazy `hx-get` targets are present. No `divide-gray-100` remains in `stats.html` or the two partials.
  3. `test_setup_messages_name_ai_provider`. The scrape AI-off fragment contains `Settings → AI provider` and a link to `/settings/ai`.
- [ ] Run check `t5-py`. Expected: the cases fail on headings and wording.
- [ ] **GREEN:** markup and wording only; no route or handler change.
- [ ] Run checks `t5-py`, `t5-src`. Expected: `passed`, three `OK`.

### Task s7-T6: Assistant s6 carry

**Size** M · agent: worker · blocked_by: — · verifierRequired: true (CSS cascade judgement)

**Files:** the s7-T6 rows of the file map.

**Checks** `[{"id": "t6-py", "name": "assistant chat and catch-up", "cmd": "docker exec rf-int-pg-s3rb dropdb --if-exists --force -U readfine rf_s7_t6 && docker exec rf-int-pg-s3rb createdb -U readfine rf_s7_t6 && cd backend && export SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_s7_t6 && .venv/bin/alembic -q upgrade head && .venv/bin/pytest -q -p no:cacheprovider tests/test_assistant_chat.py tests/test_assistant_catchup.py tests/test_catchup_main_model.py", "timeoutSec": 600}, {"id": "t6-js", "name": "assistant JS and layers", "cmd": "TMPDIR=/var/tmp PYTHON=backend/.venv/bin/python node --test tests/js/ui-assistant.test.mjs tests/js/ui-assistant-catchup.test.mjs tests/js/tailwind-layers.test.mjs tests/js/tailwind-build.test.mjs tests/js/build-css.test.mjs", "timeoutSec": 300}, {"id": "t6-css", "name": "input.css builds (scratch output)", "cmd": "mkdir -p /var/tmp/claude-rf-t6-css && node scripts/build-css.mjs -i input.css -o /var/tmp/claude-rf-t6-css/tailwind.css", "timeoutSec": 300}, {"id": "t6-src", "name": "source checks", "cmd": "node scripts/check-tw4-classes.mjs && node scripts/check-css-vars.mjs && node scripts/check-colours.mjs", "timeoutSec": 120}]`

**Interfaces.**
- Consumes: the probe `.arh-w-dev/runs/run-7429291d-8129-432b-beab-c61fff1112cd/attempts/s6-T1/18/work/settle-probe.mjs` (vendored `htmx.min.js` in jsdom, a stub `XMLHttpRequest`).
- Produces:
  - `ui/assistant.js`: `watchViewport(root, page)` re-applies the viewport value when the root is already watched instead of returning, and the chat lifecycle re-applies it after `htmx:afterSettle` on `#rf-assistant-chat`. The keyboard cap therefore survives a reply.
  - `ai.py`: `chat_setup = {"text": <sentence without a settings path>, "link_label": "Open AI provider settings", "href": "/settings/ai"}`. The problem texts become "Choose a main model.", "Add an API key for your main model.", "Set the custom model endpoint.", "Enable chat in the AI provider settings."; the text is not used as a key. `page.html` renders `text` then the link, with no `partition`. Its header Settings link is `/settings`.
  - `catchup.html` setup notices render through the `alert` macro with a link "AI provider settings" to `/settings/ai`; `catchup.py:43` says "Settings → AI provider". The `Catch me up` h2 gets the classes of the Chat h2 (`text-lg font-semibold`). On 390 px the setup notice has the same gap above the chat card as other section content (a utility margin on the notice, not a new rule).
  - `input.css`: the Sources block (`.rf-sources-*`, about lines 815–849) and the whole Assistant block (about 851–960, including the `@media (max-width: 640px)` phone rules) move inside `@layer utilities`, so no `.rf-sources-*` or `.rf-assistant-*` rule is unlayered. When that changes a computed style on an element that also has a utility class, keep the old result through specificity or the utility, and record it for the visual run in s7-T8.
- [ ] **RED** four cases:
  1. `tests/js/ui-assistant.test.mjs` `assistant: viewport cap survives a real htmx swap and settle` (jsdom, vendored htmx, `visualViewport.height = 330`). After two chat replies swapped `outerHTML` and settled, `#rf-assistant-chat` still has `--rf-assistant-viewport-height: 330px`.
  2. `backend/tests/test_assistant_chat.py` `test_chat_setup_link_is_structured` (replaces the literal-split assertion at line 241). For each problem key, the setup alert has exactly one `a[href="/settings/ai"]` with text "Open AI provider settings", and the alert text has no `Settings → AI`.
  3. `backend/tests/test_assistant_catchup.py` `test_catchup_setup_notice_shape`. With AI off, and separately with no main model, `#assistant-catch-up` has one `.alert` after `#assistant-catch-up-heading`, containing one `a[href="/settings/ai"]`. The heading carries `text-lg` and `font-semibold`.
  4. `tests/js/tailwind-layers.test.mjs` `layers: Sources and Assistant rules sit in @layer utilities`. Parse `input.css` brace depth: every selector containing `.rf-sources-` or `.rf-assistant-` lies inside the `@layer utilities { … }` block.
- [ ] Run checks `t6-js`, `t6-py`. Expected: the four cases fail (cap empty after settle, literal link, unstyled heading, unlayered rules).
- [ ] **GREEN:** the items above.
- [ ] Run checks `t6-py`, `t6-js`, `t6-css`, `t6-src`. Expected: `passed`, `# fail 0`, build exit 0, three `OK`.

### Task s7-T7: Wiring: moved pages, "Filter from this source", snapshot version 7

**Size** M · agent: worker · blocked_by: s7-T1, s7-T2, s7-T3, s7-T4, s7-T5, s7-T6 · verifierRequired: true (snapshot bump)

**Files:** the s7-T7 rows of the file map.

**Checks** `[{"id": "t7-py", "name": "moves, snapshot and article menu", "cmd": "docker exec rf-int-pg-s3rb dropdb --if-exists --force -U readfine rf_s7_t7 && docker exec rf-int-pg-s3rb createdb -U readfine rf_s7_t7 && cd backend && export SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_s7_t7 && .venv/bin/alembic -q upgrade head && .venv/bin/pytest -q -p no:cacheprovider tests/test_moved_pages.py tests/test_article_filter_from_source.py tests/test_offline_template_version.py tests/test_partials_online_unchanged.py tests/test_offline_drift.py tests/test_article_redesign.py tests/test_sync_snapshots.py tests/test_sync_manifest.py tests/test_settings_shell.py tests/test_settings_reading.py tests/test_settings_relevance.py tests/test_settings_account.py tests/test_settings_ai_stats.py", "timeoutSec": 900}, {"id": "t7-js", "name": "offline drift JS", "cmd": "TMPDIR=/var/tmp PYTHON=backend/.venv/bin/python node --test tests/js/offline-drift.test.mjs tests/js/offline-page.test.mjs", "timeoutSec": 300}]`

**Interfaces.**
- Consumes: `GET`/`POST /settings/reading` (s7-T2); `GET /settings/relevance` and `GET /settings/relevance/hidden` (s7-T3); `GET /settings/filters/new?feed=<Feed.id>` (s7-T3); `MovedPage`, `register_moved_pages` (s5).
- Produces:
  - `MOVED_PAGES` gains `MovedPage("/settings/preferences", "/settings/reading", ("GET", "POST"))`, `MovedPage("/settings/preferences/hidden", "/settings/relevance/hidden")` and `MovedPage("/settings/filters", "/settings/relevance")`. Startup validation passes on the assembled tree. In `test_moved_pages.py`, the line-316 assertion becomes `== "/settings/reading"` (s7-T1 changed the index target).
  - `article_detail.html` "···" menu: after Copy, when `article.feed_id`, `<a role="menuitem" href="/settings/filters/new?feed={{ article.feed_id }}" data-rf-online-only>` with a funnel icon and the text "Filter from this source". It is absent when `feed_id` is null. Remove the stale `article-detail-menu` comment (s4-T6 F1, lines 29–30).
  - `OFFLINE_TEMPLATE_VERSION = "7"`, `OFFLINE_TEMPLATE_HASH` = the hash `test_pinned_hash_matches_tree` reports. `LEDGER` gets `("7", <hash>)`; `RELEASED` gets the old last row `("6", "60ff43c1c5f70e34")`. The six `partials_online/detail-*.txt` goldens are regenerated. `offline/templates.js` does not mirror the article toolbar and is not changed (check: `grep -c "Filter from this source" backend/app/static/js/offline/templates.js` → `0`, and `test_offline_drift.py` passes unchanged).
  - `briefing_modal.html` timezone link → `/settings/reading` with the text "set timezone in Settings → Reading & appearance".
  - `test_moved_pages.py`: the hard-coded `Feed(id=18)` (around line 139) uses a generated id (s6 carry flake).
- [ ] **RED**:
  1. `backend/tests/test_moved_pages.py` `test_settings_moved_pages_redirect_and_alias`. For each of the three settings moves, `GET old?x=1` → 308, `Location` = new + `?x=1`, `Cache-Control: no-store`, and the target answers 200 for a logged-in user. A stale full-form `POST /settings/preferences` with `mark_read_on_scroll=on` saves the same row as `POST /settings/reading`. `POST /settings/filters` (create) still answers 303 directly, not 308.
  2. `backend/tests/test_article_filter_from_source.py` `test_article_menu_filter_from_source`. Render `article_detail.html` through the `_detail` helper of `tests/test_article_redesign.py`. With `feed_id=7`, `#article-menu-<id>` contains exactly one `a[role=menuitem][href="/settings/filters/new?feed=7"][data-rf-online-only]` with text "Filter from this source". With `feed_id=None`, there is none.
- [ ] Run check `t7-py`. Expected: case 1 gets 404 on the old paths; case 2 finds no item; after the template edit `test_closure_change_without_bump`/`test_pinned_hash_matches_tree` fail and print the new hash.
- [ ] **GREEN:** the table rows, menu item, version/hash/ledger, then regenerate from the repository root: `docker exec rf-int-pg-s3rb dropdb --if-exists --force -U readfine rf_s7_t7_goldens && docker exec rf-int-pg-s3rb createdb -U readfine rf_s7_t7_goldens && cd backend && export SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_s7_t7_goldens && .venv/bin/alembic -q upgrade head && RF_UPDATE_GOLDENS=1 .venv/bin/pytest -q -p no:cacheprovider tests/test_offline_drift.py tests/test_partials_online_unchanged.py`. Expected: `passed`; `git status` shows only the six `detail-*.txt` goldens among fixtures.
- [ ] Run checks `t7-py`, `t7-js`. Expected: `passed`, `# fail 0`.

### Task s7-T8: Regeneration, browser and visual acceptance

**Size** L · agent: worker · blocked_by: s7-T7 · verifierRequired: true

**Files:** the s7-T8 rows of the file map. This task is the sole owner of the generated CSS and contract. An application failure goes back to its owning task as a repair; this task does not patch other tasks' files.

**Checks** `[{"id": "t8-css", "name": "committed CSS equals a fresh build", "cmd": "mkdir -p /var/tmp/claude-rf-t8-css && node scripts/build-css.mjs -i input.css -o /var/tmp/claude-rf-t8-css/tailwind.css && cmp backend/app/static/css/tailwind.css /var/tmp/claude-rf-t8-css/tailwind.css", "timeoutSec": 300}, {"id": "t8-sources", "name": "check:sources", "cmd": "npm run check:sources", "timeoutSec": 300}, {"id": "t8-py", "name": "contract, goldens, drift", "cmd": "docker exec rf-int-pg-s3rb dropdb --if-exists --force -U readfine rf_s7_t8 && docker exec rf-int-pg-s3rb createdb -U readfine rf_s7_t8 && cd backend && export SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_s7_t8 && .venv/bin/alembic -q upgrade head && .venv/bin/pytest -q -p no:cacheprovider tests/test_dom_contract_pages.py tests/test_base_dark_controls.py tests/test_offline_drift.py tests/test_offline_template_version.py tests/test_partials_online_unchanged.py", "timeoutSec": 600}, {"id": "t8-js", "name": "npm test", "cmd": "TMPDIR=/var/tmp PYTHON=backend/.venv/bin/python npm test", "timeoutSec": 900}, {"id": "t8-e2e", "name": "settings e2e (Chrome)", "cmd": "TMPDIR=/var/tmp E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e npx playwright test tests/e2e/settings.spec.mjs --project=chrome", "timeoutSec": 1200, "heavy": true}]`

**Interfaces.**
- Consumes: everything above.
- Produces:
  - `_pages()` in `test_dom_contract_pages.py`: the key `preferences` is replaced by `reading` (`settings/reading.html`, path `/settings/reading`), and `relevance`, `labels`, `account` (`settings/profile.html`) and `tokens` are added with deterministic contexts. `test_base_dark_controls.py:82` reads `reading.html` instead of `preferences.html`, and its "legacy inputs found" premise is re-checked against the remaining legacy goldens without being weakened.
  - `tests/e2e/settings.spec.mjs` calls `requireE2eDatabaseUrl()` at collection, follows the `sources.spec.mjs` fixture conventions, and tracks CSP violations and external requests.
  - `helpers.mjs:50`, `theme.spec.mjs:9` and `offline.spec.mjs` navigate to `/settings/reading`. `assistant.spec.mjs:405/407` expect "Open AI provider settings". The keyboard step near `assistant.spec.mjs:351-360` stops setting `--rf-assistant-viewport-height` by hand after a reply: it sends a real chat message (stubbed provider response through the real htmx swap and settle) with a reduced visual viewport and asserts that the cap and the visible composer survive the reply, on Chrome and WebKit.
  - Visual: screen key `settings-preferences` keeps its key, with base path `/settings/preferences` and head path `/settings/reading`, through the per-side path mapping `key-screens.spec.mjs` already uses for `catch-me-up` (around line 265; the open() final-path check needs the same mapping). New screens `settings-relevance`, `settings-labels`, `settings-account`, `settings-tokens`, `settings-stats` and `settings-ai` at 1280/390. Only reasoned Settings and Assistant exemptions go in `layout-allow/s7-T8.json`.
- [ ] **RED**, five cases in `tests/e2e/settings.spec.mjs`:
  1. `settings: immediate save, failure and offline`. Toggle "Mark as read on scroll" → toast "Saved" → reload shows it saved. Then route `/settings/field` to 403 → toggle reverts and an error toast appears. Then `context.setOffline(true)` → no request is sent and the toggle reverts. Timezone plus articles per page via sticky Save → "Saved"; `abc` → inline error.
  2. `settings: delayed delete of a label and a filter with Undo`. A label that is a filter's only action is deleted, then Undo: the row is back and no `/settings/deletes` request was made. Delete the label and a filter within 10 s → one batch POST with both items, toast "Turned off 1 filter…", rows gone after reload.
  3. `settings: filter from this source`. Open a feed article → "···" → Filter from this source → the editor has only that feed checked and its title as name → add a condition and save → `/settings/relevance` lists it. A saved-URL article without a feed has no such item. Offline, the item is disabled.
  4. `settings: old bookmarks, stale form and diagnostics`. `/settings/preferences?x=1#offline-diagnostics` lands on `/settings/reading?x=1` with `#offline-diagnostics` in view. `/settings/filters` lands on `/settings/relevance`. A stale POST from an old form still saves. The offline status long-press online opens `/settings/reading#offline-diagnostics`. `/settings` lands on Reading & appearance.
  5. `settings: phone tabs, stored collapsible mode and token shown once`. At 390 px: the Settings tab row is visible, the active tab is in view, and `document.documentElement.scrollWidth <= innerWidth + 1` on every Settings page; on `/settings/tokens` the active tab is "Account" and the secondary row marks API tokens. With `localStorage.sidebar_mode_small = "collapsible"` set by `addInitScript`, `/app` boots with `data-sidebar-mode="hideable-up"`. Creating a token shows it once with Copy; after `page.goBack()` and a reload the value is absent.
- [ ] Run check `t8-e2e`. Expected: the cases fail on stale generated CSS, missing utilities or the old contract. Record the actual evidence; if a case passes already, say so rather than manufacture a failure.
- [ ] **GREEN:** `npm run build` (expected: vendor summary and CSS build exit 0, no vendor or font delta). Then from the repository root: `docker exec rf-int-pg-s3rb dropdb --if-exists --force -U readfine rf_s7_t8_goldens && docker exec rf-int-pg-s3rb createdb -U readfine rf_s7_t8_goldens && cd backend && export SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_s7_t8_goldens && .venv/bin/alembic -q upgrade head && RF_UPDATE_GOLDENS=1 .venv/bin/pytest -q -p no:cacheprovider tests/test_dom_contract_pages.py`. Then `node scripts/check-dom-contract.mjs --write` and `node scripts/check-dom-contract.mjs` (expected `dom-contract: OK`). Review every removed contract entry against the owners' reports (`#sidebar-mode-small` and the label/filter `swap-confirm` uses are expected to go; offline and diagnostics hooks must stay).
- [ ] Run checks `t8-css`, `t8-sources`, `t8-py`, `t8-js`, `t8-e2e`. Expected: `cmp` silent with exit 0; `check:sources` four `OK` lines; pytest `passed`; `# fail 0`; 5 Chrome cases pass.
- [ ] Orchestrator-run acceptance (also in `branchChecks`): `TMPDIR=/var/tmp E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e npx playwright test --project=chrome` (full suite; only existing fixmes, and the known `offline.spec.mjs` logout and `offline-freshness` flakes do not excuse a new failure); `TMPDIR=/var/tmp E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e npx playwright test tests/e2e/settings.spec.mjs tests/e2e/assistant.spec.mjs tests/e2e/sources.spec.mjs --project=webkit` (all pass: Settings, Assistant, Sources); `TMPDIR=/var/tmp E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e RF_VISUAL_BASE=12cc961 RF_VISUAL_MODE=layout npm run test:visual` (expected `layout: A n/n strict`, `B n/n structural`, exit 0). Also a gallery run (`TMPDIR=/var/tmp E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e RF_VISUAL_MODE=gallery RF_VISUAL_DEBUG=1 RF_VISUAL_GALLERY_BASE=1 npm run test:visual`) with every Settings page at 1280/390 under neutral/paper/graphite, light and dark: no clipped tabs, sticky bar or toast, and dark-patch failures 0. Deliver one end-of-segment visual package. Screenshots are not owner approval.

### Task s7-T9: As-built documentation

**Size** S · agent: worker · blocked_by: s7-T8 · verifierRequired: false

**Files:** `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `backend/app/content/features.yml`, `FEATURES.md`.

**Checks** `[{"id": "t9-docs", "name": "docs mention the new contracts", "cmd": "grep -q '/settings/reading' CLAUDE.md && grep -q '/settings/field' CLAUDE.md && grep -q 'data-rf-autosave' CLAUDE.md && grep -q 'Filter from this source' CHANGELOG.md && git diff --check -- README.md CLAUDE.md CHANGELOG.md", "timeoutSec": 60}]`

**Interfaces.**
- Consumes: the as-built behaviour of s7-T1 to s7-T8 and their reports.
- Produces:
  - **CLAUDE.md:** a Settings paragraph covering the nav keys and `settings_subnav`, `POST /settings/field` with `FIELDS`, `data-rf-autosave` and `RFSettings`, sticky `#reading-form` with `/settings/reading/save`, the legacy full POST kept until s8, the moves and the index target, label/filter delayed delete, and Collapsible retired. Update the snapshot note to version 7 and its new hash, and note that "Filter from this source" is in the snapshot. Add the Assistant phone layout note (s6 carry: visual-viewport cap through `--rf-assistant-viewport-height`, re-applied after settle). Update the "body keeps `bg-gray-50` … until … (s7)" line to s8.
  - **README:** where each setting now lives, and immediate save.
  - **features.yml:** the mobile layout text no longer promises a collapsible sidebar; `FEATURES.md` regenerated with `backend/.venv/bin/python ../scripts/gen_features.py` from `backend/`.
  - **CHANGELOG Unreleased:** the s7 user-visible changes (regrouped Settings, immediate save, Undo for label and filter deletes, Filter from this source, Collapsible retired) under Changed and Added. Fold the separate s6 "Fixed" line for behaviour that was never released into its Added entry (s6 carry).
- [ ] Write the three files. Run check `t9-docs`. Expected: exit 0, no output.
- [ ] Hand the spec update to the orchestrator/spec-keeper: as-built behaviour, test results, remaining owner questions and the next and carry lines for `specs/handoff-run-7429291d-8129-432b-beab-c61fff1112cd.md`, `specs/TRACKS.md` and `/projects/readfine/specs/backlog.md`. Those files are outside this task's writes.

Orchestrator pre-approval additions (2026-11-26): WebKit branch check covers Assistant and Sources; CSS build checks use fixed `/var/tmp/claude-rf-*` directories; the Assistant keyboard e2e step uses a real reply; s7-T9 owns the features text. Each backend check owns one database name, so the same check is never run by two agents at once.

## Task table and waves

| ID | Size | blocked_by | Deliverable |
|---|---|---|---|
| s7-T1 | L | — | Settings shell and nav, `/settings` index, `POST /settings/field`, `ui/settings.js`, Collapsible retired |
| s7-T2 | L | — | Reading & appearance page, sticky Save, legacy POST, diagnostics link |
| s7-T3 | L | — | Relevance & filters with Stories and hidden list, filter delayed delete, `?feed=` prefill |
| s7-T4 | L | — | Labels (delayed delete), Account, API tokens (shown once, no-store) |
| s7-T5 | M | — | AI provider and Stats restyle, "AI provider" wording |
| s7-T6 | M | — | s6 carry: viewport cap, setup link, notice shape, CSS layers, heading |
| s7-T7 | M | T1–T6 | moved pages, "Filter from this source", snapshot v7, `Feed(id=18)` flake |
| s7-T8 | L | T7 | CSS, DOM contract and fixtures, Settings e2e, visual |
| s7-T9 | S | T8 | README, CLAUDE.md, CHANGELOG; spec handoff to the orchestrator |

Waves: **1** → {T1, T2, T3, T4, T5, T6}; disjoint writers. T1 with T2–T5 form one designed group: the pages consume `settings/base.html`, `FIELDS` and `data-rf-autosave` from T1, and T2 and T3 split the hidden-stories route. The wave verifier reruns all six task checks on the assembled tree and lists only the generated-file gaps named in Global Constraints. **2** → {T7}. **3** → {T8}. **4** → {T9}.

Planned work norm 585 min (5 × L 90 + 3 × M 40 + S 15); critical path 235 min (90 + 40 + 90 + 15); ratio 2.49, width 6. Wave 4 is a single S task (the advisory `SINGLE_SMALL_WAVE`), kept separate because the method puts the as-built docs after regeneration.

### Segment branch checks

| id | command | timeout |
|---|---|---|
| `pytest-full` | `docker exec rf-int-pg-s3rb dropdb --if-exists --force -U readfine rf_s7_branch && docker exec rf-int-pg-s3rb createdb -U readfine rf_s7_branch && cd backend && export SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_s7_branch && .venv/bin/alembic -q upgrade head && .venv/bin/pytest -q -p no:cacheprovider` | 1800 s |
| `npm-test` | `TMPDIR=/var/tmp PYTHON=backend/.venv/bin/python npm test` | 900 s |
| `check-generated` | `npm run check:generated` | 600 s |
| `check-sources` | `npm run check:sources` | 300 s |
| `e2e-chrome` | `TMPDIR=/var/tmp E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e npx playwright test --project=chrome` (heavy) | 3600 s |
| `e2e-settings-webkit` | `TMPDIR=/var/tmp E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e npx playwright test tests/e2e/settings.spec.mjs tests/e2e/assistant.spec.mjs tests/e2e/sources.spec.mjs --project=webkit` (heavy) | 2400 s |
| `visual-layout` | `TMPDIR=/var/tmp E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e RF_VISUAL_BASE=12cc961 RF_VISUAL_MODE=layout npm run test:visual` (heavy) | 3600 s |

## Carry-over and exclusions

| Item | Disposition |
|---|---|
| Design §5.1 regrouping, §5.2 Settings, wave 7 | T1–T5, T7 |
| Interest profile (s6), Sources pages (s5) | already moved; T5 keeps the profile link, T1 links Sources and Assistant from the Settings nav |
| Q3 "Filter from this source" | T3 (prefill) + T7 (menu, snapshot v7) |
| Retire phone "Collapsible" (s3 owner answer) | T1 |
| s6 carry for s7: settle viewport cap, `input.css` layers, notice-shape test, WRE-1 literal link, cosmetic gap and heading | T6 |
| s6 carry: CLAUDE.md phone note, CHANGELOG Fixed line | T9 |
| s6 later #14 `test_moved_pages` `Feed(id=18)` flake | T7 (same file, small fix) |
| s4-T6 F1 stale comment in `article_detail.html` | T7 (same file, already bumped) |
| s2 carry: dark `tbody divide-gray-100` in settings partials (tokens, stats, ai_cost_table, feeds_stats) | T4, T5 (same files) |
| S4W-F1, S4W-F2 | owner questions, not decided; no change |
| Old-URL sweep of `backend/app` (2026-11-26): `settings/base.html` nav (T1); `filters.py:144/171` redirects and `filter_edit.html:250` Cancel (T3); `preferences.html` form and hidden `hx-get` (T2, file deleted); `nav.py:25` index (T1); `page.js:1383` (T2); `briefing_modal.html:64` (T7). `help.html:64/84/180/332/434/474/512` (filters and preferences links) stay for s8, covered by the 308s; `help.html:569` `/settings/stats` and the `filter_edit.html:20` POST action keep valid URLs; the `articles.py:704` docstring names the legacy `POST /settings/preferences`, still true through the alias until s8 | as listed |
| s8: removal of old aliases (Sources, Assistant, the three new settings moves), `help.html`/legal links and wording, admin `RedirectResponse` import | s8 |
| Later, not included: S3W-F1 sheet Escape; S3W-F3 `lock_timeout`; toast stacking order; `pending.js` > 50 chunking (owner choice); offline `autoAdvance`; T5-R1 Undo after login redirect; T5-R2 star state attribute; `label_picker` OOB; WR8-F5/F6/F7; briefing id int32; `describe_ai_error` fallback; stale `ai-settings.js`/T5 comments; e2e AI-switch cache; phone fullscreen article without Assistant entry; `help.html` "in the reader"; unread `catchup` field in `_ai_availability()`; `MissingGreenlet` and offline-logout flakes; app-theme list kept in four places; iPhone 16 Pro Max report; RuntimeWarnings; alembic drift | not touched by an s7 task, or not small; they stay in the backlog |
| Owner checks: real-iPhone keyboard (s6), visual acceptance s3–s6, double "Add source" heading, > 50 deletes | unchanged; the s7 visual package adds Settings |

## Open questions for owner approval

1. **URL scheme and nav** (Changes 1–2): Preferences → `/settings/reading`, the Filters list into `/settings/relevance`, the other pages keep their URLs; Tokens under Account; `/settings` lands on Reading & appearance instead of Stats/Sources. *Recommendation: approve.* It follows the design table and costs three 308s.
2. **Immediate save versus Save** (Change 3): choices save on change with a "Saved" toast; timezone and number fields keep a sticky Save. *Recommendation: approve.*
3. **Story grouping moves with hidden stories** to Relevance & filters (Change 4). *Recommendation: approve.* The counter only means something next to its choice.
4. **"Filter from this source"** opens the filter editor prefilled with that feed as scope and its title as name. It does not create a filter on its own, and it bumps the offline snapshot to version 7, so devices re-fetch their stored snapshots once. *Recommendation: approve.*
5. **Collapsible retirement migrates silently:** a stored `collapsible` becomes `hideable-up`, and the "Small – sidebar" row disappears. *Recommendation: approve,* since the s3 owner answer already chose retirement.

S4W-F1 and S4W-F2 stay open and are not part of this approval.

## Verified for this plan, and limits

- **Run while planning** (2026-11-26, on HEAD `af0007e`):
  - the database pattern twice on a fresh `rf_s7_dryrun` (drop `--force`, create, `alembic -q upgrade head` to 0131): `16 passed`;
  - full pytest on a probe database: `4101 passed, 16 warnings in 278 s`;
  - `TMPDIR=/var/tmp PYTHON=backend/.venv/bin/python npm test`: `595 pass, 0 fail` in 33 s;
  - the three source checks: `OK`;
  - `node scripts/check-dom-contract.mjs`: `OK (516 items, 76 rendered pages)`;
  - scratch CSS build plus `cmp` against the committed CSS: identical;
  - the E2E DB guard with the required URL: accepted;
  - `npx playwright test --list` for `--project=chrome` (46 tests) and `--project=webkit` (Sources spec);
  - the snapshot closure and hash, printed: `60ff43c1c5f70e34`, matching the pin.

  The probe databases were dropped afterwards.
- **Not run:** any test file this plan creates (they do not exist yet), the Chrome and WebKit e2e suites, the visual layout and gallery runs, and `npm run check:generated` (it rewrites tracked generated files, and this attempt must not edit the product). Their commands are the ones above.
- Anchors checked at HEAD: `preferences.py:49/64/90`, `filters.py:37/52/63/123/147/174`, `nav.py` index, `moved_pages.py` `MOVED_PAGES`, `page.js:1383`, `app.js:97/149/3796`, `init.js:35`, `base.html:155-278`, `mobile_bars.html:95`, `assistant.js:44` `watchViewport`, `assistant/page.html:22` `partition`, `ai.py:128-137`, `input.css` layer 289–813 with Sources 815–849 and Assistant 851–960, `deletes.py` label notice, `pending.js` kinds.
- Container note: `rf-int-pg-s3rb` holds about 18 leftover databases from s4–s6 attempts (for example `rf_s6_t5_a7`, `s6_t1_a15`). They were not created or removed here; cleanup is the orchestrator's decision.

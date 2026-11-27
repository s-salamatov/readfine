# UI redesign s8 — Admin and public pages Implementation Plan

Status: plan / draft · 2026-11-27 · run `run-7429291d-8129-432b-beab-c61fff1112cd`, segment `s8` · execution `native` · product base `selfhost` `b07f8b6` (s1–s7 merged and deployed); inspected HEAD `a4255bc` on `feat/ui-redesign-s8` (the commit after the base changes only specs).

**Goal:** finish the redesign: admin pages and public pages (landing example, features, changelog, help, legal) fully redesigned on the tokens and macros; public pages served without the app's JavaScript; the non-GET aliases of moved pages removed, with a stale tab that posts to one told plainly that the page is out of date; the open s7 Settings carry closed; the backlog item "Redesign UI and animations" closed.

**Architecture:** admin stays on `base.html` with its Basecoat sidebar. Its three page scripts and the admin block of `app.js` merge into one idempotent module, `static/js/ui/admin.js`, loaded from `admin/base.html`. The traffic chart takes two new series tokens. Public pages get their own standalone layout, `templates/public/base.html` (stylesheet plus `init.js` only, as `landing.example.html` already does). Alias retirement removes routes and adds one rule to the existing HTTP exception handler in `main.py`: a non-GET request to a non-API path that no route serves, or that a route serves only for other methods, answers through the existing `_client_error_response` (a toast for htmx, `errors/client.html` otherwise) with "This page is out of date. Reload it and try again.". No tombstone routes. Per-instance live landing copies stay styled through a committed copy of the `b07f8b6` example that the CSS build scans. One regeneration task, then one browser/visual acceptance task, then the as-built docs.

**Tech stack:** Python 3.12 / FastAPI, Starlette 1.0.0, Jinja2, HTMX 2.0.4, Tailwind 4 (`scripts/build-css.mjs`), Basecoat 1.1.0 (vendored), pytest, node:test + jsdom, Playwright 1.64.1 (Chrome `/usr/bin/google-chrome-stable`, WebKit). No new dependencies, no migrations.

**Design:** `docs/arh-w-dev/designs/2026-11-19-ui-redesign-design.md` §5.2 (admin and public pages), §5.4 (moved pages: GET 308 + `no-store` stays; non-GET aliases "until wave 8, which removes them"), §5.5, §5.7 wave 8 and the global rules. Read with `specs/handoff-run-7429291d-8129-432b-beab-c61fff1112cd.md` ("Backlog (carried)", "Open Decisions") and `/projects/readfine/specs/backlog.md` (ui-redesign entries, s7 carry). The s7 plan (`docs/arh-w-dev/plans/2026-11-21-ui-redesign-s7-settings-plan.md`) is the format reference and defines the interfaces reused here: `MOVED_PAGES`/`register_moved_pages`, `RFToast`/`showToast`, `error_toast`, `_client_error_response`, `settings/base.html`, the delayed delete, the visual harness.

**Execution:** `native`, as persisted for this run. Workers do not commit, push, stash, spawn agents, publish, approve or change run state. The orchestrator applies patches, runs checks and reviews, and owns approval.

## Changes from the draft, and decisions this plan makes

The draft had five tasks: T1 L admin + `ui/admin.js`; T2 M public pages; T3 S alias removal; T4 S `app.js` cleanup, contract and CSS; T5 S specs and backlog. Comparing it with the design, handoff, backlog and the code at HEAD:

1. **Admin is split in two (s8-T1 templates L, s8-T2 behaviour M).** Ten admin templates plus six partials and three admin scripts plus the `app.js` block (`app.js` ~3882–3922) are too much for one 90-minute task. The split is by file: templates/tests vs JS/tokens. The interface between them is the existing hook set (ids, `data-*`) plus one change: the A–Z / By host toggle state moves from JS-swapped legacy colour classes to `aria-pressed`.
2. **Public pages are L, not M.** `help.html` alone is 718 lines with deep-link ids and old Settings names and paths. All public pages today extend `base.html` and so load every app script (htmx, `app.js`, offline boot, service-worker registration, Basecoat). The landing has a per-instance live copy (item 5).
3. **Alias retirement is L, not S, and the surface is larger than `MOVED_PAGES`.** Besides the three `MOVED_PAGES` entries with `("GET", "POST")`, there are stacked old decorators: `feeds.py:136` (`/settings/feeds/test`), `:571` (DELETE `/settings/feeds/{id}`); `scrape.py:116/148/239/266`; `folders.py:23/45/78/103/131/151`; `opml.py:53`; `settings/ai.py:525/576` (old generate/revert preference). Twelve backend test files and two JS test files assert the aliases work today.
4. **`POST /settings/ai/preferences` is not an alias.** It is the live AI provider form (`settings/ai.html:106`). Only its stale-tab handling of the interest-profile fields (`_interest_profile_error` at `ai.py:349`, `_apply_interest_profile` at `:389`) is legacy. It keeps its URL. A post that carries `ai_preference_text` or `ai_preference_auto_days` is refused with the out-of-date message and writes nothing (owner question Q2).
5. **Landing survival is a CSS problem.** `backend/app/templates/landing.html` is gitignored (`.gitignore:73`), rendered by `routers/web/auth.py:57–75` only when registration is open and the file exists, and baked into the image by `Dockerfile` `COPY backend/ .` (`.dockerignore` does not exclude it). `input.css` excludes it from scanning (`@source not "./backend/app/templates/landing.html"`), so a live copy is styled only by classes the example happens to use. On sgn-main prod (`/opt/readfine/src`, at `b07f8b65`) there is no live copy; the hosted readfine.app is deployed elsewhere and was not inspected. Rewriting the example would drop classes that live copies still use. Plan: commit a copy of the `b07f8b6` example as a test fixture, add it to the CSS sources, test that its classes are in the built CSS and that it still renders as `landing.html`, and add an upgrade note (Q3).
6. **The draft's "app.js holds no zone code" is dropped.** After s8-T2, `app.js` still holds reader-zone code (keyboard, nav, list, `_showShareToast`). Moving it is not in this segment; it goes to the backlog as a follow-up (Q6).
7. **Regeneration and acceptance are split (s8-T6 M, s8-T7 L).** In s7 the single regeneration/acceptance task took about 290 minutes against a norm of 90, because the defects it found lay outside its write list. Here s8-T6 regenerates; s8-T7 runs the browsers and holds a declared repair surface: CSS by hand (`input.css`, `styles/tokens.css`) and regeneration by command (`tailwind.css`, DOM contract and fixtures). The s7 defects were mostly in templates and scripts, so any defect outside the CSS goes back to its owner as a repair attempt (with reconfirmation), followed by regeneration in s8-T7.
8. **The s7 Settings carry is a task of its own (s8-T5 M).** It covers the stats scroll hint, the filters intro, the prefill length, `filter_edit.html` legacy utilities and the old Settings names.
9. **Specs and backlog are not a product task.** `/projects/readfine/specs/` is outside the worktree and not a git repository. s8-T8 writes the in-repo docs and hands the exact backlog/handoff text to the orchestrator's spec-keeper, including closing "Redesign UI and animations".
10. **`<body class="bg-gray-50 …">` stays** (`base.html:586`). Switching it to `bg-background` would put white cards on a white page in the neutral light theme (`--background: #ffffff`, `--card: oklch(1 0 0)`). The CLAUDE.md promise "until the remaining pages are redesigned (s8)" is replaced by a documented intent: the canvas for card layouts (Q5).
11. **Stale native posts were checked.** All app forms are boosted or htmx, so `csrf.js` adds the token header. A non-htmx POST without that header is refused by the CSRF middleware (403) before routing. So the stale-tab path that matters is htmx. The non-htmx branch is still answered with the page (cheap, and API paths keep JSON).

## Global Constraints

Design requirements, verbatim:

- Every action available today is still reachable, in no more steps than today. Frequent ones (add source, summary, theme, offline, search) take one step.
- No CDN script; CSP unchanged; no `on*` attributes in templates (CI check).
- No hard-coded colours outside the token file, except the listed offline page (CI check).
- `prefers-reduced-motion: reduce` removes all movement, View Transitions included.
- HTMX stays the transport. The server renders partials. The client never builds article markup, except the offline mirror, which keeps doing so.
- old GET paths answer 308 to the new path with `Cache-Control: no-store`, so browsers do not keep the redirect and a revert works;
- old non-GET paths (forms and HTMX endpoints called from stale tabs or a cached offline shell) stay registered as aliases of the same handlers until wave 8, which removes them;
- The toast text is set through `textContent`, never `innerHTML` (feed titles are user data).
- **Admin and public pages:** re-tokened in wave 2, the foundation (colors, fonts, buttons through the macros), fully redesigned last.
- UI language stays English; localization goes to the backlog.
- Light/dark/system and the app theme stay per device (localStorage), as today.

Project rules (CLAUDE.md) and execution constraints:

- Components come from the `templates/ui/` macros; no hand-written Basecoat markup; no `on*` attributes; dialogs and sheets open with `data-rf-open`. HTML returned from Python uses `app/ui_fragments.py`. Tailwind 4 class names only; gray utilities stay `var(--color-gray-*)`; colour literals only in `styles/tokens.css`.
- **WR2-F2/F3:** an element carries exactly one of `hidden` or an unprefixed display class; a runtime toggle swaps both.
- **The snapshot closure is read-only in s8.** Printed from `tests/test_offline_template_version.py::snapshot_closure` at HEAD (version 7, hash `6a5a389617b4977d`): `app/partials/{ai_blocks,archive_button,article_content,article_detail,article_meta_date,article_row,article_title,chat,error_bar,read_button,readable_progress,row_poll,saved_icons,score_badge,share_button,star_icon,story_block}.html` and `ui/{display,forms,nav,overlay,readfine}.html`. No task edits a `templates/ui/*` macro or a closure partial. A need for one returns for an amendment.
- **Generated files have one owner, s8-T6** (with s8-T7's declared repair surface after it): `backend/app/static/css/tailwind.css`, `docs/ui-dom-contract.md`, `backend/tests/fixtures/dom_contract/*`. Wave-1 tasks must not run `npm run build` into the tree or `--write` the contract. Expected wave-1 gaps, and only these: `tests/test_dom_contract_pages.py`, `tests/test_base_dark_controls.py`, `node scripts/check-dom-contract.mjs` / `npm run check:sources` step 4 (stale fixtures and contract: admin scripts merged, hooks moved), `tests/js/tailwind-build.test.mjs` freshness cases if any compare to the committed CSS. E2E and visual are not run in wave 1. Wave verifiers list these gaps by name; nothing else is excused.
- **`input.css` has one writer in waves 1–2: s8-T6.** Wave-1 tasks use utility classes and tokens only. Two shared classes are defined by s8-T6 and used earlier by name: `rf-scroll-x` (a horizontal scroller with edge shadows that show there is more; s8-T1 admin tables, s8-T3 privacy table, s8-T5 stats tables) and nothing else. Any other rule that cannot be a utility is reported to s8-T6.
- **`styles/tokens.css` belongs to s8-T2 in wave 1** (chart tokens only). **`app.js` belongs to s8-T2** (admin block removal only). **`base.html` belongs to s8-T5** (comments only, see Q5).
- Preserve every hook other code binds. Admin: `#admin-nav`, `#feeds-table[data-group-mode]`, `button[data-feeds-group]` with their `hx-get`/`hx-target`/`hx-swap`, `#feed-edit-overlay`, `#rate-limits-overlay`, `#rate-limits-content`, `#legal-section`, `#legal-warning`, `#traffic-closed-note`, `#dormant-url-note`, `#traffic-bars` (buttons only inside), `#traffic-readout`, `#how-to-read`, `.swap-confirm[data-confirm-text][data-confirm-class]`, `[data-expand]`, every `hx-*` URL. Public: the help deep-link ids (`shortcuts`, `import`, `scrape`, `scoring`, `filters`, `regex`, `layout`, `stories` and every other `id` in `help.html` at HEAD), `#features`, the landing JSON-LD and the context names `base_url`, `register_url`, `request.state.csp_nonce`, `static_url`; the `public_header(request)` and `public_footer(request, current="", new_tab=false)` signatures (`auth/login.html` imports `public_footer`). A rename goes with every consumer and is reported to s8-T6 for the contract.
- At most 5 new test cases per task. Existing tests may be updated without weakening them; a test that asserted an alias works is rewritten to assert the alias is gone and the failure is visible. Stop after 3 failed approaches and report. Out-of-scope findings go in the report as "noticed" lines.
- GET redirects stay (`MOVED_PAGES` keeps every entry, GET only). Open owner questions S4W-F1 and S4W-F2 and the s5 owner items are not decided here: no change to mark-all confirmation, the View menu groups, the phone "Add source" double heading or the 50-item delete limit.
- The offline router, policy, sync, IndexedDB, `sw.js` and `static/js/offline/*` stay unchanged. Admin and public pages are online-only.

### Test environment

Checks run under `/bin/sh -c` from the repository root (`/projects/readfine/ui-redesign`), with `uv` (`~/.local/bin`), `node`, `npx` and `docker` on `PATH`. Backend checks use the throwaway container `rf-int-pg-s3rb` on `127.0.0.1:4253`. Each check drops and recreates its own fixed database `rf_s8_<task>`, migrates it and runs pytest from `backend/`. Pattern (shown for s8-T1):

```sh
docker exec rf-int-pg-s3rb dropdb --if-exists --force -U readfine rf_s8_t1 && docker exec rf-int-pg-s3rb createdb -U readfine rf_s8_t1 && cd backend && export SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_s8_t1 && .venv/bin/alembic -q upgrade head && .venv/bin/pytest -q -p no:cacheprovider <files>
```

Expected: alembic INFO lines, then pytest `N passed`, exit 0. Never use port 4250 or the databases `readfine_pytest` or `readfine_test`. Node checks use `TMPDIR=/var/tmp PYTHON=backend/.venv/bin/python node --test <files>`; `TMPDIR=/var/tmp` avoids `/tmp/.gitignore`. E2E and visual runs use only `E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e` (`tests/e2e/db-guard.mjs` refuses anything else; `global-setup.mjs`/`run.mjs` migrate it). They share `readfine_e2e` and ports 4251/4252, so they run only in s8-T7 and in `branchChecks`, never in parallel. The host has little free memory and no swap: heavy checks (`heavy: true`) run one at a time. CSS freshness checks build into fixed `/var/tmp/claude-rf-s8-<task>-css` directories.

## Review Focus

1. **Public pages render without login and without app JS.** `/features`, `/changelog`, `/help`, `/privacy`, `/terms` signed out answer 200 with their content, and their only `<script src>` is `init.js` (the landing adds only its nonce'd JSON-LD); no htmx, `app.js`, offline boot or service-worker registration; with JavaScript disabled the content is fully visible. Signed in, the back link to the reader is there and the script set is the same. → s8-T3 `test_public_pages_render_signed_out_without_app_js`, `test_public_pages_signed_in_keep_back_link_without_app_js`; s8-T7 `public: signed-out pages without app scripts, also with JavaScript off`.
2. **The admin traffic chart is readable in dark mode.** Both series (visitors, views) have at least 3:1 contrast against the card, and at least 1.5:1 against each other, in all six theme/scheme blocks; today the views series (`bg-primary/30`) is about 2.2:1 in neutral dark. → s8-T2 `tokens: chart series keep 3:1 on the card and stay apart in every theme and scheme`; s8-T1 `test_traffic_chart_bars_use_chart_tokens`; s8-T7 `admin: traffic chart readable in dark mode`.
3. **Per-instance `landing.html` customisations survive.** A live copy made from the `b07f8b6` example still renders at `/` as `landing.html` with the same context, and every class it uses is in the built CSS. → s8-T3 `test_live_landing_copy_from_b07f8b6_renders`; s8-T6 `landing compat: every class of the b07f8b6 landing is in the built CSS`.
4. **Old non-GET aliases are gone and GET redirects still work.** Every `MOVED_PAGES` GET still answers 308 + `no-store` to a 200 target with query preserved; every former alias path refuses POST/DELETE without running a handler. → s8-T4 rewritten `test_moved_pages.py` (`test_sources_non_get_alias_matrix` becomes `test_non_get_aliases_gone_and_gets_redirect`, plus the settings and assistant cases), `test_legacy_reading_and_preferences_posts_are_gone`; s8-T7 `stale tab: a post to a removed alias says the page is out of date`.
5. **Legal pages scroll and print on the phone.** At 390 px the page scrolls to its last section with no sideways scroll, a wide table scrolls inside `rf-scroll-x`, and under print media the header links and footer are hidden, text is dark on light whatever the scheme, and nothing is clipped. → s8-T3 `test_legal_pages_print_and_wrap_classes`; s8-T7 `legal: phone scroll and print`.
6. **Admin behaviour is unchanged.** Feeds A–Z / By host persists per device and reloads the table; the rate-limits dialog and feed edit overlay close as before; the legal and traffic switches show and hide their notes; the chart's arrow keys move the readout; admin pages have no sideways scroll at 390 px. → s8-T1 updated `test_restyle_admin_core.py` / `test_restyle_admin_lists.py` hook assertions and `test_admin_pages_load_one_admin_module`; s8-T2 `ui-admin` cases; existing `test_admin_*` / `test_traffic_stats.py`; s8-T7 `admin: grouping, dialogs, switches and chart keys behave as before`.
7. **A tab opened before the deploy that posts to a removed alias fails visibly.** An htmx post gets the error toast "This page is out of date. Reload it and try again." (not the generic "That did not go through"), a non-htmx post gets `errors/client.html` with that message, API paths keep JSON, and nothing is written. A route's own 404 keeps its own answer. → s8-T4 `test_stale_post_to_removed_alias_toasts_out_of_date`, `test_route_own_404_keeps_its_answer`, `test_ai_preferences_refuses_stale_profile_fields`; s8-T7 `stale tab: a post to a removed alias says the page is out of date`.

## File map

One writer per file within a wave. Wave 1: s8-T1…T5. Wave 2: s8-T6. Wave 3: s8-T7. Wave 4: s8-T8. Cross-wave overlap is only s8-T7's declared repair surface (`input.css`, `styles/tokens.css`, `tailwind.css`, DOM contract and fixtures).

| Files | Task |
|---|---|
| `backend/app/templates/admin/*.html` (10), `admin/partials/*.html` (6), `templates/partials/{feed_status,error_text,feed_display}.html`, `routers/web/admin.py`, `backend/tests/test_restyle_admin_core.py`, `backend/tests/test_restyle_admin_lists.py` | s8-T1 |
| Create `static/js/ui/admin.js`; Delete `static/js/{admin-feeds,admin-settings,traffic-chart}.js`; `static/js/app.js`; `styles/tokens.css`; Create `tests/js/ui-admin.test.mjs`; `tests/js/theme-tokens.test.mjs` | s8-T2 |
| Create `templates/public/base.html`; `templates/partials/{public_header,public_footer,back_to_reader}.html`; `templates/{features,changelog,help,landing.example}.html`; `templates/legal/{base,privacy,terms}.html`; Create `backend/tests/fixtures/landing/landing-b07f8b6.html`; `backend/tests/test_restyle_public_pages.py`, `test_restyle_landing.py` | s8-T3 |
| `routers/web/moved_pages.py`, `backend/app/main.py`, `backend/app/utils/htmx.py`, `routers/web/settings/{feeds,folders,scrape,opml,preferences,ai,fields,deletes}.py`, `templates/errors/client.html`, `templates/settings/partials/feeds_list.html`, `templates/app/partials/article_list.html`, `static/js/feeds-settings.js`, `static/js/ui/sources.js`, 12 backend test files and 2 JS test files (task list) | s8-T4 |
| `templates/settings/{stats,relevance,filter_edit}.html`, `settings/partials/{feeds_stats,ai_cost_table}.html`, `routers/web/settings/filters.py`, `templates/app/welcome.html`, `routers/web/app/{welcome,articles}.py`, `services/{preference_values,feed}.py`, `.env.example`, `templates/base.html`, Create `backend/tests/test_settings_s8_carry.py` | s8-T5 |
| `input.css`, `backend/app/static/css/tailwind.css`, `scripts/build-css.mjs` (only if a `FRAGILE_RULES` entry changes), `docs/ui-dom-contract.md`, `backend/tests/fixtures/dom_contract/*`, `backend/tests/test_dom_contract_pages.py`, `backend/tests/test_base_dark_controls.py`, Create `tests/js/landing-compat.test.mjs` | s8-T6 |
| Create `tests/e2e/admin-public.spec.mjs`; `tests/e2e/{sources,settings,assistant}.spec.mjs`, `tests/e2e/fixtures/seed.py`, `tests/e2e/helpers.mjs`, `tests/visual/{gallery-pages,layout}.mjs`, `tests/visual/layout-allow/{s2-T10,s4-T6}.json`, Delete `layout-allow/s7-T8.json`, Create `layout-allow/s8-T7.json`; repair surface `input.css`, `styles/tokens.css`, `tailwind.css`, `docs/ui-dom-contract.md`, `dom_contract/*` | s8-T7 |
| `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `RELEASING.md` | s8-T8 |

## Tasks

### Task s8-T1: Admin pages

**Size** L · agent: worker · blocked_by: — · verifierRequired: true

**Files:**
- `backend/app/templates/admin/base.html`
- `backend/app/templates/admin/dashboard.html`
- `backend/app/templates/admin/feeds.html`
- `backend/app/templates/admin/users.html`
- `backend/app/templates/admin/invitations.html`
- `backend/app/templates/admin/audit_log.html`
- `backend/app/templates/admin/fetch_logs.html`
- `backend/app/templates/admin/settings.html`
- `backend/app/templates/admin/traffic.html`
- `backend/app/templates/admin/scoring_eval.html`
- `backend/app/templates/admin/partials/feed_edit_form.html`
- `backend/app/templates/admin/partials/feeds_table.html`
- `backend/app/templates/admin/partials/users_table.html`
- `backend/app/templates/admin/partials/invitations_table.html`
- `backend/app/templates/admin/partials/rate_limits_modal.html`
- `backend/app/templates/admin/partials/users_count.html`
- `backend/app/templates/partials/feed_status.html`
- `backend/app/templates/partials/error_text.html`
- `backend/app/templates/partials/feed_display.html`
- `backend/app/routers/web/admin.py`
- `backend/tests/test_restyle_admin_core.py`
- `backend/tests/test_restyle_admin_lists.py`

**Checks** `[{"id": "s8-T1-py", "name": "admin templates and routes", "cmd": "docker exec rf-int-pg-s3rb dropdb --if-exists --force -U readfine rf_s8_t1 && docker exec rf-int-pg-s3rb createdb -U readfine rf_s8_t1 && cd backend && export SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_s8_t1 && .venv/bin/alembic -q upgrade head && .venv/bin/pytest -q -p no:cacheprovider tests/test_restyle_admin_core.py tests/test_restyle_admin_lists.py tests/test_admin_feed_grouping.py tests/test_traffic_stats.py tests/test_admin_delete_user.py tests/test_admin_fetch_error_rollup.py tests/test_csp.py tests/test_sources_table.py tests/test_sources_add.py tests/test_sources_forms.py tests/test_scrape.py", "timeoutSec": 900}, {"id": "s8-T1-src", "name": "source checks (tw4, css vars, colours)", "cmd": "node scripts/check-tw4-classes.mjs && node scripts/check-css-vars.mjs && node scripts/check-colours.mjs", "timeoutSec": 120}]`

**Interfaces.**
- Consumes: `templates/ui/*` macros (read-only), tokens, `rf-scroll-x` (defined by s8-T6; until then unstyled), `--rf-chart-visitors` / `--rf-chart-views` (defined by s8-T2), `ui/admin.js` (s8-T2).
- Produces:
  - Every admin page redesigned on the macros and tokens: page header (title, one-line description, primary action), cards, tables inside `rf-scroll-x` (feeds, users, invitations, audit log, fetch logs, scoring eval), badges from `status_badge`, no `gray-*`/`blue-*`/`dark:` palette classes in admin templates and the three shared partials (`feeds.html` 6 and `partials/users_count.html` 3 legacy classes today; `feed_status.html` 10, `error_text.html` 2, `feed_display.html` 1). The s2 carry 9 note that the admin settings sticky Save sits over the SMTP card is unverified: check it at 1280 and 390 in the gallery shots, fix it if reproduced, and report which. `feed_display.html` and `error_text.html` are also imported by `settings/partials/feeds_list.html`, `sources/add.html`, `settings/feed_edit.html` and `settings/scrape_setup.html`: change only colour classes there, so the Sources tests in `s8-T1-py` keep passing.
  - `admin/base.html` loads `{{ static_url('js/ui/admin.js') }}` once in its `scripts` block; `admin/settings.html`, `feeds.html` and `traffic.html` no longer load page scripts.
  - Feeds toggle: `button[data-feeds-group="az"|"host"]` keep their `hx-get`/`hx-target`/`hx-swap` and render `aria-pressed="true|false"` for the server's `group`; the pressed style comes from `aria-pressed:` variants on tokens. No colour class is toggled by JS any more.
  - Traffic chart: visitor bars `bg-(--rf-chart-visitors)`, view bars `bg-(--rf-chart-views)`, the legend swatches the same; `#traffic-bars` still holds only the bar buttons.
  - `admin/partials/feed_edit_form.html:65` posts to `/sources/scrape-preview` (the canonical path that exists at HEAD).
  - `routers/web/admin.py`: the unused `RedirectResponse` import goes (pre-existing carry); no route or behaviour change.
- [ ] **RED**, five new cases (in the two restyle test files):
  1. `test_traffic_chart_bars_use_chart_tokens`: render `admin/traffic.html` with a two-day chart; every button in `#traffic-bars` has the visitors or views token class, and no `bg-primary/30` remains.
  2. `test_admin_pages_load_one_admin_module`: dashboard, settings, feeds, traffic, users each render exactly one `script[src*="js/ui/admin.js"]` and none of `admin-feeds.js`, `admin-settings.js`, `traffic-chart.js`.
  3. `test_admin_tables_scroll_with_hint`: the feeds, users, invitations, audit-log and fetch-logs tables each sit inside an `.rf-scroll-x` element, and the Actions header keeps its `.sr-only` label.
  4. `test_feeds_group_toggle_uses_aria_pressed`: with `group=host` the host button is `aria-pressed="true"`, the A–Z one `"false"`, and neither carries a palette class.
  5. `test_feed_edit_scrape_preview_uses_sources_path`: the edit form's preview button posts to `/sources/scrape-preview` with `hx-include="closest form"`.
  Update the existing hook assertions (`script[src*="js/admin-feeds.js"]`, `js/admin-settings.js`, the `SOURCES` list at `test_restyle_admin_core.py:344` which drops the deleted JS paths, since `check-colours.mjs` already scans `static/js`) without weakening the id, `hx-*` and text lists.
- [ ] Run check `s8-T1-py`. Expected: the five new cases fail (old classes, old scripts, no `rf-scroll-x`, no `aria-pressed`, old path); the rest pass.
- [ ] **GREEN:** restyle the templates and partials; update the hook assertions. Run `s8-T1-py` and `s8-T1-src`. Expected: `passed`, exit 0; three `OK` lines.

### Task s8-T2: Admin behaviour module and chart tokens

**Size** M · agent: worker · blocked_by: — · verifierRequired: true

**Files:**
- `backend/app/static/js/ui/admin.js`
- `backend/app/static/js/admin-feeds.js`
- `backend/app/static/js/admin-settings.js`
- `backend/app/static/js/traffic-chart.js`
- `backend/app/static/js/app.js`
- `styles/tokens.css`
- `tests/js/ui-admin.test.mjs`
- `tests/js/theme-tokens.test.mjs`

**Checks** `[{"id": "s8-T2-js", "name": "admin module and tokens", "cmd": "TMPDIR=/var/tmp PYTHON=backend/.venv/bin/python node --test tests/js/ui-admin.test.mjs tests/js/theme-tokens.test.mjs", "timeoutSec": 300}, {"id": "s8-T2-gone", "name": "old admin scripts and app.js block removed", "cmd": "test -f backend/app/static/js/ui/admin.js && test ! -e backend/app/static/js/admin-feeds.js && test ! -e backend/app/static/js/admin-settings.js && test ! -e backend/app/static/js/traffic-chart.js && ! grep -n 'admin_feeds_group' backend/app/static/js/app.js", "timeoutSec": 30}, {"id": "s8-T2-src", "name": "source checks (tw4, css vars, colours)", "cmd": "node scripts/check-tw4-classes.mjs && node scripts/check-css-vars.mjs && node scripts/check-colours.mjs", "timeoutSec": 120}]`

**Interfaces.**
- Consumes: the admin hooks listed in Global Constraints (rendered by s8-T1); htmx (`htmx.ajax`), `RFToast`.
- Produces:
  - `static/js/ui/admin.js`, `window.RFAdmin = { init(root) }`, guarded so a second load (boosted navigation re-running the block) binds nothing twice. It runs `init(document)` on load and `init(evt.detail.elt)` on `htmx:afterSettle`, and uses delegated listeners on `document`. It absorbs: `admin-feeds.js` (`feedEditDone` closes `#feed-edit-overlay`; a backdrop click closes `#rate-limits-overlay`), `admin-settings.js` (the `hidden` toggles of `#legal-section`, `#legal-warning`, `#traffic-closed-note`, `#dormant-url-note`, again after a boosted save; each toggle swaps `hidden` together with any display class, WR2-F2), `traffic-chart.js` (roving tabindex over `#traffic-bars` buttons, arrow/Home/End keys, `#traffic-readout` text through `textContent`, `#how-to-read`), and the `app.js` admin block (localStorage `admin_feeds_group`, restored with `htmx.ajax('GET', '/admin/feeds/table?group=host', …)`, now setting `aria-pressed` instead of the legacy blue/gray classes). Behaviour, keys and storage keys are unchanged.
  - The three old files are deleted; `app.js` loses lines ~3882–3922 and nothing else.
  - `styles/tokens.css`: `--rf-chart-visitors` and `--rf-chart-views` in all six theme blocks (`html[data-rf-theme=neutral|paper|graphite]` and their `html.dark` variants), each ≥ 3:1 against that block's `--card` and ≥ 1.5:1 against each other.
- [ ] **RED**, five new cases:
  - `tests/js/ui-admin.test.mjs` (jsdom, minimal fixtures with the pinned hooks):
    1. `admin: the feeds grouping persists per device and reloads the table`: clicking By host stores `admin_feeds_group=host` and sets `aria-pressed`; a fresh `init` with that stored value requests `/admin/feeds/table?group=host`.
    2. `admin: dialogs and switches behave as before`: `feedEditDone` closes `#feed-edit-overlay`; a backdrop click closes `#rate-limits-overlay`; turning the legal switch off hides `#legal-section` (both `hidden` and the display class) and shows `#legal-warning`; a simulated `htmx:afterSettle` re-applies the state.
    3. `admin: chart keys move the readout`: ArrowRight/ArrowLeft/Home/End move `tabindex=0` and focus between bar buttons and update `#traffic-readout`.
    4. `admin: loading the module twice binds once`: evaluate the script twice; one click on a grouping button makes one request and one storage write.
  - `tests/js/theme-tokens.test.mjs`:
    5. `tokens: chart series keep 3:1 on the card and stay apart in every theme and scheme`: parse the six blocks (existing `tokenBlocks`), convert `oklch(...)`/hex to sRGB relative luminance (add an `oklch` → linear sRGB helper next to `luminance`), assert ≥ 3:1 for each series against `--card` and ≥ 1.5:1 between the series.
- [ ] Run check `s8-T2-js`. Expected: the five cases fail (no module, no tokens).
- [ ] **GREEN:** write the module and tokens, delete the old files, remove the `app.js` block. Run `s8-T2-js`, `s8-T2-gone`, `s8-T2-src`. Expected: `# fail 0`; `s8-T2-gone` silent, exit 0; three `OK` lines.

### Task s8-T3: Public pages and landing

**Size** L · agent: worker · blocked_by: — · verifierRequired: true

**Files:**
- `backend/app/templates/public/base.html`
- `backend/app/templates/partials/public_header.html`
- `backend/app/templates/partials/public_footer.html`
- `backend/app/templates/partials/back_to_reader.html`
- `backend/app/templates/features.html`
- `backend/app/templates/changelog.html`
- `backend/app/templates/help.html`
- `backend/app/templates/legal/base.html`
- `backend/app/templates/legal/privacy.html`
- `backend/app/templates/legal/terms.html`
- `backend/app/templates/landing.example.html`
- `backend/tests/fixtures/landing/landing-b07f8b6.html`
- `backend/tests/test_restyle_public_pages.py`
- `backend/tests/test_restyle_landing.py`

**Checks** `[{"id": "s8-T3-py", "name": "public pages, landing, CSP", "cmd": "docker exec rf-int-pg-s3rb dropdb --if-exists --force -U readfine rf_s8_t3 && docker exec rf-int-pg-s3rb createdb -U readfine rf_s8_t3 && cd backend && export SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_s8_t3 && .venv/bin/alembic -q upgrade head && .venv/bin/pytest -q -p no:cacheprovider tests/test_restyle_public_pages.py tests/test_restyle_landing.py tests/test_csp.py tests/test_restyle_auth_pages.py", "timeoutSec": 600}, {"id": "s8-T3-src", "name": "source checks (tw4, css vars, colours)", "cmd": "node scripts/check-tw4-classes.mjs && node scripts/check-css-vars.mjs && node scripts/check-colours.mjs", "timeoutSec": 120}]`

**Interfaces.**
- Consumes: `templates/ui/*` macros (read-only), tokens, `rf-scroll-x` (s8-T6), `request.session` for the back link.
- Produces:
  - `templates/public/base.html`: a standalone document like `landing.example.html`: `<!doctype html>`, charset/viewport, title block, favicon links, `{{ static_url('css/tailwind.css') }}`, `{{ static_url('js/init.js') }}` (theme and theme-color before first paint), a `head` block, body `bg-background text-foreground` with `public_header(request)`, `<main>` and `public_footer(request, current=…)`. No other script. It does not extend `base.html`.
  - `features.html`, `changelog.html`, `help.html`, `legal/base.html` (and through it `privacy.html`, `terms.html`) extend `public/base.html`. `public_header`, `public_footer` and `back_to_reader` drop their `gray-*`/`dark:` classes for tokens and keep their signatures.
  - `help.html`: an "On this page" nav (links to the existing section ids, a `<details>` below `sm`); all deep-link ids kept; current names: "Reading & appearance", "Relevance & filters", "Sources", "AI provider", "Account"; canonical links (`/sources`, `/sources/add`, `/sources/opml`, `/settings/reading`, `/settings/relevance`, `/settings/ai`), no `/settings/feeds`, `/settings/opml`, `/settings/preferences`, `/settings/filters`; no "collapsible" sidebar mode (line 439); "in the reader" at line 628 becomes the Assistant page link; the shortcuts list matches the current keys including `/` (S3W-F6); the `data-rf-online-only` link at line 275 stays.
  - Legal: readable measure, headings with `scroll-mt`, `wrap-break-word` on long addresses, the privacy table inside `rf-scroll-x`, `print:` variants that hide header links and footer, force dark text on a light background and drop shadows/borders of cards; `legal/privacy.html` names settings by their current names.
  - `landing.example.html`: redesigned on the same macros, same context (`base_url`, `register_url`, `request.state.csp_nonce`, `static_url`), same strings and hrefs that `test_restyle_landing.py` pins (copy may change only where a string is listed as changed in the report and the test updated with it), still `init.js` + JSON-LD only.
  - `backend/tests/fixtures/landing/landing-b07f8b6.html`: byte copy of `git show b07f8b6:backend/app/templates/landing.example.html`, with one leading Jinja comment saying what it is and that it must not be edited.
- [ ] **RED**, five new cases:
  1. `test_public_pages_render_signed_out_without_app_js` (`test_restyle_public_pages.py`): through the app client, signed out, GET `/features`, `/changelog`, `/help`, `/privacy`, `/terms` → 200, an `h1`, and the set of `script[src]` paths equals `{"/static/js/init.js"}` (query stripped); no `hx-` attribute, no `data-rf-open`. The public templates (`public/base.html`, the three partials, features, changelog, help, legal) contain no `gray-`/`blue-` palette class and no `dark:` variant: off `base.html` they no longer get its inline legacy-dark overrides (`base.html` ~400), so tokens are the only dark styling.
  2. `test_public_pages_signed_in_keep_back_link_without_app_js`: signed in, the same pages show the `/app` back link and the same script set.
  3. `test_help_uses_current_names_and_canonical_links`: every id present in `help.html` at HEAD (kept as a list literal in the test) is present; no old path or name listed above appears; the "On this page" nav links resolve to ids on the page.
  4. `test_legal_pages_print_and_wrap_classes`: privacy and terms render the `print:` hide classes on header links and footer, `wrap-break-word` on the content, and the privacy table inside `.rf-scroll-x`.
  5. `test_live_landing_copy_from_b07f8b6_renders` (`test_restyle_landing.py`): with registration open and the fixture served as `landing.html` (a `ChoiceLoader` with a `DictLoader({"landing.html": fixture})` monkeypatched onto `templates.env.loader`), GET `/` → 200, contains the fixture's title and `register_url`, and the nonce is applied to its JSON-LD.
- [ ] Run check `s8-T3-py`. Expected: cases 1–4 fail (app scripts present, old names, no print classes); case 5 may already pass. If so, report it as a guard, not a RED.
- [ ] **GREEN:** build the layout and pages, copy the fixture. Run `s8-T3-py` and `s8-T3-src`. Expected: `passed`, exit 0; three `OK` lines.

### Task s8-T4: Retire non-GET aliases; stale posts fail visibly

**Size** L · agent: worker · blocked_by: — · verifierRequired: true

**Files:**
- `backend/app/routers/web/moved_pages.py`
- `backend/app/main.py`
- `backend/app/utils/htmx.py`
- `backend/app/routers/web/settings/feeds.py`
- `backend/app/routers/web/settings/folders.py`
- `backend/app/routers/web/settings/scrape.py`
- `backend/app/routers/web/settings/opml.py`
- `backend/app/routers/web/settings/preferences.py`
- `backend/app/routers/web/settings/ai.py`
- `backend/app/routers/web/settings/fields.py`
- `backend/app/routers/web/settings/deletes.py`
- `backend/app/templates/errors/client.html`
- `backend/app/templates/settings/partials/feeds_list.html`
- `backend/app/templates/app/partials/article_list.html`
- `backend/app/static/js/feeds-settings.js`
- `backend/app/static/js/ui/sources.js`
- `backend/tests/test_moved_pages.py`
- `backend/tests/test_sources_add.py`
- `backend/tests/test_sources_forms.py`
- `backend/tests/test_sources_table.py`
- `backend/tests/test_sources_delete.py`
- `backend/tests/test_ui_fragments.py`
- `backend/tests/test_settings_ai_stats.py`
- `backend/tests/test_assistant_profile.py`
- `backend/tests/test_settings_reading.py`
- `backend/tests/test_rate_limit.py`
- `backend/tests/test_scrape.py`
- `backend/tests/test_scrape_ai_selector.py`
- `tests/js/sources-folders.test.mjs`
- `tests/js/ui-sources.test.mjs`

**Checks** `[{"id": "s8-T4-py", "name": "moved pages, Sources, Assistant profile, reading", "cmd": "docker exec rf-int-pg-s3rb dropdb --if-exists --force -U readfine rf_s8_t4 && docker exec rf-int-pg-s3rb createdb -U readfine rf_s8_t4 && cd backend && export SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_s8_t4 && .venv/bin/alembic -q upgrade head && .venv/bin/pytest -q -p no:cacheprovider tests/test_moved_pages.py tests/test_sources_add.py tests/test_sources_forms.py tests/test_sources_table.py tests/test_sources_delete.py tests/test_sources_vary.py tests/test_ui_fragments.py tests/test_settings_ai_stats.py tests/test_assistant_profile.py tests/test_settings_reading.py tests/test_rate_limit.py tests/test_scrape.py tests/test_scrape_ai_selector.py tests/test_csrf_reissue.py tests/test_login_next.py tests/test_restyle_auth_pages.py", "timeoutSec": 900}, {"id": "s8-T4-js", "name": "Sources and offline router JS", "cmd": "TMPDIR=/var/tmp PYTHON=backend/.venv/bin/python node --test tests/js/sources-folders.test.mjs tests/js/ui-sources.test.mjs tests/js/offline-router.test.mjs tests/js/ui-pending.test.mjs", "timeoutSec": 300}, {"id": "s8-T4-gone", "name": "no old non-GET decorators remain", "cmd": "! grep -rnE '@router\\.(post|delete|put|patch)\\(\"/settings/(feeds|folders|folder-order|opml)' backend/app/routers/web/settings && ! grep -rnE '@router\\.post\\(\"/(reading|ai/generate-preference|ai/revert-preference)\"' backend/app/routers/web/settings && ! grep -nE '\"(POST|DELETE|PUT|PATCH)\"' backend/app/routers/web/moved_pages.py", "timeoutSec": 30}, {"id": "s8-T4-src", "name": "source checks (tw4, css vars, colours)", "cmd": "node scripts/check-tw4-classes.mjs && node scripts/check-css-vars.mjs && node scripts/check-colours.mjs", "timeoutSec": 120}]`

**Interfaces.**
- Consumes: `error_toast(message, status)` (`utils/htmx.py`), `_client_error_response(request, status, message)` (`main.py:328`), `errors/client.html` (owned and changed by this task), the `htmx:responseError` rule in `app.js` (~677): a response whose `HX-Trigger` carries `showToast` claims the error and suppresses "That did not go through (HTTP N)".
- Produces:
  - **Callers first:** `feeds_list.html` (lines 6, 8, 66, 82, 133, 212–213) use `/sources/folders/{id}/rename-form`, `/sources/folders/{id}` (DELETE), `/sources/folder-order`, `/sources/folder-order/reset`, `/sources/folders/{id}/move`, `/sources/feeds/{uf.id}/edit`; `article_list.html:265/268` link `/sources` and `/sources/opml`; `feeds-settings.js:39` checks `/sources/feeds-list`; `ui/sources.js:256` no longer maps the old href.
  - **Routes:** `MOVED_PAGES` entries become GET only (the `methods` and `remove_aliases_in` fields go; the helper still answers 308 + `no-store`); the stacked old decorators listed in "Changes" item 3 are removed; `POST /settings/reading` (the full legacy form, `preferences.py:120`) is removed (GET `/settings/reading` and `POST /settings/reading/save` stay); `settings/ai.py` loses `@router.post("/ai/generate-preference")` and `/ai/revert-preference` (the `/assistant/profile/*` routes stay).
  - **Visible failure:** `utils/htmx.py` gains `STALE_PAGE_MESSAGE = "This page is out of date. Reload it and try again."`. In `auth_redirect_handler`, before the existing 404 branch: if the path is not API (the existing `is_api`), the method is not GET/HEAD, and either `exc.status_code == 405` or (`exc.status_code == 404` and `"endpoint" not in request.scope`, meaning no route matched; Starlette 1.0.0 sets `endpoint` on a FULL or PARTIAL match, `routing.py:249`), return `_client_error_response(request, exc.status_code, STALE_PAGE_MESSAGE, hint="")`. `_client_error_response` and the imports it needs move above `auth_redirect_handler`, and it gains `hint: str | None = None`, passed to `errors/client.html`. Today that template always appends " Go back and correct it, then try again." to the message. It now appends the hint instead when one is given (an empty hint appends nothing), so the stale page reads exactly "This page is out of date. Reload it and try again.". The 400/409 safety nets pass no hint and read as today. A route's own 404 (it set `endpoint`) keeps today's answer.
  - **`POST /settings/ai/preferences`:** if the form carries `ai_preference_text` or `ai_preference_auto_days`, answer `error_toast(STALE_PAGE_MESSAGE, 409)` and write nothing (provider fields included); otherwise unchanged. `_interest_profile_error`/`_apply_interest_profile` stay only where `/assistant/profile` uses them.
  - Docstrings in `fields.py:6` and `deletes.py:6` stop naming removed routes.
- [ ] **RED**, five new cases plus rewritten alias tests:
  1. `test_stale_post_to_removed_alias_toasts_out_of_date` (`test_moved_pages.py`): signed in, with `HX-Request` and the CSRF header, POST `/settings/folders` (no route) and POST `/settings/feeds` (GET-only route) → 404 / 405, `HX-Trigger` `showToast` with `STALE_PAGE_MESSAGE` and type `error`, and no folder or subscription was created; the same POST without `HX-Request` → the `errors/client.html` page whose text contains "This page is out of date. Reload it and try again." and not "Go back and correct it"; POST `/api/v1/no-such` keeps its JSON body.
  2. `test_route_own_404_keeps_its_answer`: `POST /htmx/saved-searches/999999/delete` (htmx, signed in; `_own` in `routers/web/app/saved_searches.py:80` raises its own 404) answers exactly as at HEAD (404, the `errors/404.html` page), without the stale message. `errors/client.html` rendered without a hint still reads "Invalid name. Go back and correct it, then try again." (the existing `test_restyle_auth_pages.py:146`, run by `s8-T4-py`).
  3. `test_legacy_reading_and_preferences_posts_are_gone` (`test_settings_reading.py`): POST `/settings/reading` and `/settings/preferences` (htmx) → 405 with the stale toast and no setting changed; `POST /settings/reading/save` still saves.
  4. `test_ai_preferences_refuses_stale_profile_fields` (`test_assistant_profile.py`): a post with `ai_preference_text` → 409 stale toast, profile text and provider fields unchanged; the provider form without those fields saves as before.
  5. `test_sources_callers_use_canonical_paths` (`test_sources_table.py`): the rendered Sources table and empty article list contain no `hx-*` or `href` under `/settings/feeds`, `/settings/folders`, `/settings/folder-order` or `/settings/opml`.
  Rewrite, not weaken: `test_post_alias_calls_same_handler`, `test_sources_non_get_alias_matrix` (now `test_non_get_aliases_gone_and_gets_redirect`: every former alias path and method answers the stale failure; every `MOVED_PAGES` GET still 308 + `no-store` to a 200 target with query kept), `test_settings_moved_pages_redirect_and_alias`, `test_assistant_non_get_compatibility`, line 510; replace the fixed `UserFeed`/`Folder` ids with created rows (T7-R2). Move the old-path requests in `test_sources_add.py` (104–252), `test_sources_forms.py` (260–401), `test_ui_fragments.py:214`, `test_settings_ai_stats.py:83`, `test_assistant_profile.py:287/316–329`, `test_settings_reading.py:150`, `test_scrape.py:930/963`, `test_scrape_ai_selector.py:135`, `test_sources_delete.py:68–70`, `test_sources_table.py:61/138/199–200` and `test_rate_limit.py:437` (`/assistant/profile/generate`) to the canonical paths; `tests/js/sources-folders.test.mjs` and `tests/js/ui-sources.test.mjs` use `/sources/...` for live behaviour and keep one case proving an old-path event is ignored.
- [ ] Run check `s8-T4-py`. Expected: cases 1–5 fail (aliases still answer 200; the generic handler answers 405 as JSON and 404 as the 404 page); rewritten alias tests fail the same way.
- [ ] **GREEN:** callers, routes, handler, AI form. Run `s8-T4-py`, `s8-T4-js`, `s8-T4-gone`, `s8-T4-src`. Expected: `passed`; `# fail 0`; `s8-T4-gone` silent with exit 0; three `OK` lines.

### Task s8-T5: Settings carry and old names

**Size** M · agent: worker · blocked_by: — · verifierRequired: true

**Files:**
- `backend/app/templates/settings/stats.html`
- `backend/app/templates/settings/partials/feeds_stats.html`
- `backend/app/templates/settings/partials/ai_cost_table.html`
- `backend/app/templates/settings/relevance.html`
- `backend/app/templates/settings/filter_edit.html`
- `backend/app/routers/web/settings/filters.py`
- `backend/app/templates/app/welcome.html`
- `backend/app/routers/web/app/welcome.py`
- `backend/app/services/preference_values.py`
- `backend/app/services/feed.py`
- `backend/app/routers/web/app/articles.py`
- `.env.example`
- `backend/app/templates/base.html`
- `backend/tests/test_settings_s8_carry.py`

**Checks** `[{"id": "s8-T5-py", "name": "Settings carry, filters, welcome", "cmd": "docker exec rf-int-pg-s3rb dropdb --if-exists --force -U readfine rf_s8_t5 && docker exec rf-int-pg-s3rb createdb -U readfine rf_s8_t5 && cd backend && export SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_s8_t5 && .venv/bin/alembic -q upgrade head && .venv/bin/pytest -q -p no:cacheprovider tests/test_settings_s8_carry.py tests/test_settings_relevance.py tests/test_settings_ai_stats.py tests/test_welcome_onboarding.py tests/test_app_themes.py tests/test_settings_shell.py", "timeoutSec": 600}, {"id": "s8-T5-names", "name": "no old Settings names in the swept files", "cmd": "! grep -nE 'Settings → (Preferences|Feeds|Profile)|Settings → Relevance($|[^ ]| [^&])|POST /settings/preferences' .env.example backend/app/templates/app/welcome.html backend/app/routers/web/app/welcome.py backend/app/services/preference_values.py backend/app/services/feed.py backend/app/routers/web/app/articles.py backend/app/templates/base.html", "timeoutSec": 30}, {"id": "s8-T5-src", "name": "source checks (tw4, css vars, colours)", "cmd": "node scripts/check-tw4-classes.mjs && node scripts/check-css-vars.mjs && node scripts/check-colours.mjs", "timeoutSec": 120}]`

**Interfaces.**
- Consumes: `rf-scroll-x` (s8-T6); the Settings shell from s7.
- Produces:
  - Stats tables (`stats.html` 303/342/367, `partials/ai_cost_table.html:12`, `partials/feeds_stats.html:4`) sit in `rf-scroll-x` instead of bare `overflow-x-auto` (T8-R5).
  - The Filters intro (`relevance.html:132–139`) stacks above "New filter" below `sm` and sits beside it from `sm` up (T8-R4).
  - `_prefill_from_feed` (`filters.py:63`) cuts the feed title to the editor's 100 characters (on a word boundary when one is within the last 20), so the prefilled form saves (T3 carry).
  - `filter_edit.html` drops its 33 legacy `gray-*`/`blue-*` utilities for tokens; ids, names and `hx-*` unchanged.
  - Names: `welcome.html:22` "Settings → Relevance & filters"; comments/docstrings in `welcome.py:4/117`, `preference_values.py:3`, `feed.py:42`, `articles.py:220/704/944`, `.env.example:87`, `base.html:539/551` use the current names (Reading & appearance, Relevance & filters, Sources, Account) and no removed route. `base.html` changes comments only; the body class stays (Q5).
- [ ] **RED**, five new cases in `test_settings_s8_carry.py`:
  1. `test_stats_tables_scroll_with_hint`: every table on `/settings/stats` (with AI costs and feed stats present) is inside `.rf-scroll-x`.
  2. `test_filters_intro_stacks_on_phone`: the intro row carries `flex-col` with an `sm:flex-row` counterpart, and the button is outside the text block.
  3. `test_prefill_long_feed_title_fits_and_saves`: a 140-character feed title prefills a name of at most 100 characters, and posting that form creates the filter.
  4. `test_filter_editor_uses_tokens`: the rendered editor has no `gray-`/`blue-` palette class and keeps its hooks.
  5. `test_welcome_names_relevance_and_filters`: the welcome screen says "Relevance &amp; filters" and links `/settings/relevance`.
- [ ] Run check `s8-T5-py`. Expected: the five cases fail.
- [ ] **GREEN:** templates, prefill, wording. Run `s8-T5-py`, `s8-T5-names`, `s8-T5-src`. Expected: `passed`; `s8-T5-names` silent with exit 0; three `OK` lines.

### Task s8-T6: Regeneration: CSS, landing compatibility, DOM contract

**Size** M · agent: worker · blocked_by: s8-T1, s8-T2, s8-T3, s8-T4, s8-T5 · verifierRequired: true

**Files:**
- `input.css`
- `backend/app/static/css/tailwind.css`
- `scripts/build-css.mjs`
- `docs/ui-dom-contract.md`
- `backend/tests/fixtures/dom_contract`
- `backend/tests/test_dom_contract_pages.py`
- `backend/tests/test_base_dark_controls.py`
- `tests/js/landing-compat.test.mjs`

**Checks** `[{"id": "s8-T6-css", "name": "committed CSS equals a fresh build", "cmd": "mkdir -p /var/tmp/claude-rf-s8-t6-css && node scripts/build-css.mjs -i input.css -o /var/tmp/claude-rf-s8-t6-css/tailwind.css && cmp backend/app/static/css/tailwind.css /var/tmp/claude-rf-s8-t6-css/tailwind.css", "timeoutSec": 300}, {"id": "s8-T6-sources", "name": "check:sources", "cmd": "npm run check:sources", "timeoutSec": 300}, {"id": "s8-T6-py", "name": "contract, goldens, drift", "cmd": "docker exec rf-int-pg-s3rb dropdb --if-exists --force -U readfine rf_s8_t6 && docker exec rf-int-pg-s3rb createdb -U readfine rf_s8_t6 && cd backend && export SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_s8_t6 && .venv/bin/alembic -q upgrade head && .venv/bin/pytest -q -p no:cacheprovider tests/test_dom_contract_pages.py tests/test_base_dark_controls.py tests/test_offline_drift.py tests/test_offline_template_version.py tests/test_partials_online_unchanged.py", "timeoutSec": 600}, {"id": "s8-T6-js", "name": "npm test", "cmd": "TMPDIR=/var/tmp PYTHON=backend/.venv/bin/python npm test", "timeoutSec": 900}]`

**Interfaces.**
- Consumes: wave 1 as applied.
- Produces:
  - `input.css` (inside `@layer utilities`): `.rf-scroll-x` = `overflow-x: auto` plus scrolling edge shadows built from tokens only (`--card`/`--background` and `color-mix(in oklab, var(--foreground) 18%, transparent)`, `background-attachment: local, local, scroll, scroll`), no literal colour; reduced motion unaffected (no animation). A second `@source "./backend/tests/fixtures/landing/landing-b07f8b6.html";` with a comment: live `landing.html` copies are not scanned, so the classes of the last pre-s8 example stay in the CSS.
  - `tailwind.css` rebuilt with `npm run build` (expected: no vendor or font delta).
  - `tests/js/landing-compat.test.mjs`, one new case: `landing compat: every class of the b07f8b6 landing is in the built CSS`: read the fixture's `class="…"` tokens (Jinja expressions skipped), drop those also used by the current templates (they are covered anyway), and assert each remaining token appears as a selector in `backend/app/static/css/tailwind.css` (escape `:`, `/`, `[`, `]`, `.`, `%`, `(`, `)` as Tailwind does).
  - `test_dom_contract_pages.py` `_pages()` gains `admin_settings`, `admin_feeds`, `admin_traffic` and `help` with deterministic contexts if their hooks are not already rendered; fixtures regenerated (this also refreshes `fixtures/dom_contract/sources.html`, the only golden at HEAD that holds the old `/settings/feeds…`/`/settings/opml` paths; `fixtures/partials_online` and `fixtures/offline_drift` hold none); `docs/ui-dom-contract.md` rewritten with `node scripts/check-dom-contract.mjs --write`. Every removed entry is checked against the s8-T1…T5 reports (expected to go: the old admin script consumers; nothing in the offline or Sources hooks).
  - `test_base_dark_controls.py` re-checked against the remaining legacy goldens without weakening.
  - `scripts/build-css.mjs` only if a `FRAGILE_RULES` entry fails by name.
- [ ] **RED:** add `landing-compat.test.mjs`; run `TMPDIR=/var/tmp PYTHON=backend/.venv/bin/python node --test tests/js/landing-compat.test.mjs`. Expected: fails if the rewritten example dropped classes the fixture uses (record the count); if it passes, say so.
- [ ] **GREEN:** `input.css`, then `npm run build`. Then `docker exec rf-int-pg-s3rb dropdb --if-exists --force -U readfine rf_s8_t6_goldens && docker exec rf-int-pg-s3rb createdb -U readfine rf_s8_t6_goldens && cd backend && export SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_s8_t6_goldens && .venv/bin/alembic -q upgrade head && RF_UPDATE_GOLDENS=1 .venv/bin/pytest -q -p no:cacheprovider tests/test_dom_contract_pages.py`, then from the root `node scripts/check-dom-contract.mjs --write` and `node scripts/check-dom-contract.mjs` (expected `dom-contract: OK`).
- [ ] Run `s8-T6-css`, `s8-T6-sources`, `s8-T6-py`, `s8-T6-js`. Expected: `cmp` silent, exit 0; four `OK` lines; `passed`; `# fail 0`.

### Task s8-T7: Browser and visual acceptance

**Size** L · agent: worker · blocked_by: s8-T6 · verifierRequired: true

**Files:**
- `tests/e2e/admin-public.spec.mjs`
- `tests/e2e/sources.spec.mjs`
- `tests/e2e/settings.spec.mjs`
- `tests/e2e/assistant.spec.mjs`
- `tests/e2e/fixtures/seed.py`
- `tests/e2e/helpers.mjs`
- `tests/visual/gallery-pages.mjs`
- `tests/visual/layout.mjs`
- `tests/visual/layout-allow/s7-T8.json`
- `tests/visual/layout-allow/s2-T10.json`
- `tests/visual/layout-allow/s4-T6.json`
- `tests/visual/layout-allow/s8-T7.json`
- `input.css`
- `styles/tokens.css`
- `backend/app/static/css/tailwind.css`
- `docs/ui-dom-contract.md`
- `backend/tests/fixtures/dom_contract`

**Repair rule:** this task may change `input.css` and `styles/tokens.css` by hand to fix a CSS defect a browser case finds, and may rewrite `tailwind.css` (`npm run build`), `docs/ui-dom-contract.md` and `backend/tests/fixtures/dom_contract/*` by the s8-T6 regeneration commands only, never by hand. A defect anywhere else goes back to its owning task as a repair attempt (the orchestrator reconfirms that task's checks); this task does not edit those files. After any repair, its own or an owner's, this task regenerates, reruns `s8-T6-css`, `s8-T6-sources`, `s8-T6-py` and `s8-T2-js`, and lists each repair in the report.

**Checks** `[{"id": "s8-T7-css", "name": "committed CSS equals a fresh build", "cmd": "mkdir -p /var/tmp/claude-rf-s8-t7-css && node scripts/build-css.mjs -i input.css -o /var/tmp/claude-rf-s8-t7-css/tailwind.css && cmp backend/app/static/css/tailwind.css /var/tmp/claude-rf-s8-t7-css/tailwind.css", "timeoutSec": 300}, {"id": "s8-T7-sources", "name": "check:sources", "cmd": "npm run check:sources", "timeoutSec": 300}, {"id": "s8-T7-allow", "name": "layout exemptions parse; the s7 wildcard file is gone", "cmd": "test ! -e tests/visual/layout-allow/s7-T8.json && node -e \"const fs=require('fs');for (const f of fs.readdirSync('tests/visual/layout-allow').filter((f)=>f.endsWith('.json'))) JSON.parse(fs.readFileSync('tests/visual/layout-allow/'+f,'utf8'))\"", "timeoutSec": 30}, {"id": "s8-T7-e2e", "name": "admin, public, stale-tab and touched specs (Chrome)", "cmd": "TMPDIR=/var/tmp E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e npx playwright test tests/e2e/admin-public.spec.mjs tests/e2e/sources.spec.mjs tests/e2e/settings.spec.mjs tests/e2e/assistant.spec.mjs --project=chrome", "timeoutSec": 2400, "heavy": true}, {"id": "s8-T7-webkit", "name": "admin, public and stale-tab spec (WebKit)", "cmd": "TMPDIR=/var/tmp E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e npx playwright test tests/e2e/admin-public.spec.mjs --project=webkit", "timeoutSec": 1200, "heavy": true}]`

**Interfaces.**
- Consumes: everything above.
- Produces:
  - `tests/e2e/admin-public.spec.mjs`: calls `requireE2eDatabaseUrl()` at collection, follows the `sources.spec.mjs`/`settings.spec.mjs` fixture conventions, tracks CSP violations and external requests.
  - `seed.py`: a `traffic` subcommand that turns traffic stats on and writes a few days of visitor/view counts (the model in `backend/app/models/traffic.py`), plus a `helpers.mjs` wrapper; admin uses the existing `role <email> admin`.
  - `sources.spec.mjs:323` (legacy `/settings/folders` alias accepted) becomes the stale-toast expectation; `assistant.spec.mjs:522` (legacy revert) uses `/assistant/profile/revert`; the stale full-form case in `settings.spec.mjs` expects the stale toast and an unchanged setting.
  - Visual: gallery pages for help (signed in and out), features, changelog, privacy, terms and the admin pages already exist; add a 390 px privacy page if missing. Layout exemptions: delete `layout-allow/s7-T8.json` (its `*` entries describe the s7 diff against `12cc961`; against `b07f8b6` they apply to nothing); remove the `#sidebar-mode-small` / `#detail-mode-small` entries from `s2-T10.json` and the `#offline-diagnostics` entry from `s4-T6.json` when the layout report shows them unused. Add `s8-T7.json` with reasoned entries only; `*` only for `help` and `admin-settings` after their gallery shots are reviewed, exact keys for `settings-relevance` (filters intro) and anything else.
- [ ] **RED**, five cases in `admin-public.spec.mjs`:
  1. `public: signed-out pages without app scripts, also with JavaScript off`: for `/features`, `/changelog`, `/help`, `/privacy`, `/terms`: no script request other than `init.js`, no CSP violation, no external request; in a `javaScriptEnabled: false` context the `h1` and the last section are visible.
  2. `legal: phone scroll and print`: at 390×844, `/privacy` scrolls until its footer is in view, `document.documentElement.scrollWidth <= innerWidth + 1`, the privacy table's scroller has `scrollWidth > clientWidth` and a non-`none` background image; with `emulateMedia({ media: 'print', colorScheme: 'dark' })` the header links and footer are not visible and the body text's luminance contrast against its background is ≥ 4.5:1 with a light background.
  3. `admin: traffic chart readable in dark mode`: seeded traffic, admin, dark scheme in each app theme: sample a visitors and a views bar and the card through a canvas (draw the computed colour, read the pixel) and assert ≥ 3:1 against the card and ≥ 1.5:1 between them.
  4. `admin: grouping, dialogs, switches and chart keys behave as before`: By host persists across reload and the table is grouped; the rate-limits dialog closes on backdrop click; the legal switch hides and shows its section; ArrowRight moves the readout; at 390 px every admin page has no sideways scroll and the admin nav can be opened and a link followed. (Focus moving into the phone nav sheet is not asserted: it is unverified at HEAD and would need `ui/nav.html` or Basecoat, which are read-only here; carry s2-6.)
  5. `stale tab: a post to a removed alias says the page is out of date`: on `/sources`, `htmx.ajax('POST', '/settings/folders', …)` and a boosted form posted to `/settings/preferences` show the toast "This page is out of date. Reload it and try again." (not "That did not go through"), and after reload no folder was created and the setting is unchanged; `GET /settings/feeds?x=1` still lands on `/sources?x=1`.
- [ ] Run `s8-T7-e2e`. Expected: cases fail on missing seed data or utilities (record the evidence; if a case passes already, say so).
- [ ] **GREEN:** seed command, spec updates, layout exemptions, CSS repairs under the rule above. Run `s8-T7-css`, `s8-T7-sources`, `s8-T7-allow`, `s8-T7-e2e`, `s8-T7-webkit` (one heavy run at a time). Expected: `cmp` silent; four `OK` lines; silent exit 0; all Chrome and WebKit cases pass.
- [ ] Orchestrator-run acceptance (also in `branchChecks`, one heavy run at a time): `e2e-chrome`, `e2e-touched-webkit`, `visual-layout` (expected `layout: A n/n strict`, `B n/n structural`, exit 0; the report lists which exemptions applied). Plus one gallery run, `TMPDIR=/var/tmp E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e RF_VISUAL_BASE=b07f8b6 RF_VISUAL_MODE=gallery RF_VISUAL_DEBUG=1 RF_VISUAL_GALLERY_BASE=1 RF_VISUAL_LANDING=1 npm run test:visual`, covering every admin and public page at 1280/390 under neutral/paper/graphite, light and dark: no clipped table, chart or sticky bar; dark-patch failures 0. Deliver one end-of-segment visual package. Screenshots are not owner approval.

### Task s8-T8: As-built documentation

**Size** S · agent: worker · blocked_by: s8-T7 · verifierRequired: false

**Files:**
- `README.md`
- `CLAUDE.md`
- `CHANGELOG.md`
- `RELEASING.md`

**Checks** `[{"id": "s8-T8-docs", "name": "docs carry the s8 contracts", "cmd": "grep -q 'public/base.html' CLAUDE.md && grep -q 'ui/admin.js' CLAUDE.md && grep -q 'This page is out of date' CLAUDE.md && grep -q 'landing' RELEASING.md && grep -q 'landing' CHANGELOG.md && ! grep -n 'until s8' CLAUDE.md && git diff --check -- README.md CLAUDE.md CHANGELOG.md RELEASING.md", "timeoutSec": 60}]`

**Interfaces.**
- Consumes: the as-built behaviour and reports of s8-T1…T7.
- Produces:
  - **CLAUDE.md:** admin behaviour in `static/js/ui/admin.js` (`RFAdmin`, loaded from `admin/base.html`, `aria-pressed` grouping, chart tokens `--rf-chart-*`); public pages on `templates/public/base.html` with no app JS; the landing compatibility fixture and `@source`; `rf-scroll-x`; moved pages are GET-only, and a non-GET to a removed path answers "This page is out of date. Reload it and try again." through `_client_error_response`; `POST /settings/ai/preferences` refuses profile fields; replace every "until s8" phrase (old POST aliases, `/settings/ai/preferences` stale-tab form, the `bg-gray-50` body line, now stated as intentional).
  - **README:** admin and public pages; where settings live (if any wording still names old pages).
  - **CHANGELOG Unreleased:** redesigned admin and public pages; public pages no longer load the app's scripts; old form addresses retired (stale tabs ask for a reload); traffic chart contrast; under an "Upgrading" note: a live `landing.html` made from an older example keeps working, and copying the new example is optional.
  - **RELEASING.md:** before a release that changes `landing.example.html`, keep the previous example as a compatibility fixture, as s8 did.
- [ ] Write the four files. Run `s8-T8-docs`. Expected: exit 0, no output.
- [ ] Hand the spec material to the orchestrator/spec-keeper (outside this task's writes): the handoff Summary for s8, the closing of the carry sections it settles, the remaining carry (the "left" rows below), `specs/TRACKS.md` line, and for `/projects/readfine/specs/backlog.md` → `backlog-resolved.md`: close **Redesign UI and animations** (done in s1–s8, PRs #1–#8 and the s8 PR) and the s7 carry items 1–4 and the parts of 5–7 this segment closes; add the new follow-ups (Q6 and the "left" rows).

## Task table and waves

| ID | Size | blocked_by | Deliverable |
|---|---|---|---|
| s8-T1 | L | — | admin templates on macros/tokens, tables in `rf-scroll-x`, chart token classes, `aria-pressed` toggle |
| s8-T2 | M | — | `ui/admin.js` (three scripts + `app.js` block), chart tokens with contrast test |
| s8-T3 | L | — | `public/base.html` without app JS; features, changelog, help, legal, landing example; landing fixture |
| s8-T4 | L | — | callers on canonical paths; non-GET aliases removed; stale-post toast/page; AI form refuses profile fields |
| s8-T5 | M | — | stats scroll hint, filters intro, prefill length, editor tokens, old names |
| s8-T6 | M | T1–T5 | `rf-scroll-x`, landing `@source` + compat test, CSS, DOM contract and fixtures |
| s8-T7 | L | T6 | admin/public/stale-tab e2e, touched specs, layout exemptions, CSS repairs |
| s8-T8 | S | T7 | README, CLAUDE.md, CHANGELOG, RELEASING; spec material to the orchestrator |

Waves: **1** → {T1, T2, T3, T4, T5}, disjoint writers; T1 and T2 are one designed pair (hooks and `aria-pressed` interface above). The wave verifier reruns all five tasks' checks on the assembled tree and excuses only the generated-file gaps named in Global Constraints. **2** → {T6}. **3** → {T7}. **4** → {T8}.

Planned work norm 495 min (4 × L 90 + 3 × M 40 + S 15); critical path 235 min (90 + 40 + 90 + 15); ratio 2.11, width 5. Wave 4 is a single S task (the advisory `SINGLE_SMALL_WAVE`), kept separate because the method puts the as-built docs after acceptance.

### Segment branch checks

| id | command | timeout |
|---|---|---|
| `pytest-full` | `docker exec rf-int-pg-s3rb dropdb --if-exists --force -U readfine rf_s8_branch && docker exec rf-int-pg-s3rb createdb -U readfine rf_s8_branch && cd backend && export SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_s8_branch && .venv/bin/alembic -q upgrade head && .venv/bin/pytest -q -p no:cacheprovider` | 1800 s |
| `npm-test` | `TMPDIR=/var/tmp PYTHON=backend/.venv/bin/python npm test` | 900 s |
| `check-generated` | `npm run check:generated` | 600 s |
| `check-sources` | `npm run check:sources` | 300 s |
| `e2e-chrome` | `TMPDIR=/var/tmp E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e npx playwright test --project=chrome` (heavy) | 3600 s |
| `e2e-touched-webkit` | `TMPDIR=/var/tmp E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e npx playwright test tests/e2e/admin-public.spec.mjs tests/e2e/sources.spec.mjs tests/e2e/settings.spec.mjs tests/e2e/assistant.spec.mjs --project=webkit` (heavy) | 2400 s |
| `visual-layout` | `TMPDIR=/var/tmp E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e RF_VISUAL_BASE=b07f8b6 RF_VISUAL_MODE=layout npm run test:visual` (heavy) | 3600 s |

`e2e-touched-webkit` covers the zones this segment touches (admin and public pages, Sources callers, the Settings stale form, the Assistant profile path). Heavy checks run one at a time.

## Carry-over and exclusions

carryOver is empty. Every open ui-redesign carry item (handoff "Backlog (carried)", backlog ui-redesign entries), with its decision. "Left" rows go to the backlog with the reason given.

| ID | Item | Decision |
|---|---|---|
| s7-1 | Stats tables clipped at 360 px without a scroll hint (T8-R5) | s8-T5 (+ `rf-scroll-x` in s8-T6) |
| s7-2 | Filters intro squeezed at 360 px (T8-R4) | s8-T5 |
| s7-3a | Old Settings names: `.env.example:87`, `welcome.html:22`, `welcome.py`, `preference_values.py`, `feed.py`, `articles.py`, `base.html` comments | s8-T5 |
| s7-3b | Old names in `help.html` (incl. 439 "collapsible") and `legal/privacy.html` | s8-T3 |
| s7-3c | Old names in `fields.py` docstring | s8-T4 |
| s7-3d | Old names in comments of `sw.js`, `init.js`, `offline/boot.js`, `offline/page.js` | left: comment-only; these files belong to the offline shell (a `sw.js` byte change updates the worker on every device); fold into the next offline change |
| s7-4 | Remove legacy POST `/settings/reading`, `/settings/preferences`, the profile part of `/settings/ai/preferences`, old Sources POST/DELETE aliases; update table links first (= s5 carry "s8 table links") | s8-T4 |
| s7-5a | `layout-allow/s7-T8.json` `*` on six Settings screens (T8-R3) | s8-T7 (deleted) |
| s7-5b | `layout-allow/s2-T10.json` stale `#sidebar-mode-small` key (T8-R10); s4-T6 F2 stale `#offline-diagnostics` / s2-T10 reasons | s8-T7 |
| s7-5c | Refused save under the offline worker untested (T8-R6) | left: Settings/offline test gap outside the s8 zones; backlog |
| s7-5d | Token Copy never clicked in e2e (T8-R9) | left: Settings test gap; backlog |
| s7-5e | `test_moved_pages.py` fixed UserFeed/Folder ids (T7-R2; s6 flaky-test note) | s8-T4 |
| s7-6a | T2-R1 stale Preferences tab after full POST gets a page without `ui/settings.js` | closed by s8-T4 (the full POST is gone; the stale tab gets the out-of-date toast) |
| s7-6b | T2-R2 timezone select lost region groups (optgroup in `ui/forms.html`) | left: `ui/forms.html` is in the offline snapshot closure; needs a version bump of its own |
| s7-7a | T3 prefill of a feed title over 100 characters | s8-T5 |
| s7-7b | T3 Stories kept-out counter updates only on next visit | left: Relevance behaviour, not s8 zone |
| s7-7c | `filter_edit.html` legacy gray/blue utilities | s8-T5 |
| s7-8 | T4-F7 deleted label name counts as taken during Undo | left: needs server-side pending-delete awareness; backlog |
| s7-9 | T6 setup-link wording differs (chat, Catch me up, `catchup.py`) | left: accepted as planned in s7 |
| s7-10 | arh-w-dev policy-enforcer `"ask"` verdict | left: tooling outside the product |
| s7-11 | sgn-main memory pressure | handled by the one-heavy-check-at-a-time rule; stays a tooling note |
| s6-1 | `help.html` ~628 "in the reader"; unread `catchup` field in `_ai_availability()` | text: s8-T3; field: left (Assistant code, not s8 zone) |
| s6-2 | WR8-F5/F6/F7, int32 briefing id 500, `describe_ai_error` raw fallback, stale comments, jsdom focus trap, gallery limits | left: Assistant/AI zone; backlog |
| s6-3 | e2e AI-switch cache, section-row rule on Catch me up, offline-disabled inserted links, no Assistant entry from a phone full-screen article | left: Assistant zone |
| s6-4 | Unstable tests: rare `MissingGreenlet` in the Sources redirect test; offline logout replay | left: not reproduced; backlog (the fixed-id part is s7-5e) |
| s6-5 | iPhone keyboard check; iPhone 16 Pro Max offset report | left: owner checks on a device |
| s5-1 | Double "Add source" heading on the phone sheet; >50 deletes → 422 | left: owner questions, not decided here |
| s5-2 | Website candidate selection without a browser case; WebKit OPML export network-only | left: Sources test gaps |
| s5-3 | Env notes (`TMPDIR`, Jinja2 in venv, e2e DB), mutation testing not configured | left: environment/tooling |
| S4W-F1, S4W-F2 | mark-all confirmation when the server is unreachable; View groups in special views | left: open owner questions, not decided |
| S4W-F5 | "Marked N" counts hidden story members | left: reader zone |
| s5-4 | 15 backend RuntimeWarnings (`AsyncMock`, `app_settings_cache.py:34`, `translation_service.py:723`); WebKit offline-logout defect on prod | left: not reproduced here; offline/test hygiene, backlog |
| s4-1 | `ui/readfine.html` docstring and "Labeled" vs sidebar "Labels" | left: `ui/*` read-only (snapshot closure) |
| s4-2 | `test_mark_all_undo.py` case where read handlers only clear `suppressed_by` | left: reader test gap |
| s4-3 | `articles.py:979` whitespace note | left: s8-T5 edits only the comments at 220/704/944 in that file; style nit, backlog |
| s4-4 | `article_list.html` `saved_only+search` header branch unreachable | left: reader logic; s8-T4 edits only the two empty-state links |
| s4-5 | T5-R1 Undo treats any 200 (also a followed login redirect) as restored | left: read zone (`read.js`), backlog |
| s4-6 | T5-R2 star colour keyed on `title="Remove star"` | left: needs snapshot closure + offline mirror + version 8 |
| s4-7 | T5-R3 translated-title toggle in `read.js` without a JS test | left: reader test gap |
| s4-8 | Unused `--rf-legacy-dark-loading-veil` token | closed before s8: no occurrence at HEAD (grep of `styles`, `input.css`, templates, JS) |
| s4-9 | `hideable-up` hides View / mark-all of a saved search on the phone (`base.html`) | left: reader shell; s8-T5 edits `base.html` comments only |
| s4-10 | `label_picker.html` gray out-of-band trigger (+ 3 drift adapter entries) | left: offline drift/snapshot side; backlog |
| s4-11 | `sw.js:85` import-failure fallback page unchanged (R5) | left: offline shell |
| s4-12 | T4-R1 offline chips by sidebar names vs online `get_folder_order` | left: offline zone |
| s4-13 | `check-dom-contract.mjs` misses `startsWith` hook reads | left: tooling; s8-T6 reviews removed entries by hand |
| s4-14 | 390 px article meta line without source name | left: reader zone, owner intent unknown |
| s4-15 | s4-T6 F1 stale `article-detail-menu` comment in `article_detail.html:29–30` | left: snapshot closure (a byte change bumps the version) |
| s4-16 | s4-T6 F2 `#offline-diagnostics` exemption in s4-T6.json; stale s2-T10 reasons | s8-T7 (with s7-5b) |
| s4-17 | s4-T6 F3 Basecoat tab polling in `gallery-pages.mjs:90`; F4 extra "s4" in `offline.spec.mjs:76` | left: harness nits; s8-T7 does not touch those lines |
| s4-18 | `app.js` toggles legacy row-title classes `text-gray-800/900` | left: reader zone of `app.js` (Q6) |
| s4-19 | Wave notes: form-encoded stamp, offline mark-all not undoable, "Nothing to restore", old `html.dark` CSS rules, swipe hooks, contract items, article sync/progress, e2e locators, accepted Ask count and keyboard tests, T5 worktree npm failures | left: recorded constraints/history of the reader zone; the old CSS rules stay for a reader-zone cleanup |
| S3W-F1 | Phone sidebar sheet not closed by Escape; inert only on list and article | left: reader shell |
| S3W-F2 | `_showShareToast` alias in `app.js` (8 occurrences) | left: reader zone of `app.js` (Q6) |
| S3W-F3 | `batch_lock` `pg_advisory_lock` without `lock_timeout` (`deletes.py`) | left: s8-T4 edits only the `deletes.py` docstring; behaviour change out of scope, backlog |
| S3W-F4 | Desktop sidebar rows not reachable by Tab (pre-existing) | left: reader shell |
| S3W-F5 | j/k/m/s/Shift+A and Escape passed through the account menu | closed in s4-T5 (result-s4) |
| s3-1 | s3-T12 F1–F4: `pending.js` timer-vs-navigation flush test, `settled()` without deadline, weak Undo check, swatch `aria-*` test | left: shell/pending test gaps |
| s3-2 | s3-T12 noticed: `markDue` on `Date.now`, unknown kind no-op, Offline reading checkmark, Color label not tied to swatches, webServer before migration | left: pending/offline/Labels; backlog |
| s3-3 | WebKit palette forced-server-error text (`shell.spec.mjs:104/118`) | left: shell zone |
| s3-4 | New Undo toast behind an older one | left: toast stack order, not s8 zone |
| s3-5 | `pending.js` does not split batches > 50 | left: tied to the open s5 owner question |
| s3-6 | `offline/router.js` does not pass `opts.autoAdvance` | left: offline zone |
| s3-7 | Bare-text 404s in `catchup.py`, briefing test-send `<p>` | closed in s6 (handoff) |
| s3-8 | AI chat retry keyed on `.text-red-500` | closed in s4 (`data-chat-error`) |
| S3W-F6 | Stale `/` text in `help.html`; theme location in `CHANGELOG.md` | help: s8-T3; CHANGELOG: s8-T8 |
| s2-1 | `<body class="bg-gray-50">` vs bar `--background` | left by decision (Q5), documented in s8-T8 |
| s2-2 | Legacy palette in `app.js` | left: reader zone (Q6) |
| s2-3 | `alert_html` live role; `admin_test_smtp` success markup | closed before s8: `alert_html(live=True)` gives `role="status"` for default/success and `admin.py` ~349–395 renders all three outcomes through it (read at HEAD) |
| s2-4 | App-theme list kept in four places | left: Settings/boot code, not s8 zone |
| s2-7 | Stale `// until s2-T21` exemption in `theme-tokens.test.mjs` | closed before s8: no occurrence at HEAD (grep) |
| s2-5, s2-8 | Macro defects (`motion.js` cap, `ui/nav.html` breakpoint, `attrs` `style`, href scheme) | left: `templates/ui/*` read-only in s8 (snapshot closure) |
| s2-6 | Static theme-color meta; swatch names; admin nav overlay focus/inert | meta: closed (created by `init.js`); swatches: closed in s7; admin nav focus/inert: left (unverified; the sheet comes from `ui/nav.html` + Basecoat, read-only here); s8-T7 reports what it observes |
| s2-9 | Admin feeds/users and privacy tables clip at 390; admin settings sticky Save over SMTP | s8-T1, s8-T3 |
| s2-10 | Taste: Graphite dark radios, Paper dark panel, changelog prose greys | changelog greys: s8-T3; rest left (owner taste) |
| s2-11 | Two toast systems | left: `RFToast` is the rule; the `app.js` alias is S3W-F2 |
| s2-12…15 | lightningcss nondeterminism, fresh e2e DB order, mutation config, offline story "· read" | left: tooling/offline |
| s1-* | Visual read-state flake, tw4 guard static only, `/tmp/.gitignore`, s1 minor notes, date inputs 2 px | left: tooling/accepted |
| i18n | Translation pass for new UI strings | left: backlog, as required |
| pre-1 | `admin.py:10` unused `RedirectResponse` | s8-T1 (verified unused: one occurrence, the import) |
| pre-2 | `alembic check` drift, `/tmp/.gitignore`, offline flakes, duplicate tab-panel ids, offline mark-all without confirm | left: outside the s8 zones |
| new | `app.js` still holds reader-zone code after s8 | left: backlog follow-up (Q6) |

## Open questions for owner approval

Approving the plan approves the recommendation of each; S4W-F1/S4W-F2 and the s5 questions stay open and are not touched.

- **Q1. How does a stale post to a removed alias fail?** Recommended: one rule in the HTTP exception handler (non-API, non-GET, 405 or no-route 404) answers through `_client_error_response`: htmx gets the toast "This page is out of date. Reload it and try again.", other requests the `errors/client.html` page. Alternative: keep tombstone routes per old path that answer 410 (more code, the list rots). Without either, htmx shows the generic "That did not go through (HTTP 405)".
- **Q2. `/settings/ai/preferences`.** Recommended: keep the URL (it is the live AI provider form) and refuse only a post that carries the old interest-profile fields, with the same message and status 409. Alternative: move the provider form to a new URL (churn with no gain).
- **Q3. Live `landing.html` copies.** Recommended: keep the `b07f8b6` example as a fixture that the CSS build scans, test its classes and rendering, and add an upgrade note. Alternative: note only (live copies may lose styles silently).
- **Q4. Public pages leave `base.html`.** Recommended: a standalone `public/base.html` with the stylesheet and `init.js` only: no htmx, toasts, palette, offline boot or service-worker registration on help, features, changelog and legal (they use none of them; help's one `data-rf-online-only` link keeps working as a plain link). Checked at HEAD: `base.html` draws no app navigation, tab bar or palette on these pages and `sw.js` does not cache `/help`; a signed-in reader sees the same header, back link and content, so no action takes more steps. What goes away on these pages is script behaviour only (app shortcuts and offline scripts). Alternative: keep `base.html` and accept the app scripts.
- **Q5. The `bg-gray-50` body.** Recommended: keep it as the canvas for card layouts (it resolves per theme through `--color-gray-*`, and dark maps it to `--background`) and document it; switching to `bg-background` puts white cards on white in neutral light. Alternative: `bg-muted` (a visible change on every non-reader page; needs a gallery review of its own).
- **Q6. `app.js` zone code.** Recommended: s8 moves only the admin block; the reader-zone remainder (keyboard, nav, list, `_showShareToast`, legacy row classes) goes to the backlog as one follow-up. Alternative: split it now (outside the admin/public scope, large).

## Verified for this plan, and limits

Run at HEAD `a4255bc`:

- `docker exec rf-int-pg-s3rb dropdb/createdb rf_s8_dryrun` + `alembic -q upgrade head` + `pytest` on `test_moved_pages.py`, `test_restyle_public_pages.py`, `test_restyle_landing.py`, `test_restyle_admin_core.py`, `test_restyle_admin_lists.py`, `test_admin_feed_grouping.py`, `test_traffic_stats.py`, `test_offline_template_version.py`: **119 passed** (database dropped afterwards).
- `TMPDIR=/var/tmp PYTHON=backend/.venv/bin/python npm test`: **608 tests, 608 pass, 0 fail**.
- `node scripts/check-tw4-classes.mjs && node scripts/check-css-vars.mjs && node scripts/check-colours.mjs && node scripts/check-dom-contract.mjs`: four `OK` lines (`dom-contract: OK (541 items, 80 rendered pages)`).
- Scratch CSS build into `/var/tmp/claude-rf-s8-plan-css` + `cmp` with the committed CSS: identical.
- `npx playwright test --list --project=chrome` with the e2e env: 51 tests in 9 files; the WebKit list for sources/settings/assistant: 18 tests in 3 files.
- Snapshot closure printed through `snapshot_closure(templates.env)` (22 files, listed above); version 7, hash `6a5a389617b4977d` in `services/sync/__init__.py`.
- Code facts cited above were read at HEAD: the stacked decorators (`grep '@router.(post|delete)'`), `MOVED_PAGES`, `auth_redirect_handler` and `_client_error_response` in `main.py`, `error_toast`, Starlette 1.0.0 `routing.py:249` (`endpoint` set on match), the CSRF middleware reads the header only, admin scripts' only references are the admin templates, public pages contain no `hx-`/`<form>`/`data-rf-open`, `.gitignore:73` / `Dockerfile` / `.dockerignore` for `landing.html`, the absent live copy in `/opt/readfine/src`, tokens are `oklch` (so the contrast test needs an `oklch` conversion).
- The grep/test-style checks were dry-run at HEAD and fail as they should before the work: `s8-T2-gone` (no `ui/admin.js`), `s8-T4-gone` (old decorators such as `folders.py:23/45`, 3 old `@router.post` paths, `("GET", "POST")` in `MOVED_PAGES`), `s8-T5-names` (exactly the 11 known old-name lines; the corrected "Settings → Relevance &amp; filters" does not match), `s8-T7-allow` (`s7-T8.json` present; all allow files parse). `git diff --check` on the four s8-T8 docs passes today.
- `validate_plan` (complex) on `phases.json`: valid; one advisory warning, `SINGLE_SMALL_WAVE` (s8-T8); work norm 495, critical path 235, ratio 2.11, width 5. `phases.json` and this plan come from one generator (`stage-attempts/plan/6/work/gen.py`), which asserts that every check command appears verbatim here.

Not run: `npm run check:generated` (needs a clean tracked tree after build), every task check that depends on code not yet written, the e2e and visual suites (heavy; only listed), `test_auth`/CSRF-related files named in task checks (exist; not executed here). The readfine.app deployment of `landing.html` was not inspected. The handler-404 example route in s8-T4 case 2 is a suggestion for the worker to confirm.

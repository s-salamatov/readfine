# UI redesign s6 — Assistant zone Implementation Plan

Status: plan / candidate · 2026-11-25 · run `run-7429291d-8129-432b-beab-c61fff1112cd`, segment `s6` · product base `selfhost` `d6a4f93`; inspected HEAD `ebcc10d`, branch `feat/ui-redesign-s6` (the intervening commit changes only handoff/backlog/track documentation).

**Goal:** one reachable Assistant page containing article/general chat, Catch me up with period and feed/folder scope, briefing schedules in a sheet, and the interest profile, preserving the shipped reader AI panel and old callers.

**Architecture:** reuse the current AI, digest, briefing and profile services; add presentation/context adapters, not a new retrieval engine. Extract the existing chat controller from `app.js` into `ui/assistant.js`, keep `catchup.js` as its digest/schedule companion, and compose server-rendered sections on `/assistant`. Use the shipped moved-pages helper for the old Catch me up bookmark and preserve action aliases through s8; finish with one generated-assets/contract/browser/visual/docs task.

**Tech stack:** Python/FastAPI, SQLAlchemy async, Jinja2, HTMX 2.0.4, Tailwind 4.3.5, Basecoat 1.1.0, anime.js 4.5.0 through `RFMotion`, pytest, node:test/jsdom, Playwright. Node >=22.22.2; CI uses Node 24. No new dependencies, migrations, provider calls in tests, or changes to AI prompts/models/billing/scheduler algorithms.

**Design:** `docs/arh-w-dev/designs/2026-11-19-ui-redesign-design.md` §5.1, §5.2 Assistant, §5.4, §5.5, §5.7 wave 6, §6 and §8a. Read with `specs/handoff-run-7429291d-8129-432b-beab-c61fff1112cd.md`, especially s3/s4/s5 and carry. Project-wide specs live in `/projects/readfine/specs/`, not a new ledger in this worktree.

**Execution:** `hc-fork`, inherited from the run assignment. Workers do not commit, push, spawn agents, publish, approve, or alter run state. The orchestrator owns approval and task dispatch; this candidate is not implementation authorization.

## Changes from the draft and explicit design delta

- **Five tasks in three waves**, preferring fewer, larger reviewable units: page/chat, digest/schedules, profile; routing/assembly; final regeneration/acceptance/docs. IDs are `s6-T1` … `s6-T5`; all sizes L (90 minutes each). Draft routing/controller work is split between its actual owners; draft contract and specs tasks are combined into the final task, as in s5. One visual acceptance at the end.
- **Scope delta for owner confirmation at plan approval:** design §2/§5.2 and the draft describe article/feed/folder/everything chat. Current `htmx_general_ai_chat` and `chat_with_article` support one attached article or no article context, not corpus retrieval. Orchestrator instruction during this planning attempt selects **“This article” / “Everything (general)”** only. The latter explicitly says “General conversation; your library is not searched.” Feed/folder/library retrieval chat is deferred; feed/folder scope remains fully available in Catch me up. No disabled feed/folder chat controls imply that retrieval exists.
- Chat is **one awaited HTML POST response**, not streaming or polling. Preserve the optimistic bubble, pending indicator, error/retry and phone keyboard behaviour. The existing **digest job** polls every 3 seconds; retain and test that separately.
- s4 already delivered Summary/Context/Ask, `[data-show-chat-modal]` and article chat. Retain those one-click article interactions and their stored article history. The new page uses the same chat controller and existing general endpoint with optional article context; it does not rebuild the AI panel or silently erase stored article conversations on scope change.
- s5 already delivered parameterized redirects, Sources, `RFDialog.open`, toasts and pending deletes. Reuse them. Assistant has no pending-delete feature; saved-config deletion retains its current semantics.
- The interest form must not POST its two fields to the broad AI-preferences form: that handler also assigns provider/model and enable flags. A narrow profile adapter is required to preserve unrelated settings. `/settings/ai` still hosts keys/models/prompts/cost and remains reachable through s8; moving its whole GET would strand provider setup.

## Global Constraints

Applicable design requirements, verbatim:

- **CSP:** `script-src 'self' 'nonce-…'`, no `unsafe-eval`; `style-src 'self' 'unsafe-inline'`. Basecoat JS and anime.js are vendored under `/static/js/vendor/`; no CDN. `htmx.config.allowEval=false` stays; no `hx-on`, no `js:` values, no trigger filters.
- **Asset versioning:** `static_url()` appends a content hash; new vendored files use it.
- HTMX stays the transport. The server renders partials. The client never builds article markup, except the offline mirror, which keeps doing so.
- Every action available today is still reachable, in no more steps than today. Frequent ones (add source, summary, theme, offline, search) take one step.
- The toast text is set through `textContent`, never `innerHTML` (feed titles are user data).
- old GET paths answer 308 to the new path with `Cache-Control: no-store`, so browsers do not keep the redirect and a revert works;
- old non-GET paths (forms and HTMX endpoints called from stale tabs or a cached offline shell) stay registered as aliases of the same handlers until wave 8, which removes them;
- Forms inside dialogs and sheets set their own `hx-swap`/`hx-target`.
- UI language stays English; localization goes to the backlog.
- Light/dark/system and the app theme stay per device (localStorage), as today.

Execution constraints:

- Use existing `ui/forms.html`, `ui/display.html`, `ui/nav.html`, `ui/overlay.html` macros and semantic tokens. No new literal colours, UI framework, CDN or inline handler. Keep the Tailwind `@custom-variant hover (&:hover)` compatibility rule; add **no hover media wrappers**. Existing reader-only hover rules are outside scope.
- Themes are `neutral|paper|graphite`, each light/dark. Motion uses `RFMotion`; reduced motion suppresses animation and smooth scrolling without delaying input. No custom focus trap; use `RFDialog.open(dialog, opener)` and native dialog close.
- Authentication, CSRF, limiter decorators, per-user article/config access, normalization, message/history limits, recipient caps, timezone behaviour, AI gating and token accounting stay intact. Secrets never enter URLs, toast text, session storage or fixtures. No real SMTP/AI calls in validation.
- Assistant is **online-only**, including chat, digest estimates/generation/polling, saved configs, briefings and profile generation/save/revert. Mark controls/entry links `data-rf-online-only`; controllers check `navigator.onLine === false`, `RFOffline.page.current()?.isOffline()` when present, and disabled/`aria-disabled` state before requests. Physical offline, forced offline and server failure must not enqueue an operation or show false success.
- Preserve existing offline policy: full navigations outside `/` and `/app` fall back to the self-contained 503 offline page; unknown `/htmx/*` requests get `needsConnection`, not a queued mutation; `/settings/*` and `/assistant/*` non-navigation actions are unclaimed. The Assistant page is never a new shell launch path. No `offline/router.js`, `policy.js`, sync or IndexedDB architecture edits are planned.
- **Snapshot version remains 6, hash `60ff43c1c5f70e34`.** Do not edit snapshot roots/include closure: `article_detail.html`, `article_row.html`, `chat.html`, shared UI macros or row context helpers. The page gets its own chat presentation template. Existing article modal markup is retained and controller-only changes preserve its DOM contract. If a necessary repair changes that closure, return for an explicit plan amendment/version bump; do not re-pin released v6 in place.
- `ui/assistant.js` is loaded once, statically and versioned from `base.html` after `app.js`; it works on reader and Assistant pages. `catchup.js` becomes idempotent and null-safe on boosted swaps; it is also loaded statically from `base.html`, with its old page-local include removed. No dynamic imports. Asset discovery through `src` remains sufficient for the offline shell.
- Page layout: `assistant/page.html` extends `base.html`; a heading and links to Read, Sources, Settings; sections Chat, Catch me up, Briefings (saved configurations) and Interest profile. `#assistant-main`, `#assistant-chat`, `#assistant-catch-up`, `#assistant-profile` are stable anchors. No duplicate reader/sidebar data pipeline. Chat and digest state are independent. Scope/section changes have real URLs and browser back/forward works; do not rely on an unparsed hash to preserve a bookmark's meaning.
- The new page's thread is session-local to that rendered page. A changed scope clears its transcript, draft and pending UI, sets hidden `history` to `[]`, and announces “New conversation” with the selected scope. It does not issue DELETE to another article's stored conversation. Legacy article modal clear/history remains unchanged. Existing owner-keyed general-modal storage is not reused for the page, preventing a stale general thread from overriding an article scope.
- At most **5 new test cases per task** across Python/JS/browser. Cases named below are the budget; existing tests may be updated without weakening assertions. No hidden test multiplication through parameterization. Stop after three failed approaches and report evidence. Canonical owners report selector changes; only s6-T5 regenerates committed CSS/DOM fixtures.

### Test environment and exact command conventions

All commands run at repository root unless wrapped below. `PY` and `JS` in task steps are literal shell functions:

```bash
export SECRET_KEY=ci-test-secret-key-0123456789abcdef
export ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd
export E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e
PY() { (cd backend && .venv/bin/pytest -q "$@"); }
JS() { TMPDIR=/var/tmp node --test "$@"; }
```
Expected: exit 0, definitions set, no output. `TMPDIR=/var/tmp` avoids the host's `/tmp/.gitignore '*'` Tailwind-build failure. Template JS tests must use `process.env.PYTHON` before local `backend/.venv/bin/python`; s5 CI already installs Jinja2 in a venv and supplies `PYTHON`. Do not add a CI dependency on a repository-local backend venv.

Before backend tests, check the existing container and binding:

```bash
docker port rf-int-pg-s3rb 5432/tcp
docker exec rf-int-pg-s3rb pg_isready -U readfine
```
Expected: `127.0.0.1:4253` and `accepting connections`. Missing container/dependencies or a different binding are blockers, never grounds to fall back to the default production 4250 DSN. Each backend worker creates its own ephemeral DB; below replace only `s6_t1` with its stable task slug:

```bash
RF_S6_DB="rf_s6_t1_${RANDOM}"
docker exec rf-int-pg-s3rb createdb -U readfine "$RF_S6_DB"
export DATABASE_URL="postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/$RF_S6_DB"
trap 'docker exec rf-int-pg-s3rb dropdb --if-exists -U readfine "$RF_S6_DB"' EXIT
(cd backend && .venv/bin/alembic upgrade head)
```
Expected: create/migrate exit 0, head reached; trap removes only this task's DB. No worker drops the container or a pre-existing shared DB. Full pytest and browser tests run serially in s6-T5.

Before **any e2e/visual server, seed or migration**, validate the explicit E2E DSN:

```bash
node --input-type=module -e "import {requireE2eDatabaseUrl} from './tests/e2e/db-guard.mjs'; requireE2eDatabaseUrl(); console.log('E2E DB guard OK')"
(cd backend && DATABASE_URL="$E2E_DATABASE_URL" .venv/bin/alembic upgrade head)
```
Expected: `E2E DB guard OK`, migration exit 0. Guard requires PostgreSQL, loopback, explicit non-4250 port, database `readfine_e2e`, no query/fragment or ambiguous authority. Obtain exclusive use of the throwaway e2e DB before seeding; it is not a parallel worker DB. Read the host port registry before using the existing 4251/4252 app/fixture ports; no new port allocation. Chrome executable is `/usr/bin/google-chrome-stable`. Do not silently skip required DB tests because a fixture reports unavailable.

Early source checks, before final regeneration:

```bash
node scripts/check-tw4-classes.mjs
node scripts/check-colours.mjs
```
Expected: both `OK`, exit 0. Do not run `npm run build` in parallel workers. Optional temporary CSS is ephemeral: in a separate shell:

```bash
RF_S6_CSS=$(mktemp -d)
trap 'rm -r "$RF_S6_CSS"' EXIT
node scripts/build-css.mjs -i input.css -o "$RF_S6_CSS/tailwind.css"
```
Expected: build exit 0 and scratch removed on exit; no committed CSS change. Browser/visual acceptance waits for s6-T5.

## Review Focus

1. **Scope changes with a reply still in flight, back/forward, or another account's stored general chat.** A visibly new thread contains no stale reply/draft/history; no article record is erased. → s6-T1 `assistant: scope changes isolate pending replies and history`; s6-T5 `assistant: chat and article entry on phone`.
2. **Slow chat response, provider failure, 403/429, login redirect or a phone keyboard.** One HTMX POST, visible pending state, readable response, preserved retry text and reachable Send; no fictitious chat streaming/polling. → s6-T1 `test_assistant_chat_response_and_access`, `assistant: lifecycle retains article retry and phone viewport`; s6-T5 chat case.
3. **A saved briefing, invalid schedule, missing/deleted/foreign config and delayed digest job.** Save updates the visible list without reload; validation leaves the sheet/input intact; unavailable config is an alert, polling remains user-bound and terminates. → s6-T2 tests 1–5; s6-T5 `assistant: digest and briefing sheet`.
4. **Missing main model/key/custom endpoint, disabled chat/scoring or no SMTP.** Assistant remains reachable with precise setup instructions; unsupported actions do not send paid requests. Profile edits never reset provider/model/preferences. → s6-T1 `test_assistant_chat_setup_states`, s6-T3 `test_assistant_profile_save_is_narrow` and `test_assistant_profile_generation_and_gates`; s6-T5 setup/profile cases.
5. **Old Catch me up bookmarks, stale form submissions, offline/forced offline and reconnect.** Bookmark lands on Catch me up, aliases retain handler/dependencies, no cached reader shell is misrepresented as Assistant and no writes queue. → s6-T4 tests 1–5; s6-T5 `assistant: bookmarks aliases and offline`.

## File map

Repository-relative paths; **Create** means absent at planning time. Braces below are finite expansions. A row is the sole writer in its wave; sequential reuse is limited to the named concern and requires rerunning predecessor checks. Read-only dependencies are not write permissions.

| Exact files and responsibility | Wave 1 | Wave 2 | Wave 3 |
|---|---|---|---|
| **Create** `backend/app/templates/assistant/{page,chat}.html` — composed page and new page-only chat macro | s6-T1 | | |
| **Create** `backend/app/static/js/ui/assistant.js` — shared chat lifecycle, scope and online guard | s6-T1 | | |
| `backend/app/routers/web/app/ai.py` — explicit Assistant response representation, access/gating | s6-T1 | | |
| `backend/app/static/js/app.js` — extract chat/config blocks, retain unrelated app state | s6-T1 | | |
| `backend/app/templates/base.html` — static script tags; `input.css` — all `.rf-assistant-*`/briefing sheet styles | s6-T1 | | |
| `tests/js/ui-read.test.mjs` — load extracted controller for existing chat retry regression | s6-T1 | | |
| **Create** `backend/tests/test_assistant_chat.py`, `tests/js/ui-assistant.test.mjs` | s6-T1 | | |
| `backend/app/routers/web/app/catchup.py` — reusable context, digest/briefing rendering and carry alerts | s6-T2 | s6-T4: remove old page handler/decorator only | |
| `backend/app/templates/app/catch_me_up.html` — temporary full-page wrapper around extracted section | s6-T2 | s6-T4: delete unused wrapper after move | |
| **Create** `backend/app/templates/assistant/catchup.html` — digest/config sections and sheet host | s6-T2 | | |
| `backend/app/templates/app/partials/{briefing_modal,catchup_configs_list}.html`, `backend/app/static/js/catchup.js` — existing fields, sheet/list lifecycle, extracted config actions | s6-T2 | | |
| **Create** `backend/tests/test_assistant_catchup.py`, `tests/js/ui-assistant-catchup.test.mjs` | s6-T2 | | |
| `backend/app/routers/web/settings/ai.py` — narrow profile adapter, shared validation, canonical/legacy handlers | s6-T3 | | |
| `backend/app/templates/settings/ai.html` — replace profile editor with direct link; `backend/app/static/js/ai-settings.js` — relinquish profile counter | s6-T3 | | |
| **Create** `backend/app/templates/assistant/{profile,profile_feedback}.html`, `backend/tests/test_assistant_profile.py` | s6-T3 | | |
| **Create** `backend/app/routers/web/app/assistant.py`; `backend/app/routers/web/app/__init__.py` — assembly/context/route inclusion | | s6-T4 | |
| `backend/app/routers/web/moved_pages.py`, `backend/tests/test_moved_pages.py` — one new page move, preserve helper | | s6-T4 | |
| `backend/app/templates/app/partials/{sidebar,mobile_bars,palette}.html`, `backend/app/static/js/ui/shell.js` — canonical entry URLs/comments | | s6-T4 | |
| `backend/app/static/js/offline/templates.js` — sidebar mirror; `backend/tests/fixtures/offline_drift/{sidebar-rail,sidebar-full,sidebar-empty}.html` — matching navigation goldens | | s6-T4 | |
| `tests/js/{offline-router,offline-worker-nav,ui-shell}.test.mjs` — offline assertions and existing nav expectations | | s6-T4 | |
| **Create** `tests/e2e/assistant.spec.mjs` — five acceptance flows; `tests/e2e/read.spec.mjs` — existing DB guard carry only | | | s6-T5 |
| `backend/app/static/css/tailwind.css`, `docs/ui-dom-contract.md`, `backend/tests/test_dom_contract_pages.py` | | | s6-T5 |
| `backend/tests/fixtures/dom_contract/{main,sidebar,login,preferences,sources,sources_add}.html`; **Create** `backend/tests/fixtures/dom_contract/{assistant,assistant_briefing}.html` | | | s6-T5 |
| `tests/visual/{gallery-pages,key-screens.spec,layout}.mjs`; **Create** `tests/visual/layout-allow/s6-T5.json` | | | s6-T5 |
| `README.md`, `CLAUDE.md`, `CHANGELOG.md` — as-built behaviour and carry handoff | | | s6-T5 (last) |

`chat.html`, article snapshots, AI panel, pending/toast/dialog modules, email briefing template, service algorithms, `.github/workflows/ci.yml` and `tests/e2e/db-guard.mjs` remain read-only. The existing email management link follows the Catch me up 308; email redesign is expressly out of scope.

## Tasks

### Task s6-T1: Assistant page presentation and shared chat lifecycle

**Size** L · agent: worker · **blocked_by:** —

**Files:** all s6-T1 rows in the file map. No catchup/settings router or article-template edits. Own every segment edit to `app.js` and `input.css`.

**Interfaces.**
- Produce `assistant/page.html`, extending `base.html`, consuming `user`, `section` (`chat|catch-up|profile`), `chat_available`, `chat_setup`, `article` (authorized object or None), `catchup_context`, `profile_context`. Render `assistant/chat.html`; include the T2/T3 sections with their context dictionaries. Its scripts block loads the existing versioned `scope-selector.js` and `label-selector.js`, as the old Catch me up page does; keep each include once. In T1 template tests only, use `DictLoader` stand-ins for those two not-yet-applied sections; the assembled wave and T4 use real templates.
- Produce page-only macro `assistant_chat_area(messages, article_id=None, article_title="", error="")` in `assistant/chat.html`. Root `#rf-assistant-chat`; visible scope select `#assistant-chat-scope`, options `general` and `article` (article offered only with authorized context), visible scope explanation and `role=status` new-thread announcement. Keep page fields `#general-chat-history`, `#general-chat-article-id`, `#general-chat-include-article`, `#general-chat-input`, `#general-chat-submit`, `#general-chat-messages` for the shared controller; this page never includes the old general modal. A visible, labelled Send button must work on touch without a keyboard Enter key.
- Page submit stays `POST /htmx/ai-chat`, explicit `hx-target="#rf-assistant-chat"`, `hx-swap="outerHTML"`; hidden fields remain `message`, `history`, `include_article`, `article_id`. `_render_general_chat_area(messages, error="", *, assistant=False, article_id=None, article_title="") -> str` chooses the new macro only when `htmx_general_ai_chat` observes `HX-Target: rf-assistant-chat`; other callers retain the existing macro. Add `Cache-Control: no-store`, `Vary: HX-Target` to dual representations. Context flags are presentation hints, never access authorization.
- For the Assistant representation, `include_article=on` requires a valid accessible ID via `_get_article_access`; missing/foreign/stale ID produces a generic inline `data-chat-error`, no provider call and no private title, rather than silently answering in general scope. Preserve the legacy endpoint's existing caller semantics outside this representation. Successful article-context messages still use the existing accounting/append behaviour; the page never loads that stored history implicitly.
- Produce `window.RFAssistant = { init(root=document), setScope(kind, articleId=null), isOffline() }`. `setScope` accepts only `general|article`; maintains a page generation counter, aborts its pending HTMX XHR, clears history/draft/messages and re-enables Send, sets article inclusion, announces the new conversation. Stamp requests at `htmx:beforeRequest`; ignore stale responses/errors at `htmx:beforeSwap`/error handlers even when abort races with a reply. A detached/replaced root cannot receive a delayed response. No new thread model or storage table.
- Move the complete AI chat IIFE from `app.js` (starts at :3944 in the inspected tree) into the module, retaining article modal behaviour and owner-keyed legacy general session restoration. Use existing global `getCsrfToken`, `showToast`, `_claimHtmxError` only where the extracted block currently needs them; no copied toast implementation. Keep the `data-chat-error` retry hook, Enter/Shift+Enter, attachment controls, scroll and visualViewport listeners; detach listeners on close/navigation.
- `app.js` also relinquishes `closeBriefingModal` event, config menu/rename helpers and only config branches of its shared `data-action` handler (:2509–2616 and config branches :2646–2675 in the baseline; identify by names, not blind line deletion). T2 takes those behaviours into `catchup.js`. Do not delete the shared keyboard/navigation handler or unrelated action branches. Native dialog detection already covers the new briefing sheet.
- T1 supplies a delegated `ai_preference_text`/`pref-char-count` input counter in `assistant.js` for T3, with threshold 5000; T3 removes the old counter. T1 owns CSS hooks `.rf-assistant-layout`, `.rf-assistant-chat`, `.rf-assistant-transcript`, `.rf-assistant-compose`, `.rf-assistant-briefing-sheet`: min-width/min-height 0, local wrapping/scrolling, safe-area bottom padding, responsive sheet, visualViewport sizing on phone, no new global reader style.

**RED — exactly 5 new cases:**
1. `test_assistant_chat_template_contract`: render real page/chat with safe fixture sections; assert `len(select('#rf-assistant-chat')) == 1`, `name=history` decodes to `[]`, explicit target/swap, visible Send and escaped hostile article title; no article option when `article is None`, no feed/folder option, exact general-scope disclosure.
2. `test_assistant_chat_response_and_access`: mock provider transport, not access checks; page submits in article/general mode render the same page root and correct context fields. Assert `provider_context == normalized_owned_article` or `None`; invalid/foreign IDs and empty message make zero provider calls; simulated provider error renders `data-chat-error` and keeps previous history. Old `/htmx/ai-chat` and per-article responses keep old roots; retain existing limits/accounting tests.
3. `test_assistant_chat_setup_states`: absent settings/main model/key/custom endpoint and disabled AI/chat map to actionable copy/link to `/settings/ai` (admin-disabled state says contact administrator), disabled Send and zero calls. Use `quality_slot_blocker` for key/endpoint distinctions; do not treat “some key exists” as readiness. HTML contains no secrets.
4. JS `assistant: scope changes isolate pending replies and history`: start article request, switch general, deliver old success/error; assert history `[]`, old message absent, `include_article` false, restored Send and “New conversation”; switch back stays fresh and sends no DELETE. Different owner `_gchat_*` data cannot populate the page. Duplicate initialization produces one send, including after a body swap.
5. JS `assistant: lifecycle retains article retry and phone viewport`: existing article Ask opens its modal; on page or modal, pending POST disables repeated send, escaped optimistic text appears, success scrolls, provider/403/429/network/login failures restore draft once with inline error. Simulated visualViewport shrink keeps composer within bounds and releases listeners on detach. Offline/force-offline sends zero requests; repeated profile textarea OOB swap leaves one functional counter; reduced-motion has no running typing animation.

- [ ] Run `PY tests/test_assistant_chat.py` and `JS tests/js/ui-assistant.test.mjs`. Expected RED: missing Assistant root/representation/controller assertions fail, not missing third-party modules. T1's setup-state test uses the same planned context contract as T4; keep assertions against template/adapters until the route exists.
- [ ] **GREEN:** implement page/macro, representation/access handling and shared controller above. Reuse `quality_slot_blocker` and existing availability rules to produce `chat_setup` in the T1 helper `assistant_chat_context(user, db, article_id=None) -> dict` in `app/ai.py`; T4 consumes it. It supplies authorized `article`, `chat_available`, `chat_setup` (safe text/link, no secrets); an inaccessible requested article is a generic unavailable state, not general chat silently.
- [ ] Extract the named blocks; load the two static scripts from `base.html`. T2 removes the old catchup page-local tag in the same wave. Update existing `ui-read.test.mjs` harness to load `ui/assistant.js`; retain its retry assertions and unchanged Ask contract.
- [ ] Run `PY tests/test_assistant_chat.py tests/test_ai_chat.py tests/test_ai_input_guards.py tests/test_ai_summary_context.py` and `JS tests/js/ui-assistant.test.mjs tests/js/ui-read.test.mjs tests/js/keyboard-shortcuts.test.mjs`. Expected GREEN: `passed`, `# fail 0`.
- [ ] Run the two early source checks. Expected: `OK`. Report selector additions/removals and CSS hooks to T5. No screenshot acceptance here.

**Done:** real legacy article/general chat still works through the extracted controller; page presentation and adapter are testable without inventing feed retrieval. The new full-page route is deliberately assembled in T4.

### Task s6-T2: Catch me up and briefing schedules in one section

**Size** L · agent: worker · **blocked_by:** —

**Files:** all s6-T2 entries. Consume T1 CSS hooks; no `app.js` or `input.css` write.

**Interfaces.**
- Extract current `catchup_page` context into `async catchup_page_context(user, db) -> dict` in `catchup.py`. Retain existing keys (`catchup_available`, `ai_scoring_available`, `user_feeds`, `labels`, `saved_configs`, `default_catchup_prompt`, `custom_prompt_max`, `period_descs`, `smtp_available`, `main_model_configured`), supplying safe defaults even when unavailable. Keep timezone fallback and per-user queries. The temporary old page wrapper includes `assistant/catchup.html`; T4 consumes this same context and removes the wrapper/old page handler.
- `assistant/catchup.html` owns `#assistant-catch-up`, `#catchup-form`, `#catchup-result`, `#catchup-estimate`, `#catchup-configs-list-wrapper`, configuration save/name controls, scope/label selectors, period JSON and `#rf-briefing-sheet` / `#rf-briefing-sheet-body`. Preserve period values `today|yesterday|7days`, scope serialization, labels, status, score threshold/availability, snippet, article limit, custom/default prompt, estimate/cost, copy, save/load/generate/rename/delete, schedule status/last error. No domain defaults or limits change.
- Reuse all existing `/htmx/catch-me-up/*` and `/htmx/catchup-configs*` actions. `briefing_modal.html` becomes sheet content, retaining `#briefing-form`, `#briefing-form-error`, `#briefing-test-result`, interval/day/time/recipient field names and ownership checks. Sheet open uses `RFDialog.open`; save still explicitly targets `#catchup-configs-list-wrapper` with `innerHTML`, returning `_catchup_configs_list_html` plus the existing `closeBriefingModal` event. Controller closes after successful list swap, not on validation/transport errors; focus goes to matching config action or section heading if the original node was replaced. No redundant list-refetch endpoint.
- A 404 for missing/foreign config uses `alert_html('Configuration not found.', variant='destructive', live=True)` with status **404**; do this for update/rename/briefing GET/save/test. Sheet load handles non-2xx and login/offline documents explicitly; list failures leave existing list intact. Replace the successful test-mail `<p>` with the existing alert macro/helper and retain `data-briefing-test-ok`, 5-second notice lifetime and 1/minute rate limit. Never mask a failed send as success.
- Refactor `catchup.js` to `window.RFCatchup = { init(root=document) }`, guarded once with delegated listeners and per-root initialized state. Move the config helpers/branches T1 removes into this file. Existing `openBriefingModal`/`closeBriefingModal` global aliases may remain for legacy callers; sheet lifecycle has one owner. Timers and pending estimate/sheet XHRs are cancelled on detach; request generations reject old config/estimate responses and followed login pages. Init handles missing period JSON and both `DOMContentLoaded`/`htmx:afterSettle`.
- Preserve 300 ms estimate debounce and `_digest_progress` `hx-trigger="load delay:3s"`, with explicit `#catchup-result` target. Stop polling when the section leaves the document, a terminal result arrives, or offline mode begins; no new digest on retrying a poll, no duplicate digest on a repeated Generate. This is existing job transport, not chat streaming. Scope selections remain isolated from chat scope.

**RED — exactly 5 new cases:**
1. `test_assistant_catchup_section_and_scope`: context/template retain all named controls, labels, periods, limits and selected serialized feed/folder scope; no subscriptions/configs and main-model missing cases render useful empty/setup states. Assert one form/list wrapper/sheet, scoped targets and escaping of hostile config names.
2. `test_assistant_briefing_save_and_validation`: owned saved config, successful weekly save yields updated list/status/time and `closeBriefingModal`; invalid interval/day/time/recipient/cap follows existing `_validation_error` with `HX-Retarget: #briefing-form-error`, no close event and no mutation. Retain existing detailed schedule tests rather than duplicate every combination.
3. `test_assistant_config_not_found_and_test_feedback`: loop missing/foreign IDs across update/rename/briefing GET/save/test; assert 404 plus accessible alert/no secret, no mutation/send. Mock `send_briefing`: success contains alert and `data-briefing-test-ok`; disabled AI/no SMTP/SMTP/provider failure are escaped inline errors, not bare paragraphs or false success. The JS sheet case below pins the 429 presentation; keep the existing limiter decorator unchanged.
4. JS `catchup: sheet save refreshes list and restores focus`: open twice after boosted swaps, one GET each; valid save replaces list without navigation and closes sheet/focus, invalid save retains typed values and open sheet. Deleted ID/403/429/login/network answers show useful error and preserve the list; stale first-open response cannot fill the second config's sheet. Rename/load/generate/delete remain delegated, with escaped names and no duplicate requests.
5. JS `catchup: estimates and jobs survive swaps without leaking requests`: fake timers, no estimate at 299 ms/one at 300, latest scope only; repeated init no duplicate request, missing JSON safe. Existing 3-second job fragment stays targeted after phone layout changes; detach/forced offline stops further requests and reconnect permits explicit retry. Copy works, reduced-motion avoids smooth scroll; malformed/expired job response is not success. Backend job semantics remain covered by `test_catchup_main_model.py`.

- [ ] Run `PY tests/test_assistant_catchup.py` and `JS tests/js/ui-assistant-catchup.test.mjs`. Expected RED: missing section/native sheet/alert contracts and unsafe reinitialization assertions.
- [ ] **GREEN:** extract reusable context, restyle with macros, implement the response/controller contracts, move config behaviour into `catchup.js`, and remove page-local catchup script. Preserve saved config deletion's existing immediate semantics; do not enroll configs into `RFPending`.
- [ ] Run `PY tests/test_assistant_catchup.py tests/test_catchup_main_model.py tests/test_catchup_integration.py tests/test_catchup_service.py tests/test_briefing.py tests/test_briefing_scheduler.py` and `JS tests/js/ui-assistant-catchup.test.mjs`. Expected GREEN: `passed`, `# fail 0`; DB-backed integration is executed, not silently skipped.
- [ ] Run early source checks. Expected: `OK`. Report the exact moved config selectors and all alert changes to T1/T5; email template and scheduler services unchanged.

### Task s6-T3: Move interest profile without overwriting AI provider settings

**Size** L · agent: worker · **blocked_by:** —

**Files:** all s6-T3 entries. No shared `assistant.js` edit: T1 owns the delegated profile counter contract.

**Interfaces.**
- Produce `async interest_profile_context(user, db) -> dict` in `settings/ai.py`, returning the profile portion of current `_ai_page_context` only: `s`, generation blocker/detail/provider labels, signal count, auto status/detail and limits. Use `quality_slot_blocker`, `preference_auto_status`, `signal_counts`; do not load API keys/cost tables into Assistant. `assistant/profile.html` owns `#assistant-profile` and a form targeting that root with `outerHTML`; keep `ai_preference_text`, `ai_preference_auto_days`, `#pref-char-count`, `#pref-cold-start-warning`, `#preference-message`, generation/revert buttons and status/error dates.
- New `assistant_router = APIRouter(tags=['settings'])` in the same module supplies `POST /assistant/profile` via `async assistant_profile_save(request, user=Depends(get_current_user), db=Depends(get_db), _ai=Depends(require_ai_enabled))`. T4 includes it once. It accepts **only** the profile fields, with absent field meaning unchanged, trimmed empty text → None, non-empty length 10…5000, auto interval `0|14|28` with existing invalid-value fallback to 0. Preserve timestamp/source/failure-reset/first-schedule semantics from `settings_ai_preferences_save`.
- Factor the existing manual profile validation/application into `_apply_interest_profile(s, form, now) -> str | None`; validate both fields before assigning anything. Reuse it in the narrow handler and the legacy broad handler, leaving provider validation and all non-profile assignments there intact. No commit on validation failure. The narrow handler re-renders the profile with entered safe values/errors (no toast), or fresh persisted profile and JSON-encoded `showToast` on success. Unknown injected provider/model/enable fields have no effect.
- Register **identical handlers**, not redirects, for `/settings/ai/generate-preference` ↔ `/assistant/profile/generate` and `/settings/ai/revert-preference` ↔ `/assistant/profile/revert` using decorators on `router`/`assistant_router`. Preserve auth/AI dependencies and rate limits. Generation remains a **draft** in the textarea, not auto-save; revert still swaps stored current/previous values immediately. Both use `assistant/profile_feedback.html` for escaped macro feedback plus existing OOB textarea/count/warning IDs. Keep old callers' targets/body semantics.
- `/settings/ai/preferences` remains the old full-form endpoint for stale tabs and provider settings. `/settings/ai` remains a real provider settings GET: replace its editor block with “Interest profile has moved to Assistant” link to `/assistant?section=profile#assistant-profile`. No blanket redirect of the AI settings page. Current provider form omits profile fields, so saving it preserves text/auto interval; old submitted profile fields still work until s8. Remove only the now-shared character-counter listener from `ai-settings.js`, retaining key/model/numeric behaviour.
- Disabled scoring retains the current disabled-edit/generate UI policy and status explanation; a missing main model/key/custom endpoint explains where to configure it, and manual draft is not lost. Automatic generation, cold-start 20-signal guidance, previous-version availability and last-error metadata remain visible. New section scripts use T1 counter and shared generic loading hooks.

**RED — exactly 5 new cases in `test_assistant_profile.py`:**
1. `test_assistant_profile_save_is_narrow`: set non-default providers/models/keys, summary/chat/scoring flags, limits/prompts, then submit profile plus malicious extra provider fields; assert only allowed text/auto metadata changes, `showToast` is JSON, all unrelated settings remain byte-for-byte equal. An unchanged text does not change its timestamp.
2. `test_assistant_profile_validation_and_schedule`: empty, length 9/10/5000/5001 and intervals 0/14/28/invalid in a bounded loop; assert old validation/fallback, no partial mutation on rejected text, escaped submitted value retained, enable resets failures and preserves full-interval scheduling. Absent fields remain unchanged.
3. `test_assistant_profile_generation_and_gates`: render existing disabled/main-model/key/custom-endpoint states, no secret exposure; mocked generation yields draft-only OOB textarea/count/cold-start warning and usage log, no profile save; provider failure retains text and gives inline feedback. No real AI transport.
4. `test_assistant_profile_revert_and_aliases`: seed previous profile, call old/new revert against reset identical fixtures; endpoint/dependencies/status/body/effect match, including no previous version. Old/new generate share handler/limiter and equivalent OOB response. Anonymous/AI-disabled callers retain denial behaviour.
5. `test_ai_settings_retains_provider_form_and_legacy_profile_submit`: settings GET has provider controls and direct Assistant profile link, no duplicate profile textarea; provider-only POST preserves profile and schedule, full stale-tab POST still updates both according to prior semantics. New profile form has explicit target/swap and all existing metadata/IDs; saving through either route cannot edit another user's settings.

- [ ] Run `PY tests/test_assistant_profile.py`. Expected RED: narrow route/helper absent, old settings still embeds profile and form isolation assertions fail.
- [ ] **GREEN:** implement shared validation and narrow adapter/templates/aliases above, keeping existing broad save behaviour for legacy callers; do not call the full save handler with a fabricated form or hidden copies of provider credentials.
- [ ] Run `PY tests/test_assistant_profile.py tests/test_ai_preference.py tests/test_ai_profile_auto.py tests/test_ai_input_guards.py tests/test_ai_provider_content.py`. Expected GREEN: `passed`. Use a local FastAPI fixture including both routers before T4 assembly; T4 verifies production registration.
- [ ] Run early source checks. Expected: `OK`. Report canonical/legacy routes and OOB IDs to T4/T5. No scheduler, AI algorithm, key storage, provider navigation or s7 settings redesign.

### Task s6-T4: Assemble canonical routes, bookmarks and online-only navigation

**Size** L · agent: worker · **blocked_by:** s6-T1, s6-T2, s6-T3

**Files:** all s6-T4 rows. Later writes to `catchup.py`/old wrapper are only removal of obsolete page dispatch after helper extraction. No `app.js`, CSS or shared helper algorithm rewrite.

**Interfaces.**
- Create `assistant.py` with `async assistant_page(request, section='chat', article_id: int | None=None, user=Depends(get_current_user), db=Depends(get_db))`; GET `/assistant`. Compose T1 `assistant_chat_context`, T2 `catchup_page_context`, T3 `interest_profile_context` into `assistant/page.html` with no-store. Allowed section values select/scroll to stable anchors, unknown section safely defaults to chat. A requested inaccessible article renders a generic unavailable alert without its title/content; never silently send it to AI. Page exists even with no AI provider.
- Register `GET /assistant/catch-up` on the **same page handler**, forcing section `catch-up` by path regardless of conflicting query `section`. This makes the moved-page helper work **unchanged**, with an exact path target rather than unsupported query/fragment text in `MovedPage.new`. `/assistant?section=profile#assistant-profile` is the canonical profile entry; query selects server state, fragment is an accessibility/navigation aid.
- Add exactly `MovedPage('/app/catch-me-up', '/assistant/catch-up')` to `MOVED_PAGES`. Remove the old GET registration first; keep helper startup validation and existing Sources table entries. Queries are preserved byte-for-byte by the shipped helper, e.g. old `?x=a%2Bb` → new same query. `/assistant/catch-up` renders Catch me up even with `?section=chat`. No nonexistent POST alias is invented for a GET-only page.
- Existing action families `/htmx/ai-chat`, `/htmx/articles/{article_id}/ai-chat`, `/htmx/catch-me-up/{estimate,generate,jobs/{job_id}}`, `/htmx/catchup-configs*` **do not move**. Thus all their old non-GET URLs remain the exact handler. The only new action aliases are the T3 profile generation/revert pair; `/settings/ai/preferences` remains the legacy full form, not an alias to the narrow save. Explicitly test this distinction.
- Include `assistant.router` and `settings.ai.assistant_router` once in `app/__init__.py`; preserve the main application router inclusion order and moved-pages registration after all routes. No duplicate `/settings/ai` GET, no new provider-settings alias URL before s7.
- Sidebar rail/zone, mobile Assistant tab and palette point to `/assistant` and remain visible for signed-in readers without configuration so setup guidance can be reached. Preserve sidebar's existing quick AI Chat button and s4 Ask modal through the shared controller; do not add a second Ask UI. The mobile tab becomes a real link, not the old general-modal button; retain its ID if existing tests consume it and remove the old controller binding to that ID in T1's module. `RFAssistant` may enrich a link with the currently visible article's ID only on a user click, using its nearest active detail; direct sidebar/palette navigation remains general.
- Offline `templates.js` sidebar gets the same unconditional Assistant zone/rail link, marked `data-rf-online-only`; it still omits the optional quick AI Chat button, whose capability is unknown offline. Regenerate only three sidebar drift fixtures; do not touch article mirrors or snapshot hash. Cached mobile/legacy markup is blocked by the online-only guard; stale action aliases stay available online.

**RED — exactly 5 new cases:**
1. `test_assistant_moved_get_and_section` in `test_moved_pages.py`: explicit expected move must exist; old GET has 308/no-store, raw query preserved, target 200 with Catch me up selected even for contradictory section query. New page with chat/profile/article/invalid section and no provider renders intended state. Anonymous page request retains authentication. Existing Sources matrix stays green.
2. `test_assistant_non_get_compatibility`: inspect production endpoint identities/dependencies for T3 old/new actions; paired requests against reset fixtures compare body/status/headers/effect. Assert old full `/settings/ai/preferences` still retains its broad handler and `/htmx/*` identities unchanged; stale old POST/PUT/DELETE never receives a move redirect. Include invalid and inaccessible config/profile requests.
3. `test_assistant_navigation_and_real_composition`: real page sections, sidebar/mobile/palette/settings links and static scripts appear once; missing provider still exposes Assistant; one live profile textarea/list/sheet/chat root; ordinary boosted GET remains a complete page. Validate real T2/T3 includes (no DictLoader stubs), article ownership and provider-setup link.
4. JS `worker: Assistant and Catch me up stay online-only` in `offline-worker-nav.test.mjs`: cached reader shell plus successful network navigation to old/new paths passes the online response through; physical/forced offline yields 503 offline page for both, never cached reader; redirected `/assistant/catch-up` is not mistaken for login/wipe. Backend test 1 covers actual 308; T5 browser covers real following.
5. JS `router: Assistant operations never enter the offline queue` in `offline-router.test.mjs`: all existing chat/digest/config `/htmx/*` methods yield needs-connection response and zero queued ops, new/legacy profile non-HTMX requests return null; full `/assistant` and old `/app/catch-me-up` are not shell routes. Offline sidebar contains disabled/online-only Assistant link, no enabled chat input. Retain earlier Sources/read assertions.

- [ ] Run `PY tests/test_moved_pages.py` and `JS tests/js/offline-worker-nav.test.mjs tests/js/offline-router.test.mjs`. Expected RED: missing production route/move/navigation; offline policy characterization may already pass, record actual result.
- [ ] **GREEN:** assemble routes and navigation; delete the now-unreferenced old Catch me up wrapper, retaining its extracted section. Keep current helper implementation; no query-bearing redirect extension and no changes to offline route classification.
- [ ] Run `RF_UPDATE_GOLDENS=1 PY tests/test_offline_drift.py -k sidebar`. Expected: `passed`; only `sidebar-rail.html`, `sidebar-full.html`, `sidebar-empty.html` change. `sidebar-style.html` stays unchanged.
- [ ] Run `PY tests/test_moved_pages.py tests/test_assistant_chat.py tests/test_assistant_catchup.py tests/test_assistant_profile.py tests/test_offline_drift.py tests/test_offline_template_version.py` and `JS tests/js/ui-assistant.test.mjs tests/js/ui-assistant-catchup.test.mjs tests/js/ui-read.test.mjs tests/js/ui-shell.test.mjs tests/js/offline-worker-nav.test.mjs tests/js/offline-router.test.mjs tests/js/offline-drift.test.mjs`. Expected GREEN: `passed`, `# fail 0`, snapshot v6/hash unchanged. Update only old navigation expectations in `ui-shell.test.mjs`, keeping coverage.
- [ ] Run early source checks. Expected: `OK`. Provide full route/selector deltas to T5. No screenshot acceptance in this task.

### Task s6-T5: Final regeneration, acceptance and as-built documentation

**Size** L · agent: worker · **blocked_by:** s6-T4

**Files:** all s6-T5 entries. Final generated CSS/DOM-contract owner. Failed application flows return to their canonical owner; do not patch implementation outside this map.

**Interfaces.**
- Extend `_pages()` in `test_dom_contract_pages.py` with deterministic `assistant` and `assistant_briefing` rendered fixtures, using real contexts/templates; update existing `main`/`sidebar` navigation fixtures and `login`/`preferences`/`sources`/`sources_add` fixtures whose retained script tags change with `base.html`. `_strip_scripts` removes script bodies, not tags; these additional golden changes are expected. Existing article snapshots/online partial goldens must remain unchanged. Extend existing parametrized fixture checks, not new Python test functions.
- New e2e spec calls `requireE2eDatabaseUrl()` at module collection before seeding, follows `sources.spec.mjs` fixture conventions and serial cleanup. Replace `read.spec.mjs`'s legacy name-only guard with this same shared guard (s5 carry); do not change its read behaviours or make guard exceptions.
- AI responses/digest stages and mail transport are deterministic fixtures/mocks, clearly distinguished from real route/persistence checks. At least schedule/profile save and 308 following hit the local backend. Do not send mail to the real account, use real provider keys or invoke paid generation. Track CSP violations/external requests for all five flows. Backend tests prove provider adapter and job ownership; browser stubs prove pending/error layout, not provider integration.
- Keep visual screen key `catch-me-up` stable: base `/app/catch-me-up`, head `/assistant/catch-up`; preserve `#catchup-form` structural measurement with side-aware anchors where layout deliberately changes. Add gallery states for chat/article context/pending/error, briefing sheet invalid/saved, profile and missing-provider explanation. Base equivalents are old modal/Catch me up/AI settings states and labelled accordingly, not invented empty pages. Retain unchanged Sources/read/settings screens and existing exemptions; only reasoned Assistant exemptions in `s6-T5.json`.

**RED — exactly 5 new browser cases in `assistant.spec.mjs`:**
1. `assistant: chat and article entry on phone`: widths 1280/390; existing article Summary/Context/Ask still works and shares extracted controller; Assistant page general/article context sends one POST, visible pending then response, Enter/Shift+Enter/Send, long message wraps. Switch during delayed reply and assert fresh thread/old reply ignored. Focus/keyboard viewport/retry after failure remain usable; repeated boosted navigation sends once. DOM horizontal overflow `<= innerWidth + 1`, reduced-motion no running animation.
2. `assistant: digest and briefing sheet`: select period/feed/folder/labels, save/load/rename config, generate fixture progress then terminal digest, Copy, edit schedule in native sheet. Invalid schedule retains input and focus; successful real backend save closes sheet and updates schedule in list without reload; reopen shows saved value, Escape returns focus. Test-mail feedback is stubbed, no real send; assert inline 429 explanation. No new job after polling completes/detaches.
3. `assistant: profile and provider settings remain independent`: edit/save profile and auto interval using real backend, reload sees saved values; provider/model/flags unchanged; generated fixture draft requires Save, revert restores stored previous value, validation retains draft. Old provider settings GET/link remains reachable and saving it does not clear profile. Counter and OOB fields work after repeated swaps.
4. `assistant: missing configuration and failed requests`: seeded no-model/key/custom-endpoint/disabled/scoring/SMTP variants show specific setup path or administrator explanation, reachable Assistant tab, no provider/email requests. Stale session/403/network and unknown config leave inline retryable state, not a login page inside sheet or a false success toast. Use local fixtures/stubs for transport faults, restoring data afterwards.
5. `assistant: bookmarks aliases and offline`: enabled service worker follows old bookmark to canonical Catch me up with 308/no-store evidence; old profile action matches canonical one online. Physical offline and force-offline separately block Assistant actions/navigation and leave reading usable; no queued operation. Reconnect then explicit retry works. Back/forward retains intended section, old email-management URL opens Catch me up.

- [ ] Add the browser cases and run `E2E_DATABASE_URL="$E2E_DATABASE_URL" npx playwright test tests/e2e/assistant.spec.mjs --project=chrome`. Expected RED before implementation: missing page/contracts. On assembled T4 this may already pass; record actual evidence without manufacturing a failure.
- [ ] **GREEN, regenerate after all canonical changes:** run `npm run build`. Expected: vendor summary and CSS build exit 0. No vendor/font delta expected.
- [ ] Run `RF_UPDATE_GOLDENS=1 PY tests/test_dom_contract_pages.py`, then `node scripts/check-dom-contract.mjs --write`, then `node scripts/check-dom-contract.mjs`. Expected: `passed`, contract written, final `OK`. Review removed selectors against owner reports; do not drop retained article-modal or offline coverage to silence failures.
- [ ] Check deterministic CSS with ephemeral output:
  ```bash
  RF_S6_BUILD=$(mktemp -d)
  trap 'rm -r "$RF_S6_BUILD"' EXIT
  node scripts/build-css.mjs -i input.css -o "$RF_S6_BUILD/tailwind.css"
  cmp backend/app/static/css/tailwind.css "$RF_S6_BUILD/tailwind.css"
  ```
  Expected: build exit 0, `cmp` exit 0/no output, scratch removed on exit. Use a separate shell from the DB cleanup trap so neither overwrites the other.
- [ ] Run `npm run check:sources`, `TMPDIR=/var/tmp npm test`, `PY`, then `PY tests/test_offline_drift.py tests/test_offline_template_version.py tests/test_dom_contract_pages.py`. Expected: source checks `OK`, Node `# fail 0`, pytest `passed`; record actual counts/skips, do not reuse s5 totals. Full pytest uses the migrated task-owned throwaway DB. Version/hash stays 6/`60ff43c1c5f70e34`.
- [ ] Exercise frontend template runtime like CI: `PYTHON="$PWD/backend/.venv/bin/python" TMPDIR=/var/tmp npm test`. Expected: `# fail 0`; no new test hardcodes backend venv when `PYTHON` is supplied. Existing `.github/workflows/ci.yml` Jinja2 setup is retained, not recreated.
- [ ] Run `E2E_DATABASE_URL="$E2E_DATABASE_URL" npx playwright test --project=chrome`, then `E2E_DATABASE_URL="$E2E_DATABASE_URL" npx playwright test tests/e2e/assistant.spec.mjs --project=webkit`. Expected: complete Chrome suite passes with only existing explicit fixmes reported; 5 Assistant WebKit cases pass. Missing browser/runtime is a named limitation, not a pass. Pre-existing logout/freshness flakes do not waive a new Assistant failure.
- [ ] Run `E2E_DATABASE_URL="$E2E_DATABASE_URL" RF_VISUAL_BASE=d6a4f93 RF_VISUAL_MODE=layout npm run test:visual`. Expected: `layout: A <n>/<n> strict` and `B <n>/<n> structural`, exit 0, only reasoned intentional Assistant changes exempted.
- [ ] Run `E2E_DATABASE_URL="$E2E_DATABASE_URL" RF_VISUAL_BASE=d6a4f93 RF_VISUAL_MODE=gallery RF_VISUAL_DEBUG=1 RF_VISUAL_GALLERY_BASE=1 npm run test:visual`. Expected: all Assistant states at 1280/390 under neutral/paper/graphite light/dark captured without clipped composer/sheet/menu/toast; unchanged old screen retained under all dark themes, dark-patch failures 0. Include keyboard Tab/Escape, readable labels/status, contrast and touch scroll checks. Automated browser viewport shrink is not evidence of a real iPhone keyboard: name the owner phone check in the package.
- [ ] Deliver **one end-of-segment visual acceptance package** to the orchestrator, including the scope delta and phone keyboard check. Screenshots/generated checks do not imply owner visual approval. No separate s6 task-by-task visual acceptance and no reopening s3/s4/s5 owner decisions here.
- [ ] **Docs last:** README explains Assistant's general-vs-article scope truthfully, fresh threads, Catch me up, briefing sheets and profile location; CLAUDE records controllers, context/response contracts, canonical paths/aliases, online-only policy and unchanged snapshot v6; CHANGELOG Unreleased records s6 and explicitly deferred corpus-chat scope. No claim of streaming or library search.
- [ ] **Specs handoff before integration/whole review:** report as-built behaviour, test commands/results, design delta, unchanged owner questions and next/carry lines to the orchestrator/spec-keeper for `specs/handoff-run-7429291d-8129-432b-beab-c61fff1112cd.md`, `specs/TRACKS.md`, `/projects/readfine/specs/backlog.md`. Those files remain outside task write ownership; do not create a competing ledger or workflow completion marker.
- [ ] On the applied/committed product tree, orchestrator runs `npm run check:generated`. Expected: exit 0, no generated diff. Worker evidence is deterministic build comparison; an intentional generated diff against the old commit is not itself a worker failure. Canonical repair afterwards requires regeneration and fresh T5 reconfirmation.

**Done:** assembled tests/source/generated/DOM/offline checks are current, one visual package is ready, docs/spec handoff is complete and runtime limitations are explicit. Integration, whole review, accepted Result, PR/merge and deployment remain orchestrator workflow actions.

## Task table and waves

Files column references the exact, exhaustive ownership rows above (no implied neighbour-file rights).

| ID | Size | blocked_by | Files / deliverable |
|---|---|---|---|
| s6-T1 | L | — | `assistant/{page,chat}.html`, `ui/assistant.js`, `app/ai.py`, `app.js`, `base.html`, `input.css`, chat tests and existing read JS harness |
| s6-T2 | L | — | `app/catchup.py`, temporary `catch_me_up.html`, `assistant/catchup.html`, briefing/config partials, `catchup.js`, digest/sheet tests |
| s6-T3 | L | — | `settings/ai.py`, `settings/ai.html`, `ai-settings.js`, `assistant/{profile,profile_feedback}.html`, profile tests |
| s6-T4 | L | s6-T1, s6-T2, s6-T3 | new `app/assistant.py`, router inclusion, move table/tests, removal of old page dispatch/wrapper, navigation/mirror/drift and offline tests |
| s6-T5 | L | s6-T4 | CSS/DOM fixtures/contract, e2e Assistant/read guard, visual harness/exemptions, README/CLAUDE/CHANGELOG |

1. **Wave 1:** s6-T1 + s6-T2 + s6-T3. Disjoint write ownership. Designed assembly group: T1 removes old config handlers while T2 supplies them and removes the old duplicate script tag; T1 supplies the profile counter while T3 relinquishes it. Fresh task tests use explicit fixture seams; wave verifier reruns all three suites with real sections/scripts, plus legacy read/chat/config/profile coverage. No release of intermediate worker trees.
2. **Wave 2:** s6-T4, consuming all three interfaces. Verify real route registration, bookmark semantics, static script discovery, offline mirror and unchanged snapshot hash on the assembled tree.
3. **Wave 3:** s6-T5, sole final regeneration owner and last docs writer; then integration/whole review. One final wave verifier adds assembled evidence, not fake `blocked_by` task IDs.

Planned work norm 450 minutes; critical path 270 minutes; ratio 1.67, dependency width 3. Three parallel domain tasks are deliberate; the later assembly and acceptance chain is required. No setup-only task and no separate visual/spec microtask.

## Carry-over and risk register

| Item | Disposition |
|---|---|
| Bare-text config 404s; briefing test-mail `<p>` | s6-T2 accessible alerts, unchanged status and success hook. |
| Old `/app/catch-me-up` bookmarks/email link | s6-T4 helper 308 to exact `/assistant/catch-up`; target forces Catch me up, queries preserved. |
| Missing provider/main model/key/custom endpoint | s6-T1/T3 actionable setup states; s6-T4 makes zone reachable without configuration. |
| Scope switch mixes threads / delayed response | s6-T1 explicit fresh transcript and request-generation guard; no stored article-history deletion. |
| Phone chat and job transport | s6-T1 single-response chat and viewport/retry; s6-T2 digest polling; s6-T5 browser plus owner phone check. |
| Schedule save invisible until reload | s6-T2 direct list response plus close event, verified on real backend in s6-T5. |
| Profile move and stale AI settings forms | s6-T3 narrow adapter plus shared old/new generate/revert handlers; provider page/full legacy save remains. Alias removal is s8. |
| Feed/folder/library retrieval chat | Deferred design delta, explicitly selected by orchestrator during planning; owner confirmation required at plan approval. Feed/folder digest scope preserved. |
| Q3 Filter from this source | s7, no control or prefill work in s6. |
| S4W-F1/F2; s3/s4/s5 owner visual acceptance | Out of scope, remain open. No mark-all offline/Sort/Show changes. |
| s5 read e2e name-only DB guard | s6-T5 uses shipped shared guard; no new DSN bypass. |
| s5 >50-delete 422, double Add heading; WebKit offline/logout defect | Out of scope. Record any reproduced failures separately. |
| Email template redesign, AI retrieval/streaming, scheduler algorithms | Out of scope. Management URL remains valid through helper. |
| Snapshot closure accidentally touched through chat/macros | No writes planned; unchanged v6/hash tests required. Necessary changes demand amendment, never silent re-pin. |
| Existing RuntimeWarnings / alembic drift / absent mutation tooling | Report if encountered; no unrelated repair. No mutation step is added by this method. |

## Open questions for owner approval

Confirm the explicit scope delta: this segment implements article/general chat; feed/folder/library retrieval chat is deferred, while Catch me up retains those scopes. This is a visible design narrowing, not an implementation detail. The orchestrator instructed this candidate; it is not presented as already owner-approved. No other new product decision is needed to implement the candidate. Existing S4W-F1/F2 and s5 choices remain separate.

## Verified source anchors and limits of this planning attempt

Inspected on 2026-11-25; paths/functions below exist in the baseline. These are navigation anchors, not fixed edit ranges:

- `backend/app/routers/web/app/ai.py`: `_render_chat_area` :82, `_render_general_chat_area` :91, `htmx_general_ai_chat` :316, general clear :418, `htmx_ai_chat` :426, article clear :512. `backend/app/services/ai_service.py:1304` defines `chat_with_article`; no feed/folder retrieval chat exists.
- `backend/app/routers/web/app/catchup.py`: `catchup_page` :48, `htmx_catchup_estimate` :130, `htmx_catchup_generate` :209, `htmx_catchup_job` :270, `_digest_progress` :335, `_catchup_configs_list_html` :474, briefing GET/save/test :667/:709/:822. Bare 404s are at :592/:633/:683/:734/:840; success paragraph starts :875. These supersede draft 37/654/696/808 references.
- `backend/app/routers/web/settings/ai.py`: `_ai_page_context` :71, `settings_ai_preferences_save` :210, generation :463, revert :517. Broad save assigns absent providers/models/flags; profile omission is already guarded. `PROFILE_MIN_CHARS=10`; `ai_profile_service.py` has `PROFILE_MAX_CHARS=5000`, `AUTO_INTERVALS=(0,14,28)` and existing generation blockers/status helpers.
- `backend/app/static/js/app.js`: config close/list/rename helpers :2509 onward and chat block :3944 onward. `catchup.js` currently assumes a non-boosted one-time load and unguarded `period-descs-data`; `ai-settings.js` owns a counter that must move with the profile.
- `backend/app/templates/app/partials/{sidebar,mobile_bars,palette}.html` contain current Assistant links to Catch me up and general-modal buttons. Offline `templates.js:645` explicitly documents omitting Assistant/chat because capability is unknown; unconditional online-only navigation requires a matching mirror change.
- `backend/app/routers/web/moved_pages.py` already interpolates path parameters, preserves raw query and validates target routes. Its new target must be a route path, not a URL containing a query. Existing Sources tests exercise it; do not rebuild it.
- `backend/app/static/js/offline/router.js:597` recognizes shell GET only at `/` and `/app`, then handles `/htmx/*` or returns null. `policy.js.classify` treats full GET navigation separately and leaves non-HTMX actions unclaimed. This supports online-only Assistant without policy changes.
- `backend/app/services/sync/__init__.py` pins version 6/hash `60ff43c1c5f70e34`; release status comes from deployed s5 handoff, even though the test ledger's historical RELEASED list still precedes its latest entry. Treat v6 as released.
- `.github/workflows/ci.yml` already installs Jinja2 in a frontend venv and exports `PYTHON`; `tests/e2e/db-guard.mjs` rejects absent/unsafe DSNs before execution; `input.css:44` keeps unconditional Tailwind hover compatibility. These are constraints, not new infrastructure tasks.

Verified here: source/design/handoff inspection and plan structure/path/interface checks. Not claimed here: container health, DB migrations, application/browser/visual tests, external deployment or owner visual acceptance. These are execution-time checks above.

Artifact hygiene: task DBs and CSS comparisons are ephemeral, removed by scoped traps; do not overwrite the DB trap with a scratch trap in the same shell. One visual package under existing `test-results/visual-report` is short-lived evidence owned by the orchestrator until Result publication/owner acceptance, then removed. The plan and implementation/docs are persistent deliverables. No ad hoc backups, duplicate galleries or production state changes are needed for planning.

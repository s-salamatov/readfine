# Project: Readfine

Self-hosted web RSS reader (inspired by Tiny Tiny RSS) with feed scraping, filters,
article scoring, and AI summaries, scoring and briefings.

## Tech stack
- Backend: Python 3.12 + FastAPI
- Database: PostgreSQL
- Task queue: APScheduler (in-process, inside the FastAPI process)
- Frontend: HTMX + Jinja2 + Tailwind CSS
- Readable extraction: trafilatura → readability-lxml (fallback)
- AI: Anthropic Claude / OpenAI / Google Gemini (configurable, bring-your-own-key)
- Auth: signed session cookies (web) + JWT (API)
- Deployment: Docker
- Package manager: uv

## Technical decisions
- **Dev environment**: hybrid (PostgreSQL in Docker, FastAPI run locally via uv)
- **CSRF**: the web is protected by `starlette_csrf.CSRFMiddleware` (double-submit
  cookie + `x-csrftoken` header; HTMX requests attach it via `csrf.js`). The API is
  exempt (it authenticates with a JWT in the `Authorization` header), as are the auth
  forms (`/login`, `/register`, `/logout`, `/reset-password`, `/resend-verification`)
- **Git workflow**: `dev` = active development, `master` = production trunk and the
  GitHub default branch. New work branches off `dev`; deploying to production means
  merging `dev → master` and pulling on the server; master is continuously deployable
  and may sit ahead of the last release. A **version release is a separate event**: a
  tag + `CHANGELOG` section cut over commits already on master (see `RELEASING.md`), not
  a prerequisite for deploying. **Before any merge to `master`, verify on staging first.**

## Status
Released and on the post-release `0.x` line. First public release was v0.9.0 (2026-06-20);
for the current version and release notes see `CHANGELOG.md` (and `RELEASING.md` for the
process). Implemented: RSS/Atom and
web-scraping feeds, folders, scheduled fetching, readable extraction, 3-panel reading UI,
article states, labels, filters (conditions → actions, regex, AND/OR, feed/folder scoping),
per-user settings, admin panel, SMTP, API tokens (JWT), tiered retention/purge, dark mode,
OPML import/export (incl. TT-RSS compatibility), AI summaries, relevance scoring, chat over
articles, and Catch me up & briefings. Self-hosted via Docker; hosted instance at
readfine.app.

## Testing
- **Test**: auth flows (login, registration, verification, password reset), account deletion,
  irreversible/destructive data operations, business-logic services (fetcher, filters, AI
  pipeline, briefing, scoring, purge), security-critical paths (crypto, rate limiting,
  URL/SSRF validation)
- **Don't test**: CRUD routes (name/email/password/settings changes), admin UI, Jinja2
  templates, simple static routes (low risk, reversible or trivial)
- A new feature gets a test if it is irreversible, security-critical, or contains non-trivial
  business logic

## CSS / Tailwind conventions
- When fixing layout bugs, find the root cause (e.g. a flex/truncate parent) rather than
  patching symptoms
- After changing classes in templates, `static/js` or Python class strings, rebuild the stylesheet: `npm run build`; `npm run check:sources` must pass
- Tailwind 4 class names: `rounded-sm`/`rounded-xs`, `shadow-sm`/`shadow-xs`, `outline-hidden`, `shrink-0`, `wrap-break-word` (not the v3 names). Class strings in Python under `routers/` and `services/` are scanned
- Custom CSS and inline `<style>` go inside `@layer utilities`
- `input.css` has a v3-compatibility layer (palette, ring, border/placeholder colour, button cursor, hover, text line heights, form-control background, table-cell padding, `space-*`/`divide-*` sibling form, `peer-checked`/`group-open` specificity) that keeps screens identical. Do not remove parts of it without an `npm run test:visual` run
- Gray utilities must stay `var(--color-gray-*)` (`scripts/check-css-vars.mjs`)
- `npm run build` goes through `scripts/build-css.mjs`, not raw `tailwindcss --minify` (see
  README "CSS build"). A legitimate change to one of its `FRAGILE_RULES` fails the build by
  name: update the list there
- `input.css` repeats Basecoat's three `aria-hidden` hiding rules (command, dropdown-menu,
  select) as plain CSS (s2-T38). Keep them
- Colour literals live only in `styles/tokens.css`; templates, JS and `input.css` use tokens
  (`npm run check:sources` → `scripts/check-colours.mjs`). The only exceptions (its `ALLOW`)
  are the email templates, `static/js/offline/launch.js` and the worker's offline page
  (`offlinePage` in `static/js/offline/templates.js`). Label palette colours come from
  `services/label_palette.py`, mirrored by `--rf-label-*`; stored label colours are hex data
- Themes: `html[data-rf-theme]` (`neutral`, `paper`, `graphite`) plus `html.dark`, set by
  `static/js/init.js` before first paint. Change the theme only through `setAppTheme`;
  never use Basecoat's `window.basecoat.theme` (it bypasses `colorScheme`,
  `data-rf-theme` and the theme-color sync). The theme-color meta is created by
  `init.js` (no static one in `base.html`). The reader shell's sidebar and bars use
  tokens (`--background`, `--sidebar`, …), which the theme-color meta follows (on a phone
  the light list takes `--background` too); the body keeps the light-mode `bg-gray-50`
  on every page until the remaining pages are redesigned (s7)
- Toasts go through `RFToast` (`static/js/ui/toast.js`) or the global `showToast(msg,
  type)` / an `HX-Trigger` `showToast`. Never call Basecoat's `toaster.toast()` with
  `action` or `cancel`: it writes inline `onclick`, which the CSP blocks
- Delayed delete: the trigger carries `data-rf-delete="<kind>:<id>"` (plus
  `data-rf-delete-label`), every row of that object `data-rf-delete-key="<kind>:<id>"`;
  `RFPending` (`static/js/ui/pending.js`) hides, offers Undo and sends one batch to
  `POST /settings/deletes`
- Command palette (`app/partials/palette.html`, `RFPalette` in `static/js/ui/palette.js`):
  server results carry `data-force` (so Basecoat's `command.js` filter keeps them), and
  the command element's `refresh()` is called after they are swapped in
- Reader shell behaviour (account menu, sidebar pin, collapsible sections, long-press,
  phone tab bar and sidebar sheet) lives in `static/js/ui/shell.js`, not `app.js`. The
  reader sidebar keeps its own `<aside id="sidebar">`; Basecoat's `sidebar` macro and
  `sidebar.js` are not used there
- Sources lives at `/sources`; Add is `/sources/add`. `static/js/ui/sources.js`
  owns discovery and the one shared `#rf-source-sheet`; `feeds-settings.js` owns
  table/folder state. Only `HX-Target: rf-source-sheet-body` selects a fragment;
  boosted navigation gets the full page. Forms set their own target and swap.
- Source saves emit `HX-Trigger` events `sidebarRefresh`, `rf:sourceschanged`
  (`kind: subscribe|edit|scrape|opml`) and `showToast`. Subscribe/edit/scrape return
  an empty 200 with `HX-Reswap: none`; OPML retains its report in the sheet.
- `UserFeed.id` identifies edit/unsubscribe and `data-rf-delete-key="feed:<id>"`;
  `Feed.id` identifies counts, reading navigation and scraping lookup. Do not mix them.
  Unsubscribe uses `RFPending` and 10 s Undo; folder deletion remains immediate.
- Old Sources GET URLs redirect 308 with `Cache-Control: no-store`; old POST/DELETE
  aliases remain until s8. Sources is online-only: no offline cache or mutation queue.
  These sidebar/Sources changes leave snapshot version 6 and hash `60ff43c1c5f70e34`
  unchanged; do not bump the article snapshot version for them.
- Read-zone behaviour (mark-all and archive Undo toasts, the View reload, folder chips,
  the list skeleton, swipe on rows, the reading progress bar, "Show original") lives in
  `static/js/ui/read.js` (`RFRead`); what needs `app.js`'s own state (keyboard, nav)
  stays in `app.js`
- Mark all read: every mark-all route answers `HX-Trigger` `rf:markedall` `{stamp,
  count}` next to `sidebarRefresh` (the offline worker sends `stamp: null`). The stamp is
  opaque text: post it back unchanged, form-encoded (it holds a `+`), to
  `POST /htmx/articles/mark-read/undo`, which restores only that mark-all's bulk reads
  (10 minutes, then 410)
- `data-chat-error` marks an AI chat error reply (the `alert` macro's `attrs` in
  `app/partials/chat.html`); `app.js` keys the chat retry on it, never on a colour class
- `POST /htmx/list-view` (`field`, `value`) saves one View-menu choice and answers
  `rf:viewchanged`; nothing else changes
- `data-rf-nav="<hx-get url>"` means "go to this sidebar view", shared by the palette and
  the folder chips (`RFPalette.goTo`)
- The offline page's colours are a constant pinned against `styles/tokens.css` by
  `tests/js/offline-page-tokens.test.mjs`; change both together
- Components come from the `templates/ui/` macros. No hand-written Basecoat markup; no
  `on*` attributes; dialogs and sheets open with `data-rf-open="<id>"`
- HTML fragments returned from Python (`HTMLResponse`) use `app/ui_fragments.py`
  (`alert_html()` renders the `alert` macro); never hand-write component markup in Python.
  Pass plain strings: a `Markup` argument is emitted unescaped
- Basecoat's `vega.css` (imported in full by `input.css`) also skins components that are
  not imported (`.accordion`, `.avatar`, `.table`, `.progress`, …). Do not rely on these
  classes; `.table` now also shadows the Tailwind `table` display utility
- Motion goes through `RFMotion` and `data-motion`; it is instant under reduced motion
- **WR2-F2:** an element carries exactly one of `hidden` or an unprefixed display class. A
  runtime toggle swaps both, never just `hidden`
- **WR2-F3:** Tailwind 4 preflight makes `[hidden]` `display:none !important`. An element
  with the `hidden` attribute stays hidden whatever its display utility
- DOM contract: rename a contract item only together with its consumers and its entry in
  `docs/ui-dom-contract.md` (`scripts/check-dom-contract.mjs`)
- Changing a snapshot partial (`app/partials/article_row.html`, `article_detail.html` and
  what they include) bumps `OFFLINE_TEMPLATE_VERSION`, updates `OFFLINE_TEMPLATE_HASH`
  (both in `services/sync/__init__.py`), adds a ledger row in
  `tests/test_offline_template_version.py` and regenerates both golden sets (in `backend/`:
  `RF_UPDATE_GOLDENS=1 uv run pytest tests/test_offline_drift.py
  tests/test_partials_online_unchanged.py`), then updates the mirror in
  `static/js/offline/templates.js`
- CSP is nonce-based: an inline `<script>` needs `nonce="{{ request.state.csp_nonce }}"`;
  inline event handlers belong in external JS

## Before large changes
- For non-trivial work (e.g. error handling, new features), propose at least two approaches
  with tradeoffs and wait for approval before implementing
- Don't assume behavior is a bug; verify the current behavior is actually wrong before
  "fixing" it

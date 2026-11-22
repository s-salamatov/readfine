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
  `data-rf-theme` and the theme-color sync). In light mode the body is `bg-gray-50` while
  the bars and `<meta name="theme-color">` use `--background` (the same colour in dark)
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

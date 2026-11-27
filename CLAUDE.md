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
articles, an Assistant page (article/general chat, Catch me up, briefing schedules, interest
profile), and Catch me up & briefings. Self-hosted via Docker; hosted instance at
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
  the light list takes `--background` too). The body in `base.html` keeps `bg-gray-50` on
  purpose: it is the canvas for card layouts (it follows the theme through
  `--color-gray-*`, dark mode maps it to `--background`), and `bg-background` would put
  white cards on a white page in neutral light. `public/base.html` uses `bg-background`
- Toasts go through `RFToast` (`static/js/ui/toast.js`) or the global `showToast(msg,
  type)` / an `HX-Trigger` `showToast`. Never call Basecoat's `toaster.toast()` with
  `action` or `cancel`: it writes inline `onclick`, which the CSP blocks
- Delayed delete: the trigger carries `data-rf-delete="<kind>:<id>"` (plus
  `data-rf-delete-label`), every row of that object `data-rf-delete-key="<kind>:<id>"`;
  `RFPending` (`static/js/ui/pending.js`) hides, offers Undo and sends batches to
  `POST /settings/deletes`. Each delete has its own 10 s: a timer flush sends only the
  entries that are due, so two deletes seconds apart may go in two requests; navigation,
  history save, hide and unload send everything pending together
- Delayed-delete list state is opt-in, inside `[data-rf-pending-list]`:
  `[data-rf-pending-empty]` (shown with no visible row), `[data-rf-pending-sep]` (shown
  with a visible row before and after it) and, anywhere,
  `[data-rf-pending-count="<list id>"]` ("(N)"). Render the empty text and separator
  whenever they could be needed and toggle only `hidden` (marked elements carry no display
  class), so counts and empty states follow delete and Undo without a reload. Labels and
  filters use them; `.swap-confirm` stays for token revoke, folders, admin and other
  confirms
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
- Old Sources GET URLs redirect 308 with `Cache-Control: no-store`; the old POST/DELETE
  addresses were removed in s8. Sources is online-only: no offline cache or mutation queue.
  Sidebar and Sources changes outside the snapshot closure do not bump the article
  snapshot version.
- Assistant lives at `/assistant` (`?section=chat|catch-up|profile`); `/assistant/catch-up`
  is the same page handler forcing the Catch me up section. It composes existing AI,
  digest and profile services through three context adapters: `assistant_chat_context`
  (`app/ai.py`), `catchup_page_context` (`app/catchup.py`), `interest_profile_context`
  (`settings/ai.py`). No new retrieval engine, thread table or streaming.
- Chat scope is **this article** or **everything (general)** only; the general option
  states up front that the library is not searched. There is no feed/folder/library
  retrieval chat; Catch me up keeps full feed/folder scope. Chat is one awaited HTML POST
  to `/htmx/ai-chat` (no streaming/polling); the 3-second poll belongs to the digest job.
- `static/js/ui/assistant.js` (`window.RFAssistant.init/setScope/isOffline`) owns the chat
  lifecycle: scope select `#assistant-chat-scope`, the page thread `#rf-assistant-chat`,
  hidden `#general-chat-history`/`-article-id`/`-include-article`, `#general-chat-input`,
  `#general-chat-submit`, `#general-chat-messages`, the `data-chat-error` retry, Enter /
  Shift+Enter, the phone `visualViewport`, and the legacy article Ask modal. A scope change
  clears the transcript/draft/history and aborts the in-flight XHR; a request-generation
  guard drops stale success/error even when abort races a reply. `static/js/catchup.js`
  (`window.RFCatchup.init`) owns estimates, the digest job poll and the briefing-sheet
  config actions. Both are loaded once from `base.html`; neither is dynamically imported.
- Server representation: `_render_general_chat_area(..., assistant=True)` renders
  `assistant/chat.html::assistant_chat_area` only when the request carries
  `HX-Target: rf-assistant-chat`; every other caller keeps the existing macro. Both dual
  representations answer `Cache-Control: no-store` and `Vary: HX-Target`. `include_article`
  with a missing/foreign/stale id yields a generic inline `data-chat-error`, no provider call.
- The interest profile moved to `/assistant?section=profile#assistant-profile`, saved by the
  narrow `POST /assistant/profile` (`settings/ai.py` `assistant_router`), which writes only
  `ai_preference_text`/`ai_preference_auto_days` and never provider/model/flags. `/settings/ai`
  keeps provider setup and links to it. `POST /settings/ai/preferences` is the live AI
  provider form: a post that carries `ai_preference_text` or `ai_preference_auto_days` (a
  stale tab) gets `error_toast(STALE_PAGE_MESSAGE, 409)` and writes nothing, provider
  fields included. Generate/revert live only at `/assistant/profile/{generate,revert}`.
- While an article is on screen, `ui/shell.js` adds `?article_id=` to the reader's bare
  `/assistant` links; each article chat also gets an "Open in Assistant" link
  (`[data-rf-assistant-open]`) naming its article.
- Old `/app/catch-me-up` GET 308s to `/assistant/catch-up` through the moved-pages helper
  (query preserved, `Cache-Control: no-store`); action endpoints `/htmx/ai-chat`,
  `/htmx/articles/{id}/ai-chat`, `/htmx/catch-me-up/*`, `/htmx/catchup-configs*` do not move.
  Assistant is online-only (`data-rf-online-only`): it is not a shell launch path, offline
  navigation gets the 503 offline page, and no operation is queued. The page-only chat
  template is outside the snapshot closure.
- Assistant phone layout (≤ 640 px, `input.css`): the chat section is one screen tall, and
  the card is capped by `--rf-assistant-viewport-height` (the visual viewport, which the
  phone keyboard shrinks), set on `#rf-assistant-chat` by `watchViewport` in
  `ui/assistant.js`. HTMX settle restores the swapped element's own attributes and drops
  that inline value, so `htmx:afterSettle` re-applies it on an already watched root; do not
  turn that back into an early return. All `.rf-sources-*` and `.rf-assistant-*` rules sit
  in `@layer utilities`. `chat_setup` is `{text, link_label, href}`; never parse the
  sentence for the link
- Settings (s7): `settings/base.html` renders the sub-navigation (a left column; below `sm`
  one scrolling tab row in `[data-mobile-nav]`). A child sets `active` to
  `reading|relevance|labels|ai|account|stats` and may set `settings_subnav`
  (`[{label, url, active}]`; Account: Profile · API tokens). "AI provider" shows only while
  `app_ai_enabled()`; Sources, Assistant and Admin are links under the items. Both layouts
  are in the HTML, so each link (and `aria-current`) appears twice. `app.js` re-centres the
  active phone tab after load and after boosted swaps
- Settings pages: `/settings/reading` (Reading & appearance), `/settings/relevance` (cards
  `#relevance`, `#filters`, `#stories`), `/settings/labels`, `/settings/ai`,
  `/settings/profile` with `/settings/tokens`, `/settings/stats`. `/settings` 303s to
  `/settings/reading`. Moved GETs 308 through the moved-pages helper
  (`/settings/preferences` → `/settings/reading`, `/settings/preferences/hidden` →
  `/settings/relevance/hidden`, the filter list `/settings/filters` →
  `/settings/relevance`); `POST /settings/filters` and the filter actions kept their URLs
- Immediate save: a checkbox, radio or select with `name=<field>` and `data-rf-autosave`
  (its value is the URL, empty means `POST /settings/field`), optionally
  `data-rf-autosave-label`. `window.RFSettings` (`static/js/ui/settings.js`, loaded once
  from `base.html`) posts `field`/`value` with the CSRF header; on a non-ok or redirected
  answer, a network error or offline it restores the last confirmed value and says so, and
  a late older reply never overrides a newer confirmed choice. The route answers with the
  "Saved" `showToast` and `rf:settingsaved` `{field, value}` in `HX-Trigger`; `RFSettings`
  dispatches the non-toast events on `<body>`. A new such choice needs an entry in
  `FIELDS` (`routers/web/settings/fields.py`, the closed allowlist; anything else is 400
  and writes nothing). Used on Reading & appearance and for `story_dedup`; the relevance
  terms form and the AI provider forms keep their own Save
- The timezone and the number fields (articles per page, two breakpoints) are
  `#reading-form` with a sticky Save to `POST /settings/reading/save` (a non-integer
  re-renders with field errors and writes nothing; its card needs `overflow-visible` for
  the sticky bar). The full legacy form (`POST /settings/reading` and its
  `/settings/preferences` alias) was removed in s8
- Moved pages (`routers/web/moved_pages.py`, `MOVED_PAGES`) are GET only: 308 +
  `no-store`, query kept; a target without a GET route fails startup. There are no non-GET
  aliases or tombstone routes. In `auth_redirect_handler` (`main.py`) a non-API,
  non-GET/HEAD request that gets a 405, or a 404 with no `endpoint` in the scope (no route
  matched), answers through `_client_error_response(..., hint="")` with
  `STALE_PAGE_MESSAGE` (`utils/htmx.py`), "This page is out of date. Reload it and try
  again.": htmx gets the error toast, other requests `errors/client.html`; the 405 keeps
  its `Allow` header, `/api/` keeps its JSON, and a route's own 404 keeps its page. In
  `errors/client.html` an absent `hint` keeps the "Go back and correct it" advice, `""`
  drops it. Retiring a route needs no extra code, but move every caller first
- Admin pages: `admin/base.html` draws the page header from the blocks `admin_title`,
  `admin_description` and `admin_actions` (no title, no header) and loads
  `static/js/ui/admin.js` once in its `scripts` block, so a child that overrides that block
  must call `super()`. `window.RFAdmin.init(root)` runs on load and `htmx:afterSettle`
  with delegated listeners bound once: the Feeds A–Z / By host choice (localStorage
  `admin_feeds_group`; the pressed style comes only from `aria-pressed`, rendered by the
  server and flipped by the script), the feed-edit and rate-limits dialogs, the Settings
  switches and the traffic chart keys. The switch-driven notes toggle the `hidden`
  **class**, not the attribute; the script parks an unprefixed display class in
  `data-rf-display` (WR2-F2; breakpoint variants are not handled). Registration off hides
  `#legal-section` and `#legal-warning` and shows `#traffic-closed-note`.
  `#traffic-bars` holds only bar buttons. The two series use `--rf-chart-visitors` /
  `--rf-chart-views`, defined in all six theme blocks of `styles/tokens.css` (≥ 3:1 on
  `--card`, ≥ 1.5:1 apart, pinned by `tests/js/theme-tokens.test.mjs`). Admin is
  online-only
- Public pages (features, changelog, help, privacy, terms) extend the standalone
  `templates/public/base.html`, never `base.html`: the stylesheet and `init.js` only (no
  htmx, `app.js`, offline boot or service-worker registration), so no `hx-*` or
  `data-rf-open` there and the content works without JavaScript. Tokens are their only
  colours, with no `gray-*`/`blue-*` palette classes or `dark:` variants (the legacy dark
  overrides live in `base.html`). A page names itself to the footer with `footer_current`;
  print styling is `print:` variants in that layout, the header and footer partials and
  the legal templates. Sign-in
  and error pages stay on `base.html` (the sign-in form imports `public_footer`). Keep the
  section ids of `help.html`: the app deep-links to them
- Live `landing.html` copies are gitignored and not scanned by the CSS build. The frozen
  `backend/tests/fixtures/landing/landing-b07f8b6.html` (never edit it) is an `@source` in
  `input.css`, checked by `tests/js/landing-compat.test.mjs` and `test_restyle_landing.py`;
  changing `landing.example.html` follows `RELEASING.md`
- Wide tables sit in `rf-scroll-x` (`input.css`): a horizontal scroller with edge shadows,
  which wraps instead in print. Its covers default to `--card`; on another surface set
  `--rf-scroll-cover` (done for Source statistics and dialogs). The shadows are
  backgrounds, so opaque cells and table heads hide them. Add `relative` when the table
  has `sr-only` or absolute descendants
- "Filter from this source" (article ··· menu, only with a `feed_id`, online-only) opens
  `/settings/filters/new?feed=<Feed.id>`; only a feed among the user's own subscriptions
  prefills scope and name, anything else gives the empty form
- A created API token is rendered once (`#new-token-value`, `.copy-from-btn`) in a
  `no-store` response
- The phone sidebar has one mode, `hideable-up` (Collapsible is retired): `init.js` and
  `applyBucket` rewrite any other stored `sidebar_mode_small`, and small screens request
  the sidebar with `pinned=true`
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
  `static/js/offline/templates.js`. Current: version 7, hash `6a5a389617b4977d`; version 7
  added "Filter from this source" to the article menu (online-only, not mirrored in
  `templates.js`)
- CSP is nonce-based: an inline `<script>` needs `nonce="{{ request.state.csp_nonce }}"`;
  inline event handlers belong in external JS

## Before large changes
- For non-trivial work (e.g. error handling, new features), propose at least two approaches
  with tradeoffs and wait for approval before implementing
- Don't assume behavior is a bug; verify the current behavior is actually wrong before
  "fixing" it

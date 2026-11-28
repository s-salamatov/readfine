# Readfine UI redesign: shadcn visual system on Jinja + HTMX, with motion

Status: draft for owner review (2026-11-19), revision 6 (design review passed; minors M1-M6 folded in: undo response, per-user lock, failure classification, per-item results, tests, notice list; before that X1-X4: one batch delete request, keys kept across reloads, the existing `showToast` event, real mark-all responses; before that N1-N7: delete reports, in-flight keys, sequential sends, existing template version, undo route contract; earlier, design review D1-D14: undo keyed by stamp, document-lifetime pending-delete queue, Tailwind 4 sources, offline restyle, drift harness, redirect policy, CSP checks, View Transitions limits, stronger tests).
Repo: `/projects/readfine/ui-redesign` (git worktree of the fork, branch `feat/ui-redesign` from `selfhost` c81977a). Workflow run: arh-w-dev `run-7429291d`.
Source request: `/projects/readfine/specs/backlog.md` (project specs, outside this worktree) item "Redesign UI and animations" (owner, 2026-11-17).
Reference material: the discussion page with screenshots of today's UI and mockups of every screen (published Claude Artifact "Readfine redesign"), and the working prototype https://claude.ai/artifact/BsuMQ732ksD3waLJfoY6Qa (Basecoat 1.1.0 + HTMX 2.0.4 + anime.js 4.5.0, mocked server).

## 1. Intent

The owner uses Readfine every day on desktop and iPhone and finds the interface too plain and unintuitive. Settings are hidden, important actions take too many clicks, the visual system is weak and nothing moves. Concretely, from the walk-through of the deployed app:

- Adding a feed takes three clicks through Settings → Feeds; the reader has no entry point except the empty state.
- Summary and context are three clicks away behind the "···" menu; chat lives there too.
- Theme, offline mode and reading layout are buried in Settings → Preferences.
- The phone layout has a hamburger plus a bottom bar that appears only on scroll-up, with unlabelled icons.
- Mark all read asks through a browser `confirm()` (`app.js:2264`); deleting a feed, label or filter uses a two-click inline confirmation. Nothing can be undone.
- There are no animations anywhere.

The goal is a reader that feels like a modern, calm, fast product: everything frequent is one tap or one key away, the structure is obvious, and state changes are visible through motion. The owner chose:

- **Visual language:** shadcn/ui, used through Basecoat (a plain HTML/Jinja port of shadcn/ui), not React.
- **Motion:** anime.js 4 plus the View Transitions API.
- **Stack:** stays FastAPI + Jinja2 + HTMX. No React rewrite.
- **Language:** the UI stays English. Localization goes to the backlog.
- **Approach A:** waves by zone on one shared foundation, each wave a PR into `selfhost` that leaves Readfine fully usable.

## 2. Goals, non-goals, anti-goals

Goals:

1. One coherent design system: shadcn tokens (CSS variables) with three app themes (Neutral, Paper, Graphite), each in light and dark; Geist for UI and Source Serif 4 for article text by default, self-hosted (today no web fonts are loaded: system stack, Georgia for articles at `base.html:185`); the existing reading-font preferences (`UserSettings.reading_font_size/family`, `models/user.py:84-85`) keep working and gain the new fonts as options.
2. New information architecture: four zones, **Read**, **Sources**, **Assistant**, **Settings**, reachable from the sidebar on desktop and a labelled bottom tab bar on the phone.
3. Frequent actions within one step:
   - command palette on ⌘K / Ctrl+K and `/`;
   - "+" add-source in the sidebar header (phone: tab "Add");
   - a "View" menu in the list header for density, grouping and filters;
   - theme, app theme and offline mode in the account menu.
4. One AI panel on the article (Summary / Context / Ask) instead of three menu items; one chat with a scope switch (this article, this feed or folder, everything).
5. Phone: full-screen article with a floating action bar, swipe on list rows (right: star, left: read), bottom sheets instead of modals, labelled tab bar always visible.
6. Undo toasts instead of confirmations: mark all read, archive, and deleting a feed (unsubscribe), label or filter (owner: delayed delete, see 5.4).
7. Purposeful motion everywhere state changes, driven by shared duration and easing tokens, fully disabled under `prefers-reduced-motion`.
8. Tailwind 3.4 → 4 with the build and CI check kept.
9. Leave the code easier to work on: `app.js` (4855 lines) broken into per-zone modules as each zone is rewritten; Jinja component macros instead of copy-pasted class strings.

Non-goals:

- New backend features. Every feature already exists (`FEATURES.md`); the redesign changes how they are presented and reached. Small view endpoints and partials may be added where a new UI needs them (for example a palette search endpoint), never new domain logic.
- Localization (backlog).
- Changing the offline architecture. The redesign must keep offline v2 working as it is.
- A native app or a React/SPA rewrite.
- Redesigning the email briefing template.

Anti-goals (a failure even if it technically works):

- The reader becomes slower to use: more clicks than today for any frequent action, or animations that delay input.
- Offline mode silently breaks because `offline/templates.js` drifts from the Jinja markup.
- Keyboard shortcuts change or stop working without being listed in the new shortcuts sheet.
- The app looks like a stock shadcn demo. The three themes, serif reading text and Readfine-specific components must give it its own character.
- A wave leaves the app half-broken between PRs (dead links, unreachable settings, mixed dark mode).

## 3. Constraints (from the code)

- **CSP:** `script-src 'self' 'nonce-…'`, no `unsafe-eval`; `style-src 'self' 'unsafe-inline'`. Basecoat JS and anime.js are vendored under `/static/js/vendor/`; no CDN. `htmx.config.allowEval=false` stays; no `hx-on`, no `js:` values, no trigger filters.
- **HTMX 2.0.4** with `hx-boost` (18), `hx-push-url` (21), OOB swaps (35) and `HX-Trigger` response headers (23 in routers). History and back/forward must keep working; `Cache-Control: no-store` on HTML stays.
- **Committed CSS:** `backend/app/static/css/tailwind.css` is committed and CI rebuilds it and fails on any diff. Every wave rebuilds and commits it. The build is not in Docker and stays outside it.
- **Asset versioning:** `static_url()` appends a content hash; new vendored files use it.
- **Offline mirror:** `static/js/offline/templates.js` (698 lines) hand-copies Jinja partials (classes and `hx-*`) for worker-served pages. The drift golden test is an open backlog item.
- **DOM contract:** `app.js` uses about 76 ids, 114 selectors and `data-header-*` attributes; Playwright `offline.spec.mjs` selects by id; `tests/js` (19 files) includes the keyboard map and pins `shortcuts-modal-overlay` (`keyboard-shortcuts.test.mjs:223`); about 118 backend tests assert on HTML text.
- **Online partial goldens:** `backend/tests/test_partials_online_unchanged.py` with `backend/tests/fixtures/partials_online/` freezes the online article partials (regenerated with `RF_UPDATE_GOLDENS=1`). Every wave that changes those partials regenerates the goldens in the same PR, and the reviewer checks the golden diff against the intended change.
- **Existing pieces to reuse, not duplicate:** `showToast(msg, type)` (`app.js:574`) becomes the toast API on top of Basecoat's toaster; the shortcuts sheet `app/partials/shortcuts.html`; the feed test/detection route; the AI routes (`routers/.../ai.py`: summary 139, context 218, chat 303/413); Catch me up (`catchup.py:37`) and briefing configs (`catchup.py:654/696/808`, `briefing_modal.html`).
- **Dark mode** is class-based (313 `dark:` usages) and stored per device in `localStorage.colorScheme` (`init.js:28-33`, `preferences.js`), not on the server. `init.js` sets `.dark` on `<html>`; the server sets `data-font-size`, `data-font-family`, `data-label-display` there (`base.html:2`).
- **Hard-coded colours:** an inline `<style>` in `base.html` (from line 45) holds about 106 hex colours, including the dark surfaces `#141414`/`#2a2a2a`; `showToast` (`app.js:575`) and `theme-color` (`base.html:21`, `init.js:41-45`) use hex too.
- **Tailwind sources:** v3 scans templates and JS only, excluding `landing.html` (`tailwind.config.js:4-10`). Several routers build class strings in Python (at least `admin.py`, `settings/ai.py`, `settings/feeds.py`, `app/ai.py`, `app/catchup.py`, `articles.py`, `filters.py`, `scrape.py`).
- **Offline internals the redesign touches:** the worker's offline page is self-contained with no external resources (`templates.js:645-658`); the shell cache discovers assets only through `src`/`href`/`data-rf-scripts` and CSS `url()` (`sync.js:510-525`); offline mark-all is one id-less `mark_scope_read` op (`offline/router.js:391-421, 510-521`); the offline settings hook is `[data-rf-offline-settings]` (`page.js:1115`) and the status long-press opens `/settings/preferences#offline-diagnostics` (`page.js:1277`).
- **Parallel work:** offline-freshness is being designed in `/projects/readfine/src`. Each wave rebases on `selfhost` before its PR; conflicts in `offline/*` are resolved in favour of the offline work, then re-applied to the new markup.

## 4. Approaches considered

- **A. Waves by zone on one foundation (chosen).** Foundation first (Tailwind 4, tokens, Basecoat, motion layer, macros, offline drift test), then zones one by one. The app stays usable after every PR; old screens keep their layout until their wave and take the colours of the selected theme. Cost: a mixed look between waves.
- **B. New shell beside the old one behind a flag.** No mixed look, but two template trees and two offline mirrors for weeks, every backend fix done twice, and exactly the drift risk we want to remove. Rejected.
- **C. One big PR.** A diff over 124 templates and `app.js` with everything to debug at once. Rejected.

Inside A, my calls:

- Basecoat is an **npm dependency** (`basecoat-css`) imported into `input.css`. A new small script (`scripts/vendor-assets.mjs`, run by `npm run build`) copies its JS and anime.js's UMD bundle into `static/js/vendor/`; the copies are committed like `tailwind.css`, and CI's freshness check covers them. Upgrades are a version bump plus rebuild.
- Readfine owns its components as **Jinja macros** in `templates/ui/` that render Basecoat markup. Templates never hand-write component markup, so a Basecoat change is made in one place.
- **Motion** lives in one module, `static/js/ui/motion.js`. It holds the tokens, the reduced-motion guard and the HTMX hooks. Templates declare intent with `data-motion="…"` attributes; no inline anime.js calls in templates.
- `app.js` shrinks **by zone**: each wave moves its zone's code into `static/js/ui/<zone>.js` behind the same DOM contract, and deletes the old code. No big-bang JS rewrite.

## 5. Design

### 5.1 Information architecture

```
Sidebar (desktop) / tab bar + sheets (phone)
├─ Header: logo · "+" Add source · Search (⌘K)
├─ Read
│   ├─ All articles (unread count) · Top picks · Starred · Saved · Archive
│   ├─ Saved searches (with counts)
│   └─ Folders → feeds (health dot, unread count)
├─ Sources            feeds, folders, discovery/add, OPML, scraping setup, feed health
├─ Assistant          chat (scope switch), Catch me up, briefings, interest profile
├─ Settings           Reading & appearance · Relevance & filters · Labels · AI provider ·
│                     Account · Tokens · Stats   (admin: Admin link)
└─ Footer: account menu (theme, app theme, offline, shortcuts, help, sign out) · sync state · refresh
```

Phone tab bar: **Feed · Search · Add · Assistant · Folders** (Folders opens the sidebar as a sheet). Settings and Sources are reached from the account menu and the sidebar sheet.

Settings regrouping (today: Stats, Relevance, AI, Feeds, Preferences, Filters, Labels, Profile, OPML, Tokens):

| New place | Today's pages |
|---|---|
| Sources | Feeds, feed edit, folders (`settings/folders.py`), OPML, scrape setup |
| Assistant | Catch me up page (`/app/catch-me-up`), briefing schedules (catch-up configs, today in `briefing_modal.html`), interest profile (from the AI page) |
| Settings → Reading & appearance | Preferences (layout, typography, density, number/date format, mark-read-on-scroll) |
| Settings → Relevance & filters | Relevance, Filters, hidden stories |
| Settings → Labels | Labels |
| Settings → AI provider | AI keys, models, prompts, cost |
| Settings → Account | Profile, Tokens |
| Settings → Stats | Stats |

Old URLs keep working (policy in 5.4, "Moved pages"). The device-specific offline toggle moves to the account menu; its full settings (storage size, diagnostics) stay under Reading & appearance → This device, which keeps the `[data-rf-offline-settings]` hook and the `#offline-diagnostics` anchor, and `page.js:1277` is pointed at the new URL in the wave that moves the page.

### 5.2 Screens

The mockups on the discussion page and the prototype are the visual reference. Per zone:

- **Shell:** Basecoat sidebar (collapsible on desktop, a sheet on the phone), list pane and reading pane in a 2- or 3-panel layout following the existing per-device layout preferences and breakpoints.
- **List:** a header with title, View menu and mark-all. Filter chips by folder. Rows show feed icon, source, time, title, optional excerpt (density), score badge, source count for stories and a star marker. Skeleton rows while loading. Story clusters expand inline.
- **Article:** a sticky toolbar with read, star, archive, labels, Ask, original link and a "···" menu for share, save, copy and filter-from-source. Meta line, serif title and the AI panel with tabs Summary and Context; Ask opens chat scoped to the article. A reading progress bar. On the phone: full screen, back button, floating action bar (read, star, archive, next).
- **Command palette:** articles (server search), saved searches, feeds and folders, and actions (add source, mark all read, theme, app theme, offline, toggle sidebar, shortcuts, go to zone). Keyboard-first.
- **Add source:** a sheet with an address field, live discovery of feeds (the existing `POST /settings/feeds/test`, which already detects the feeds of a site address via `detect_feeds`), feed choice, folder and auth fields under "Advanced", plus a test result. Errors such as captcha are explained inline.
- **Sources:** a feeds table grouped by folder with health, unread count, last fetch and a per-feed menu. Folder rename and move happen inline. OPML import/export and scraping setup open as sheets.
- **Assistant:** a chat with a scope switch, plus Catch me up (period and scope) and briefing schedules on the same page.
- **Settings:** a left sub-navigation (tabs on the phone). Each page is built from Basecoat `field`, `switch`, `select` and `card`, with sticky save where forms need it. Most toggles save immediately with a toast.
- **Auth and errors:** centered card layout in the new tokens.
- **Admin and public pages:** re-tokened in wave 2, the foundation (colors, fonts, buttons through the macros), fully redesigned last.

### 5.3 Foundation (tokens, components, motion)

Motion is specified by [the motion design](2026-11-28-motion-design.md) (2026-11-28), which replaces this section's motion rules.

- **Tokens:** the shadcn variable set (`--background`, `--foreground`, `--primary`, `--muted`, `--accent`, `--border`, `--ring`, `--sidebar-*`, `--radius` …) defined for Neutral (default), Paper and Graphite, each light and dark, plus Readfine tokens:
  - `--rf-unread`, `--rf-star`, `--rf-ok`, `--rf-warn`;
  - `--rf-serif`, `--rf-body-font`;
  - motion durations `--t-fast` 125, `--t-fast-max` 165, `--t-med` 300, `--t-med-max` 400, `--t-slow` 700 ms (adapted from Astryx's neutral motion scale).
- **Theme selection (owner: per device):** `<html class="dark" data-rf-theme="paper">`, set by `init.js` before first paint from `localStorage` (`colorScheme`: light/dark/system as today, plus a new `appTheme`: neutral/paper/graphite). No server preference and no migration. `init.js` also keeps updating `<meta name="theme-color">` from the active theme.
- **Old screens follow the theme too:** Tailwind 4 emits palette utilities through CSS variables (`bg-gray-100` → `var(--color-gray-100)`, opacity modifiers through `color-mix(… var(--color-gray-100) …)`), so each app theme also redefines `--color-gray-*` and the few accent scales in use. Screens not yet redesigned keep their `gray-*`/`dark:` classes but take the hue of the selected theme. Wave 1 verifies the variable form on the built CSS (a check script fails if any `gray-*` utility resolves to a literal colour).
- **No hard-coded colours:** wave 2 moves the hex colours of the `base.html` inline style, `showToast` and `theme-color` onto tokens (`theme-color` is read from the computed `--background` by `init.js`). A lint check then rejects new hex/`rgb()` literals in templates, `static/js` and `input.css` outside the token file, with one listed exception: the self-contained offline page (5.5).
- **Fonts:** Geist and Source Serif 4 as latin-subset `woff2` (about 4 files, under 200 KB total), declared with `@font-face` in `input.css` so the shell cache finds them through CSS `url()`; `font-display: swap`.
- **Components (`templates/ui/`):** button, icon button, badge, kbd, input, select, switch, field, card, alert, menu (dropdown), popover, tabs, dialog, sheet (drawer), toast, command palette, sidebar, skeleton, empty state, plus Readfine-specific article row, feed icon, score badge and health dot. Each macro has a short docstring and a gallery page (`/dev/ui`, only when `DEBUG` is on) used for visual checks.
- **Motion module:** a thin wrapper over anime.js 4 (`animate`, `stagger`, `spring`). The guard turns every animation into an instant set under reduced motion. HTMX hooks:
  - `htmx:afterSwap` runs the enter animations declared by `data-motion`: `list-enter`, `fade-up`, `pop`;
  - View Transitions wrap only the article open and zone navigation (`hx-swap="… transition:true"`), where supported, with a plain fallback. They last at most `--t-fast-max` (165 ms), because the page does not take input during a transition. If a swap starts while one is still running, the running one is skipped (`skipTransition()`), so swaps never queue behind each other. Reduced motion is handled in CSS too: under `prefers-reduced-motion: reduce` the `::view-transition-group/old/new(*)` animations are set to `none`;
  - event-driven effects: star burst, count-up, row read dot, mark-all wave, sheet spring, swipe snap, toast slide.
  Colour flashes use CSS keyframes, because anime.js cannot animate a CSS variable.

### 5.4 Data flow and behaviour rules

- HTMX stays the transport. The server renders partials. The client never builds article markup, except the offline mirror, which keeps doing so.
- Server events reach the UI as `HX-Trigger` events (for example `rf:starred`, `rf:markedall`, and the existing `showToast`). Toasts and counters listen to these events; nothing else depends on response bodies. The existing `showToast` is the single toast entry point and the single toast event name (`app.js:594`, `admin.py:729`); it renders through Basecoat's toaster. Wave 3 replaces the regex that finds it in `HX-Trigger` (`app.js:660`) with JSON parsing, since more routes now send JSON triggers. Trigger values with user-supplied text are built with `json.dumps` (ASCII default), as `saved_searches.py:127` does.
- **Undo for mark all read, keyed by stamp (not by ids).** `mark_scope_read` (`services/article.py:850`) never loads ids into Python, on purpose, and stamps every row it writes with one `now` plus `suppressed_by='bulk'`. The redesign:
  - makes `mark_scope_read` and the saved-search variant `mark_saved_search_read` (`saved_search_service.py:283-317`, own `now` and upsert) return `(stamp, count)`, `count` being the statement rowcount;
  - `count` is the rowcount of whichever of the two statements ran (`article.py:910` or `:963`); the other caller of `mark_scope_read` (`ops.py:444`) is updated for the new return value;
  - the mark-all routes (`shell.py:138/180/202`, `saved_searches.py:133`) turn their `HX-Trigger` from the plain string `sidebarRefresh` (`shell.py:176/198/218`) into JSON that keeps it: `{"sidebarRefresh": true, "rf:markedall": {"stamp": "<ISO with microseconds>", "count": N}}`;
  - the stamp is an opaque string: the client never parses it into a `Date` (which would drop the microseconds) and posts it back unchanged; a test round-trips it;
  - a new service `undo_scope_read(user, stamp)` runs one `UPDATE user_article_state SET is_read=false, read_at=NULL, suppressed_at=NULL, suppressed_by=NULL WHERE user_id=:user AND read_at=:stamp AND suppressed_by='bulk' AND is_read=true`. The user filter is inside the UPDATE itself. Rows that the reader touched since (read properly, which clears the stamp, or marked again) do not match and stay as they are. The existing trigger sets `read_changed_at` (`alembic/versions/0127_offline_sync.py:52-66`), so offline devices pick the change up through the normal sync. Mark-all writes no story state, so nothing else needs reversing;
  - the route `POST /htmx/articles/mark-read/undo` takes only the stamp. Its response mirrors the mark-all response it reverses: the mark-all routes return the badge-total fragment (`shell.py:175`) or an empty body (saved search, `saved_searches.py:148`) and let the client refresh the list; the undo returns an empty body with an `HX-Trigger` carrying `sidebarRefresh` and `showToast` ("Restored N"). The badge totals need scope parameters the undo does not have (`shell.py:166-174, 191, 211`), so the toast code instead re-fetches the active `.nav-item.active[hx-get]` into `#article-list`, as `app.js:3394-3395` does, which re-renders rows with their unread badges. It rejects stamps older than 10 minutes; repeating it changes nothing (idempotent);
- **Undo while offline:** offline the worker answers mark-all with a queued id-less op and no stamp, so the toast has no Undo button ("Marked as read · will sync"). If the connection drops between an online mark-all and pressing Undo, the worker has no undo route and the request fails; the toast says "Couldn't undo while offline" and the articles stay read. Both tested.
- **Archive's Undo** calls the existing unarchive toggle for that one article.
- **Delayed delete (owner's choice) for feeds, labels and filters,** as one client module `static/js/ui/pending.js` that lives for the whole document (boosted navigation keeps the same document, `offline/page.js:8`):
  - Delete adds an entry `{key, url, label}` to the queue, hides the row (`data-rf-pending-delete`) and shows "Deleted <label> · Undo" for 10 s. Undo removes the entry and unhides the row if it is still in the DOM.
  - Each entry goes through `pending → sending → done | failed`. The queue is flushed when an entry's 10 s end, before any boosted navigation or history change (`htmx:beforeRequest` with a navigation target, `htmx:beforeHistorySave`), on `visibilitychange` to hidden and on `beforeunload`, which is the pattern the existing flush code already uses for iOS (`app.js:1182-1186`).
  - The moment an entry leaves `pending`, its toast loses the Undo button and reads "Deleting <label>…", then "Deleted <label>". Undo is therefore never shown for something already sent (for example after an iPhone app switch).
  - **One request per flush, one batch at a time on the server.** Every flush sends all entries due in one `POST /settings/deletes` with a JSON body `[{kind: feed|label|filter, id}, …]` and `x-csrftoken` set explicitly (as `app.js:1145-1149` does; `csrf.js` only covers HTMX requests), with `keepalive: true`. The route is a thin wrapper: it checks each item belongs to the user and calls the existing delete services one after the other inside the request, (`services/feed.py:895 unsubscribe`, `label_service.py:107 delete_label`, `filter_service.py:374 delete_filter`), and a page exit cannot cut the batch in half: `keepalive` keeps the one request alive. The route takes a per-user `pg_advisory_xact_lock` before it starts, so two batches (a timer flush overlapping an exit flush, or two tabs) never run their scope cleanups (`services/scope_cleanup.py:77-113`, no row lock) at the same time. Each item runs in its own try block: an error rolls back that item only, and the route always answers 200 JSON `{results: [{kind, id, status: done|failed}], notices: [...]}`. An id that is not found, whether already deleted or another user's, is a no-op reported as `done`, which also avoids revealing whether another user's id exists. The existing `DELETE` routes stay for other callers.
  - **What counts as failure:** anything other than an ok JSON response with per-item results: network errors, a followed redirect (`r.redirected`, the expired-session 302 to `/login` from `main.py:263-274`), 401, 403 (stale CSRF), 429 and 5xx. `/settings/deletes` is also added to the JSON 401 branch at `main.py:262`. Items reported `failed` are restored individually.
  - **Cleanup report:** the batch response carries what the server did besides the delete (unsubscribe: filters deactivated, briefings disabled, saved searches emptied, today rendered at `feeds_list.html:5-34`; label delete: "Turned off N filters", `labels.py:84-93`) as a list under the existing `showToast` key in `HX-Trigger`; `showToast` handling accepts either one `{msg, type}` or a list of them, and shows each. When the flush happens because the page is being left, nobody is there to read the response; so those notices are lost. Likewise, a send that fails after the page is gone leaves its keys in `sessionStorage`, so the object stays hidden for up to 2 minutes and then reappears: the safe direction. Accepted: the Sources and Settings pages already show deactivated filters and disabled briefings in their own lists. My call.
  - **Keys survive reloads.** Back/forward reloads the page (`historyCacheSize = 0`, `refreshOnHistoryMiss`, `base.html:493-494`), which ends the document. So keys in `sending` or `done` are also written to `sessionStorage` (`rf.deletedKeys`, each with a time, dropped after 2 minutes). On load and after every swap, an `htmx:afterSwap`/`DOMContentLoaded` pass hides rows with those keys, so a list rendered before the delete committed — after navigation, back/forward or reload — does not show the row. Pending entries are flushed (as `sending`) on `beforeunload`/`visibilitychange` before the document ends, so after a reload nothing is left pending.
  - A failed send (network error or 5xx, offline included: the worker passes non-`/htmx/` requests to the network, `offline/router.js:575`) moves the keys out of the hidden set and `sessionStorage`, shows "Couldn't delete <label>" and unhides the row if it is on screen; otherwise the object simply stays and reappears on the next load: the safe direction.
  - Other tabs and devices see the object until the send; accepted.
  - My call: client-side delay, so no new server state, no migration, no query changes. The two-click inline confirmation is removed.
  - The toast text is set through `textContent`, never `innerHTML` (feed titles are user data).
- **Moved pages (redirects),** shared helper added in wave 2, used by each wave that moves a page:
  - old GET paths answer 308 to the new path with `Cache-Control: no-store`, so browsers do not keep the redirect and a revert works;
  - old non-GET paths (forms and HTMX endpoints called from stale tabs or a cached offline shell) stay registered as aliases of the same handlers until wave 8, which removes them;
  - hard-coded targets such as `RedirectResponse("/settings/feeds", 303)` (`feeds.py:459`, `filters.py:170`) move to the new path in the same wave;
  - one table lists old → new paths; a test walks it (308 + `no-store` + target 200 for GET, alias works for POST).
- **Palette:** a GET endpoint returns grouped results as a partial (articles via the existing search, feeds and folders from the sidebar data). Static actions are in the markup. Basecoat command filtering works on the static part; server results are swapped in with a debounce.
- **Basecoat initialisation:** components in HTMX-swapped content initialise themselves through Basecoat's MutationObserver. The prototype verified this for dropdown, tabs and toast inside swapped content. No manual init calls.
- **Basecoat and CSP:** Basecoat's documented examples open dialogs with inline `onclick`, which CSP blocks. The macros never emit `on*` attributes; dialogs and sheets open through `data-rf-open="<id>"` handled by one delegated listener in `ui/dialog.js` calling `showModal()`. A CI check fails on any inline event handler in templates: an attribute whose name is a DOM event handler (`onclick`, `onchange`, `onsubmit`, `onload`, `oninput`, `onkeydown` … from a fixed list), matched as a whole attribute name after whitespace, so `content=`, `once=` and `only=` do not trip it. Toasts are built by our code with `textContent`.
- **Inherited `hx-*`:** forms inside dialogs and sheets set their own `hx-swap`/`hx-target`. The prototype hit an inherited `hx-swap="none"`.

### 5.5 DOM contract and offline

- A **contract file** `docs/ui-dom-contract.md` lists every id, `data-*` attribute and class that `app.js`, the offline modules, `tests/js`, Playwright or backend tests depend on, with its consumers. Wave 2 builds it and a check:
  - extraction: string literals in `getElementById`, `querySelector(All)`, `closest`, `matches` and test locators; ids built at runtime (`'article-row-' + id`) are recorded as prefix patterns (`article-row-*`);
  - verification: each entry must appear in the rendered HTML of a fixed page set (the same key screens as the visual check, rendered by pytest with fixtures) or, for entries not on those pages, as a literal or prefix in some template or JS template;
  - CI fails on a selector used in code but missing from the contract, or listed but found nowhere.
  A wave may rename an item only together with every consumer and the contract entry.
- **Offline drift golden test (wave 2, foundation).** There is no such harness today. Design:
  - Python half (pytest job): renders each mirrored fragment from its real source, a Jinja partial or a Python helper (for example `_badge_html`, mirrored at `templates.js:77-80`), with a fixture context, and writes the normalised HTML to `backend/tests/fixtures/offline_drift/<fragment>.html`. The test fails if the committed file is stale (`RF_UPDATE_GOLDENS=1` regenerates), like the online partial goldens.
  - JS half (node job, `tests/js/offline-drift.test.mjs`): renders the `templates.js` counterpart from an IndexedDB-shaped fixture built by a per-fragment adapter (`tests/js/offline-drift/adapters.mjs`) that holds the same data as the Python fixture, normalises it the same way and compares with the committed file.
  - Normalisation: whitespace, attribute order and class order. Any other allowed difference is listed per fragment in the adapter with a reason (for example a server-only attribute). The committed files join the two CI jobs, so neither job needs the other's runtime.
  - Every later wave updates `templates.js` in the same PR as the partial, and the test proves it.
- **Offline pages:** the banner and diagnostics (server-rendered) are restyled with the macros in wave 4. The worker's self-contained offline page cannot use macros or external CSS; it gets the token values inlined from a small JS constant that the build script generates from the token file, so its colours cannot drift.
- **Shell cache:** new scripts (`ui/*.js`, `motion.js`, vendored Basecoat and anime.js) are loaded with static `<script src>` tags in `base.html`, never dynamic `import()`, so `sync.js` discovers them; fonts are found through CSS `url()`. The offline e2e checks that the shell works offline after each wave.
- **Stale snapshots:** the mechanism exists. Snapshots in IndexedDB (`db.js:113`, from `/sync/v1/snapshots`) carry `OFFLINE_TEMPLATE_VERSION` (`services/sync/__init__.py:5`, sent as `manifest.lists.templates`), and `snapshotStale` re-fetches them and re-caches the shell on a mismatch (`sync.js:64-67, 719-723`). Every wave that changes what the snapshots render bumps that constant. Wave 2 adds a test that fails when that output can change without a bump: it pins a hash next to the constant over the snapshot templates (`app/partials/article_row.html`, `article_detail.html`) plus their include/import closure computed with `jinja2.meta.find_referenced_templates`, and the Python context helpers they use (`row_render_context`). CSS needs no bump: it is loaded through the content-hashed URL and re-cached with the shell. The offline e2e covers an upgrade with stored snapshots.

### 5.6 Failure and recovery

- **JS fails to load** (offline cold start, CSP block): the app stays usable without motion. Animations are additive; the server-rendered state is already correct. Menus and dialogs use native `<details>` or `<dialog>` where Basecoat does, so they keep basic function.
- **View Transitions unsupported** (older WebKit): plain swap.
- **Undo after the window:** the toast is gone and the action stays done. The mark-all undo route rejects stamps older than 10 minutes and matches only the caller's rows; repeating it changes nothing. A delayed delete that fails on send follows 5.4.
- **Wave rollback:** each wave is one PR; reverting it restores the previous UI. Redirects are sent with `no-store`, so browsers do not keep them after a revert. A revert also bumps `OFFLINE_TEMPLATE_VERSION`, so devices drop snapshots from the reverted wave.

### 5.7 Waves (segments)

Each wave is a sequential segment with its own plan approval and its own PR into `selfhost`. Sizes are rough.

1. **Tailwind 4 migration (no visual change):** `input.css`, config, typography plugin, all 124 templates via the official upgrade tool plus manual fixes; CI freshness check kept. Split out of the foundation because it touches every template and must be reviewable on its own.
   - Sources: `@import "tailwindcss" source(none)` plus explicit `@source` entries for templates, `static/js` and the whole `routers/` and `services/` directories (Python files only), and `@source not` for `landing.html` as today, so edits in `docs/` or `specs/` never change the CSS.
   - Classes built in Python strings are migrated by hand: a grep for the utilities renamed or removed in v4 (`flex-shrink-*`, `flex-grow-*`, `shadow-sm`/`shadow`, `rounded-sm`/`rounded`, `ring`, `outline-none`, `blur`, `*-opacity-*` …) over `routers/` and `services/`.
   - v3 defaults that v4 changed (border colour, ring width, placeholder colour, button cursor, hover on touch devices) are kept through a compatibility layer in `input.css`.
   - Acceptance: pixel diff of the key screens (1280/390, light/dark) between the base and the wave's build, threshold 0.1 % per screen; every remaining difference is listed in the PR. The check script that `gray-*` utilities resolve to variables (5.3). All suites green.
2. **Foundation:**
   - tokens and themes (including the `--color-gray-*` remap), `init.js` theme bootstrap with `appTheme`, self-hosted fonts;
   - Basecoat and anime.js vendored;
   - `ui/` macros with the gallery and `motion.js`;
   - hex colours moved to tokens and the colour lint;
   - DOM contract file and check, offline drift golden test, the template-version bump test;
   - the moved-pages helper (5.4) and the `on*` attribute check;
   - re-token admin, auth and public pages so nothing looks broken.
   - Visible result: new colours and fonts, no layout change.
3. **Shell and navigation:**
   - new sidebar (zones, "+" add source, search entry, account menu with theme/app theme/offline), with the mirrored `sidebar.html` markup updated in `offline/templates.js` in the same PR;
   - command palette;
   - phone tab bar and sidebar sheet;
   - shortcuts sheet (keeps `shortcuts-modal-overlay` or updates the keyboard test and the contract together);
   - `showToast` moved onto Basecoat's toaster, `rf:*` events;
   - shared `ui/pending.js` (delayed delete), the `POST /settings/deletes` batch route and the undo toast, used by waves 5 and 7.
4. **Read:**
   - list (rows, View menu, chips, skeletons, swipe, story clusters);
   - mark-all undo: `mark_scope_read` returns its stamp, `undo_scope_read` and its route, the offline toast without Undo;
   - article (toolbar, AI panel Summary/Context, Ask entry, progress, phone full-screen and action bar);
   - offline banner and pages;
   - `templates.js` updated.
5. **Sources:** add-source sheet with discovery, feeds table, folders, feed edit, OPML, scraping setup, health; delayed delete for feeds; moved-page redirects for the feed pages.
6. **Assistant:** unified chat with scope switch, Catch me up, briefings, interest profile; moved-page redirects for these pages.
7. **Settings:** regrouped pages, moved-page redirects, the offline settings section and the `page.js` diagnostics link, immediate-save toggles, delayed delete for labels and filters.
8. **Admin and public pages:** full redesign of admin, landing, features, changelog, help and legal; removal of the non-GET aliases of moved pages.

Waves 5 to 7 depend on 1 to 3 (not on 4) and could be reordered; 8 is last.

## 6. Invariants and acceptance tests

Invariants:

- Every action available today is still reachable, in no more steps than today. Frequent ones (add source, summary, theme, offline, search) take one step.
- All keyboard shortcuts of today keep working; new ones (⌘K) are added to the sheet.
- No CDN script; CSP unchanged; no `on*` attributes in templates (CI check).
- No hard-coded colours outside the token file, except the listed offline page (CI check).
- `prefers-reduced-motion: reduce` removes all movement, View Transitions included. anime.js animations never block input; the only input pause is a View Transition, at most 165 ms.
- Offline v2 behaviour unchanged: worker-served pages render the new markup and the drift test passes.
- Committed `tailwind.css` is fresh (CI).

Acceptance tests per wave, beyond the existing suites (pytest, `tests/js`, Playwright offline):

- **Contract check** as in 5.5 (CI).
- **Visual check:** Playwright screenshots of the key screens at 1280 and 390 px, in light and dark, for each touched zone, reviewed against the mockups and stored as CI artifacts. Wave 1 uses a pixel diff instead (see 5.7). From wave 2 on, one old (not yet redesigned) screen is also captured under each app theme in dark mode, to catch mixed colours.
- **Flow tests (Playwright, role- and label-based selectors for new UI):**
  - open article, star, archive;
  - mark all read with undo;
  - add a source via the sheet;
  - palette search and action;
  - theme and app-theme switch persisting across reload;
  - phone tab bar and full-screen article;
  - swipe row read and star (touch emulation).
- **Motion:** a test that, under emulated reduced motion, no element keeps a running animation after an action, and that actions resolve without waiting.
- **Accessibility:** axe-core run on the key screens (no serious or critical violations); focus is trapped in dialogs and sheets and returns after close; every icon-only button has a label.
- **Mark-all undo (pytest):** only the caller's rows change (a second user's rows with the same stamp stay read); rows read properly after the mark-all stay read; a stamp older than 10 minutes is rejected; repeating the undo changes nothing; every mark-all variant, saved search included, returns a stamp and a count; the stamp survives the client round trip unchanged; the undo returns an empty body with `sidebarRefresh` and the toast, and the open list re-renders with unread badges; `ops.py:444` still works. Playwright: offline mark-all shows no Undo.
- **Delayed delete (tests/js + Playwright):** Undo restores the row and sends nothing; the delete is sent once after 10 s; boosted navigation during the window sends it and the destination list does not show the row; back/forward and reload during or right after the send do not show the row; two pending deletes go out in one batch request, also when the flush is triggered by `beforeunload`; a list re-render keeps pending and sent rows hidden; Undo disappears once sent (`visibilitychange`); cleanup notices from `HX-Trigger` are shown; a failed send shows the error and the row; an expired session (redirect to login), 403 and 429 count as failures; one failed item in a batch restores only that row; the request carries the CSRF header. pytest for `POST /settings/deletes`: a batch unsubscribing both feeds of a filter's scope leaves the filter consistent (deactivated, not pointing at a deleted feed); foreign and already-deleted ids are a no-op reported as `done` and change nothing; a failing item does not undo the others; two concurrent batches for one user run one after the other (advisory lock); several notices come back as a list under `showToast`.
- **Redirects (pytest):** the old → new table as in 5.4.
- **Negative paths:** discovery error and captcha message in add-source; palette with no results; JS disabled for the article page (readable, actions as plain forms where they are today).

## 7. Calls I made (owner can override)

- Basecoat as an npm dependency with vendored JS, not a fork.
- Jinja macros in `templates/ui/` as the only place for component markup.
- Geist (UI) and Source Serif 4 (article body) self-hosted as new assets; the reading-font preference gains them as options and still overrides the article font.
- Three app themes: Neutral, Paper, Graphite. Neutral is the default.
- Phone tab bar: Feed, Search, Add, Assistant, Folders.
- Settings regrouping and 308 redirects as in 5.1.
- Undo window: 10 s. Delayed delete is client-side (5.4). Mark-all undo by stamp, accepted for 10 minutes.
- Redirects: 308 with `no-store` for GET, aliases for non-GET until wave 8.
- Wave 1 (Tailwind 4) split from the foundation.
- Old screens follow the app theme through the `--color-gray-*` remap.
- The `/dev/ui` gallery is only available with `DEBUG`.
- Waves 5 to 7 in the order Sources, Assistant, Settings.
- New Playwright tests for the new UI use roles and labels. Old id-based tests stay until their zone is rewritten.

## 8. Left to the builder

- Exact Tailwind 4 config form (CSS-first `@theme` vs `@config` bridge) as long as the CI check holds.
- Exact component API of each macro.
- How the contract check parses JS (regex or AST), within the rules of 5.5.
- Exact anime.js parameters inside the token ranges.
- How `app.js` code is split inside a zone module.

## 8a. Owner decisions (2026-11-19)

- UI language stays English; localization goes to the backlog.
- Approach A (waves by zone on one foundation).
- Light/dark/system and the app theme stay per device (localStorage), as today.
- Deletes of feeds, labels and filters become delayed deletes with Undo; the inline confirmation is removed.

## 9. Open follow-ups (not in this run)

- Row lock in `strip_scope_references` (`services/scope_cleanup.py`) for the other callers of the delete services (the single `DELETE` routes, the API). The batch route is already serialised per user by its advisory lock.

- Localization (i18n) — backlog.
- Email briefing template redesign.

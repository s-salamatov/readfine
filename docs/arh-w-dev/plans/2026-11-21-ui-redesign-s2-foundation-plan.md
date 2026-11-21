# UI redesign s2 — Foundation Implementation Plan

Status: plan / candidate · 2026-11-21 · run `run-7429291d-8129-432b-beab-c61fff1112cd`, segment s2

**Goal:** lay down the design system, the motion layer and the safety rails that every zone wave builds on. The visible result is new colours and fonts under three app themes. The reading zones (list, article, sidebar, settings) keep their layout; this plan defines that check precisely (Global Constraints, "Acceptance"). Auth, error, admin and public pages are restyled through the `ui/` macros (owner decision Q5, 2026-11-21), and the owner accepts them on reviewed screenshots.

**Architecture:**
- **Token file.** `styles/tokens.css` is a new file imported by `input.css`. It is the only file allowed to hold colour literals. It contains:
  - the v3 palette `@theme`, moved out of `input.css`;
  - the shadcn token set for Neutral, Paper and Graphite, each light and dark, on `html[data-rf-theme]` and `.dark`;
  - a `--color-gray-*` remap per theme, which carries light mode and explicit `dark:` utilities;
  - a "legacy dark" token family. The dark overrides in `base.html` are per-utility literals (`html.dark .bg-gray-100 {#2a2a2a}`), so the remap alone cannot reach dark mode. These tokens point those overrides at per-theme values.
- **Basecoat.** Its component CSS is imported **selectively**: an explicit list of `basecoat-css/components/*.css` plus `styles/vega.css`. Readfine owns the token-to-`@theme` mapping. Basecoat's `base/base.css` is **not** imported, because it brings its own dark variant, `--font-sans`, `--radius-*`, `* {border-color}`, `scroll-smooth` and `overscroll-none`. Neither is `collapsible.css`, `tooltip.css` or `radio.css`, which style bare `details`/`summary`, `[data-tooltip]` and `[role=radiogroup]`.
- **Vendoring.** `scripts/vendor-assets.mjs` runs inside `npm run build`. It copies Basecoat JS, the anime.js UMD bundle and four latin variable `woff2` files from `node_modules` into `static/`. The copies are committed and CI checks they are fresh.
- **Components and motion.** Jinja macros live in `templates/ui/`. `static/js/ui/dialog.js` opens dialogs and sheets through `data-rf-open`. `static/js/ui/motion.js` and `styles/motion.css` hold the motion layer. A DEBUG-only `/dev/ui` gallery shows every macro.
- **Guards:**
  - DOM contract file and check (a node half, plus a pytest half that writes the rendered pages);
  - offline drift golden harness (pytest half and node half, joined by committed files);
  - template-version bump test;
  - colour lint and inline-handler check;
  - WR2-F1 display-order guard from the built CSS.
- **Moved pages.** A helper with an empty production table, proven by a synthetic entry.
- **Visual harness.** It gains a `layout` mode and a `gallery` mode with a dark-patch probe. Regenerating `tailwind.css` is the last code task.

**Tech stack:** all new devDependencies are exact versions, each published at least 14 days before 2026-11-21 (`npm view … time`, checked 2026-11-21):

| Package | Version | Published |
|---|---|---|
| `basecoat-css` | 1.1.0 (latest) | 2026-10-23 |
| `animejs` | 4.5.0 (latest stable; 5.0.0 is beta) | 2026-06-22 |
| `@fontsource-variable/geist` | 5.3.0 | 2026-07-19 |
| `@fontsource-variable/source-serif-4` | 5.3.1 | 2026-10-11 |

Unchanged from s1: Tailwind 4.3.5, Jinja2, pytest, `node --test` with jsdom, Playwright 1.64.1 with `/usr/bin/google-chrome-stable`.

**Design:** `docs/arh-w-dev/designs/2026-11-19-ui-redesign-design.md`. Binding for this segment:
- §3: CSP, Committed CSS, Offline mirror, DOM contract, Online partial goldens, Dark mode, Hard-coded colours, Offline internals;
- §5.3 (tokens, theme selection, old screens, no hard-coded colours, fonts, components, motion);
- §5.4: Moved pages, Basecoat initialisation, Basecoat and CSP, Inherited `hx-*`;
- §5.5: contract, drift, shell cache, stale snapshots;
- §5.7 wave 2 and §6 invariants.

**Execution:** the mode persisted at workflow init for run `run-7429291d-8129-432b-beab-c61fff1112cd`.

**Probe evidence (scratch, 2026-11-21, removed afterwards):**
- **Baseline.** A scratch build of `input.css` at `1d7f2f4` reproduces the committed `tailwind.css` byte for byte (86 648 B, gzip 14 649 B).
- **Basecoat package layout.** `basecoat-css@1.1.0` ships:
  - CSS: `dist/basecoat.css` = `basecoat-base.css` (`base/base.css`) + `styles/vega.css` + `basecoat-components.css` (all 39 `components/*.css`) + `compat/legacy.css`. It is exported as `basecoat-css/components/*` and `basecoat-css/styles/*`.
  - JS: per-component files in `dist/js/*.min.js`. The core `basecoat.min.js` (2.6 KB) holds the registry and the MutationObserver; `all.min.js` is 44 KB.
  - Templates: `templates/jinja/*.jinja`. Their dialog and command examples use inline `onclick` / `onpointerdown`, so Readfine does not use them.
  - Licence: MIT.
- **What Basecoat's `base/base.css` contains:**
  - `@custom-variant dark (&:is(html.dark *))`. Ours, declared later, wins: `.dark\:bg-gray-800:is(.dark *)` is unchanged.
  - `--font-sans: "Geist", …`.
  - `--radius-sm/md/lg/xl` as `calc(var(--radius) ± …)`. With `--radius: 0.5rem` they equal the Tailwind 4 defaults exactly (0.25 / 0.375 / 0.5 / 0.75 rem).
  - `* { border-border outline-ring/50 }`, `html { scroll-smooth }`, `body { overscroll-none }`.
- **Two import variants, built against the real sources:**

  | Variant | Minified | gzip | `check-css-vars` |
  |---|---|---|---|
  | Full `basecoat.css` | 316 270 B | 35 253 B | OK |
  | Selective (24 components + `vega.css` + own theme map) | 281 065 B | 31 433 B | OK (66 gray utilities) |

  In the selective variant, no bare `details` rule is emitted; `details` appears only under `.sidebar>nav` and `.accordion>`.
- **No class collisions.** Basecoat's top-level component classes (`.btn`, `.card`, `.input`, `.select`, `.label`, `.table`, `.field`, `.badge`, `.alert`, `.dialog`, `.drawer`, `.popover`, `.sidebar`, `.tabs`, `.toast`, …) do not occur as bare classes in templates, `static/js`, `routers/` or `services/`. The `card` hit is in `email/briefing.html`, which is not styled by `tailwind.css`. No source uses token-named utilities (`bg-primary`, `text-muted-foreground`, …).
- **Vendored JS adds no utilities.** Adding `anime.umd.min.js` or Basecoat `all.min.js` as an explicit `@source` leaves the build byte-identical (86 648 B). A canary file under the same scratch path was scanned, which proves the result.
- **Space/divide utilities (T7-N1 recheck).** Basecoat's only use of the space/divide utilities is `@apply flex -space-x-2` in `components/avatar.css` (`.avatar-group`). Avatar is not in the import list.
- **`anime.umd.min.js` 4.5.0.** It is 118 043 B and defines `globalThis.anime`. Neither it nor Basecoat's JS contains `eval(` or `new Function`.
- **Basecoat `toast.js` builds `onclick="…"` strings** from its `action.onclick` / `cancel.onclick` options. Its cancel button always carries `onclick` (empty when no option is passed).
- **Font `url()`.** Tailwind passes `url("../fonts/x.woff2")` through unchanged. From `/static/css/tailwind.css` it resolves to `/static/fonts/x.woff2`, which `sync.js` `staticRefs(…, cssOnly)` collects for the shell cache. Basecoat's `data:` URLs have no same origin, so `staticRefs` skips them.
- **Font files.** `@fontsource-variable` latin files:

  | File | Size |
  |---|---|
  | `geist-latin-wght-normal.woff2` | 29 400 B |
  | `geist-latin-wght-italic.woff2` | 31 008 B |
  | `source-serif-4-latin-wght-normal.woff2` | 50 936 B |
  | `source-serif-4-latin-wght-italic.woff2` | 51 576 B |
  | Total | 162 920 B |

  All are OFL-1.1, and each package ships its `LICENSE`.
- **CSP** (`backend/app/main.py:178-189`): `script-src 'self' 'nonce-…'`, no `'unsafe-inline'` and no `'unsafe-eval'`, so inline event-handler attributes never run. `style-src 'self' 'unsafe-inline'`, so inline `style=""` and `<style>` are allowed. No template or JS file has an inline `on*=` attribute today. `backend/tests/test_csp.py` already scans templates for htmx eval.
- **Snapshot closure.** `jinja2.meta.find_referenced_templates` over `app/partials/article_row.html` and `article_detail.html` gives 17 templates, `error_bar.html` among them, which has the inline `background:#f87171`. `render_snapshots` (`services/sync/snapshots.py:242`) uses `row_render_context`, `detail_render_context` and `list_density` (`routers/web/app/articles.py:207-232`). `OFFLINE_TEMPLATE_VERSION = "3"` is in `backend/app/services/sync/__init__.py:5`.
- **Colour literals today:**

  | File | Count |
  |---|---|
  | `input.css` | 151, of which about 100 are the `@theme` palette |
  | `base.html` | 119 |
  | `sidebar.html` | 3 |
  | `app.js` | 6 lines: 575, 584, 2487, 2493, 3163, 3819 |
  | `offline/templates.js` | 5 lines: 23, 328, 591, 654, 655 |
  | `offline/launch.js` | 5 |
  | `email/briefing.html` | 17 |
  | `labels.html` / `labels_list.html` | 3 / 1 (label palette data) |
  | `tokens.html` | 1 (API example text) |
  | `story_members.html:21` | `divide-[#ecedf1]` / `divide-[#353535]` |
  | `error_bar.html:9` | 1 |
  | `init.js:58` | 1 |
  | `landing.example.html` | 2 |

- **File paths.** These exist: `static/js/init.js`, `static/js/preferences.js` (`applyColorScheme`, `color_scheme_device` radios at `settings/preferences.html:378`), `window.syncThemeColor` (`init.js:53`, also called from `app.js:85` and `preferences.js:34`). `init.js` loads after the stylesheet `<link>` (`base.html:56` and `:502`), so computed custom properties are available when it runs.

## Changes from the draft

1. **The token file is a separate `styles/tokens.css`,** and the palette moves into it. The lint rule then reads "no literals outside `styles/tokens.css`". The draft put tokens inside `input.css`, which leaves the rule undefined.
2. **The dark mode gap (WR2-F5 and more) is made explicit.** `base.html:383-498` overrides each utility with a literal, so the `--color-gray-*` remap does not reach dark mode. A "legacy dark" token family and a dedicated `base.html` task (s2-T13) close the gap.
3. **Basecoat is imported selectively; `base/base.css` and `collapsible.css` are not.** Without this, old screens change: the `details`/`summary` layout in 8 templates, every border colour, smooth scrolling and overscroll. The radius stays identical through `--radius: 0.5rem`.
4. **Draft S2-T1 is split.** Dependencies, vendor script and fonts become s2-T1, which owns `package.json`. Tokens become s2-T9. Tokens need `basecoat-css` installed, and `package.json` can have one owner per wave.
5. **Draft S2-T2 is split.** The theme bootstrap and picker (`init.js`, `preferences.*`) become s2-T10. `base.html` becomes s2-T13. Hand-written CSS in `input.css` becomes s2-T14. Mirrored and snapshot partials plus JS literals become s2-T15, because they need the version bump and golden regeneration.
6. **Draft S2-T4 is split.** Form and display macros become s2-T16. Overlay and navigation macros, `dialog.js`, the gallery and the `<script>` tags in `base.html` become s2-T18.
7. **Draft S2-T6 is split.** The contract file and its node check become s2-T4. The pytest-rendered pages become s2-T11. The node job has no Python and the pytest job has no node, so they are joined by committed HTML, as in the drift design.
8. **Draft S2-T7 is split.** Harness and core fragments become s2-T5. Lists, sidebar and story fragments become s2-T12. Wave 3 (s3) needs the sidebar fragment covered.
9. **Draft S2-T10 is split.** The colour lint and inline-handler check are written early (s2-T3, wave 1) with fixture tests. Their real-tree inventory guides the token work. Wiring all CLI guards into `check:sources` and CI is one late task (s2-T20), so `package.json` and `ci.yml` have one owner per wave.
10. **New task s2-T8: visual acceptance modes.** The s1 pixel diff cannot accept a segment that changes colours and fonts on purpose. The harness gains a `layout` mode (two passes), a `gallery` mode (3 themes × light/dark) and a dark-patch probe. The default base moves to `1d7f2f4`.
11. **New task s2-T2 for the carry-over.** WR2-F1 (derive `HIDDEN_LOSES_TO` from the built CSS) plus the stale `story-overlay.test.mjs:180` fixture from the backlog. WR2-F2 and WR2-F3 go to the docs task (s2-T22). WR2-F5 goes to s2-T13/T14/T15. T7-N1 becomes a test in s2-T9.
12. **The template-version test covers all three context helpers.** It hashes `row_render_context`, `detail_render_context` and `list_density`. The draft named only `row_render_context`.
13. **The moved-pages test uses a synthetic table entry.** No page moves in s2, so the production table is empty and a test over it alone would prove nothing.
14. **The inline-handler check is a pytest test in `test_csp.py`** next to the existing htmx-eval scan, so it runs in the CI test job without wiring. It skips `static/js/vendor/`. The colour lint stays a node script.
15. **Paths corrected:** `backend/app/routers/web/moved_pages.py`, `backend/app/services/sync/__init__.py` (exists), `styles/motion.css` (new) and `tests/visual/layout.mjs` (new).
16. **Owner decisions Q1–Q8 are recorded** (see "Owner decisions (resolved 2026-11-21)"). The Paper and Graphite values come from the prototype and are copied into Appendix A, so workers do not need the published artifact.
17. **Revision 2026-11-21 (owner answers): no extra colour-lint exceptions.** Only three exceptions remain: email templates, `offline/launch.js` and the worker's offline page. New task s2-T27 moves the label palette onto tokens; stored label colours stay hex data (Q9). s2-T15 takes the `templates.js:23` fallback, and s2-T26 takes `landing.example.html`.
18. **Revision: full restyle of admin and public pages in s2 (Q3+Q5).** Draft S2-T11 (old s2-T19) becomes six tasks:
    - s2-T19: auth and error pages;
    - s2-T23: admin dashboard, traffic, settings;
    - s2-T24: admin feeds, users, invitations, logs, scoring eval;
    - s2-T25: help, features, changelog, legal;
    - s2-T26: landing;
    - s2-T28: a Playwright review of the restyled pages.
19. **Revision: layout exemptions move to one file per task.** They live in `tests/visual/layout-allow/<task>.json`, so restyle tasks in one wave do not share a file. A fully restyled screen is exempted whole (`key: "*"`) and accepted on reviewed screenshots instead.
20. **Revision: s2-T8's gallery covers every auth, error, admin and public page,** not only the 8 key screens. It also covers landing, when it is copied into the head tree for the run.
21. **Amendment 2026-11-21: repair tasks after the browser review.** s2-T28 (attempt a1, report `2e01fbb8…`) found 15 defects in completed tasks. The workflow cannot reopen completed tasks inside the implementation stage (return-to-repair works only backwards between stages), so the defects become repair tasks s2-T29–s2-T35 (see "Repair tasks after s2-T28"). s2-T28 now also waits for them and runs again as the confirmation pass before s2-T20.

## Orchestrator decisions (2026-11-21)

- One task per wave may run Playwright (e2e or visual). Ports 4251 and 4252 are fixed in `tests/e2e/env.mjs`, and no new port is assigned (`~/sgn-main_ports_registry.md` block 4200-4299). The Playwright tasks are:
  - s2-T8 (wave 1);
  - s2-T10 (wave 2);
  - s2-T28 (wave 6, and again after the repair tasks);
  - s2-T35 (repair wave);
  - s2-T21 (wave 8).

  The restyle tasks (s2-T19, T23–T26) validate with pytest and rendering. s2-T28 then reviews them in the browser; its defects become the repair tasks s2-T29–s2-T35, after which s2-T28 runs again.
- Real-tree runs of the new CLI guards (colour lint, DOM contract) are wired by s2-T20. Earlier tasks prove their scripts on fixtures and report the real-tree output.
- Tasks in waves 2–5 that add selectors used by JS or tests list them in their report. s2-T20 adds them to `docs/ui-dom-contract.md` and turns the check green. Restyle tasks keep every existing id and `data-*` attribute; a contract item is renamed only together with all its consumers.
- As-built project specs (`/projects/readfine/specs`: TRACKS line, handoff, backlog) are written by the spec-keeper at the segment's completion stage. In-repo docs are s2-T22.

## Owner decisions (resolved 2026-11-21)

Relayed by the orchestrator on 2026-11-21 and recorded as a resolved user decision.

| # | Question | Decision | Tasks |
|---|---|---|---|
| Q1 | Theme values | Accepted as recommended:<br>• tokens from Appendix A;<br>• gray remap Neutral → Tailwind 4 `neutral`, Paper → `stone`, Graphite → `slate`, as hex;<br>• Neutral dark keeps today's colours; Paper and Graphite dark take the nearest step of their scale;<br>• `--background` is hex;<br>• Graphite `--radius: 0.875rem`;<br>• per-theme `--rf-body-font` is left out (Q4). | s2-T9 |
| Q2 | Colour-lint exceptions | **Only three:**<br>• `templates/email/**`;<br>• `static/js/offline/launch.js`;<br>• the worker's offline page (`offlinePage()` in `offline/templates.js`).<br><br>Plus the token file itself. These move onto tokens in s2:<br>• `landing.example.html` (s2-T26);<br>• the label palette (s2-T27);<br>• the `tokens.html` API example (s2-T27);<br>• the `templates.js:23` label fallback (s2-T15). | s2-T3, T15, T26, T27 |
| Q3 | App-theme picker | Radios in Settings → Preferences in s2; s3 moves them to the account menu. | s2-T10 |
| Q4 | Default article font | Recommended default stands: `sans` → Geist, `serif` → Source Serif 4, stored default unchanged; a serif default is decided in s4. | s2-T13 |
| Q5 | Admin, auth and public pages | **Full restyle through the `ui/` macros in s2,** admin and public pages included. Their layout changes are listed acceptance exceptions with reviewed screenshots. | s2-T19, T23–T26, T28 |
| Q6 | Basecoat JS and anime.js on every page | Yes, static tags in `base.html`. | s2-T18 |
| Q7 | CSS growth (about 281 KB min, gzip about 31 KB) | Accepted. | s2-T9 |
| Q8 | Accent scales per theme | Recommended default stands: gray only, plus the legacy dark family. | s2-T9 |

### Still open for the owner

**Q9 — stored label colours stay hex data.** A label's colour is user data, not a source literal:
- the column is `labels.color`, `String(7)`, default `#6366f1` (`models/label.py:14`);
- the API accepts any `#RRGGBB` (`schemas/label.py:18-23`);
- OPML import keeps any valid hex and falls back to `DEFAULT_LABEL_COLOR` (`services/opml.py:72,558-559`);
- the colour syncs to offline devices and is rendered as inline `style` in 10 templates and `app.js` / `templates.js`.

Turning stored values into palette names would change the API, OPML and the offline payload, and would need a migration. That is a non-goal.

s2-T27 therefore:
- keeps storage as it is;
- renders the swatches with `var(--rf-label-<name>)`;
- takes the hex values that the form submits from one Python constant, `backend/app/services/label_palette.py`. `DEFAULT_LABEL_COLOR`, the form defaults and `stats_service` use it too.

`tokens.css` defines the same 16 values as `--rf-label-<name>`, the same in every theme, and a test keeps the two equal.

The narrowest exception, then:
- Stored colours reach the page through `{{ label.color }}` and need no lint exception.
- The palette's canonical hex lives in Python, and Python is outside the lint's scope (templates, `static/js`, CSS).

**Owner: confirm that the Python palette constant is acceptable as the data source.** The alternative is to make `tokens.css` the source and generate the Python constant from it at build time. That adds a build step to the backend image for little gain. A follow-up, not in s2: map a stored colour that equals a palette entry to its token at render time, so palette colours could vary per theme. That touches the snapshot partials and the mirror.

**Q10 — the live `landing.html`.** s2-T26 restyles `landing.example.html` only. The live `landing.html` is a gitignored per-instance copy (`routers/web/auth.py:63-71`), so the owner must re-copy it on the instance; s2-T22 writes the upgrade note. No decision is needed unless the owner wants it handled differently.

### What remains for s8

Before this revision, s8 was "full redesign of admin, landing, features, changelog, help and legal; removal of the non-GET aliases". After s2, s8 keeps:
- removal of the non-GET aliases of moved pages;
- fitting the admin pages into the s3 shell and navigation (the admin sidebar and links), where s3 has not already done it;
- a structural or content redesign of help and landing beyond macro adoption, if the owner wants one;
- polish from the owner's review of the s2 gallery.

Macro adoption and the theme restyle of admin, auth, error and public pages are done in s2.

## Global Constraints

- **Themes.** Neutral (default), Paper and Graphite, each light and dark. The selection is per device in `localStorage` (`colorScheme`: light / dark / system as today; `appTheme`: neutral / paper / graphite). There is no server preference and no migration. `<html class="dark" data-rf-theme="paper">` is set by `init.js` before first paint. An unknown or missing `appTheme` means `neutral`.
- **Token file.** `styles/tokens.css` is the only place for colour literals (`#…`, `rgb()`, `rgba()`, `hsl()`, `oklch()`) in CSS, templates and `static/js`. Q2 allows only three exceptions: `templates/email/**`, `static/js/offline/launch.js` and `offlinePage()` in `offline/templates.js`. Stored label colours are user data and reach the page through `{{ label.color }}`; they are not source literals (Q9). Surface tokens, at least `--background`, are hex so that `theme-color` works on iOS.
- **No layout change on screens s2 does not restyle.** Old screens keep their geometry. The Q5 exception is the auth, error, admin and public pages, which s2 restyles on purpose through the macros; they are accepted on reviewed screenshots. Basecoat CSS must not reach old markup:
  - no `base/base.css`, `collapsible.css`, `tooltip.css`, `radio.css`, `avatar.css` or `compat/legacy.css`;
  - `--radius: 0.5rem` (Graphite `0.875rem` per Q1, which changes corners only, not boxes);
  - the `--font-sans` fallback tail equals the Tailwind 4 default stack.
- **Fonts.** Geist (wght normal and italic) and Source Serif 4 (wght normal and italic), latin `woff2`, 162 920 B in total (budget 200 KB). `@font-face` lives in `input.css` with `url("../fonts/…")` and `font-display: swap`. The OFL text ships next to the files.
- **Motion tokens.** `--t-fast` 125 ms, `--t-fast-max` 165 ms, `--t-med` 300 ms, `--t-med-max` 400 ms, `--t-slow` 700 ms. Everything is instant under `prefers-reduced-motion: reduce`, View Transitions included. A View Transition lasts at most 165 ms.
- **No inline event handler attribute** in templates, `static/js` (except `vendor/`) or Python strings under `routers/` and `services/`. Dialogs and sheets open through `data-rf-open="<id>"`. No `hx-on`, no `js:`, no trigger filters (design §3).
- **Snapshot output.** Every change to snapshot-rendered output (the closure of `article_row.html` and `article_detail.html`, plus the three context helpers) bumps `OFFLINE_TEMPLATE_VERSION` and updates the pinned hash. The online partial goldens (`backend/tests/fixtures/partials_online/`) and offline drift goldens are regenerated with `RF_UPDATE_GOLDENS=1` in the same task, and the reviewer checks their diff.
- **Mirrored pairs change together:** `sidebar.html` `<style>` with `SIDEBAR_STYLE` (`templates.js:591`); `story_members.html:21` with `templates.js:328`.
- **Vendored files.** They are committed and produced only by `scripts/vendor-assets.mjs`. They are loaded with static `<script src="{{ static_url(…) }}">` in `base.html` (shell cache discovery, design §5.5), never through dynamic `import()`.
- **Committed CSS.** Before s2-T21, no task writes the committed `tailwind.css`. Builds go to `$(mktemp -d)`, or to the worker's worktree copy, which is restored before the report.
- **Workers:**
  - no commits;
  - at most 5 new test functions per task, unless the task says otherwise;
  - stop after 3 failed approaches;
  - out-of-scope observations go into the report as "noticed" lines.
- **Test environment:**
  - `npm test` needs `TMPDIR=/var/tmp`, because `/tmp/.gitignore` makes Tailwind skip scratch sources.
  - Backend tests need:
    ```
    SECRET_KEY=ci-test-secret-key-0123456789abcdef
    ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd
    DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4250/<throwaway>
    ```
    `<throwaway>` is a database the worker creates on dev-pg (for example `rf_s2_t6_<rand>`) and drops afterwards. Never use `readfine_test` or `readfine_e2e` on dev-pg.
  - e2e and visual need a throwaway Postgres container on `127.0.0.1:4253` with a database named exactly `readfine_e2e` (the seed refuses other names), passed as `E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e`. The container is removed afterwards.
  - Never touch production (`/opt/readfine`, container `readfine-app-1` on :4200) and never log in to it.
- **Acceptance (replaces the s1 pixel threshold for this segment):**
  1. **Layout, fonts blocked:** `RF_VISUAL_MODE=layout`, pass A. Font requests are aborted on both sides, so the head falls back to the same stack as the base. Every tracked box (every visible element with an `id`, the first 10 `.article-row`, the first 20 `.nav-item`) of every key screen × viewport × scheme matches the base within 0.5 px, and the key sets are equal. The only exceptions are the entries in `tests/visual/layout-allow/<task>.json`, each with a reason. A `key: "*"` entry exempts a whole screen. In s2 these exist:
     - `s2-T10.json`: the boxes below the app-theme radios on `settings-preferences`;
     - `s2-T19.json`: `login` (`*`);
     - `s2-T25.json`: `help` (`*`);
     - `s2-T23.json`: `admin-settings` (`*`).

     A whole-screen exemption is accepted only with the screen's gallery shots reviewed (item 3).
  2. **Layout, fonts loaded:** pass B. The structural boxes in `KEY_STRUCTURE` (shell panes, sidebar, list pane, detail pane, fixed bars, settings column, login card) keep x, width and the bar heights within 1 px. Text reflow elsewhere is listed in the report and reviewed, not failed.
  3. **Gallery:** `RF_VISUAL_MODE=gallery`. Head-only screenshots of `GALLERY_PAGES` × 3 themes × light/dark × 1280/390. `GALLERY_PAGES` holds:
     - the 8 key screens;
     - every auth, error, admin and public page;
     - landing, with `RF_VISUAL_LANDING=1`;
     - `/dev/ui` at 1280, with `RF_VISUAL_DEBUG=1`.

     They go into `test-results/visual-report/gallery.html`. The orchestrator publishes them on the Result page for the owner's review. The restyled pages are reviewed there against the mockups, with their base shots beside them.
  4. **Dark-patch probe:** inside gallery mode, under each theme's dark scheme, no visible element of at least 8×8 px has a computed `background-color` whose relative luminance exceeds 0.45, outside the allowlist calibrated on the base's dark mode in s2-T8.
  5. **Pixel diff** stays available (`RF_VISUAL_MODE=pixel`, the default) for later segments and for the harness self-check. It is not a gate for s2.
  6. All suites green: pytest, `npm test`, `npm run test:e2e -- --project=chrome` (offline suite: the shell works offline with the new scripts and fonts) and the new theme e2e. Also `npm run check:generated` and `npm run check:sources`.

## Review Focus

1. **Leftover hex under a dark theme.** An old screen under Paper dark or Graphite dark shows no light-grey patch from a leftover literal. → s2-T8 dark-patch probe; s2-T13/T14/T15 move literals; s2-T3 colour lint (wired in s2-T20).
2. **`theme-color` on iOS.** It follows the active theme and scheme, and is written as hex/rgb, never `oklch()`. → s2-T10 test `theme: theme-color follows --background as hex`; s2-T9 test that `--background` is hex in all six blocks.
3. **A Basecoat dialog opens without inline `onclick`.** → s2-T18 test `dialog: data-rf-open opens and returns focus`; s2-T3 pytest `no inline event handlers`.
4. **A runtime-built id passes as a prefix.** `'article-row-' + id` is recorded as `article-row-*` and passes. → s2-T4 test `contract: runtime-built id becomes a prefix pattern`.
5. **A partial changed without a `templates.js` update fails CI.** → s2-T5 test `drift: a changed partial without its mirror fails`.
6. **Basecoat CSS reaches no old markup.** No bare `details`/`summary`, `[data-tooltip]` or `[role=radiogroup]` rule; no `*` border or outline, `scroll-behavior` or `overscroll-behavior` rule; `--radius-*` unchanged. → s2-T9 test `basecoat: selective import leaves old markup alone`; acceptance pass A.
7. **No flash of the wrong theme.** `data-rf-theme` and `.dark` are set synchronously before `<body>`. An unknown `appTheme` falls back to `neutral`. → s2-T10 tests.
8. **Snapshot change without a bump.** Tokenising `error_bar.html` (in the snapshot closure) bumps `OFFLINE_TEMPLATE_VERSION`, updates the hash and regenerates both golden sets. → s2-T6 test `template-version: closure change without bump fails`; s2-T15 steps.
9. **Vendored copies.** They equal `node_modules` byte for byte, CI fails when they are stale, and vendoring changes no utility in `tailwind.css`. → s2-T1 tests.
10. **Fonts.** Under 200 KB, OFL text shipped, picked up by the shell cache through CSS `url()`, `font-display: swap`. → s2-T1 and s2-T9 tests; the offline e2e in s2-T21.
11. **Basecoat `toast.js` inline `onclick` strings.** No Readfine code passes `onclick` options. The inline-handler check skips `vendor/` on purpose. s3 must verify the empty cancel `onclick` under CSP. → noted for s3; s2-T18 report.
12. **Moved pages.** A synthetic entry answers 308 with `Cache-Control: no-store` to a target that returns 200, and its POST alias works. → s2-T7.
13. **Display order (WR2-F1).** `inline-grid` and `table-cell` next to `hidden` are caught, because the list is derived from the built CSS. → s2-T2.
14. **Stored label colours keep working.** A label stored as any `#RRGGBB` (API, OPML) still renders. A palette swatch submits the same hex as before, and its swatch colour equals the stored colour's rendering. → s2-T27 tests `palette: tokens.css and label_palette.py agree` and `palette: create with a swatch stores the same hex`.
15. **Restyled pages keep their contract and text.** Admin JS (`admin-feeds.js`, `admin-settings.js`, `traffic-chart.js`) and the backend tests that assert on HTML text keep finding their ids, `data-*` and strings. → full pytest in s2-T19 and T23–T26; contract check in s2-T20; s2-T28 browser review.
16. **Landing follows the device theme.** Landing loads `init.js` instead of its inline copy of the scheme logic, and its `theme-color` comes from `--background`. → s2-T26.

## File map

One owner per file per wave. Later owners are named. Planned cross-task interfaces:
- s2-T1's `build` script runs s2-T1's `scripts/vendor-assets.mjs`.
- s2-T20 wires the CLIs of s2-T3 (`check-colours.mjs`) and s2-T4 (`check-dom-contract.mjs`).
- s2-T4's check reads s2-T11's `backend/tests/fixtures/dom_contract/*.html` and s2-T5's `backend/tests/fixtures/offline_drift/*.html` when they exist.
- s2-T9 creates `styles/motion.css` as an empty, imported file; s2-T17 is its later owner.

| File | Task | Responsibility |
|---|---|---|
| `package.json`, `package-lock.json` | T1 (later T20) | exact deps; `vendor`, `build`, `check:generated` (T1); `check:sources` additions (T20) |
| `scripts/vendor-assets.mjs` | T1 | copy Basecoat JS, anime UMD, fonts and licences from `node_modules` |
| `backend/app/static/js/vendor/basecoat/*`, `backend/app/static/js/vendor/anime/*`, `backend/app/static/fonts/*` | T1 (regenerated by T21) | vendored copies |
| `.github/workflows/ci.yml` | T1 (later T20) | vendored freshness step (T1); colour and contract steps (T20) |
| `tests/js/vendor-assets.test.mjs` | T1 | vendor tests |
| `scripts/check-tw4-classes.mjs`, `tests/js/check-tw4-classes.test.mjs`, `tests/js/story-overlay.test.mjs` | T2 | WR2-F1; backlog fixture |
| `scripts/check-colours.mjs`, `tests/js/check-colours.test.mjs` | T3 | colour lint |
| `backend/tests/test_csp.py` | T3 | inline-handler check |
| `docs/ui-dom-contract.md` | T4 (later T20) | contract file |
| `scripts/check-dom-contract.mjs`, `tests/js/check-dom-contract.test.mjs` | T4 | contract check |
| `backend/tests/test_offline_drift.py`, `backend/tests/fixtures/offline_drift/*`, `tests/js/offline-drift.test.mjs`, `tests/js/offline-drift/adapters.mjs` | T5 (later T12, then T15 for regenerated goldens) | drift harness |
| `backend/tests/test_offline_template_version.py` | T6 | bump test |
| `backend/app/services/sync/__init__.py`, `backend/tests/test_offline_template_version.py` (ledger) | T6 (later T15) | pinned hash next to the version; bump in T15 |
| `backend/app/routers/web/moved_pages.py`, `backend/tests/test_moved_pages.py` | T7 | moved-pages helper |
| `backend/app/main.py` | T7 (later T18) | register moved pages (T7); `/dev/ui` router (T18) |
| `tests/visual/key-screens.spec.mjs`, `tests/visual/run.mjs`, `tests/visual/layout.mjs`, `tests/visual/gallery-pages.mjs`, `tests/visual/layout-allow/README.md`, `playwright.visual.config.mjs`, `tests/js/visual-layout.test.mjs` | T8 | visual acceptance modes; `GALLERY_PAGES` |
| `tests/visual/layout-allow/s2-T10.json`, `s2-T19.json`, `s2-T23.json`, `s2-T25.json` | T10, T19, T23, T25 (one file each) | layout exemptions with reasons |
| `styles/tokens.css` | T9 | palette, themes, gray remap, legacy dark family, Basecoat vars |
| `input.css` | T9 (later T14) | imports, theme map, Basecoat list, fonts, radius, motion tokens (T9); hand-written rules on tokens (T14) |
| `styles/motion.css` | T9 creates empty (later T17) | View Transition and reduced-motion CSS, colour-flash keyframes |
| `tests/js/tailwind-build.test.mjs` | T9 (later T14) | sources test copies `styles/`; palette assertions via tokens |
| `tests/js/theme-tokens.test.mjs` | T9 | token, theme and Basecoat-import tests |
| `backend/app/static/js/init.js`, `backend/app/static/js/preferences.js`, `backend/app/templates/settings/preferences.html` | T10 | theme bootstrap and picker |
| `tests/js/theme-bootstrap.test.mjs`, `tests/e2e/theme.spec.mjs` | T10 | theme tests |
| `backend/tests/test_dom_contract_pages.py`, `backend/tests/fixtures/dom_contract/*` | T11 | rendered pages for the contract |
| `backend/app/templates/base.html` | T13 (later T18) | style block on tokens, meta, serif (T13); `<script src>` tags (T18) |
| `backend/app/templates/app/partials/sidebar.html`, `story_members.html`, `error_bar.html`, `backend/app/static/js/offline/templates.js`, `backend/app/static/js/app.js`, `backend/tests/fixtures/partials_online/*` | T15 | mirrored and snapshot partials, JS literals |
| `backend/app/templates/ui/forms.html`, `ui/display.html`, `ui/readfine.html`, `backend/tests/test_ui_macros.py` | T16 | form and display macros |
| `backend/app/static/js/ui/motion.js`, `tests/js/motion.test.mjs` | T17 | motion module |
| `backend/app/templates/ui/overlay.html`, `ui/nav.html`, `backend/app/static/js/ui/dialog.js`, `backend/app/routers/web/dev_ui.py`, `backend/app/templates/dev/ui.html`, `backend/tests/test_dev_ui.py`, `tests/js/ui-dialog.test.mjs` | T18 | overlay and navigation macros, dialog, gallery |
| `backend/app/services/label_palette.py`, `backend/app/templating.py` (one global), `backend/app/templates/settings/labels.html`, `settings/partials/labels_list.html`, `settings/tokens.html`, `backend/app/routers/web/settings/labels.py`, `backend/app/services/opml.py` (`DEFAULT_LABEL_COLOR`), `backend/app/services/stats_service.py` (default colour), `backend/tests/test_label_palette.py` | T27 | label palette on tokens |
| `backend/app/templates/auth/*`, `errors/*`, `backend/tests/test_restyle_auth_pages.py` | T19 | auth and error pages through the macros |
| `backend/app/templates/admin/base.html`, `admin/dashboard.html`, `admin/traffic.html`, `admin/settings.html`, `admin/partials/rate_limits_modal.html`, `backend/app/static/js/admin-settings.js`, `backend/app/static/js/traffic-chart.js`, `backend/tests/test_restyle_admin_core.py` | T23 | admin I through the macros |
| `admin/feeds.html`, `admin/users.html`, `admin/invitations.html`, `admin/audit_log.html`, `admin/fetch_logs.html`, `admin/scoring_eval.html`, `admin/partials/{feeds_table,feed_edit_form,users_table,users_count,invitations_table}.html`, `backend/app/static/js/admin-feeds.js`, `backend/app/routers/web/admin.py` (three strings), `backend/tests/test_restyle_admin_lists.py` | T24 | admin II through the macros |
| `help.html`, `features.html`, `changelog.html`, `legal/*`, `backend/tests/test_restyle_public_pages.py` | T25 | public pages through the macros |
| `landing.example.html`, `backend/tests/test_restyle_landing.py` | T26 | landing through the macros, theme bootstrap via `init.js` |
| `backend/app/static/css/tailwind.css` | T21 | regenerated (last code task) |
| `README.md`, `CLAUDE.md`, `CHANGELOG.md` | T22 | as-built docs |

## Tasks

Waves:

| Wave | Tasks |
|---|---|
| 1 | T1, T2, T3, T4, T5, T6, T7, T8 |
| 2 | T9, T10, T12 |
| 3 | T13, T14, T15, T16, T17, T27 |
| 4 | T18, T19, T25, T26 |
| 5 | T23, T24 |
| 6 | T11, T28 |
| 7 | T20 |
| 8 | T21 |
| 9 | T22 |

Where a wave seems to share a file, the "later owner" column in the File map resolves it.

- s2-T11 renders real templates, so it runs after the last task that changes them: T10 (`preferences.html`), T13 and T18 (`base.html`), T15 (`sidebar.html`, `error_bar.html`), T19 (auth pages) and T23–T26. Its fixtures are then fresh at T21.
- The admin restyle (T23, T24) waits for s2-T18, because admin uses modals and menus. Auth, error, public and landing pages need only the form and display macros (s2-T16), so they run in wave 4.
- Restyle task numbers (T23–T28) were added in the 2026-11-21 revision; the ids of earlier tasks are kept stable.

### Task s2-T1: Dependencies, vendor script and fonts

**Size** M · agent: worker · blocked_by: —

**Files:**
- Modify: `package.json`, `package-lock.json`, `.github/workflows/ci.yml` (frontend job: one step after "Fail if committed tailwind.css is stale")
- Create:
  - `scripts/vendor-assets.mjs`;
  - `backend/app/static/js/vendor/basecoat/{basecoat,dropdown-menu,popover,tabs,select,command,sidebar,drawer,toast}.min.js` and `LICENSE.md`;
  - `backend/app/static/js/vendor/anime/anime.umd.min.js` and `LICENSE.md`;
  - `backend/app/static/fonts/{geist-latin-wght-normal,geist-latin-wght-italic,source-serif-4-latin-wght-normal,source-serif-4-latin-wght-italic}.woff2`, `OFL-geist.txt` and `OFL-source-serif-4.txt`.
- Test: `tests/js/vendor-assets.test.mjs`

**Interfaces.**

Produces `scripts/vendor-assets.mjs`:
- `export const VENDOR: Array<{ from: string, to: string }>`. Each `from` is a path under `node_modules`; each `to` is a path under `backend/app/static/`. The files are:
  - Basecoat: `basecoat-css/dist/js/<name>.min.js` → `js/vendor/basecoat/<name>.min.js` for the 9 names above, and `basecoat-css/LICENSE.md`;
  - anime: `animejs/dist/bundles/anime.umd.min.js` → `js/vendor/anime/anime.umd.min.js`, and the animejs licence file;
  - fonts: `@fontsource-variable/geist/files/geist-latin-wght-{normal,italic}.woff2` and `@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-{normal,italic}.woff2` → `fonts/`, plus each package's `LICENSE` → `fonts/OFL-<family>.txt`.
- `export function vendor(root: string): { copied: number, bytes: number }`. It copies byte for byte and removes files under the two vendor dirs and `fonts/` that are not in `VENDOR`. It never touches `js/vendor/minisearch.js`.
- CLI `node scripts/vendor-assets.mjs` prints `vendor: <n> files, <bytes> B` and exits 0. It exits 1 with the missing path when a `from` is absent.

Produces `package.json`:
- devDependencies, exact:
  ```
  "basecoat-css": "1.1.0"
  "animejs": "4.5.0"
  "@fontsource-variable/geist": "5.3.0"
  "@fontsource-variable/source-serif-4": "5.3.1"
  ```
- scripts:
  - `"vendor": "node scripts/vendor-assets.mjs"`;
  - `"build": "node scripts/vendor-assets.mjs && tailwindcss -i input.css -o backend/app/static/css/tailwind.css --minify"`;
  - `"check:generated": "npm run build && git diff --exit-code backend/app/static/css/tailwind.css backend/app/static/js/vendor backend/app/static/fonts"`.

Produces `ci.yml`: a step `Fail if vendored assets are stale` that runs `git diff --exit-code backend/app/static/js/vendor backend/app/static/fonts`. CI's `Build CSS` step already runs `npm run build`, which vendors first.

Steps:
- [ ] **RED:** `tests/js/vendor-assets.test.mjs`:
  - `vendor: copies are byte-identical to node_modules`: for each `VENDOR` entry, the sha256 of `from` equals the sha256 of `to`.
  - `vendor: fonts are latin woff2 under 200 KB with their OFL text`: the four `woff2` files sum to less than 204 800 B and start with the `wOF2` magic; `fonts/OFL-geist.txt` and `fonts/OFL-source-serif-4.txt` contain `SIL OPEN FONT LICENSE`.
  - `vendor: stale files are removed, minisearch kept`: run `vendor()` on a `mkdtemp` copy of the static tree that has an extra `js/vendor/basecoat/old.js`. Afterwards `old.js` is gone and `js/vendor/minisearch.js` is still there.
- [ ] Run: `TMPDIR=/var/tmp node --test tests/js/vendor-assets.test.mjs`. Expected: `# fail` ≥ 2.
- [ ] **GREEN:** `npm install -D --save-exact basecoat-css@1.1.0 animejs@4.5.0 @fontsource-variable/geist@5.3.0 @fontsource-variable/source-serif-4@5.3.1`. Then write the script, the package scripts and the CI step, and run `npm run vendor`.
- [ ] Run: `TMPDIR=/var/tmp node --test tests/js/vendor-assets.test.mjs`. Expected: `# fail 0`.
- [ ] Run: `npm run vendor && git status --short backend/app/static`. Expected: only the new vendor and font files. Running it twice produces no further change.
- [ ] One-off check, not in `npm test`: `O=$(mktemp -d) && npx tailwindcss -i input.css -o $O/tw.css --minify && cmp $O/tw.css backend/app/static/css/tailwind.css && echo no-new-utilities; rm -r $O`. Expected: `no-new-utilities` (probe: byte-identical at 86 648 B). This holds only before s2-T9 imports Basecoat; that is why it is not a permanent test.
- [ ] Run: `node -e "const s=require('fs').readFileSync('backend/app/static/js/vendor/anime/anime.umd.min.js','utf8');process.exit(/new Function|\beval\(/.test(s)?1:0)"`. Repeat for each Basecoat file. Expected: exit 0.
- [ ] Run: `TMPDIR=/var/tmp npm test`. Expected: `# fail 0`.
- [ ] Run: `git status --short backend/app/static/css/tailwind.css`. Expected: empty (T21 owns it).

### Task s2-T2: Display-order guard from the built CSS (WR2-F1) and the stale story fixture

**Size** S · agent: worker · blocked_by: —

**Files:**
- Modify: `scripts/check-tw4-classes.mjs`:
  - `:28-33`: `HIDDEN_LOSES_TO` and `DISPLAY_ALL` become derived;
  - `main()`: a new `--css <file>` option, default `backend/app/static/css/tailwind.css`.
- Modify: `tests/js/check-tw4-classes.test.mjs`, `tests/js/story-overlay.test.mjs:180`
- Carry-over: WR2-F1. Backlog: "Stale fixture in `tests/js/story-overlay.test.mjs:180`".

**Interfaces.**
- `export function displayAfterHidden(css: string): string[]`. It returns the unprefixed display utilities (`block`, `inline`, `inline-block`, `inline-flex`, `inline-grid`, `inline-table`, `table`, `table-cell`, `table-row`, `flex`, `grid`, `contents`, `flow-root`, `list-item`, …) whose rule `.<name>{display:…}` comes after `.hidden{display:none}` in the built CSS. Rules inside `@media` or with a variant are ignored.
- `export function displayAll(css: string): string[]`. It returns every unprefixed display utility in the build.
- `HIDDEN_LOSES_TO` and `DISPLAY_ALL` stay exported for compatibility. They are computed from the default CSS file when it exists, and fall back to the current four names otherwise.
- `hiddenDisplayHits(files, display)` is unchanged.

Steps:
- [ ] **RED:** in `tests/js/check-tw4-classes.test.mjs`, add `tw4-classes: display utilities after .hidden come from the built CSS`. Input: `'.block{display:block}.hidden{display:none}.inline-grid{display:inline-grid}.table-cell{display:table-cell}@media (min-width:640px){.sm\\:flex{display:flex}}'`. Expected: `['inline-grid', 'table-cell']`. Then run `hiddenDisplayHits` on `class="hidden inline-grid"` with that list. Expected: one hit.
- [ ] Run: `node --test tests/js/check-tw4-classes.test.mjs`. Expected: `# fail 1`.
- [ ] **GREEN:** implement both functions and the `--css` option. In `story-overlay.test.mjs:180`, change the fixture to the T8 markup: one display utility per element, so `class="hidden"` for an unread member. Keep the assertion that the mark loses `hidden` on `articleReadChanged`. If `_syncStoryFooterLine` now adds `inline-flex`, assert that too.
- [ ] Run: `node --test tests/js/check-tw4-classes.test.mjs tests/js/story-overlay.test.mjs && node scripts/check-tw4-classes.mjs`. Expected: `# fail 0`, then `tw4-classes: OK`.
- [ ] Run: `node -e "import('./scripts/check-tw4-classes.mjs').then(m=>console.log(m.displayAfterHidden(require('fs').readFileSync('backend/app/static/css/tailwind.css','utf8'))))"`. Expected: it includes `inline`, `inline-block`, `inline-flex` and `table`. Report the full list.

### Task s2-T3: Colour lint and inline-handler check

**Size** M · agent: worker · blocked_by: —

**Files:**
- Create: `scripts/check-colours.mjs`, `tests/js/check-colours.test.mjs`
- Modify: `backend/tests/test_csp.py` (one test added after `test_templates_do_not_use_htmx_eval`)

**Interfaces.**

Produces `scripts/check-colours.mjs`:
- `export function colourHits(files: Array<{ path, text }>, allow = ALLOW): Array<{ path, line, literal }>`.
  - It matches `(?<![&\w])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])` and `\b(?:rgba?|hsla?|oklch|oklab)\(` in CSS text, in `<style>` and `style=""` content, in arbitrary-value classes (`divide-[#ecedf1]`) and in JS strings.
  - The `(?![\w-])` guard matters. A plain `\b` matches id selectors such as `#feed-…` (`settings/feeds.html:28-47`, `sidebar.html:368`, `help.html:245`, `feed_error.html:6`), because `\b` sits before the `-`.
  - These are not colours and never match:
    - HTML entities (`&#123;`);
    - id references in attribute values of `href`, `hx-target`, `hx-select`, `hx-include`, `hx-indicator` and `for`;
    - selector strings passed to `querySelector*`, `closest`, `matches` and `getElementById`;
    - `location.hash`;
    - Jinja comments.
- `export const ALLOW`: exactly the Q2 owner decision, each entry with its reason:
  - `styles/tokens.css` (the token file);
  - `backend/app/templates/email/**` (mail clients get no stylesheet);
  - `static/js/offline/launch.js` (self-contained worker launch page);
  - function `offlinePage()` in `static/js/offline/templates.js` (self-contained worker offline page, design §5.5), matched by function span, not by line number.

  Nothing else. In particular, `landing.example.html`, the label palette, `tokens.html` and `templates.js:23` are **not** allowed; s2-T26, T27 and T15 clear them.
- A test asserts that `ALLOW` has exactly these four entries, so it cannot grow without a plan change.
- Roots: `input.css`, `styles/`, `backend/app/templates`, `backend/app/static/js`. It skips `vendor/` and `htmx.min.js`.
- CLI `node scripts/check-colours.mjs [--list]`:
  - success prints `colours: OK (<n> files)` and exits 0;
  - failure prints `colours: FAIL — <m> literals` with one `<path>:<line> <literal>` line each, and exits 1;
  - `--list` prints the per-file counts.

Produces `test_csp.py::test_templates_have_no_inline_event_handlers`:
- It scans `app/templates/**/*.html`, `app/static/js/**/*.js` (not `vendor/`, `htmx.min.js`) and `app/routers/**/*.py` / `app/services/**/*.py`.
- It matches an attribute name from a fixed list of DOM event handlers (`onabort onblur onchange onclick oncontextmenu ondblclick onerror onfocus oninput onkeydown onkeypress onkeyup onload onmousedown onmouseenter onmouseleave onmousemove onmouseout onmouseover onmouseup onpaste onpointerdown onpointerup onreset onresize onscroll onselect onsubmit ontoggle ontouchstart ontouchend onwheel …`).
- An attribute is a whole name after whitespace or a quote, followed by `\s*=`. So `content=`, `once=`, `only=`, `data-onclick=` and `aria-…` do not match.

Steps:
- [ ] **RED:** `tests/js/check-colours.test.mjs`:
  - `colours: literal in CSS, style attribute, arbitrary class and JS string is reported`. A fixture of four files gives exactly 4 hits.
  - `colours: entities, id references and allowed paths are not reported`: `&#39;`, `href="#top"`, `hx-target="#feed"`, `class="x" data-x="#feed-list"`, `querySelector('#add')`, `location.hash === '#x'`, and a hit in `templates/email/x.html`.
  - `colours: only the four Q2 exceptions are allowed`: `styles/tokens.css` with `#fff` → no hit; the same text in `input.css` → one hit; `landing.example.html`, `settings/labels.html` and a `templates.js` hit outside `offlinePage()` → hits. `ALLOW.length === 4`.
- [ ] **RED:** add `test_templates_have_no_inline_event_handlers` to `test_csp.py`. Its parametrised self-check feeds the matcher `'<button onclick="x()">'` (hit), `'<meta content="x">'` and `'<a data-onclick="x">'` (no hit). Then it asserts the real tree has 0 hits.
- [ ] Run: `node --test tests/js/check-colours.test.mjs`. Expected: `# fail 3`. Run: `cd backend && uv run pytest tests/test_csp.py -q` (env as in Global Constraints; no DB needed). Expected: the new test errors with `NameError` before GREEN.
- [ ] **GREEN:** write the script and the test.
- [ ] Run: both commands again. Expected: `# fail 0`; pytest `passed`.
- [ ] Run: `node scripts/check-colours.mjs --list`. Expected: `colours: FAIL`. Paste the per-file counts into the report: this inventory is what s2-T9 tokenises and s2-T13/T14/T15 clear. Expected files and their clearing tasks:

| File | Cleared by |
|---|---|
| `input.css` | T9, T14 |
| `base.html` | T13 |
| `sidebar.html` | T15 |
| `story_members.html` | T15 |
| `error_bar.html` | T15 |
| `app.js` | T15 |
| `templates.js` (lines 23, 328 and `SIDEBAR_STYLE`) | T15 |
| `init.js` | T10 |
| `landing.example.html` | T26 |
| `settings/labels.html` | T27 |
| `settings/partials/labels_list.html` | T27 |
| `settings/tokens.html` | T27 |

A file outside this list is reported as "noticed".

### Task s2-T4: DOM contract file and static check

**Size** L · agent: worker · blocked_by: —

**Files:**
- Create: `docs/ui-dom-contract.md`, `scripts/check-dom-contract.mjs`, `tests/js/check-dom-contract.test.mjs`

**Interfaces.**

Produces `docs/ui-dom-contract.md`:
- A header explaining the rules: rename an item only together with every consumer and its entry.
- One Markdown table per kind (`id`, `data-*`, `class`), with columns `| item | kind | consumers |`.
  - `item` is a literal (`shortcuts-modal-overlay`), a prefix pattern ending in `*` (`article-row-*`) or an attribute (`data-header-title`).
  - `consumers` is a comma list of `path` values (`static/js/app.js`, `tests/js/keyboard-shortcuts.test.mjs`, `tests/e2e/offline.spec.mjs`, `backend/tests/test_x.py`, …).

Produces `scripts/check-dom-contract.mjs`:
- `export function extract(files: Array<{ path, text }>): Array<{ item, kind, path }>`. It covers:
  - string literals in `getElementById`, `querySelector(All)`, `closest`, `matches`, `getElementsByClassName`, `dataset.<camel>` (as `data-<kebab>`), Playwright `locator`, `#id` / `.class` / `[data-…]` in selector strings, and pytest `soup.select`/`find(id=…)`/`'id="…"' in` assertions;
  - concatenations `'prefix-' + x` and template literals `` `prefix-${x}` ``, which become `prefix-*`.
- Consumers scanned:
  - `backend/app/static/js/**/*.js` (not `vendor/`, `htmx.min.js`);
  - `tests/js/**/*.mjs`, `tests/e2e/**/*.mjs`, `tests/visual/**/*.mjs`;
  - `backend/tests/**/*.py`.
- `export function verify(contract, extracted, sources): { missing: [...], unused: [...], unrendered: [...] }`:
  - `missing`: used in code, not in the contract;
  - `unused`: in the contract, not found anywhere;
  - `unrendered`: neither in the rendered HTML nor as a literal or prefix in a template, a JS template string or a Python class string.
  - Rendered HTML: every `backend/tests/fixtures/dom_contract/*.html` (s2-T11) and `backend/tests/fixtures/offline_drift/*.html` (s2-T5/T12), when present.
- CLI `node scripts/check-dom-contract.mjs`. It prints `dom-contract: OK (<n> items, <r> rendered pages)` with exit 0, or `dom-contract: FAIL` and lines `missing <item> (<path>)`, `unused <item>`, `unrendered <item>`, with exit 1.

Steps:
- [ ] **RED:** `tests/js/check-dom-contract.test.mjs`:
  - `contract: runtime-built id becomes a prefix pattern`: `"document.getElementById('article-row-' + id)"` → `{ item: 'article-row-*', kind: 'id' }`. A template with `id="article-row-{{ a.id }}"` satisfies it.
  - `contract: selector in code but not in contract is missing`.
  - `contract: listed item found nowhere is unused`.
  - `contract: dataset and Playwright locators are extracted`: `el.dataset.headerTitle` → `data-header-title`; `page.locator('#sidebar .nav-item')` → `sidebar` (id) and `nav-item` (class).
- [ ] Run: `node --test tests/js/check-dom-contract.test.mjs`. Expected: `# fail 4`.
- [ ] **GREEN:** write the script. Generate the first `docs/ui-dom-contract.md` from `extract()` over the real tree, grouped and sorted. Then review it by hand: drop false positives at their source by tightening the extractor, never by editing the file to hide them. Design §3 counts about 76 ids and 114 selectors in `app.js`; report the real counts.
- [ ] Run: `node --test tests/js/check-dom-contract.test.mjs && node scripts/check-dom-contract.mjs`. Expected: `# fail 0`, then `dom-contract: OK (<n> items, 0 rendered pages)`. Report every item that passes only as a template literal.
- [ ] Run: `TMPDIR=/var/tmp npm test`. Expected: `# fail 0`.

### Task s2-T5: Offline drift harness, core fragments

**Size** L · agent: worker · blocked_by: —

**Files:**
- Create:
  - `backend/tests/test_offline_drift.py`;
  - `backend/tests/fixtures/offline_drift/<fragment>.html`;
  - `tests/js/offline-drift.test.mjs`;
  - `tests/js/offline-drift/adapters.mjs`.

**Interfaces.**
- Fragment set for this task: the `templates.js` renderers paired with their Jinja or Python source.

  | `templates.js` renderer | Source |
  |---|---|
  | `badgeUnread` / `badgeTotal` | `badges.html` |
  | `readButton` | `read_button.html` |
  | `starButton` | `star_icon.html` |
  | `archiveButton` | `archive_button.html` |
  | `shareButton` | `share_button.html`, online and pending |
  | `rowLabelButton` | `article_row.html` label trigger, each `label_display` |
  | `labelChips` and `detailLabelDot` | `article_detail.html` label parts |
  | `labelPicker` | `label_picker.html`, with and without `oob` |
  | `aiSummary` / `aiContext` / `aiRequested` | `ai_blocks.html` |
  | `scoreBadge` | `score_badge.html` |
  | `detailScore` | `article_content.html` footer |
  | `storyMarker` / `storyLine` / `storyBlock` | `story_block.html` and the row story parts |
  | the `_badge_html` helper | Python source; mirrored at `templates.js:77-80` |

- Python half: `test_offline_drift.py` renders each case from its real source with a fixture context, in the style of `test_partials_online_unchanged.py` (`templates.env`, a bare `Request`, `ArticleListItem`). It normalises the HTML and writes `fixtures/offline_drift/<case>.html`. It fails when a committed file is stale. `RF_UPDATE_GOLDENS=1` regenerates.
- JS half: `tests/js/offline-drift.test.mjs` loads `templates.js` in a `vm` context. It renders each case from the IndexedDB-shaped record built by its adapter, normalises it the same way and compares it with the committed file.
- Normalisation, identical on both sides:
  - whitespace collapsed;
  - attributes sorted;
  - `class` tokens sorted;
  - boolean attributes in one form;
  - entity forms unified.
- `adapters.mjs` exports `CASES: Array<{ name, record, ctx, render: (T) => string, allowed?: Array<{ pattern: RegExp, reason: string }> }>`. `allowed` strips listed differences on both sides, for example a server-only attribute, and every entry carries a reason.
- **Existing drift policy:** a difference found on day one is listed in `allowed` with a reason and a backlog line in the report, not fixed here. An example is WR2-F4: the offline story footer always renders "· read" hidden.

Steps:
- [ ] **RED:** `tests/js/offline-drift.test.mjs`:
  - `drift: every committed fragment matches its templates.js counterpart` (one subtest per case);
  - `drift: a changed partial without its mirror fails`: render `readButton`, alter one class in the committed HTML in memory and assert the comparison reports that fragment;
  - `drift: normalisation ignores attribute and class order only`.
- [ ] **RED:** `test_offline_drift.py`:
  - `test_drift_fixtures_are_fresh`, parametrised over the cases;
  - `test_drift_cases_match_js_adapters`: the Python case names equal the JS `CASES` names, read from a JSON list both sides keep in `fixtures/offline_drift/cases.json`.
- [ ] Run: `TMPDIR=/var/tmp node --test tests/js/offline-drift.test.mjs`. Expected: fail (no fixtures). Run: `cd backend && uv run pytest tests/test_offline_drift.py -q`. Expected: fail.
- [ ] **GREEN:** write both halves, then run `cd backend && RF_UPDATE_GOLDENS=1 uv run pytest tests/test_offline_drift.py`. Run the JS half, inspect each mismatch, and either fix the adapter data (same data on both sides) or list the difference in `allowed` with its reason.
- [ ] Run: `cd backend && uv run pytest tests/test_offline_drift.py -q && cd .. && TMPDIR=/var/tmp node --test tests/js/offline-drift.test.mjs`. Expected: `passed`, then `# fail 0`.
- [ ] Probe: change one class in `backend/app/templates/app/partials/read_button.html` in the worktree, regenerate the goldens, and run the JS half. Expected: `read_button` fails. Revert both files.
- [ ] Report: the case count, every `allowed` entry with its reason, and the backlog lines for existing drift.

### Task s2-T6: Template-version bump test

**Size** S · agent: worker · blocked_by: —

**Files:**
- Modify: `backend/app/services/sync/__init__.py` (add `OFFLINE_TEMPLATE_HASH` under `OFFLINE_TEMPLATE_VERSION`)
- Create: `backend/tests/test_offline_template_version.py`

**Interfaces.**
- `OFFLINE_TEMPLATE_HASH: str`. It is the sha256 (first 16 hex) of:
  - the sources of the closure of `app/partials/article_row.html` and `app/partials/article_detail.html`, computed with `jinja2.meta.find_referenced_templates`; 17 files today; a dynamic reference (`None`) fails the test;
  - `inspect.getsource` of `row_render_context`, `detail_render_context` and `list_density` (`routers/web/app/articles.py`);
  - all of it concatenated in sorted path order, each part preceded by its name.
- The comment next to the constant says: change the hash only together with a bump of `OFFLINE_TEMPLATE_VERSION`; regenerate with `RF_UPDATE_GOLDENS=1`.
- The test reads a small `(version, hash)` ledger kept in the test file. A hash change with the version unchanged fails with a message naming both constants.

Steps:
- [ ] **RED:** `test_offline_template_version.py`:
  - `test_closure_is_static_and_complete`: no `None` reference; the closure includes `error_bar.html` and `score_badge.html`.
  - `test_closure_change_without_bump_fails`: monkeypatch the loader to return a changed `error_bar.html`; the computed hash then differs from `OFFLINE_TEMPLATE_HASH` while the version stays `"3"`, which is a failure.
  - `test_pinned_hash_matches_tree`.
- [ ] Run: `cd backend && uv run pytest tests/test_offline_template_version.py -q`. Expected: `ImportError` (`OFFLINE_TEMPLATE_HASH`).
- [ ] **GREEN:** compute the hash, pin it, and write the ledger with `("3", <hash>)`.
- [ ] Run: the same command. Expected: `3 passed`.
- [ ] Run: `cd backend && uv run pytest tests/test_sync_manifest.py tests/test_sync_snapshots.py -q` with a throwaway `DATABASE_URL`. Expected: `passed`.

### Task s2-T7: Moved-pages helper

**Size** S · agent: worker · blocked_by: —

**Files:**
- Create: `backend/app/routers/web/moved_pages.py`, `backend/tests/test_moved_pages.py`
- Modify: `backend/app/main.py:251-259` (one `register_moved_pages(app)` call after the web routers)

**Interfaces.**
- `@dataclass(frozen=True) class MovedPage: old: str; new: str; methods: tuple[str, ...] = ("GET",); remove_aliases_in: str = "s8"`.
- `MOVED_PAGES: list[MovedPage] = []`. It is empty in s2; s5–s7 add entries.
- `register_moved_pages(app, pages=MOVED_PAGES) -> None`:
  - for each page, GET `old` answers `308` with `Location: new` (query string kept) and `Cache-Control: no-store`;
  - each non-GET method in `methods` is registered on `old` as an alias of the route that serves `new` with that method, by looking up `app.router.routes`. A missing target raises at startup.
- Hard-coded `RedirectResponse` targets are not changed in s2.

Steps:
- [ ] **RED:** `test_moved_pages.py`:
  - `test_get_redirects_308_no_store_and_target_is_200`: on a throwaway `FastAPI()` with `GET /new` returning 200 and `MovedPage("/old", "/new")`. `GET /old?x=1` → 308, `location == "/new?x=1"`, `cache-control == "no-store"`; following the redirect gives 200.
  - `test_post_alias_calls_same_handler`: `POST /new` echoes a form field; `POST /old` gives the same body.
  - `test_missing_target_raises`.
  - `test_production_table_targets_exist`: each entry of `MOVED_PAGES` resolves on the real app (vacuous in s2, real from s5).
- [ ] Run: `cd backend && uv run pytest tests/test_moved_pages.py -q`. Expected: `ModuleNotFoundError`.
- [ ] **GREEN:** helper and the `main.py` call.
- [ ] Run: the same command, then `uv run pytest -q` with a throwaway `DATABASE_URL`. Expected: `4 passed`, then `passed` with no `failed`.

### Task s2-T8: Visual acceptance modes (layout, gallery, dark-patch probe)

**Size** L · agent: worker · blocked_by: —

**Files:**
- Modify: `tests/visual/key-screens.spec.mjs`, `tests/visual/run.mjs`, `playwright.visual.config.mjs`
- Create:
  - `tests/visual/layout.mjs`;
  - `tests/visual/gallery-pages.mjs`;
  - `tests/visual/layout-allow/README.md` (the format: one `<task>.json` per task, an array of `{ screen, key, reason }`, where `key: "*"` exempts the whole screen);
  - `tests/js/visual-layout.test.mjs`.

**Interfaces.**
- **`run.mjs`.** `RF_VISUAL_BASE` defaults to `1d7f2f4` (selfhost with s1). `RF_VISUAL_MODE` is `pixel` (default, unchanged), `layout` or `gallery`. Gallery is head-only: no base export.
- **`playwright.visual.config.mjs`.** `RF_VISUAL_DEBUG=1` sets `DEBUG: 'true'` in the head app's env, for `/dev/ui`. It is ignored on the base side.
- **Theme injection.** Each context's init script sets both `colorScheme` and `appTheme` (`neutral` unless the job says otherwise). The base ignores `appTheme`.
- **`tests/visual/layout.mjs`:**
  - `export function collectBoxes()` is self-contained and evaluated in the page. It returns `Array<{ key, x, y, w, h }>` for every visible element with an `id` (key `#id`), the first 10 `.article-row` (`.article-row[i]`) and the first 20 `.nav-item`.
  - `export function compareBoxes(base, head, { tolerance, keys? }): { missing: string[], extra: string[], moved: Array<{ key, dx, dy, dw, dh }> }`.
  - `export const KEY_STRUCTURE`: a per-screen list of structural keys (shell panes, sidebar, list pane, detail pane, mobile bars, settings column, login card). The worker picks them from real ids and documents each.
  - `export function formatLayoutReport(results, allow): { lines, failed }`.
- **`layout` mode** runs two passes per key screen × viewport × scheme:
  - **Pass A:** `context.route('**/static/fonts/**', r => r.abort())` on both sides. Strict, `tolerance: 0.5`, all keys. Entries merged from every `tests/visual/layout-allow/*.json` are exempt; `key: "*"` exempts the screen in both passes. The report names each exemption with its file and reason.
  - **Pass B:** fonts loaded. `KEY_STRUCTURE` keys only, `tolerance: 1` on x, w and bar heights. Every other moved key is reported as `reflow`, not failed.
  - The report goes to `test-results/visual-report/layout.md` and ends with `layout: A <ok>/<n> strict, B <ok>/<n> structural`.
- **`tests/visual/gallery-pages.mjs`** exports `GALLERY_PAGES: Array<{ name, path, account: 'anonymous'|'alice'|'admin', setup? }>`:
  - the 8 key screens;
  - auth: `login`, `register`, `reset-password` request, `check-email` and `registration-disabled` where a state can be reached by seeding;
  - errors: 404 through an unknown path; 429 and 500 only if they can be rendered without faking the server, otherwise noted;
  - admin: dashboard, traffic, settings, scoring-eval, users, invitations, audit-log, fetch-logs, feeds;
  - public: help, features, changelog, privacy, terms.

  The worker verifies each path against the routers and reports pages that cannot be reached.
- **Landing in the gallery.** `RF_VISUAL_LANDING=1` copies `landing.example.html` to the gitignored `backend/app/templates/landing.html` of the head tree for the run, adds `landing` (anonymous `/`) to the gallery, and removes the copy in `finally`. It never overwrites an existing `landing.html`; it fails instead.
- **`gallery` mode** captures `GALLERY_PAGES` × `neutral|paper|graphite` × light/dark × 1280/390. With `RF_VISUAL_DEBUG=1` it also captures `/dev/ui` at 1280 × 6. With `RF_VISUAL_GALLERY_BASE=1` it also captures each page once per scheme on the base tree (themes do not exist there), for side-by-side review. It writes the PNGs and `test-results/visual-report/gallery.html`: a contact sheet with relative links, grouped by page, base beside head.
- **Dark-patch probe**, in gallery mode, for each dark job:
  - `page.evaluate` walks visible elements of at least 8×8 px and computes the relative luminance of each opaque `background-color`;
  - a failure is a luminance above 0.45 on an element outside `PATCH_ALLOW` (selectors, each with a reason: label colour dots, `img`, `video`, `mark.search-hit`, buttons with a `bg-blue-*`/`bg-red-*` fill, …);
  - it reports `screen, theme, selector path, colour`.
- The spec's fixed `toHaveLength(34)` becomes `jobs.length` per mode.
- The `compat: button cursor and placeholder colour` test compares the placeholder colour with the computed `--color-gray-400` instead of the literal `rgb(156, 163, 175)`, so it holds under every theme.

Steps:
- [ ] **RED:** `tests/js/visual-layout.test.mjs`:
  - `layout: equal boxes pass, a 1 px move fails strict and passes structural tolerance`;
  - `layout: missing and extra keys are reported`;
  - `layout: allow-list entries from several files merge; "*" exempts a screen; each is named in the report`.
- [ ] Run: `node --test tests/js/visual-layout.test.mjs`. Expected: `# fail 3`.
- [ ] **GREEN:** `layout.mjs`, the modes, theme injection, the probe and the report.
- [ ] Run: `node --test tests/js/visual-layout.test.mjs`. Expected: `# fail 0`.
- [ ] Start the throwaway Postgres on `127.0.0.1:4253` (database `readfine_e2e`). In this worktree head equals base, so the following prove the harness:
  - `E2E_DATABASE_URL=… RF_VISUAL_MODE=layout node tests/visual/run.mjs`. Expected: `layout: A n/n strict, B n/n structural`, exit 0.
  - `E2E_DATABASE_URL=… RF_VISUAL_MODE=gallery RF_VISUAL_LANDING=1 node tests/visual/run.mjs`. Expected: `len(GALLERY_PAGES)` × 12 PNGs and `gallery.html`; the dark-patch probe finds 0 patches in the base's dark mode across all gallery pages. Calibrate `PATCH_ALLOW` here and report each entry. Afterwards `git status --short backend/app/templates` is clean (the landing copy is removed).
  - Harness self-check, a test `harness: an injected shift is detected` in layout mode. The head page gets `addStyleTag('#sidebar{margin-left:3px}')` (or the first `KEY_STRUCTURE` key of `list@1280`). Expected: pass A and pass B both fail for that key.
  - `E2E_DATABASE_URL=… RF_VISUAL_BASE=1d7f2f4 npm run test:visual`, the pixel mode unchanged. Expected: `visual: 34/34 screens within 0.1%`.
- [ ] Run: `E2E_DATABASE_URL=… npm run test:e2e -- --project=chrome` against the same throwaway container. Expected: `passed`. Then remove the container.

### Task s2-T9: Tokens, themes, fonts and the Basecoat CSS import

**Size** L · agent: worker · blocked_by: s2-T1, s2-T3 · theme values from Appendix A; gray remap per Q1 (owner confirms, together with Q7 and Q8)

**Files:**
- Create: `styles/tokens.css`, `styles/motion.css` (header comment only: "owned by s2-T17"), `tests/js/theme-tokens.test.mjs`
- Modify:
  - `input.css`:
    - header: imports and `@theme` mapping;
    - `:21-147`: the palette moves to `tokens.css`;
    - `@font-face`;
    - the custom rules from `:264` on are left to s2-T14.
  - `tests/js/tailwind-build.test.mjs`:
    - the `sources` test copies `styles/` with `input.css`;
    - the palette assertions now read `tokens.css` values through the build.

**Interfaces.**

Produces `styles/tokens.css`. It holds, in order:
1. **The v3 palette `@theme`,** moved verbatim from `input.css`. Utilities keep resolving through `var(--color-*)`.
2. **Theme blocks.** `:root, html[data-rf-theme="neutral"]` (Neutral light), `html.dark, html.dark[data-rf-theme="neutral"]`, then `html[data-rf-theme="paper"]`, `html.dark[data-rf-theme="paper"]`, `html[data-rf-theme="graphite"]` and `html.dark[data-rf-theme="graphite"]`. Each block defines:
   - the shadcn set `--background --foreground --card --card-foreground --popover --popover-foreground --primary --primary-foreground --secondary --secondary-foreground --muted --muted-foreground --accent --accent-foreground --destructive --border --input --ring --sidebar --sidebar-foreground --sidebar-primary --sidebar-primary-foreground --sidebar-accent --sidebar-accent-foreground --sidebar-border --sidebar-ring`;
   - `--rf-unread --rf-star --rf-ok --rf-warn`;
   - `--color-gray-50 … --color-gray-950`, the remap: in light and dark alike, the theme's scale (Q1);
   - the legacy dark family `--rf-legacy-dark-*`, in dark blocks only: one token per distinct role and literal found by s2-T3's inventory in `base.html:383-498`, `sidebar.html`, the `input.css` custom rules, `story_members.html`, `error_bar.html`, `app.js` and `init.js`. Neutral dark values equal today's literals (Q1).
   - Values follow Appendix A. Prototype `oklch()` values may stay `oklch()`. The exceptions are `--background` (converted to hex), the gray scales and the legacy dark family, which are hex.
3. **Theme-independent tokens:**
   - `--radius: 0.5rem`;
   - `--rf-serif: "Source Serif 4", Georgia, "Times New Roman", serif`;
   - `--rf-body-font: var(--font-sans)`;
   - `--t-fast: 125ms; --t-fast-max: 165ms; --t-med: 300ms; --t-med-max: 400ms; --t-slow: 700ms`;
   - easing tokens;
   - the label palette, `--rf-label-<name>`, with 16 names in today's order: `red #ef4444, orange #f97316, amber #f59e0b, yellow #eab308, lime #84cc16, green #22c55e, teal #14b8a6, cyan #06b6d4, blue #3b82f6, indigo #6366f1, violet #8b5cf6, purple #a855f7, pink #ec4899, rose #f43f5e, slate #64748b, gray #374151` (`settings/labels.html:6`). The values are identical in every theme, because they must match stored hex label colours (Q9). s2-T27 consumes them; the Python constant must equal them;
   - Basecoat's non-colour variables (`--sidebar-width`, `--sidebar-mobile-width`, `--scrollbar-*`);
   - `--chevron-down-icon`, `--chevron-down-icon-50` and `--check-icon` per scheme (data URIs with the theme's muted colour).
4. **A comment table** `legacy literal → token` covering every literal that s2-T13/T14/T15 will replace. Those tasks do not edit `tokens.css`.

Produces the `input.css` header, in this order. All `@import` lines go directly after line 1 (`@import "tailwindcss" source(none);`) and before the `@source` lines. The probe verified that position; CSS requires `@import` before other statements.
- the Basecoat imports, exactly: `basecoat-css/components/{alert,badge,button,card,checkbox,command,dialog,drawer,dropdown-menu,empty,field,input,kbd,label,native-select,popover,select,sidebar,skeleton,switch,tabs,textarea,toast}.css`, then `basecoat-css/styles/vega.css`;
- `@import "./styles/tokens.css";`
- `@import "./styles/motion.css";`
- the existing `@source`, `@plugin` and `@custom-variant` lines, unchanged. Ours are declared after Basecoat's, so `.dark *` wins (probe-verified with Basecoat's `html.dark *` variant present);
- an `@theme` block:
  - `--font-sans: "Geist", ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"`. The tail must equal the Tailwind 4 default.
  - `--radius-sm: calc(var(--radius) - 4px)`, `--radius-md: calc(var(--radius) - 2px)`, `--radius-lg: var(--radius)`, `--radius-xl: calc(var(--radius) + 4px)`.
  - `--color-<name>: var(--<name>)` for every shadcn name above (Basecoat's `base.css` mapping, minus fonts).
  - `--color-rf-<name>: var(--rf-<name>)` for each token that s2-T15 uses as a utility colour, at least `--color-rf-story-divide: var(--rf-story-divide)`. The token is scheme-aware: one value in each light block, one in each dark block. One class `divide-rf-story-divide` then replaces `divide-[#ecedf1] dark:divide-[#353535]`. It resolves through s1's `@utility divide-*` (`--value(--color-*, [color])`); a bare `divide-(--var)` might emit nothing under that utility.
- four `@font-face` rules with `font-family: "Geist"` / `"Source Serif 4"`, `font-weight: 100 900` / `200 900`, `font-style: normal|italic`, `font-display: swap`, `src: url("../fonts/<file>.woff2") format("woff2")`.

Steps:
- [ ] **RED:** `tests/js/theme-tokens.test.mjs`, on a scratch build:
  - `tokens: six theme blocks define the full set; --background is hex`. Parse `tokens.css`: every block has every shadcn name, `--rf-*` and all 11 `--color-gray-*`. `--background` matches `/^#[0-9a-f]{6}$/i`.
  - `basecoat: selective import leaves old markup alone`. The build has:
    - no rule whose selector list contains a bare `details` or `summary` (not under `.sidebar` or `.accordion`), `[data-tooltip]` or `[role=radiogroup]`;
    - no `scroll-behavior:smooth` and no `overscroll-behavior:none`;
    - no `*{border-color:var(--color-border)` and no `outline-color` on `*`;
    - `--radius-md` resolves to `calc(.5rem - 2px)`.
  - `basecoat: old utility selectors are kept` (T7-N1 recheck): every class selector in the committed `tailwind.css` is in the scratch build. No Basecoat rule selector contains `>:not([hidden])~:not([hidden])`. The `.space-y-2` rule is byte-equal to the committed one.
  - `fonts: four @font-face with swap and ../fonts urls that exist`: each `url()` resolves from `backend/app/static/css/` to an existing file.
  - `tokens: every inventoried literal has a token`: the files in s2-T3's `--list` inventory, minus `input.css`'s palette, map literal by literal to an entry of the comment table.
- [ ] Run: `TMPDIR=/var/tmp node --test tests/js/theme-tokens.test.mjs tests/js/tailwind-build.test.mjs`. Expected: `# fail` ≥ 5.
- [ ] **GREEN:** write `tokens.css`, the `input.css` header and the `@font-face` rules; move the palette; update `tailwind-build.test.mjs` (`sources` copies `styles/`; the palette needles stay `--color-gray-100:#f3f4f6` etc. inside `@theme`, now emitted from `tokens.css`).
- [ ] Run: the same command. Expected: `# fail 0`.
- [ ] Run: `O=$(mktemp -d) && npx tailwindcss -i input.css -o $O/tw.css --minify && node scripts/check-css-vars.mjs $O/tw.css && node scripts/check-tw4-classes.mjs --css $O/tw.css && wc -c $O/tw.css && gzip -c $O/tw.css | wc -c; rm -r $O`. Expected: `css-vars: OK`, `tw4-classes: OK`; report the sizes (probe: about 281 KB, gzip about 31 KB).
- [ ] Run: `TMPDIR=/var/tmp npm test`. Expected: `# fail 0`. Then `git status --short backend/app/static/css/tailwind.css`: empty.

### Task s2-T10: Theme bootstrap and app-theme picker

**Size** M · agent: worker · blocked_by: s2-T8 (shares the Playwright ports; uses its theme injection)

**Files:**
- Modify:
  - `backend/app/static/js/init.js:40-62` (scheme, theme, `syncThemeColor`);
  - `backend/app/static/js/preferences.js:22-44` (`applyAppTheme` next to `applyColorScheme`);
  - `backend/app/templates/settings/preferences.html` (an "App theme" radio group `app_theme_device` next to `color_scheme_device` at `:378`; Q3);
  - Create `tests/visual/layout-allow/s2-T10.json`: one `{ screen: "settings-preferences", key, reason }` entry per box the new radio group moves.
- Create: `tests/js/theme-bootstrap.test.mjs`, `tests/e2e/theme.spec.mjs`

**Interfaces.**
- `init.js`:
  - It reads `localStorage.appTheme`; values other than `neutral|paper|graphite` count as `neutral`.
  - It sets `document.documentElement.dataset.rfTheme` synchronously, together with `.dark` as today.
  - `window.syncThemeColor()` sets `meta[name=theme-color]` from `getComputedStyle(documentElement).getPropertyValue('--background').trim()` when it is hex or `rgb()`, otherwise from the computed `background-color` of `document.body`, and never writes a literal. It also creates the meta if it is missing (s2-T13 removes the literal `content`).
  - `window.setAppTheme(name)` stores the theme, sets the attribute and calls `syncThemeColor`.
- `preferences.js`: the `app_theme_device` radios call `setAppTheme`, mirroring `color_scheme_device`. The page is boosted, so listeners are re-added per swap as today.

Steps:
- [ ] **RED:** `tests/js/theme-bootstrap.test.mjs` (jsdom, runs `init.js` source in a window with a stubbed `localStorage` and `matchMedia`):
  - `theme: stored appTheme sets data-rf-theme before body; unknown falls back to neutral`;
  - `theme: colorScheme dark plus paper sets both`;
  - `theme: theme-color follows --background as hex`: a `<style>` sets `html[data-rf-theme=paper]{--background:#f5f5f4}`, and the meta becomes `#f5f5f4`. If jsdom does not cascade custom properties, use the `document.body` background fallback and assert that path instead.
- [ ] **RED:** `tests/e2e/theme.spec.mjs`: `theme and app-theme switch persist across reload`. Log in, open `/settings/preferences`, choose Dark and Graphite and reload. Then `html` has class `dark` and `data-rf-theme="graphite"`, and the meta `theme-color` is non-empty and not `#f9fafb`.
- [ ] Run: `node --test tests/js/theme-bootstrap.test.mjs`. Expected: `# fail 3`.
- [ ] **GREEN:** implement.
- [ ] Run: `node --test tests/js/theme-bootstrap.test.mjs && TMPDIR=/var/tmp npm test`. Expected: `# fail 0`.
- [ ] Run, with the throwaway container on 4253: `E2E_DATABASE_URL=… npm run test:e2e -- --project=chrome`. Expected: `passed`, including `theme.spec.mjs`. The committed CSS has no `--background` yet, so the meta comes from the body background fallback. s2-T21 re-runs this spec against the regenerated CSS.
- [ ] Run, same container: `E2E_DATABASE_URL=… RF_VISUAL_BASE=1d7f2f4 RF_VISUAL_MODE=layout node tests/visual/run.mjs`. Expected: pass A fails only on `settings-preferences` boxes below the radio group. Add those keys to `layout-allow/s2-T10.json` with the reason "app-theme radios added (s2-T10, Q3)", re-run, and expect exit 0.
- [ ] Report the new selectors and names for the contract (`app_theme_device`, `data-rf-theme`).

### Task s2-T11: DOM contract, rendered pages (pytest half)

**Size** M · agent: worker · blocked_by: s2-T4, s2-T10, s2-T13, s2-T15, s2-T18, s2-T19, s2-T23, s2-T24, s2-T25, s2-T26. It runs after every task that changes a rendered template, so its fixtures do not go stale.

**Files:**
- Create: `backend/tests/test_dom_contract_pages.py`, `backend/tests/fixtures/dom_contract/<page>.html`

**Interfaces.**
- It renders a fixed page set from real templates with fixture contexts (no DB), in the style of `test_partials_online_unchanged.py`. The minimum set:
  - `app/partials/article_row.html`, `article_detail.html` and `article_list.html`;
  - `app/partials/sidebar.html`;
  - `app/partials/shortcuts.html`;
  - `auth/login.html`;
  - `settings/preferences.html`;
  - the shell `app/main.html` when its context can be built without a DB. When it cannot, the worker reports why and covers its parts through the partials.
- It writes normalised HTML to `fixtures/dom_contract/<page>.html` (`RF_UPDATE_GOLDENS=1` regenerates) and fails when a file is stale.
- s2-T4's check reads these files.

Steps:
- [ ] **RED:** `test_dom_contract_pages.py::test_rendered_pages_are_fresh` (parametrised) and `test_contract_ids_appear_in_rendered_pages`. The second reads `docs/ui-dom-contract.md` and asserts that every `id` item whose consumers include `tests/e2e/offline.spec.mjs` appears in at least one rendered page, literally or as a prefix.
- [ ] Run: `cd backend && uv run pytest tests/test_dom_contract_pages.py -q`. Expected: fail.
- [ ] **GREEN:** contexts and rendering, then `RF_UPDATE_GOLDENS=1 uv run pytest tests/test_dom_contract_pages.py`.
- [ ] Run: the pytest command, then `node scripts/check-dom-contract.mjs`. Expected: `passed`. The check reports `<r> rendered pages` with `r` ≥ 7 and no `unrendered` line for items on those pages. `missing` lines for selectors added in waves 1–4 (T8, T10, T17, T18) are expected here and fixed by s2-T20; list them. Report items that are still verified only as literals.

### Task s2-T12: Offline drift harness, lists, sidebar and story fragments

**Size** L · agent: worker · blocked_by: s2-T5

**Files:**
- Modify (later owner of s2-T5's files): `backend/tests/test_offline_drift.py`, `backend/tests/fixtures/offline_drift/*`, `tests/js/offline-drift.test.mjs`, `tests/js/offline-drift/adapters.mjs`

**Interfaces.** New cases, with the same rules as s2-T5:

| `templates.js` renderer | Source |
|---|---|
| `storyMembers` | `story_members.html` |
| `listHeader` | the list header of `article_list.html`: saved, saved search and search variants |
| `listPage` | `article_list.html`: rows, sentinel, empty states, cfg island |
| `sidebar` | `sidebar.html`: rail and full parts, labels, saved searches, folders with feeds; online-only parts marked `data-rf-online-only` are listed differences |
| `SIDEBAR_STYLE` | the `<style>` block of `sidebar.html`, compared as normalised CSS text |
| `offlineBanner` | its server-side counterpart, if one exists; otherwise noted |

`pendingSavedRow`, `searchModal` and `needsConnection` are offline-only and have no Jinja source. They are listed in `cases.json` with `source: null` and a reason.

Steps:
- [ ] **RED:** add the cases to `cases.json` and `CASES`. Run: `cd backend && uv run pytest tests/test_offline_drift.py -q`. Expected: fail (missing fixtures).
- [ ] **GREEN:** Python contexts and JS adapters. Regenerate with `RF_UPDATE_GOLDENS=1`. Every remaining difference goes into `allowed` with a reason; WR2-F4 is expected in `storyMembers`.
- [ ] Run: `cd backend && uv run pytest tests/test_offline_drift.py -q && cd .. && TMPDIR=/var/tmp node --test tests/js/offline-drift.test.mjs`. Expected: `passed`, `# fail 0`.
- [ ] Probe: change one class in `sidebar.html` and regenerate. Expected: the JS half fails on `sidebar`. Revert.

### Task s2-T13: `base.html` onto tokens

**Size** L · agent: worker · blocked_by: s2-T9, s2-T10, s2-T3

**Files:**
- Modify: `backend/app/templates/base.html`:
  - `:18-21`: meta `theme-color` keeps a `name` and loses its literal `content`; `init.js` fills it;
  - `:63-500`: the `<style>` body.

**Interfaces.**
- **Dark overrides** (`:383-498`): each rule keeps its selector and its `html.dark …` specificity, which s1's cascade relies on. Each value becomes the `--rf-legacy-dark-*` token or shadcn token named in the `tokens.css` comment table: `#141414` → `var(--background)`, `#2a2a2a` → `var(--rf-legacy-dark-step-2)`, and so on. This task never adds or edits a token. When a literal has no table entry, return to s2-T9 (repair).
- **Light-mode literals** (mobile bars `:275-362` `#f9fafb`/`#e5e7eb`, `.ai-score-*`, shadows `rgba(0,0,0,…)`) map to tokens the same way.
- **Reading font:** `html[data-font-family="serif"] … { font-family: var(--rf-serif) }` (Q4). `sans` gets Geist through `--font-sans`, with no rule.
- The `@layer utilities {` wrapper stays the first content of the `<style>` (`tailwind-layers.test.mjs`).

Steps:
- [ ] **RED:** Run `node scripts/check-colours.mjs | grep base.html | wc -l`. Expected: about 119.
- [ ] **GREEN:** replace every literal through the comment table.
- [ ] Run: `node scripts/check-colours.mjs | grep -c base.html`. Expected: `0`.
- [ ] Run: `TMPDIR=/var/tmp node --test tests/js/tailwind-layers.test.mjs`. Expected: `# fail 0`.
- [ ] Probe in headless Chrome against a scratch build, `html.dark` with no `data-rf-theme`: each element of `.bg-white`, `.bg-gray-100`, `.text-gray-500`, `.border-gray-200` and `.nav-item.active` computes the same colour as at `1d7f2f4`, if Q1 keeps Neutral dark at today's values. Report any difference.
- [ ] Run: `cd backend && uv run pytest -q` with a throwaway `DATABASE_URL`. Expected: `passed`. The online goldens are untouched, because `base.html` is not a partial.

### Task s2-T14: Hand-written CSS in `input.css` onto tokens (WR2-F5)

**Size** M · agent: worker · blocked_by: s2-T9, s2-T3

**Files:**
- Modify (later owner after s2-T9): `input.css` (the `@layer utilities` custom rules: `.prose` invert `#fff` and `rgb(0 0 0 / 50%)`, `.feature-desc a`/`code`, infobox `details[data-infobox]`, `.article-row:hover`, `.article-row.article-active`, `.story-chip` and `:hover`, the story band, `row-just-saved` keyframes, `mark.search-hit`, the video facade); `tests/js/tailwind-build.test.mjs`
- Carry-over: WR2-F5. The literal gray hex in hand-written CSS (`.story-chip`, `.article-row:hover {#f3f4f6}`, infobox, `.feature-desc code`) moves to tokens, so the remap reaches it.

**Interfaces.**
- A light-mode rule that used a v3 gray literal now uses `var(--color-gray-N)` of the same step, so the theme remap reaches it: `#f3f4f6` → `var(--color-gray-100)`, `#e5e7eb` → `var(--color-gray-200)`, `#6b7280` → `var(--color-gray-500)`.
- Any other literal uses the comment-table token.
- `.dark …` variants use the `--rf-legacy-dark-*` tokens.
- The row-just-saved keyframes animate `background-color` from a token through `color-mix(in oklab, var(--…) 22%, transparent)`.

Steps:
- [ ] **RED:** in `tailwind-build.test.mjs`, add `compat: hand-written rules use tokens`. In the scratch build, `.story-chip{`, `.article-row:hover{` and `.feature-desc code{` contain `var(--`, and no declaration in the custom-rules part of `input.css` has a hex or `rgb(` literal. Run `TMPDIR=/var/tmp node --test tests/js/tailwind-build.test.mjs`. Expected: `# fail 1`.
- [ ] **GREEN:** replace the literals.
- [ ] Run: `TMPDIR=/var/tmp node --test tests/js/tailwind-build.test.mjs && node scripts/check-colours.mjs | grep -c '^input.css'`. Expected: `# fail 0`, then `0`.
- [ ] Run: a scratch build plus `node scripts/check-css-vars.mjs <out>`. Expected: `css-vars: OK`.

### Task s2-T15: Mirrored and snapshot partials and JS literals onto tokens

**Size** M · agent: worker · blocked_by: s2-T9, s2-T3, s2-T5, s2-T6, s2-T12

**Files:**
- Modify:
  - `backend/app/templates/app/partials/sidebar.html:392-418` (`.nav-item.active` `#eff6ff`/`#1d4ed8`) with `backend/app/static/js/offline/templates.js:589-595` (`SIDEBAR_STYLE`);
  - `backend/app/templates/app/partials/story_members.html:21` (`divide-[#ecedf1] dark:divide-[#353535]`) with `templates.js:328`;
  - `backend/app/templates/app/partials/error_bar.html:9` (`background:#f87171`);
  - `backend/app/static/js/offline/templates.js:23`: the label-colour validator fallback `'#9ca3af'` becomes `'var(--color-gray-400)'` (Q2). The validator still accepts a stored `#RRGGBB` or a colour name unchanged. A test in `tests/js/offline-drift.test.mjs` is not needed, because no server fragment renders an invalid colour; the existing `offline-*` tests must stay green;
  - `backend/app/static/js/app.js:575,584` (`showToast` colours → tokens through `var(--…)` in `cssText`), `:2487`, `:2493`, `:3163`, `:3819`;
  - `backend/app/services/sync/__init__.py` (bump `OFFLINE_TEMPLATE_VERSION` "3" → "4", new `OFFLINE_TEMPLATE_HASH`), with the ledger in `backend/tests/test_offline_template_version.py`;
  - regenerated: `backend/tests/fixtures/partials_online/*`, `backend/tests/fixtures/offline_drift/*`.

**Interfaces.**
- An arbitrary-value class with a literal becomes a token utility, identical in the template and in `templates.js`: `divide-[#ecedf1] dark:divide-[#353535]` → `divide-rf-story-divide`, the scheme-aware `@theme` colour from s2-T9.
- Scratch-build assertion: the build contains `.divide-rf-story-divide>:not([hidden])~:not([hidden]){border-color:var(--color-rf-story-divide)}`, or the equivalent minified form. An empty result means the utility did not resolve; return to s2-T9.
- `showToast(msg, type)` keeps its signature and DOM. Only colour values change.

Steps:
- [ ] **RED:** Run `node scripts/check-colours.mjs` and keep the lines for these files. Expected: hits in all six files, as inventoried by s2-T3.
- [ ] **GREEN:** make the replacements in pairs. Bump the version and update the hash and ledger. Then run `cd backend && RF_UPDATE_GOLDENS=1 uv run pytest tests/test_partials_online_unchanged.py tests/test_offline_drift.py`.
- [ ] Run: `git diff --word-diff backend/tests/fixtures | grep -oE '\[-[^]]*-\]\{\+[^}]*\+\}' | sort | uniq -c`. Expected: only the colour replacements of this task.
- [ ] Run: `node scripts/check-colours.mjs | grep -E 'sidebar.html|story_members|error_bar|app.js|templates.js'`. Expected: no output. Only `offlinePage()` in `templates.js` stays allowed.
- [ ] Run, with a throwaway `DATABASE_URL`: `cd backend && uv run pytest tests/test_offline_template_version.py tests/test_offline_drift.py tests/test_partials_online_unchanged.py tests/test_sync_manifest.py tests/test_sync_snapshots.py -q`, then `TMPDIR=/var/tmp npm test`. Expected: `passed`, `# fail 0`.

### Task s2-T16: UI macros: forms and display

**Size** L · agent: worker · blocked_by: s2-T9

**Files:**
- Create:
  - `backend/app/templates/ui/forms.html`: `button`, `icon_button`, `input`, `select`, `switch`, `field`;
  - `backend/app/templates/ui/display.html`: `badge`, `kbd`, `card`, `alert`, `skeleton`, `empty_state`;
  - `backend/app/templates/ui/readfine.html`: `article_row`, `feed_icon`, `score_badge`, `health_dot`;
  - `backend/tests/test_ui_macros.py`.

**Interfaces.**
- Every macro has a `{# … #}` docstring: purpose, arguments, the Basecoat markup it emits.
- Arguments are keyword-only with safe defaults, plus `attrs: dict = {}`, rendered through a shared `attrs()` helper that escapes values and **refuses** keys matching `^on` (it raises) and `hx-on*`.
- Macros never emit `on*` attributes, `style` colour literals or `hx-swap="none"` by default. Forms inside overlays set their own `hx-target`/`hx-swap` (design §5.4).
- `icon_button` requires `label` (rendered as `aria-label`).
- The Readfine `article_row` macro is gallery-only in s2. `app/partials/article_row.html` keeps its markup until s4 moves it onto the macro together with the drift test.

Steps:
- [ ] **RED:** `test_ui_macros.py`:
  - `test_every_macro_renders_without_inline_handlers`: render each macro with its defaults. Each output passes the inline-handler matcher of s2-T3 and the colour lint pattern.
  - `test_attrs_refuses_event_handlers`: `button(attrs={"onclick": "x"})` raises.
  - `test_icon_button_requires_label`.
  - `test_button_variants_emit_basecoat_markup`: `button(variant="outline", size="sm")` → `class="btn"` with `data-variant="outline" data-size="sm"`, following Basecoat 1.1.0 `components/button.css`.
- [ ] Run: `cd backend && uv run pytest tests/test_ui_macros.py -q`. Expected: fail.
- [ ] **GREEN:** the macros.
- [ ] Run: the same command, and `uv run pytest tests/test_csp.py -q`. Expected: `passed`.
- [ ] Report the classes the macros emit that the Tailwind sources must pick up. They live in `templates/ui/`, which is already a source.

### Task s2-T17: Motion module

**Size** M · agent: worker · blocked_by: s2-T1, s2-T9

**Files:**
- Create: `backend/app/static/js/ui/motion.js`, `tests/js/motion.test.mjs`
- Modify (later owner after s2-T9): `styles/motion.css`

**Interfaces.**
- `motion.js` is a classic script, not a module. It expects `window.anime` (the vendored UMD) and defines `window.RFMotion`:
  - `tokens`: `{ fast: 125, fastMax: 165, med: 300, medMax: 400, slow: 700 }`, read from the CSS variables when present, otherwise these defaults;
  - `reduced()`: `matchMedia('(prefers-reduced-motion: reduce)').matches`;
  - `animate(targets, params)`: with `reduced()` or without `anime`, it applies the end state instantly (`anime.utils.set` or direct styles) and returns a resolved promise-like object. Otherwise it calls `anime.animate` with a duration capped at `tokens.slow`.
  - `stagger`, `spring`: thin pass-throughs, or no-ops under reduced motion.
  - `enter(root)`: runs `data-motion="list-enter|fade-up|pop"` enter animations for elements under `root` that have not run yet (`data-motion-done`).
  - `transition(update)`: uses `document.startViewTransition` when available and not reduced. It calls `skipTransition()` on a running one first and caps the duration with CSS. Otherwise it calls `update()` directly.
- One `document.addEventListener('htmx:afterSwap', e => RFMotion.enter(e.detail.target))`. No other global listeners.
- `styles/motion.css`:
  - `::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation-duration: var(--t-fast-max) }`;
  - `@media (prefers-reduced-motion: reduce) { ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none } [data-motion] { animation: none !important; transition: none !important } }`;
  - colour-flash keyframes on tokens (anime.js cannot animate a CSS variable).
- No template uses `data-motion` yet. s2-T18's gallery demonstrates it.

Steps:
- [ ] **RED:** `tests/js/motion.test.mjs` (jsdom with a stub `anime` recording calls):
  - `motion: reduced motion sets end state instantly and never calls anime.animate`;
  - `motion: enter runs once per element on afterSwap`;
  - `motion: transition skips a running view transition and falls back without the API`;
  - `motion: durations are capped at --t-slow`.
- [ ] Run: `node --test tests/js/motion.test.mjs`. Expected: `# fail 4`.
- [ ] **GREEN:** implement.
- [ ] Run: `node --test tests/js/motion.test.mjs && TMPDIR=/var/tmp npm test`. Expected: `# fail 0`.
- [ ] Run: a scratch build. Its output contains `@media (prefers-reduced-motion:reduce)` with `::view-transition-group(*)` and `animation:none`.

### Task s2-T18: UI macros: overlays and navigation, `dialog.js`, `/dev/ui` gallery, script tags

**Size** L · agent: worker · blocked_by: s2-T16, s2-T17, s2-T13, s2-T7

**Files:**
- Create:
  - `backend/app/templates/ui/overlay.html`: `menu` (dropdown), `popover`, `dialog`, `sheet` (drawer), `toast` (static markup for the toaster container only);
  - `backend/app/templates/ui/nav.html`: `tabs`, `command_palette`, `sidebar`;
  - `backend/app/static/js/ui/dialog.js`;
  - `backend/app/routers/web/dev_ui.py`;
  - `backend/app/templates/dev/ui.html`;
  - `backend/tests/test_dev_ui.py`;
  - `tests/js/ui-dialog.test.mjs`.
- Modify:
  - `backend/app/main.py`: include `dev_ui.router` only when `settings.debug`;
  - `backend/app/templates/base.html`: static deferred `<script src="{{ static_url(…) }}">` tags after `htmx.min.js` and before `app.js`, in this order: `js/vendor/anime/anime.umd.min.js`, `js/vendor/basecoat/basecoat.min.js`, the 8 component files, `js/ui/motion.js`, `js/ui/dialog.js` (Q6).

**Interfaces.**
- `dialog.js` (classic script) adds one delegated `click` listener on `document`:
  - `[data-rf-open]` → `document.getElementById(value)`. For a `<dialog>`, it calls `showModal()` and remembers the opener;
  - `[data-rf-close]` inside a dialog closes it;
  - on `close`, focus returns to the opener.
  - Sheets (Basecoat drawer) use the same attribute.
- Macros never emit `onclick`. Basecoat's documented `onclick="…showModal()"` is replaced by `data-rf-open`.
- `/dev/ui` (GET, DEBUG only) renders every macro in every variant, including `data-motion` examples, with the toaster container. It extends `base.html`.
- No Readfine code passes `onclick` options to Basecoat `toast.js` (Review Focus 11).

Steps:
- [ ] **RED:** `tests/js/ui-dialog.test.mjs`:
  - `dialog: data-rf-open opens and returns focus`: jsdom with a polyfilled `HTMLDialogElement.showModal` / `close`;
  - `dialog: unknown id does nothing and logs nothing`.
- [ ] **RED:** `test_dev_ui.py`:
  - `test_gallery_404_when_debug_off`;
  - `test_gallery_renders_every_macro_when_debug_on`: settings override plus a fresh app; every macro name from `ui/*.html` appears as a section id; the HTML passes the inline-handler matcher;
  - `test_base_loads_ui_scripts_statically`: `/login` HTML has the vendored and `ui/` script tags with `?v=` and no `import(`.
- [ ] Run: `node --test tests/js/ui-dialog.test.mjs` and `cd backend && uv run pytest tests/test_dev_ui.py -q`. Expected: fail.
- [ ] **GREEN:** implement.
- [ ] Run: both again, plus `cd backend && uv run pytest tests/test_csp.py tests/test_ui_macros.py -q` and `TMPDIR=/var/tmp npm test`. Expected: `passed`, `# fail 0`.
- [ ] Report the new contract selectors (`data-rf-open`, `data-rf-close`, `data-motion`, `data-motion-done`) and the Basecoat initialisation attributes seen in the gallery.

### Common rules for the restyle tasks (s2-T19, T23, T24, T25, T26)

These hold for every restyle task (Q5):

- **Markup.** Pages are rebuilt from the `ui/` macros (`forms.html`, `display.html`; `overlay.html` and `nav.html` from s2-T18 for the admin tasks). There is no hand-written Basecoat markup.
- **Contract and text stay.** Every existing `id`, `name`, `data-*`, `hx-*` attribute, form `action`/`method` and visible English string stays. Admin JS, the backend tests (about 118 assert on HTML text) and `docs/ui-dom-contract.md` depend on them. A rename is allowed only together with all its consumers, and is reported for s2-T20.
- **Behaviour stays.** No route, handler or service change. The one exception is s2-T24's three Python strings, which change markup classes only. Forms inside dialogs set their own `hx-target`/`hx-swap` (design §5.4). A two-click inline confirmation stays until its zone wave.
- **Colours.** No colour literal is added, and existing ones move to tokens; the colour lint must report 0 for the task's files.
- **Validation without Playwright.** Ports are taken by other waves. The task proves its work with:
  - full pytest;
  - a render test file of its own (at most 5 tests). Each page renders, contains the macro markers (`class="btn"` / `class="card"` / `class="field"` …), passes the inline-handler matcher and the colour pattern, and still carries the ids and strings that tests and JS use;
  - `node scripts/check-dom-contract.mjs`, where `missing` lines are allowed only for new selectors and are listed;
  - a scratch build plus `check-css-vars` and `check-tw4-classes --css`.

  s2-T28 reviews the result in a browser.
- **Layout exemptions.** A key screen the task restyles gets a whole-screen entry in the task's own `tests/visual/layout-allow/<task>.json`, with the reason "restyled through ui macros (Q5)".
- **Sizes are honest.** Each task is one coherent page group. A worker that finds a page needs a new macro variant reports it and uses the nearest existing one; macro files belong to s2-T16 and s2-T18.

### Task s2-T19: Auth and error pages through the macros

**Size** M · agent: worker · blocked_by: s2-T13, s2-T14, s2-T16 · scope per owner decision Q5

**Files:**
- Modify:
  - `backend/app/templates/auth/{login,register,reset_password_request,reset_password_confirm,check_email,email_change_result,registration_disabled}.html` (about 400 lines): centred `card`, `field` + `input`, primary `button`, `alert` for errors;
  - `backend/app/templates/errors/{404,429,500,client}.html` (56 lines): `card` / `empty_state`.
- Create: `backend/tests/test_restyle_auth_pages.py`, `tests/visual/layout-allow/s2-T19.json` (`login` `*`).
- Keep: the inline scripts in `check_email.html:55` and `register.html:102`. They are nonce'd and look up `resend-btn` and `submit-btn` by id. The ids stay.

Steps:
- [ ] **RED:** `test_restyle_auth_pages.py`:
  - `test_auth_pages_use_macros_and_keep_contract`: parametrised over the pages. Each renders through `unauth_client` (or the template with a fixture context) with `class="card"` and `class="btn"`, and keeps `form[data-rf-login]`, `#email`, `#resend-btn`, `#submit-btn` where present today;
  - `test_error_pages_use_macros`.
- [ ] Run: `cd backend && uv run pytest tests/test_restyle_auth_pages.py -q`. Expected: fail.
- [ ] **GREEN:** restyle.
- [ ] Run: the same command, then `uv run pytest -q` (throwaway `DATABASE_URL`), then `node scripts/check-colours.mjs | grep -E 'templates/(auth|errors)/'`. Expected: `passed`, `passed`, no output.

### Task s2-T23: Admin pages I through the macros: dashboard, traffic, settings

**Size** L · agent: worker · blocked_by: s2-T18, s2-T13, s2-T14

**Files:**
- Modify:
  - `backend/app/templates/admin/base.html` (23 lines: admin sub-navigation through `ui/nav.html` `tabs` or the `sidebar` macro);
  - `admin/dashboard.html` (462): stat `card`s, tables, `badge`s;
  - `admin/traffic.html` (348): cards and table; the chart container keeps its ids;
  - `admin/settings.html` (344): `field`, `input`, `select`, `switch`, sticky save;
  - `admin/partials/rate_limits_modal.html` (58): `dialog` macro with `data-rf-open`;
  - `backend/app/static/js/admin-settings.js` and `traffic-chart.js`, only where a selector or class they use changes with the markup. Chart colours, if any are literals, move to `getComputedStyle` tokens.
- Create: `backend/tests/test_restyle_admin_core.py`, `tests/visual/layout-allow/s2-T23.json` (`admin-settings` `*`).

Steps:
- [ ] **RED:** `test_restyle_admin_core.py`, with `admin_client` from `conftest.py` and the mock DB where the route allows it, else template rendering with fixture contexts:
  - `test_admin_core_pages_use_macros_and_keep_ids` (parametrised: dashboard, traffic, settings);
  - `test_rate_limits_modal_opens_with_data_rf_open`: the trigger carries `data-rf-open`, the target is a `<dialog>`, and there is no `onclick`.
- [ ] Run: `cd backend && uv run pytest tests/test_restyle_admin_core.py -q`. Expected: fail.
- [ ] **GREEN:** restyle.
- [ ] Run: the same, then the full pytest, `TMPDIR=/var/tmp npm test` and `node scripts/check-colours.mjs | grep -E 'templates/admin/|admin-settings|traffic-chart'`. Expected: `passed`, `passed`, `# fail 0`, no output.

### Task s2-T24: Admin pages II through the macros: feeds, users, invitations, logs, scoring eval

**Size** L · agent: worker · blocked_by: s2-T18, s2-T13, s2-T14

**Files:**
- Modify:
  - `admin/feeds.html` (83), `admin/partials/feeds_table.html` (168) and `feed_edit_form.html` (108): table, `badge`, `menu`, the edit form as `sheet` or `dialog`;
  - `admin/users.html` (16), `admin/partials/users_table.html` (137) and `users_count.html` (5);
  - `admin/invitations.html` (41) and `admin/partials/invitations_table.html` (61);
  - `admin/audit_log.html` (42), `admin/fetch_logs.html` (49) and `admin/scoring_eval.html` (233);
  - `backend/app/static/js/admin-feeds.js`, only where its selectors change;
  - `backend/app/routers/web/admin.py:356,360,366`: the SMTP test result spans use the same `alert` / token classes as the macros. Python cannot call the macros, so the classes are copied from `ui/display.html` `alert`, with a comment naming the macro.
- Create: `backend/tests/test_restyle_admin_lists.py`.
- Admin delete and activate actions keep their current confirmation and `hx-*` behaviour. Delayed delete is a later wave.

Steps:
- [ ] **RED:** `test_restyle_admin_lists.py`:
  - `test_admin_list_pages_use_macros_and_keep_ids` (parametrised over the pages);
  - `test_feed_edit_form_in_overlay_sets_own_hx_target`;
  - `test_smtp_test_result_uses_alert_classes`.
- [ ] Run: `cd backend && uv run pytest tests/test_restyle_admin_lists.py -q`. Expected: fail.
- [ ] **GREEN:** restyle.
- [ ] Run: the same, then `uv run pytest tests/test_admin_delete_user.py tests/test_admin_feed_grouping.py tests/test_admin_fetch_error_rollup.py -q`, then the full pytest, then `TMPDIR=/var/tmp npm test`. Expected: `passed` throughout, `# fail 0`.

### Task s2-T25: Public pages through the macros: help, features, changelog, legal

**Size** L · agent: worker · blocked_by: s2-T13, s2-T14, s2-T16

**Files:**
- Modify:
  - `backend/app/templates/help.html` (695): sections as `card`s, `kbd` for shortcuts, `alert` for notes. The anchors (`id`s) used by in-app links (for example `#offline-diagnostics`-style deep links and `help.html:245`) stay;
  - `features.html` (44): `.feature-desc` stays the Markdown hook; card layout;
  - `changelog.html` (58): `card` per release, `badge` for the admin-only upgrade notes;
  - `legal/base.html`, `legal/privacy.html` and `legal/terms.html` (273): prose in a `card`.
- Create: `backend/tests/test_restyle_public_pages.py`, `tests/visual/layout-allow/s2-T25.json` (`help` `*`).
- The `<details>` elements in `help.html` stay native. Basecoat's `collapsible.css` is not imported (Global Constraints), and an accordion macro is not in the design's list.

Steps:
- [ ] **RED:** `test_restyle_public_pages.py`, parametrised over the pages: each renders with macro markers, keeps every `id` present at `1d7f2f4` (read with `git show 1d7f2f4:<path>` inside the test setup, or a list frozen in the test), and has no colour literal.
- [ ] Run: `cd backend && uv run pytest tests/test_restyle_public_pages.py -q`. Expected: fail.
- [ ] **GREEN:** restyle.
- [ ] Run: the same, then the full pytest, then `node scripts/check-colours.mjs | grep -E 'help.html|features.html|changelog.html|legal/'`. Expected: `passed`, `passed`, no output.

### Task s2-T26: Landing page through the macros, theme bootstrap via `init.js`

**Size** M · agent: worker · blocked_by: s2-T10, s2-T13, s2-T14, s2-T16

**Files:**
- Modify: `backend/app/templates/landing.example.html` (299):
  - the two `theme-color` metas (`:30-31`, `#ffffff` / `#030712`) become one `<meta name="theme-color">` without content, filled by `syncThemeColor`;
  - the inline scheme script (`:35-44`) is replaced by `<script src="{{ static_url('js/init.js') }}">`, so landing gets `data-rf-theme` and the same bootstrap as the app. `init.js`'s layout code is harmless on a page without the shell, which the worker verifies and reports;
  - the sections are rebuilt with the `ui/` macros (`{% import %}`): buttons, cards, badges;
  - the JSON-LD block stays.
- Create: `backend/tests/test_restyle_landing.py`.
- Not modified: the live `landing.html`, which is gitignored and per instance. s2-T22 writes the upgrade note (Q10).

Steps:
- [ ] **RED:** `test_restyle_landing.py`:
  - `test_landing_example_renders_with_macros_and_init_js`: render `landing.example.html` with the context `auth.py:71` passes. Expect `class="btn"`, a script tag for `js/init.js`, and no inline scheme script;
  - `test_landing_example_has_no_colour_literal`.
- [ ] Run: `cd backend && uv run pytest tests/test_restyle_landing.py -q`. Expected: fail.
- [ ] **GREEN:** restyle.
- [ ] Run: the same, `uv run pytest tests/test_csp.py -q`, and `node scripts/check-colours.mjs | grep landing`. Expected: `passed`, `passed`, no output.

### Task s2-T27: Label palette onto tokens (Q2, Q9)

**Size** M · agent: worker · blocked_by: s2-T9, s2-T3

**Files:**
- Create:
  - `backend/app/services/label_palette.py`: `LABEL_PALETTE: tuple[tuple[str, str], ...]` (name, hex), with the 16 entries of s2-T9 in today's order; `DEFAULT_LABEL_NAME = "indigo"`; `DEFAULT_LABEL_COLOR = "#6366f1"`;
  - `backend/tests/test_label_palette.py`.
- Modify:
  - `backend/app/templating.py`: register `label_palette` (the tuple and the default) as a Jinja global;
  - `backend/app/templates/settings/labels.html:6,29,38` and `settings/partials/labels_list.html:1`:
    - the swatch loop iterates `label_palette`;
    - each swatch renders `style="background-color: var(--rf-label-{{ name }})"` and keeps submitting `value="{{ hex }}"`;
    - the selected ring test compares `name` with the default;
    - the hidden default input takes `label_palette.default`;
  - `backend/app/templates/settings/tokens.html:170`: the API example colour comes from `{{ label_palette.default_hex }}`;
  - `backend/app/routers/web/settings/labels.py:42,62`: `Form(DEFAULT_LABEL_COLOR)`;
  - `backend/app/services/opml.py:72`: `DEFAULT_LABEL_COLOR` is imported from `label_palette`;
  - `backend/app/services/stats_service.py:800`: the same.
- Not modified: `models/label.py` and `schemas/label.py`. Stored values stay `#RRGGBB`; there is no migration (Q9).

Steps:
- [ ] **RED:** `test_label_palette.py`:
  - `test_tokens_css_and_python_palette_agree`: parse `--rf-label-<name>: <hex>` from `styles/tokens.css` and compare with `LABEL_PALETTE`, name for name and hex for hex;
  - `test_swatches_use_tokens_and_submit_hex`: render `settings/partials/labels_list.html`. Each swatch has `var(--rf-label-<name>)` and `value="<hex>"`, and the template contains no colour literal;
  - `test_create_with_a_swatch_stores_the_same_hex`: through the labels route with the mock DB, or through `LabelCreate`. Posting a swatch's value stores exactly that hex;
  - `test_stored_non_palette_colour_still_renders`: a label with `#123456` renders that value in the label list and the row partial.
- [ ] Run: `cd backend && uv run pytest tests/test_label_palette.py -q`. Expected: fail.
- [ ] **GREEN:** implement.
- [ ] Run: the same, then `uv run pytest tests/test_opml*.py tests/test_label*.py tests/test_api_labels.py -q`, the full pytest, and `node scripts/check-colours.mjs | grep -E 'labels|tokens.html'`. Expected: `passed`, `passed`, `passed`, no output.

### Task s2-T28: Browser review of the restyled pages

**Size** M · agent: worker · blocked_by: s2-T10, s2-T13, s2-T14, s2-T18, s2-T19, s2-T23, s2-T24, s2-T25, s2-T26, s2-T27, s2-T29, s2-T30, s2-T31, s2-T32, s2-T33, s2-T34, s2-T35 (the repair tasks were added by amendment 21 after the first pass; the first pass ran without them)

**Files:**
- Modify: none in the product. It may refine reasons in `tests/visual/layout-allow/*.json` (later owner) but may not add exemptions.
- Output: `test-results/visual-report/` (gitignored), handed to the orchestrator.

Steps:
- [ ] Start the throwaway container on 4253. Copy `tailwind.css` aside, run `npm run build` into the worktree copy, and copy the saved file back at the end.
- [ ] Run: `E2E_DATABASE_URL=… RF_VISUAL_MODE=gallery RF_VISUAL_DEBUG=1 RF_VISUAL_LANDING=1 RF_VISUAL_GALLERY_BASE=1 node tests/visual/run.mjs`. Expected: all `GALLERY_PAGES` captured and dark-patch probe `0`.
- [ ] Review every restyled page in all six theme/scheme pairs at 1280 and 390 against the base shots and the mockups. Record each defect as `page, theme, viewport, what, likely owner task`. Typical defects: overflow on 390, a missing dark state, a lost control, a broken modal, text contrast.
- [ ] Run: `E2E_DATABASE_URL=… RF_VISUAL_BASE=1d7f2f4 RF_VISUAL_MODE=layout node tests/visual/run.mjs`. Expected: pass A fails only on exempted screens and keys; pass B passes.
- [ ] Run: `E2E_DATABASE_URL=… npm run test:e2e -- --project=chrome`. Expected: `passed`.
- [ ] Report the defects list. First pass (done, attempt a1): its 15 defects became s2-T29–s2-T35. Second pass (after them): confirm each of those defects fixed, with the same commands; any new defect is reported the same way, and the orchestrator decides on a further repair task before s2-T20 starts.

### Task s2-T20: Guards in CI and contract reconciliation

**Size** S · agent: worker · blocked_by: s2-T2 … s2-T19 and s2-T23 … s2-T28 (every code task, s2-T11 and the review s2-T28 included)

**Files:**
- Modify (later owner): `package.json`, `.github/workflows/ci.yml`, `docs/ui-dom-contract.md`

**Interfaces.**
- `"check:sources": "node scripts/check-tw4-classes.mjs && node scripts/check-css-vars.mjs && node scripts/check-colours.mjs && node scripts/check-dom-contract.mjs"`.
- New `ci.yml` frontend steps after the existing two checks: `Check colour literals live in styles/tokens.css` (`node scripts/check-colours.mjs`) and `Check the DOM contract` (`node scripts/check-dom-contract.mjs`). The inline-handler check, the drift and bump tests and the rendered contract pages already run in the pytest job.
- Contract entries added for the selectors reported by s2-T8, T10, T17, T18, T19 and T23–T27.

Steps:
- [ ] **RED:** Run `node scripts/check-colours.mjs; node scripts/check-dom-contract.mjs`. Expected: colours `OK` (T13–T15, T26 and T27 done; only the four Q2 exceptions remain); contract `FAIL` with `missing` lines for the new selectors.
- [ ] **GREEN:** add the entries, the scripts and the CI steps.
- [ ] Run: `npm run -s check:sources`. Expected: four `OK` lines, exit 0. Run: `TMPDIR=/var/tmp npm test`. Expected: `# fail 0`.

### Task s2-T21: Regenerate `tailwind.css` and vendored files; accept the segment

**Size** M · agent: worker · blocked_by: s2-T20

**Files:**
- Modify (generated): `backend/app/static/css/tailwind.css`. Vendored files and fonts are regenerated only if `npm run build` changes them, which it should not.

Steps:
- [ ] **RED:** Run `npm run check:generated`. Expected: exit 1 with a `tailwind.css` diff.
- [ ] **GREEN:** Run `npm run build`. Expected: `vendor: 18 files, …` and `Done in`. Then `O=$(mktemp -d) && cp backend/app/static/css/tailwind.css $O/a.css && npm run build && cmp $O/a.css backend/app/static/css/tailwind.css && echo deterministic; rm -r $O`. Expected: `deterministic`.
- [ ] `npm run check:generated` compares against the commit, so the orchestrator's verifier runs it on the applied tree. Expected there: exit 0.
- [ ] Run: `npm run -s check:sources`. Expected: four `OK` lines.
- [ ] Run, with a throwaway `DATABASE_URL` and the throwaway container on 4253: `TMPDIR=/var/tmp npm test && (cd backend && uv run pytest -q) && E2E_DATABASE_URL=… npm run test:e2e -- --project=chrome`. Expected: `# fail 0`, `passed`, `passed`. The e2e includes the offline suite (the shell works offline with the new scripts and fonts) and `theme.spec.mjs`, whose `theme-color` now comes from `--background`.
- [ ] Run: `E2E_DATABASE_URL=… RF_VISUAL_BASE=1d7f2f4 RF_VISUAL_MODE=layout npm run test:visual`. Expected: `layout: A <n>/<n> strict` (allow-listed entries named) and `B <n>/<n> structural`, exit 0. A pass-A failure outside the allow list goes back to its task through return-to-repair. Likely owners: s2-T9 for CSS leaks, s2-T13/T14 for tokens.
- [ ] Run: `E2E_DATABASE_URL=… RF_VISUAL_MODE=gallery RF_VISUAL_DEBUG=1 RF_VISUAL_LANDING=1 RF_VISUAL_GALLERY_BASE=1 npm run test:visual`. Expected: every `GALLERY_PAGES` entry × 12 plus `/dev/ui` × 6, `gallery.html` with base beside head, and dark-patch probe `0`. Every whole-screen layout exemption has its shots in the gallery. Hand `test-results/visual-report/{layout.md,gallery.html}` and the PNGs to the orchestrator for the Result page.
- [ ] Probe on a 390 px Chrome page with `appTheme=graphite`, `colorScheme=dark`: `meta[name=theme-color]` equals the computed `--background` and is hex.

### Task s2-T22: As-built docs

**Size** S · agent: worker · blocked_by: s2-T21

**Files:**
- Modify: `README.md` ("CSS build" section), `CLAUDE.md` ("CSS / Tailwind conventions"), `CHANGELOG.md` (`[Unreleased]`)

**Content:**
- **`CLAUDE.md` conventions**, added:
  - Colour literals live only in `styles/tokens.css`; templates, JS and `input.css` use tokens (`npm run check:sources` → `check-colours`). The only exceptions are email templates, `offline/launch.js` and the worker's offline page. Label palette colours come from `services/label_palette.py`, mirrored by `--rf-label-*`; stored label colours are hex data.
  - Components come from the `templates/ui/` macros. No hand-written Basecoat markup; no `on*` attributes; dialogs and sheets open with `data-rf-open="<id>"`.
  - Motion goes through `RFMotion` and `data-motion`; it is instant under reduced motion.
  - **WR2-F2:** an element carries exactly one of `hidden` or an unprefixed display class. A runtime toggle swaps both, never just `hidden`.
  - **WR2-F3:** Tailwind 4 preflight makes `[hidden]` `display:none !important`. An element with the `hidden` attribute stays hidden whatever its display utility.
  - DOM contract: rename a contract item only together with its consumers and its entry in `docs/ui-dom-contract.md`.
  - Changing a snapshot partial bumps `OFFLINE_TEMPLATE_VERSION`, updates `OFFLINE_TEMPLATE_HASH` and regenerates both golden sets.
- **`README.md`:** themes and fonts; `npm run build` vendors first; the visual harness modes (`RF_VISUAL_MODE`, `RF_VISUAL_BASE` default `1d7f2f4`, `RF_VISUAL_DEBUG`).
- **`CHANGELOG.md`:**
  - "Added: app themes Neutral, Paper and Graphite (light and dark), chosen per device in Settings → Preferences."
  - "Changed: interface font Geist, article serif font Source Serif 4 (self-hosted)."
  - "Changed: sign-in, error, admin, help, features, changelog and legal pages redesigned in the new visual style."
  - Upgrade note (Q10): "If you serve your own `landing.html`, re-copy it from `landing.example.html`, or apply the same changes. The example now loads `init.js` for the theme and uses the new components." No migration.

Steps:
- [ ] **RED:** Run `grep -n 'tokens.css\|data-rf-open\|exactly one of' CLAUDE.md`. Expected: no output.
- [ ] **GREEN:** write the docs.
- [ ] Run: the same grep. Expected: 3 or more lines. Run `grep -n 'Paper' CHANGELOG.md`. Expected: a line under `## [Unreleased]`.

### Repair tasks after s2-T28 (amendment 2026-11-21)

Source: s2-T28 attempt a1, defects list in its report (`noticed`), screenshots under that attempt's `test-results/visual-report/`. Each task below fixes defects of one area. Common rules:
- RED then GREEN: a failing test (pytest render, node test or computed-style check) before the fix, where the defect can be tested without a browser. A defect that only shows in a browser is listed for s2-T28's second pass.
- Keep ids, names, `data-*`, `hx-*`, form actions and visible strings, as in the restyle tasks.
- No Playwright, except s2-T35. Throwaway DBs as in "Global Constraints".
- `test_dom_contract_pages.py` goldens: only s2-T29 regenerates them (it is the only task that changes `base.html`, which every full-page golden includes). Other tasks keep the rendered HTML of those eight pages unchanged.
- `tailwind.css` is not regenerated here (s2-T21). New utility classes are fine; the theme-tokens guard ignores classes that are not in the committed CSS yet.

### Task s2-T29: Repair base.html dark form controls and light seams

**Size** M · agent: worker · blocked_by: s2-T13, s2-T19, s2-T23, s2-T24, s2-T26 (all complete; the defects come from the s2-T28 first pass)

**Files:** Modify `backend/app/templates/base.html`; regenerate `backend/tests/fixtures/dom_contract/*.html` (`RF_UPDATE_GOLDENS=1`); tests in a new `backend/tests/test_base_dark_controls.py`.

Defects:
- **T28-2 (all dark themes):** a checked switch shows a dark track with a dark thumb and reads as off; the checked radio dot is invisible; macro inputs and selects take the legacy panel fill (navy under Graphite dark). Cause: the unlayered rule `html.dark input, html.dark select, html.dark textarea { background-color: var(--rf-legacy-dark-panel) … }` (`base.html` ~413) beats Basecoat's layered `.input`, `[role=switch]`/`input[type=checkbox][role=switch]` and radio styles. Fix: the legacy dark rule must not apply to Basecoat-styled controls (for example `:where()` with `:not(.input, .select, .textarea, [role=switch], [type=radio], [type=checkbox])`, or the same rule inside a cascade layer below Basecoat), keeping legacy inputs that still rely on it unchanged.
- **T28-10 (Paper/Graphite light, 390):** the two `#article-detail` overlay rules use `background: white` (~312, ~350), a visible seam under the `--background` back bar; the keyword also slips past the colour lint. Use the token (`var(--background)` or the surface token the bar uses) so overlay and bar match.
- **T28-11 (Paper/Graphite light, 390):** the mobile top bar and `#mobile-bottom-bar` use `--background` (cream) while `#article-list` is white and the body gray-50, so bands show. Make the shell consistent in `base.html` only (do not edit `app/partials/*`: that would bump `OFFLINE_TEMPLATE_VERSION`). Neutral must stay as it is.

Steps:
- [ ] **RED:** tests that read the `base.html` style block: no `background: white`; the legacy dark input rule excludes Basecoat controls (assert the selector text).
- [ ] **GREEN:** the fix; `RF_UPDATE_GOLDENS=1 uv run pytest tests/test_dom_contract_pages.py`; the diff of the goldens is limited to the `<style>` block.
- [ ] Run: full pytest, `TMPDIR=/var/tmp npm test`, `node scripts/check-colours.mjs` (no new hits). Expected: pass.

### Task s2-T30: Repair dark default border colour and the story band token

**Size** S · agent: worker · blocked_by: s2-T9, s2-T14, s2-T19, s2-T23, s2-T24, s2-T26 (all complete; the defects come from the s2-T28 first pass)

**Files:** Modify `input.css`, `styles/tokens.css`, `tests/js/theme-tokens.test.mjs`.

Defects:
- **T28-3 (all dark themes):** Basecoat borders with no colour of their own (alert, admin sidebar, dialog boxes, dev-ui cards) draw a bright 1 px `--color-gray-200` line. Cause: the Tailwind 3 compat default `border-color: var(--color-gray-200, currentcolor)` (`input.css` ~153) has no dark mapping. Fix: the default border colour is the scheme-aware `var(--border)`; light themes must keep the same computed colour (Neutral `--border` equals gray-200; check Paper and Graphite light too).
- **T28-9 (Paper and Graphite light, confirmed):** `--rf-story-top` equals `--rf-row-hover` (`#f5f5f4` / `#f1f5f9`), so the 4 px story band vanishes on a hovered row after a group. Give `--rf-story-top` a distinct step in those two light themes (Neutral keeps `#eef0f3` vs `#f5f5f5`), keeping dark untouched.

Steps:
- [ ] **RED:** in `theme-tokens.test.mjs`: the compat default border uses `--border`; `--rf-story-top` differs from `--rf-row-hover` in every theme/scheme.
- [ ] **GREEN:** the fix.
- [ ] Run: `TMPDIR=/var/tmp npm test`, temp build + `check-css-vars` + `check-tw4-classes`, colour lint. Expected: pass.

### Task s2-T31: Alert variants and their use on traffic, settings and check-email

**Size** M · agent: worker · blocked_by: s2-T16, s2-T19, s2-T23, s2-T24, s2-T26 (all complete; the defects come from the s2-T28 first pass)

**Files:** Modify `backend/app/templates/ui/display.html`, `backend/app/templates/admin/traffic.html`, `backend/app/templates/admin/settings.html`, `backend/app/templates/auth/check_email.html`, `backend/tests/test_ui_macros.py`, `backend/tests/test_restyle_admin_core.py`, `backend/tests/test_restyle_auth_pages.py`.

Note on `input.css`: to keep one owner per wave, this task does NOT edit `input.css`; variants are expressed with token utilities in the macro.

Defects:
- **T28-4 (admin-traffic):** the trusted-proxy notice lost its amber warning state; inline `<code>TRUSTED_PROXY_COUNT</code>`, `<code>TRUST_CLOUDFLARE</code>` and "or" each break onto their own line inside the alert body.
- **T28-5 (admin-settings):** "Settings saved." is a neutral alert with no success state and is wider than the cards below it.
- **T28-6 (check-email):** "Verification email sent" lost its green success state.
- Macro gap from review: `alert` has only default/destructive. Add `warning` and `success` variants (token-based colours, e.g. `--rf-warn`/`--rf-ok` style roles that exist in `tokens.css`; read it first), readable in all six theme/scheme pairs. The default and destructive output must stay byte-identical (the `login.html` golden must not change).
- The alert body must keep inline content inline (text with `<code>` flows as a paragraph).

Steps:
- [ ] **RED:** `test_ui_macros.py` renders `alert(variant="warning")` / `"success"` with distinct markup; traffic/settings/check-email tests assert the variant.
- [ ] **GREEN:** the fix.
- [ ] Run: full pytest (the `dom_contract` goldens unchanged), `TMPDIR=/var/tmp npm test`, colour lint. Expected: pass.

### Task s2-T32: Admin sidebar after resize, and Escape

**Size** M · agent: worker · blocked_by: s2-T18, s2-T19, s2-T23, s2-T24, s2-T26 (all complete; the defects come from the s2-T28 first pass)

**Files:** Modify `backend/app/static/js/ui/dialog.js`, `backend/app/templates/ui/nav.html`, `tests/js/ui-dialog.test.mjs`.

Defects:
- **T28-7 (all themes):** an admin page loaded at 390 keeps `#admin-nav` closed (`aria-hidden=true`) after a resize to 1280, and the menu button is `md:hidden`, so navigation is unreachable until a reload. The reverse (1280 → 390) leaves the nav open over the content. Cause: the vendored Basecoat sidebar decides the open state once at init. Fix in our code (never edit `static/js/vendor/`): a `matchMedia` listener for the sidebar breakpoint that sets the open state through Basecoat's own API or event when the breakpoint is crossed.
- **T28-8 (390):** Escape does not close the open mobile sidebar. Close it on Escape when it is in its mobile (overlay) state, returning focus to the opener.
- Review carry T23-R1/T18-R2: keep the opener's `aria-expanded` in sync with the open state.

Steps:
- [ ] **RED:** `ui-dialog.test.mjs` (jsdom or the existing harness): crossing the breakpoint opens/closes; Escape closes on mobile; `aria-expanded` follows.
- [ ] **GREEN:** the fix.
- [ ] Run: `TMPDIR=/var/tmp npm test`, CSP check (no inline handlers). Expected: pass.

### Task s2-T33: Admin list pages: no page overflow at 390, selected chip

**Size** M · agent: worker · blocked_by: s2-T19, s2-T23, s2-T24, s2-T26 (all complete; the defects come from the s2-T28 first pass)

**Files:** Modify `backend/app/templates/admin/base.html`, `backend/app/templates/admin/feeds.html`, `backend/app/templates/admin/users.html`, `backend/app/templates/admin/invitations.html`, `backend/app/templates/admin/partials/feeds_table.html`, `backend/app/templates/admin/partials/users_table.html`, `backend/app/templates/admin/partials/invitations_table.html`, `backend/app/templates/admin/scoring_eval.html`, `backend/tests/test_restyle_admin_lists.py`.

Defects:
- **T28-1 (all themes, 390):** admin feeds, users and invitations scroll the whole page sideways (document 836/801/393 px wide) although the table scrolls inside its card. The base had no page overflow. Likely cause: a flex/grid child without `min-w-0` (the admin main column next to the sidebar, or the card) lets the table's width push the page. Fix so the document width equals the viewport and only the table container scrolls.
- **T28-14 (scoring eval, dark; weak in light):** the selected window chip (variant secondary) is barely distinguishable from the outline chips. Make the selected state clear (e.g. default/primary variant or `aria-pressed` with a token fill), keeping links and their query strings.

Steps:
- [ ] **RED:** render tests: the admin main column and card wrappers carry `min-w-0` (or the chosen mechanism); the selected chip renders the selected variant.
- [ ] **GREEN:** the fix.
- [ ] Run: full pytest, `TMPDIR=/var/tmp npm test`, colour lint. Expected: pass. The page width is confirmed in s2-T28's second pass.

### Task s2-T34: Landing CTA size at 390

**Size** S · agent: worker · blocked_by: s2-T19, s2-T23, s2-T24, s2-T26 (all complete; the defects come from the s2-T28 first pass)

**Files:** Modify `backend/app/templates/landing.example.html`, `backend/tests/test_restyle_landing.py`.

Defect **T28-15 (all themes, 390):** the hero CTA buttons shrank from large to small compared with the base (touch target). Use the large button size for the hero CTAs.

Steps: RED render test for the CTA size class; GREEN; full pytest. Expected: pass.

### Task s2-T35: Visual harness: primary fills and the compat test

**Size** S · agent: worker · blocked_by: s2-T8 (all complete; the defects come from the s2-T28 first pass)

**Files:** Modify `tests/visual/key-screens.spec.mjs`.

Defects:
- **T28-12:** the dark-patch gate fails with 64 patches, all primary-filled controls (`.btn` primary, `.badge` default) whose `--primary` is light by design in Neutral and Paper dark (Appendix A). Allow them precisely: match the element's computed background against the theme's `--primary`/`--primary-foreground` (read from the page), not a blanket class exemption; any other light patch still fails.
- **T28-13:** test "compat: button cursor and placeholder colour" (~464) expects `--color-gray-400` on the login `#email`, which is now the Basecoat `.input` with the `--muted-foreground` placeholder. Point the check at an unrestyled input that still uses the compat placeholder, or compare against the new token, keeping its purpose (Tailwind 4 compat placeholder/cursor).
- Review carry T8-R3: the probe skips backgrounds with alpha < 0.9 and `background-image`; extend it to flag translucent light fills and light gradients on dark themes, with a positive control.

Steps:
- [ ] Throwaway Postgres on 4253 (`readfine_e2e`), as in "Global Constraints". Copy `tailwind.css` aside, `npm run build`, restore it byte-identical at the end.
- [ ] Run: `RF_VISUAL_MODE=gallery` for the dark themes only, and the compat test. Expected: the dark-patch probe reports 0 and the compat test passes; a deliberately injected light patch (positive control, not committed) fails.

## Carry-over map

| Item | Where |
|---|---|
| WR2-F1 derive `HIDDEN_LOSES_TO` from the built CSS | s2-T2 |
| WR2-F2 "exactly one of hidden / display; toggles swap both" in `CLAUDE.md` | s2-T22 |
| WR2-F3 `[hidden]` is `display:none !important` | s2-T22 |
| WR2-F5 literal gray hex in hand-written CSS | s2-T14 (`input.css`), s2-T13 (`base.html`), s2-T15 (`sidebar.html` / mirror); caught by s2-T3, wired in s2-T20 |
| T7-N1 unused space/divide variants, recheck with the theme layer | s2-T9 test `basecoat: old utility selectors are kept`. The probe shows Basecoat's only use is `.avatar-group` (not imported). |
| Backlog: stale fixture `story-overlay.test.mjs:180` | s2-T2 |
| WR2-F4 offline story footer parity gap (pre-existing) | listed as an `allowed` drift in s2-T12, not fixed (backlog stays) |
| Owner Q2: no lint exceptions for landing, label palette, `tokens.html` example, `templates.js:23` | s2-T26 (landing), s2-T27 (palette, `tokens.html`), s2-T15 (`templates.js:23`); `ALLOW` frozen at 4 entries in s2-T3 |
| Owner Q3+Q5: full restyle of admin, auth and public pages | s2-T19, T23, T24, T25, T26; browser review s2-T28; s8 remainder under "What remains for s8" |
| Backlog: "Date inputs 2 px shorter under Tailwind 4" (revisit with Basecoat inputs) | touched where s2-T19/T23 replace date inputs with the `input` macro; the zones keep theirs until their waves |

## Appendix A — theme values from the prototype

Source: the prototype's `index.html` (theme `<style>` block), read on 2026-11-21 from the run's scratchpad copy `readfine-proto/index.html`. That copy is the file the published prototype https://claude.ai/artifact/BsuMQ732ksD3waLJfoY6Qa was built from; the owner confirmed this on 2026-11-21. Owner decision Q1 (2026-11-21) accepts these values, the derived gray remap and Graphite's radius. Neutral is Basecoat 1.1.0's own `:root` / `.dark` values (`basecoat-css/dist/base/base.css`); s2-T9 copies them from `node_modules`.

Readfine tokens (all themes; dark overrides in `.dark`):

```
:root { --rf-unread: oklch(0.55 0.2 255); --rf-star: oklch(0.8 0.16 85); --rf-ok: oklch(0.6 0.15 150);
        --rf-serif: "Source Serif 4", Georgia, "Times New Roman", serif; }
.dark { --rf-unread: oklch(0.72 0.15 255); --rf-star: oklch(0.85 0.15 85); --rf-ok: oklch(0.7 0.15 150); }
```

`--rf-warn` is not in the prototype: use `oklch(0.75 0.15 70)` light and `oklch(0.8 0.14 75)` dark (amber), owner to confirm with Q1.

Paper:

```
html[data-rf-theme="paper"]{
  --background: oklch(0.985 0.006 85); --foreground: oklch(0.2 0.02 60); --card: oklch(0.995 0.004 85);
  --muted: oklch(0.955 0.01 85); --muted-foreground: oklch(0.5 0.025 60); --accent: oklch(0.94 0.014 85); --accent-foreground: oklch(0.22 0.02 60);
  --primary: oklch(0.33 0.05 45); --primary-foreground: oklch(0.98 0.01 85); --border: oklch(0.9 0.014 80); --input: oklch(0.9 0.014 80); --ring: oklch(0.6 0.05 50);
  --popover: oklch(0.995 0.004 85); --popover-foreground: oklch(0.2 0.02 60); --secondary: oklch(0.95 0.012 85); --secondary-foreground: oklch(0.25 0.02 60);
  --sidebar: oklch(0.965 0.012 85); --sidebar-foreground: oklch(0.22 0.02 60); --sidebar-accent: oklch(0.925 0.016 80); --sidebar-accent-foreground: oklch(0.2 0.02 60); --sidebar-border: oklch(0.9 0.014 80);
  --radius: 0.5rem;
}
html[data-rf-theme="paper"].dark{
  --background: oklch(0.19 0.012 60); --foreground: oklch(0.93 0.012 85); --card: oklch(0.22 0.012 60);
  --muted: oklch(0.26 0.012 60); --muted-foreground: oklch(0.7 0.02 80); --accent: oklch(0.3 0.014 60); --accent-foreground: oklch(0.95 0.01 85);
  --primary: oklch(0.86 0.04 75); --primary-foreground: oklch(0.2 0.02 60); --border: oklch(1 0 0 / 10%); --input: oklch(1 0 0 / 14%);
  --popover: oklch(0.23 0.012 60); --popover-foreground: oklch(0.93 0.012 85); --secondary: oklch(0.27 0.012 60); --secondary-foreground: oklch(0.93 0.012 85);
  --sidebar: oklch(0.21 0.012 60); --sidebar-foreground: oklch(0.92 0.012 85); --sidebar-accent: oklch(0.28 0.014 60); --sidebar-accent-foreground: oklch(0.95 0.01 85); --sidebar-border: oklch(1 0 0 / 9%);
}
```

Graphite:

```
html[data-rf-theme="graphite"]{
  --background: oklch(0.99 0.002 250); --foreground: oklch(0.2 0.02 260); --muted: oklch(0.965 0.006 255); --muted-foreground: oklch(0.52 0.02 260);
  --accent: oklch(0.955 0.012 255); --accent-foreground: oklch(0.25 0.04 262); --primary: oklch(0.5 0.2 262); --primary-foreground: oklch(0.985 0 0);
  --border: oklch(0.92 0.008 255); --input: oklch(0.92 0.008 255); --ring: oklch(0.6 0.15 262);
  --sidebar: oklch(0.975 0.005 255); --sidebar-accent: oklch(0.94 0.016 258); --sidebar-accent-foreground: oklch(0.3 0.08 262); --sidebar-border: oklch(0.92 0.008 255);
  --radius: 0.875rem; --rf-body-font: "Geist", ui-sans-serif, system-ui, sans-serif;
}
html[data-rf-theme="graphite"].dark{
  --background: oklch(0.17 0.012 260); --foreground: oklch(0.96 0.005 255); --card: oklch(0.2 0.014 260); --muted: oklch(0.25 0.014 260); --muted-foreground: oklch(0.7 0.02 258);
  --accent: oklch(0.28 0.03 262); --accent-foreground: oklch(0.96 0.005 255); --primary: oklch(0.68 0.16 262); --primary-foreground: oklch(0.15 0.02 262);
  --popover: oklch(0.21 0.014 260); --popover-foreground: oklch(0.96 0.005 255); --secondary: oklch(0.26 0.014 260); --secondary-foreground: oklch(0.96 0.005 255);
  --border: oklch(1 0 0 / 9%); --input: oklch(1 0 0 / 13%);
  --sidebar: oklch(0.19 0.014 260); --sidebar-accent: oklch(0.27 0.03 262); --sidebar-accent-foreground: oklch(0.96 0.005 255); --sidebar-border: oklch(1 0 0 / 8%);
}
```

Gaps that s2-T9 fills and reports:
- tokens the prototype leaves out of a block (Graphite light `--card`, `--popover*`, `--secondary*`, `--sidebar-foreground`, `--sidebar-primary*`, `--sidebar-ring`; `--destructive` and `--chart-*` everywhere) inherit Neutral's value or are derived from the block's own foreground and background;
- Graphite's `--rf-body-font` waits for Q4;
- the prototype's article View Transition (300 ms in) is not adopted: design §5.3 caps it at 165 ms.

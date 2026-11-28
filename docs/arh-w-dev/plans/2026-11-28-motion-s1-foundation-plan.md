# Motion s1 — Foundation and presses Implementation Plan

Status: plan / draft · 2026-11-28 · run `run-24209be3-a48b-4f12-a7a1-b7eb02530254`, segment `s1` of 4 · `native` (workers never commit, spawn, publish or approve) · branch `feat/animations` from `origin/selfhost` `8281192`.

**Goal:** an engine over `anime.waapi.animate` that leaves no inline styles, presets with trimmed springs and a bounded cascade, presses everywhere, cross-document View Transitions, a reduced-motion reset covering Basecoat, closing overlays that stop catching clicks, and a check that keeps animation calls in `motion.js`.

**Architecture:** `static/js/ui/motion.js` gets a core (`run()` with the five rules, `play`, `springEase`, `activeCount`/`idle`, `trace`) and a preset registry; `RFMotion.animate` stays, fenced, until s4. CSS motion in `styles/motion.css`/`tokens.css`. `scripts/check-motion-calls.mjs` joins `check:sources` and CI. No snapshot template changes.

**Tech stack:** anime.js 4.5.0, htmx 2.0.4, Basecoat 1.1.0, Tailwind 4, Jinja2, node:test, Playwright, pytest; no new dependencies.

**Design:** `docs/arh-w-dev/designs/2026-11-28-motion-design.md` (sha256 `8313dc20…`), §10 point 1. Owner (§15): particles yes (s2); Undo countdown, swipe-to-close, vibration no.

## Коротко для владельца

1. Кнопки, ссылки, пункты меню, вкладки и строки коротко «ныряют» под пальцем и пружиной возвращаются; клик проходит сразу.
2. Переход между экранами — затухание не дольше 165 мс (где браузер умеет).
3. При «уменьшении движения» замирают и диалоги, листы, меню, тосты, вкладки, переключатели.
4. Закрывающееся меню или диалог не перехватывает клик.
5. Остальное — этапы 2–4; экраны в покое не меняются.

Два места дизайна нельзя выполнить буквально (п. 1 и 8 ниже); решения — в «Decided questions».

## Design points this plan settles

1. **Transitional allowances (Q1):** §6.14 wants the call check green in s1, but `ui/read.js:256` and `feeds-settings.js:63` use the JS engine until s2/s4; one call each is allowed until then.
2. **Legacy fence:** `RFMotion.animate` needs `TRANSFORMS` (`motion.js:252-256`, `x:` keys); T1 fences it, T3 exempts the fence, s4 deletes it; unused `persist` goes.
3. `RFMotion.tokens` keeps five keys (`motion.test.mjs:175`); `definePreset`, `springs`, `springEase` are public.
4. **i9 accepted:** one instance per element per call; a stop ends all its keys at the correct end state.
5. Entrance presets use the new engine; the `afterSwap` trigger and the harness layer check wait for s2. No product template has `data-motion`.
6. **"No traces" compares values**, not `style` text (Chrome 158 re-serialises `transition: all 150ms` after `revert()`).
7. CI runs checks as separate steps (`ci.yml:103-113`): one new step.
8. **Snapshot macros (Q2):** `templates/ui/{overlay,display,forms,nav,readfine}.html` are in the snapshot closure, so §6.2/§8 macro declarations contradict §6.7.

## Global Constraints

- Animation only via anime.js 4.5.0's public API in `motion.js` (`anime.waapi.animate`, `anime.spring`, `anime.waapi.convertEase`); no `Element.animate`, no `anime.animate` in presets, no `createSpring`; no `anime.waapi` → nothing plays or is written.
- Five engine rules: `revert()` in `onComplete`; array keyframes; last frame at rest (own animations of that element/property stopped first; `none` for `scale`/`translate`; computed `opacity`, skipped during a CSS `opacity` transition; sole exception `visibility` for the phone sidebar, s3); never `persist`; stop via `handle.stop()` (native `cancel()`).
- Keys `opacity`, `scale`, `translate` (+ `transform`/`visibility`, phone sidebar); `x`, `translateX`… forbidden.
- Durations unchanged (125/165/300/400/700 ms); new `--rf-stagger-step: 20ms`, `--rf-stagger-max: 10`, `--rf-ease-overshoot: cubic-bezier(0.34, 1.4, 0.64, 1)`; no `--t-press`.
- Springs (bounce/duration → budget ms): `press` 0.35/140 → 165, `pop` 0.5/220 → 400, `panel` 0.15/280 → 400, `snap` 0.25/160 → 165; trimmed, normalised; residue > 0.02 → lower bounce. Cascade: 10 visible, 20 ms apart, each ≤ 165, all ≤ 400. Frequent actions ≤ 165; nothing past 700.
- Press: one call per `pointerdown`, `scale [1, ~0.94, rest]` (`press-soft` ~0.985), nothing on release, never `preventDefault`.
- Reduced motion: no preset, `activeCount()` 0, no inline style, no View Transition; read per call.
- No animation delays state or input; closing overlays drop modality and pointer capture at once; inline style after = before (except `read.js`'s swipe `transform`).
- No reduced-motion `transition: none` on `[data-motion]`, `.toast`, `[data-popover]`, `.dialog`, `.drawer`, `.command-dialog`.
- Static scripts, CSP unchanged, token colours, resting screens pixel-identical.
- **Snapshot closure read-only:** `app/partials/{ai_blocks,archive_button,article_content,article_detail,article_meta_date,article_row,article_title,chat,error_bar,read_button,readable_progress,row_poll,saved_icons,score_badge,share_button,star_icon,story_block}.html`, `ui/{display,forms,nav,overlay,readfine}.html`; version `7`, hash `6a5a389617b4977d`.
- **Generated files belong to s1-T5** (`tailwind.css`, `docs/ui-dom-contract.md`, `backend/tests/fixtures/dom_contract/*`); before it the only excused gaps are missing contract items and a stale `tailwind.css`. Browsers from s1-T6.
- ≤ 5 new tests per task; no weakened tests; stop after 3 failed approaches.

### Test environment

`/bin/sh -c` from `/projects/readfine/ui-redesign`, no `ARH_W_DEV_*`. Present: `backend/.venv`, `node_modules`, vendored anime and Basecoat, WebKit, Chrome.

- Node: `TMPDIR=/var/tmp node --test <files>` → `ℹ fail 0`.
- The s1 pytest files need no database: dummy URL on 4253 (checked).
- E2E, visual, full pytest: throwaway `rf-int-pg-motion` (rootless docker, `postgres:16-alpine`, tmpfs, `127.0.0.1:4253` only, reserved in the host port registry, db `readfine_e2e`). The script reuses or recreates it and waits ≤ 60 s for TCP.

  `scripts/motion-e2e-db.sh` (new, written by s1-T6; heavy checks add `uv`, which Playwright calls, to `PATH` and run it first) contains `#!/bin/sh` and this line:

  ```sh
  C=rf-int-pg-motion;{ docker exec $C pg_isready -qh127.0.0.1 -Ureadfine||{ docker rm -f $C;docker run -d --name $C -e POSTGRES_USER=readfine -e POSTGRES_PASSWORD=readfine -e POSTGRES_DB=readfine_e2e -p 127.0.0.1:4253:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine;};}>/dev/null 2>&1;i=0;until docker exec $C pg_isready -qh127.0.0.1 -Ureadfine -dreadfine_e2e;do i=$((i+1));[ $i -lt 60 ]||exit 1;sleep 1;done
  ```

  Playwright migrates `readfine_e2e`; `pytest-full` creates `rf_motion_s1_branch`. Remove at the end: `docker rm -f rf-int-pg-motion`. The line was dry-run under `env -i`: fresh (`alembic` → `0131`), reuse, after stop.
- Never 4250, `readfine_pytest`/`readfine_test` or production (`db-guard.mjs` refuses). One heavy check at a time. Scratch CSS: `/var/tmp/rf-s1-<task>css`.

## Review Focus

1. **Rapid repeated presses** (double-click, press during `pop`): every click lands, no scale stays. → s1-T1 `motion press: …`, `motion engine: …`; s1-T6 `motion e2e: presses leave no trace`.
2. **Pressing an element with inline style or state** (swiped `transform`, `opacity-75`, inline `transition`): only `scale` moves. → s1-T1 `motion engine: …`; s1-T6 `motion e2e: presses leave no trace`.
3. **Reduced motion turned on mid-session:** nothing plays or is written. → s1-T1 `motion core: …`; s1-T6 `motion e2e: reduced motion keeps overlays working and still`.
4. **anime.js blocked, without `waapi`, or a hidden tab:** clicks work, no throw, no writes, `idle()` resolves. → s1-T1 `motion core: …`.
5. **Clicking where a closing menu/dialog was; Basecoat under reduced motion:** the click lands below; a closed toast is removed; a closed dialog is not modal. → s1-T2 `motion css: closing overlays stop catching the pointer at once and exit on tokens`; s1-T6 `motion e2e: a closing menu lets the click through at once`, `motion e2e: reduced motion keeps overlays working and still`.

## File map

| Files | Task |
|---|---|
| `backend/app/static/js/ui/motion.js`, `tests/js/motion.test.mjs`, new `tests/js/motion-presets.test.mjs` | s1-T1 |
| `styles/tokens.css`, `styles/motion.css`, `input.css`, new `tests/js/motion-css.test.mjs` | s1-T2 |
| new `scripts/check-motion-calls.mjs`, `package.json`, `.github/workflows/ci.yml`, new `tests/js/check-motion-calls.test.mjs` | s1-T3 |
| `backend/app/templates/dev/ui.html`, `backend/tests/test_dev_ui.py` | s1-T4 |
| `backend/app/static/css/tailwind.css`, `docs/ui-dom-contract.md`, `backend/tests/fixtures/dom_contract/*` (if asked) | s1-T5 |
| new `scripts/motion-e2e-db.sh`, new `tests/e2e/motion.spec.mjs`, `tests/e2e/read.spec.mjs`, `tests/visual/key-screens.spec.mjs` | s1-T6 |
| `CLAUDE.md`, `CHANGELOG.md`, `FEATURES.md`, `docs/arh-w-dev/designs/2026-11-19-ui-redesign-design.md` | s1-T7 |

## Tasks

### Task s1-T1: Motion core, presets and press

**Size** L · agent: worker · blocked_by: — · verifierRequired: true

**Files:** `backend/app/static/js/ui/motion.js` · `tests/js/motion.test.mjs` · `tests/js/motion-presets.test.mjs`

**Checks** `[{"id":"s1-T1-js","name":"motion.js parses; motion unit tests","cmd":"node --check backend/app/static/js/ui/motion.js && TMPDIR=/var/tmp node --test tests/js/motion.test.mjs tests/js/motion-presets.test.mjs tests/js/ui-read.test.mjs","timeoutSec":300}]`

**Interfaces.**
- Consumes: `window.anime`; `--rf-stagger-step`/`--rf-stagger-max` (T2; defaults 20 ms / 10).
- Produces on `window.RFMotion` (unchanged: `tokens` with five keys, `reduced`, `animate`, `stagger`, `spring`, `transition`, `enter`):
  - `play(name, target, opts?) → {stop(), finished} | null`; `null`, nothing written, when reduced, `document.hidden`, no `anime.waapi`, unknown name, disconnected target, opacity skip.
  - `presets` (frozen `name → {keys, budget, frequent, exception?}`: `press`, `press-soft`, `fade-up`, `fade-up-short`, `pop`, `list-enter`); `definePreset(name, spec)` throws on a duplicate or a key outside `opacity|scale|translate` (`transform`/`visibility` need `exception: 'visibility'`).
  - `springs` (frozen `{bounce, duration, budget}` per `press`, `pop`, `panel`, `snap`); `springEase(name) → {ease, duration} | null`: `s = anime.spring({bounce, duration})`, `k = min(1, budget / s.settlingDuration)`, `ease = anime.waapi.convertEase(t => s.ease(t * k) / s.ease(k))`, `duration = min(s.settlingDuration, budget)`.
  - `activeCount()`; `idle() → Promise<void>` (count 0, `transition()` done); `trace` (`{name, target, t}` per started preset while `<html>` has `data-rf-motion-trace`).
- Engine: internal `run(target, keyframes, opts)`, one `anime.waapi.animate` instance per target per call; rule 3 first stops own instances on that element sharing a key (whole instance, i9) and skips on a running opacity `CSSTransition`; `stop()` = native `cancel()` on `instance.animations` (fallback `complete()`); `delay + duration ≤ --t-slow`, frequent ≤ `--t-fast-max`; throws rethrown in `setTimeout`.
- Presets (§6.3): `press`/`press-soft` `scale [1, 0.94|0.985, rest]`, `springEase('press')`; `fade-up` `opacity [0, rest]` + `translate ['0px 8px', rest]`, `--t-med`, `--rf-ease-out`; `fade-up-short` 4px, `--t-fast`; `pop` `opacity [0, rest]` + `scale [0.92, rest]`, `springEase('pop')`; `list-enter` = `fade-up` at `--t-fast-max` on the first `staggerMax` children in view, delay `i × staggerStep`.
- Presses: capture passive `pointerdown` on `document`, `keydown` Enter/Space (`!repeat`); `closest()` of the §6.4.3 selector verbatim; skip `:disabled`, `[aria-disabled=true]`, `[data-motion-press=off]`, inside `[data-rf-swipe]`, form fields, computed `display: inline`; `press-soft` for `.article-row`, `#sidebar a`, `tr`, `[data-motion-press=soft]`; no release listeners.
- `enter()` plays via `play()`; its `afterSwap` listener (`:377-381`) stays. Guard `if (window.RFMotion) return;`; header drops "The only global listener…" (`:11-13`); `RFMotion.animate`'s code (`TIMING_KEYS` without `persist`, cap helpers, `endState`, `TRANSFORMS`/`setStyles`, `finished`, `animate`, `stagger`) between `// rf-motion:legacy-animate start` and `// rf-motion:legacy-animate end`.

- [ ] **RED**, five cases in `tests/js/motion-presets.test.mjs`; stub `waapi.animate` records `{target, params}`, returns `{animations: [{cancel}], complete, revert, cancel}`; `params.onComplete(instance)` finishes:
  1. `motion core: loads once; reduced motion, a hidden tab or no anime.waapi play nothing and write nothing`: two loads → one `RFMotion`, one call per `pointerdown`; reduced → `null`, no call, no `style`, `activeCount() === 0`; matchMedia flipped between plays → `null`; hidden tab, `anime = {}`, no `anime` → `null`, no throw; `idle()` resolves.
  2. `motion springs: each named spring fits its budget and ends at 1 on the real bundle`: real bundle; durations ≤ 165/400/400/165; `linear(…, 1)`; `|1 − s.ease(k)| ≤ 0.02`; no `console.warn`.
  3. `motion cascade: list-enter animates at most 10 visible children, 20 ms apart, and ends by --t-med-max`: 200 children, 30 in view → children 0–9, delays 0…180, ends ≤ 400; `enter()` values are arrays.
  4. `motion engine: every preset follows the five rules`: `onComplete` → `revert()`, arrays, no `persist`, whitelisted keys, no `exception`; `scale`/`translate` end `'none'`; `opacity` ends on stubbed `'0.75'` read after `stop()`; opacity transition → `null`; native `cancel()` only; `press` mid-`pop` cancels both `pop` animations; inline `transform` survives; `trace` only with the attribute; `activeCount()` 0 after `onComplete`.
  5. `motion press: one scale call per pointerdown, none on release, skipped targets, second press stops the first`: `[1, x<1, 'none']`, press ease, ≤ 165; release → nothing; skip cases and `<aside id="sidebar" hx-get hx-trigger="load">` → nothing; `.article-row` → 0.985; not `defaultPrevented`; Enter once, no repeat; second press cancels the first.
  Rewrite `motion: enter runs once per element on afterSwap` (`motion.test.mjs:93-126`) for `waapi.animate` (done marks, "only the swap target is scanned" kept).
- [ ] Run `s1-T1-js`. Expected: new and rewritten cases fail (`RFMotion.play is not a function`).
- [ ] **GREEN:** implement; `s1-T1-js` → `ℹ fail 0`. Report `motion.js`'s line count (§6.1, ~800).

### Task s1-T2: Motion CSS and tokens

**Size** M · agent: worker · blocked_by: — · verifierRequired: false

**Files:** `styles/tokens.css` · `styles/motion.css` · `input.css` · `tests/js/motion-css.test.mjs`

**Checks** `[{"id":"s1-T2-js","name":"motion CSS and build tests","cmd":"TMPDIR=/var/tmp node --test tests/js/motion-css.test.mjs tests/js/tailwind-build.test.mjs tests/js/tailwind-layers.test.mjs tests/js/theme-tokens.test.mjs","timeoutSec":600},{"id":"s1-T2-build","name":"scratch build keeps the VT rule, drops the dead flash; source checks","cmd":"mkdir -p /var/tmp/rf-s1-t2css && node scripts/build-css.mjs -i input.css -o /var/tmp/rf-s1-t2css/tailwind.css && grep -q 'navigation:auto' /var/tmp/rf-s1-t2css/tailwind.css && ! grep -q 'folder-just-moved' /var/tmp/rf-s1-t2css/tailwind.css && node scripts/check-colours.mjs && node scripts/check-css-vars.mjs && node scripts/check-tw4-classes.mjs","timeoutSec":300}]`

**Interfaces.**
- Produces:
  - `tokens.css` Motion block (`:733-741`): the three new tokens.
  - `motion.css`: header (`.row-just-saved` 2 s fade is the one `--t-slow` exception); the `(*)` cap; `@media (prefers-reduced-motion: no-preference) { @view-transition { navigation: auto; } }`; `view-transition-name` `rf-sidebar` on `#sidebar`, `rf-tab-bar` on `#tab-bar`; verbatim `:is(.dialog, .alert-dialog, .command-dialog, .drawer):not([open]), .drawer[data-closing], [data-popover][aria-hidden='true'], .toaster .toast[aria-hidden='true'] { pointer-events: none; }`; closed `.dialog`, `.alert-dialog`, `.command-dialog`, `[data-popover][aria-hidden='true']` exit on `var(--t-fast)` + `var(--rf-ease-in)`, a closing toast on `var(--t-fast-max)`.
  - Reduced block (§6.11): `.rf-flash` keeps `animation`/`transition: none !important`; `[data-motion] { animation: none !important; transition-duration: 0.01ms !important; transition-delay: 0s !important }`; `.dialog, .alert-dialog, .command-dialog, .drawer, [data-popover], .toaster .toast, .sidebar, .tabs, .switch, .btn, #sidebar, #mobile-sidebar-backdrop` with ` *`/`::backdrop` → `transition-duration: 0.01ms !important`, the components themselves also `animation-duration: 0.01ms !important; animation-iteration-count: 1 !important`; nothing on `html`. `input.css:746-760` moves here, same effect (both unlayered; equal `!important` pairs keep today's winner).
  - `input.css`: `:746-760` and `.folder-just-moved` (`:798-803`) removed.
- [ ] **RED**, five cases in `tests/js/motion-css.test.mjs` (text parsed into `{media, selectors, declarations}`):
  1. `motion css: no reduced-motion rule sets transition none on overlays or [data-motion]`: also `[data-motion]`'s three declarations and `.rf-flash`'s two.
  2. `motion css: Basecoat components and shell get 0.01 ms under reduced motion, descendants keep their animations`: the 12 selectors, ` *`, `::backdrop`; animation declarations only without descendant combinators; no `html`.
  3. `motion css: the cross-document transition is declared only under no-preference and capped`: one `@view-transition`, in no-preference; cap `var(--t-fast-max)`.
  4. `motion css: closing overlays stop catching the pointer at once and exit on tokens`: verbatim list; token exits; no ms literal outside the reduced block.
  5. `motion tokens: new motion tokens exist, durations unchanged, the dead folder flash is gone`: eight old values, three new, no `--t-press`; `.row-just-saved` kept.
- [ ] Run `s1-T2-js`. Expected: the five new cases fail.
- [ ] **GREEN:** `s1-T2-js`, `s1-T2-build` → `ℹ fail 0`; `build-css: …` and three `OK`. Never write `tailwind.css`.

### Task s1-T3: Animation call check

**Size** M · agent: worker · blocked_by: s1-T1 · verifierRequired: false

**Files:** `scripts/check-motion-calls.mjs` · `package.json` · `.github/workflows/ci.yml` · `tests/js/check-motion-calls.test.mjs`

**Checks** `[{"id":"s1-T3-js","name":"check unit tests","cmd":"TMPDIR=/var/tmp node --test tests/js/check-motion-calls.test.mjs","timeoutSec":120},{"id":"s1-T3-tree","name":"the tree passes; wired into check:sources and CI","cmd":"node scripts/check-motion-calls.mjs && grep -q 'node scripts/check-motion-calls.mjs' package.json && grep -q 'node scripts/check-motion-calls.mjs' .github/workflows/ci.yml","timeoutSec":60}]`

**Interfaces.**
- Consumes: s1-T1's fence markers.
- Produces:
  - `scripts/check-motion-calls.mjs` like `check-colours.mjs`: `ALLOW`, `sourceFiles(repo)`, `motionCallHits(files) → {path, line, rule}[]`; prints `motion-calls: OK (N files)` or `motion-calls: FAIL` + `path:line rule` (exit 1).
  - Scope `static/js/**/*.js`, `templates/**/*.html`, minus `static/js/vendor/**` and `htmx.min.js`; JS, `{# #}`, `<!-- -->` comments blanked first (`base.html:557-563` passes).
  - Outside `ui/motion.js` hits: `anime.<name>(`, `window.anime`, `.animate(`, `startViewTransition`, `RFMotion.animate`. Bounded (§6.14 inv. 9, §9 item 17): `app.js` ≤ 1 `RFMotion.transition(` inside `function _shellTransition`, ≤ 6 helper calls keyed by a listed literal (`mobile-detail-open:on|off`, `story-detail-open:on|off`, `deeplink-detail-open:off`) or a two-literal ternary; `RFMotion.play(` only `read.js` `'swipe-snap'`, `feeds-settings.js` `'flash'`, `dev/ui.html`; `RFMotion.enter(` only `dev/ui.html`; no `data-rf-vt` in templates. Transitional: one `.animate(` in `ui/read.js` (to s2), one `RFMotion.animate(` in `feeds-settings.js` (to s4).
  - In `ui/motion.js` hits: `persist` key, `commitStyles`, keys `x|y|z`, `translate[XYZ]`, `scale[XYZ]`, `rotate*`, `skew*`, `.animate(` other than `waapi.animate(`; the fence is exempt with ≤ 1 `.animate(`.
  - `check:sources` runs it before `check-dom-contract.mjs`; `ci.yml` step `Check animation calls stay in motion.js` after the colour step.
- [ ] **RED**, five cases in `tests/js/check-motion-calls.test.mjs` (in-memory fixtures):
  1. `motion calls: the repository passes`.
  2. `motion calls: anime, animate and view transitions outside motion.js are reported, comments and script tags are not`.
  3. `motion calls: motion.js keeps the engine rules, except inside the legacy fence` (a second fenced `.animate(` hits).
  4. `motion calls: the allow list holds its upper bounds`: seventh call, `'foo:on'`, variable key, three-literal ternary, `transition(` outside the helper, `play('pop')` in `read.js`, `play`/`enter` in `app.js` hit; six valid calls pass.
  5. `motion calls: transitional calls are bounded and data-rf-vt stays out of templates`.
- [ ] Run `s1-T3-js`. Expected: `Cannot find module`.
- [ ] **GREEN:** `s1-T3-js`, `s1-T3-tree` → `ℹ fail 0`; `motion-calls: OK (N files)`.

### Task s1-T4: Gallery of the stage presets

**Size** S · agent: worker · blocked_by: — · verifierRequired: false

**Files:** `backend/app/templates/dev/ui.html` · `backend/tests/test_dev_ui.py`

**Checks** `[{"id":"s1-T4-py","name":"source checks; gallery and CSP tests","cmd":"node scripts/check-colours.mjs && node scripts/check-tw4-classes.mjs && cd backend && SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_motion_nodb .venv/bin/pytest -q -p no:cacheprovider tests/test_dev_ui.py tests/test_csp.py","timeoutSec":300}]`

**Interfaces.**
- Consumes: `RFMotion.play(name, target)` and the s1 preset names (markup only; runs beside T1).
- Produces: in `#ui-motion` (`dev/ui.html:369-385`) a caption naming the engine and, per s1 preset, `data-ui-demo-play="<name>"` (Replay) with `data-ui-demo-target="<name>"` (button, or a `div` with `data-motion-press="soft"` for rows); the `data-motion` demos stay. The nonce'd script (`:390-420`) keeps `RFMotion.enter(document)` and adds a click branch calling `RFMotion.play(name, target)` if present. No other `RFMotion` call, no `on*`.
- [ ] **RED:** `test_gallery_replays_each_stage_preset` in `test_dev_ui.py`: a play button and a target per `press`, `press-soft`, `fade-up`, `fade-up-short`, `pop`, `list-enter`; the script has `RFMotion.play(` and `RFMotion.enter(document)`, no `RFMotion.animate(` or `anime.`; `:74-84` unchanged.
- [ ] Run `s1-T4-py`. Expected: `1 failed`.
- [ ] **GREEN:** run `s1-T4-py`. Expected: two `OK` lines, `passed`.

### Task s1-T5: Regeneration: CSS and DOM contract

**Size** S · agent: worker · blocked_by: s1-T1, s1-T2, s1-T3, s1-T4 · verifierRequired: true

**Files:** `backend/app/static/css/tailwind.css` · `docs/ui-dom-contract.md` · `backend/tests/fixtures/dom_contract`

**Checks** `[{"id":"s1-T5-css","name":"committed CSS equals a fresh build","cmd":"mkdir -p /var/tmp/rf-s1-t5css && node scripts/build-css.mjs -i input.css -o /var/tmp/rf-s1-t5css/tailwind.css && cmp backend/app/static/css/tailwind.css /var/tmp/rf-s1-t5css/tailwind.css","timeoutSec":300},{"id":"s1-T5-sources","name":"check:sources","cmd":"npm run check:sources","timeoutSec":300},{"id":"s1-T5-py","name":"contract pages, drift, version, gallery","cmd":"cd backend && SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/rf_motion_nodb .venv/bin/pytest -q -p no:cacheprovider tests/test_dom_contract_pages.py tests/test_offline_drift.py tests/test_offline_template_version.py tests/test_partials_online_unchanged.py tests/test_dev_ui.py","timeoutSec":600},{"id":"s1-T5-js","name":"npm test","cmd":"TMPDIR=/var/tmp PYTHON=backend/.venv/bin/python npm test","timeoutSec":900}]`

**Interfaces.**
- Consumes: s1-T1…T4 as applied.
- Produces: `tailwind.css` from `npm run build` (vendor and fonts unchanged: `git status --porcelain -- backend/app/static/js/vendor backend/app/static/fonts` empty); the contract from `node scripts/check-dom-contract.mjs --write`. Expected additions `data-motion-press`, `data-rf-motion-trace`, `data-ui-demo-play|target`; a removal is checked against the T1–T4 reports. Fixtures change only if `test_dom_contract_pages.py` asks (`RF_UPDATE_GOLDENS=1` on the `s1-T5-py` line).
- [ ] **RED:** `s1-T5-css`, `s1-T5-sources`. Expected: `cmp` differs; `dom-contract: FAIL`, `missing data-motion-press`.
- [ ] **GREEN:** build, `--write`, all four checks. Expected: `cmp` silent; five `OK` lines; `passed`; `ℹ fail 0`.

### Task s1-T6: Browser and visual acceptance

**Size** L · agent: worker · blocked_by: s1-T5 · verifierRequired: true

**Files:** `scripts/motion-e2e-db.sh` · `tests/e2e/motion.spec.mjs` · `tests/e2e/read.spec.mjs` · `tests/visual/key-screens.spec.mjs`

**Checks** `[{"id":"s1-T6-chrome","name":"full Chrome suite with the motion spec","cmd":"export PATH=\"$HOME/.local/bin:$PATH\" && sh scripts/motion-e2e-db.sh && TMPDIR=/var/tmp E2E_DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e npx playwright test --project=chrome","timeoutSec":3600,"heavy":true},{"id":"s1-T6-sources","name":"no new DOM-contract item","cmd":"npm run check:sources","timeoutSec":300}]`

**Repair rule:** only these four files; a defect elsewhere returns to its owner, then that task and s1-T5 are reconfirmed. No new DOM-contract item (if unavoidable, report it; s1-T5 is reconfirmed).

**Interfaces.**
- Consumes: `RFMotion.activeCount/idle/trace` (T1); rebuilt CSS (T5); `seed()`, `login()`; `read.spec.mjs`'s CSP collector.
- Produces:
  - `motion.spec.mjs`: `requireE2eDatabaseUrl()` at collection, `seed()` per test, an init script setting `data-rf-motion-trace` and recording cross-document transitions (`pagereveal` → `viewTransition.ready` → durations of `::view-transition*` animations).
  - `read.spec.mjs` `runningAnimations` (`:138-140`) ignores `dialog-scroll-lock` and identity `scale`/`translate` transitions, reports `activeCount() > 0`; the reduced test (`:443-466`) asserts `activeCount() === 0` and an empty `trace`.
  - `key-screens.spec.mjs`: `capture()` (`:321-332`) and `boxes()` (`:335-343`) await `RFMotion.idle()` when defined (base `8281192` has none).
  - "No traces" compares `style.cssText` and inline `scale`/`translate`/`opacity`/`transform`.
- [ ] **RED**, five cases in `motion.spec.mjs`:
  1. `motion e2e: a press plays one short scale animation and the click still lands`: `mouse.down()` on a toolbar `.btn` → one `Animation`, `scale` `1`, `< 1`, `none`, ≤ 165 ms; `mouse.up()` opens its menu with no added wait; a row → `press-soft`.
  2. `motion e2e: presses leave no trace`: button, read row, unread row; single, double, cancelled presses; after `idle()` equal values, no `opacity` `transitionrun` on the read row, `activeCount() === 0`.
  3. `motion e2e: a closing menu lets the click through at once`: Escape, then within 30 ms a click at a menu item's point reaches the element below; same for the shortcuts dialog.
  4. `motion e2e: reduced motion keeps overlays working and still`: dialog, menu, toast open/close with `runningAnimations` empty; the toast leaves the DOM; the dialog is not `:modal`; no `trace`; no view transition on `/app` → `/settings`.
  5. `motion e2e: navigating between screens cross-fades within --t-fast-max`: `/app` → `/settings`; Chrome records `::view-transition-old/new(root)` ≤ 165 ms; WebKit the same or none.
- [ ] Run `s1-T6-chrome`. Expected: new cases fail or pass with evidence; the existing 56 pass.
- [ ] **GREEN:** `s1-T6-chrome`, `s1-T6-sources`, then branch checks `e2e-touched-webkit`, `visual-layout`, one at a time. Expected: `passed`; five `OK`; `layout: A n/n strict`, `B n/n structural`.

### Task s1-T7: As-built documentation

**Size** S · agent: worker · blocked_by: s1-T6 · verifierRequired: false

**Files:** `CLAUDE.md` · `CHANGELOG.md` · `FEATURES.md` · `docs/arh-w-dev/designs/2026-11-19-ui-redesign-design.md`

**Checks** `[{"id":"s1-T7-docs","name":"docs carry the s1 contracts","cmd":"grep -q 'anime.waapi.animate' CLAUDE.md && grep -q 'check-motion-calls' CLAUDE.md && grep -q 'data-motion-press' CLAUDE.md && grep -q 'RFMotion.idle' CLAUDE.md && grep -q '2026-11-28-motion-design.md' docs/arh-w-dev/designs/2026-11-19-ui-redesign-design.md && grep -q 'answer a press' CHANGELOG.md && ! git diff --quiet -- FEATURES.md && git diff --check -- CLAUDE.md CHANGELOG.md FEATURES.md docs/arh-w-dev/designs/2026-11-19-ui-redesign-design.md","timeoutSec":60}]`

**Interfaces.**
- Consumes: the as-built s1-T1…T6.
- Produces:
  - `CLAUDE.md:272` becomes a short block: `motion.js` only, `anime.waapi.animate`, the five rules, keys, `data-motion`/`data-motion-press="off|soft"`/`data-motion-done`/`data-rf-motion-trace`, presses, `scripts/check-motion-calls.mjs` (transitional `read.js`, `feeds-settings.js`), 0.01 ms (never `transition: none`) on Basecoat overlays, the harness awaiting `RFMotion.idle()`, no `textContent` writes, link to the motion design.
  - `CHANGELOG.md` Unreleased: `- **Motion:** buttons, links and rows answer a press with a short spring; moving between screens cross-fades (at most 165 ms); with reduced motion on, dialogs, sheets, menus and toasts are instant too; a closing menu or dialog no longer catches clicks.`
  - `FEATURES.md`: one line on interface motion and reduced motion.
  - ui-redesign design §5.3 (`:140`): "Motion is specified by [the motion design](2026-11-28-motion-design.md) (2026-11-28), which replaces this section's motion rules."
- [ ] Write; `s1-T7-docs` → exit 0, silent. Hand over the spec material.

## Waves

**1** s1-T1 L, s1-T2 M, s1-T4 S · **2** s1-T3 M · **3** s1-T5 S · **4** s1-T6 L · **5** s1-T7 S. Work norm 305 min, critical path 250 min, ratio 1.22, width 3. The chain T1 → T3 → T5 → T6 → T7 is real, so advisory NARROW_PLAN and SINGLE_SMALL_WAVE (waves 3, 5) are expected. The wave-1 verifier reruns T1, T2, T4 checks on the assembled tree and excuses only the gaps in Global Constraints.

### Segment branch checks

`pytest-full` (heavy), `npm-test`, `check-generated`, `check-sources`, `e2e-chrome` (heavy), `e2e-touched-webkit` (heavy), `visual-layout` (heavy); commands are the approved run declarations (`branchChecks`) (heavy ones start with the database script). One heavy check at a time; afterwards `docker rm -f rf-int-pg-motion`.

## Spec material for the spec-keeper

Outside the worktree; the spec-keeper writes it after s1-T7.

- `backlog.md`, "s3 inputs (fix in s3)" item 5: remove "`motion.js:62` `cap()` caps duration only, not delay/keyframes;"; `backlog-resolved.md`: "**`motion.js` `cap()` capped duration only** (s3 inputs 5): fixed before 2026-11-28, `capParams` (`motion.js:165-220`) caps delay, endDelay and keyframes; closed by motion design §4, run `run-24209be3-…` s1."
- `backlog.md`, new: "**Motion follow-ups (declined for now, owner 2026-11-28):** countdown bar on Undo toasts; swipe right to close the article on the phone; vibration on swipe commit (Android). Source: motion design §15."
- `log-decisions.md`, newest first: "## 2026-11-28 — Motion: the web UI animates through one anime.js layer. **Context:** the UI was almost still; the owner asked for feedback on every action and a lively character, through anime.js. **Decision:** one layer, `static/js/ui/motion.js`; templates declare `data-motion…`; four sequential segments, one PR each. 'Through anime.js' = anime 4.5.0's public WAAPI module (`anime.waapi.animate`, `anime.spring` + `convertEase`), no direct `Element.animate`, no anime → no animation. 'Animated counters' = a spring pop of the badge, number already final. Five engine rules. View Transitions: cross-document between screens; in-document for the three-column article and phone full-screen states; ≤ 165 ms. Owner: particles yes; Undo countdown, swipe-to-close, vibration no. **Consequences:** calls outside `motion.js` fail `check-motion-calls.mjs`; cleanliness relies on anime 4.5.0 internals pinned by the e2e 'no traces' cases (rerun on upgrade); Basecoat overlays get 0.01 ms, never `transition: none`, under reduced motion."
- `TRACKS.md`, run handoff: s1 done, next s2.

## Carry-over

- **m10** (`busy-in` on `htmx-indicator` never plays: htmx injects `.htmx-request .htmx-indicator{opacity:1; transition: opacity 200ms ease-in;}`) → s4 overrides that transition in `motion.css` and starts the preset on `htmx:beforeSend` (design: `beforeRequest`).
- **i9** settled here (Design points 4); s2 relies on it.
- Allowances and fence: s2 removes `read.js`'s, s4 the rest. Identity `scale`/`translate` transitions are filtered in the e2e helper (§6.4.3).

## Decided questions

The owner pre-approved the plan and delegated open questions to the orchestrator (2026-11-28).

- **Q1.** One transitional JS-engine call each in `read.js` (to s2) and `feeds-settings.js` (to s4).
- **Q2 (applies in s3).** No new attributes in snapshot macros: `motion.js` registry selectors attach overlays, alerts, empty states, skeletons and field errors, so the offline snapshot version stays 7. This replaces the macro defaults of design §6.2/§8.

## Verified for this plan, and limits

At `8281192`: design hash unchanged; motion/ui-read/ui-dialog node tests 30 pass; `check:sources` four `OK`; no-database pytest 100 passed; real bundle: `settlingDuration` 440/740/620/480, `s.ease(k)` within 0.012 of 1, no warning; Chrome 158: `scale: [1, 0.94, 'none']` → one `Animation`, nothing inline after `revert()`; 56 Chrome e2e tests listed; container prefix dry-run; cited lines read. Not run: checks of unwritten code, e2e/visual, full suites. No `validate_plan` here; the declarations attached to the run match the task text.

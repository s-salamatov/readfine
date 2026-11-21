# UI redesign s1 — Tailwind 4 migration Implementation Plan

Status: plan / amended 2026-11-21 (Task T7) · 2026-11-21 · run `run-7429291d-8129-432b-beab-c61fff1112cd`, segment s1

**Goal:** move the CSS build from Tailwind 3.4.19 (locked; `^3.4.17` declared) to Tailwind 4 without changing what any screen looks like. This lets later waves use CSS-variable tokens and Basecoat.

**Architecture:**
- `input.css` becomes CSS-first. It uses `@import "tailwindcss" source(none)` with explicit `@source` entries, `@plugin` for typography, and `@custom-variant dark`.
- A v3-compatibility block covers five changed defaults: border colour, ring, placeholder, button cursor and hover on touch.
- The v3 colour palette is pinned in `@theme`, so `gray-*` utilities resolve to `var(--color-gray-*)` with the same values as today.
- The custom rules in `input.css` and the inline `<style>` blocks move into `@layer utilities`, which keeps the v3 cascade order.
- Templates and JS are migrated by the official upgrade tool, run on a scratch export of the base, plus listed manual fixes. Python class strings are migrated by hand.
- Two scripts guard the result: `check-css-vars` and `check-tw4-classes`. A Playwright harness diffs the key screens of the base against the head. Regenerating `tailwind.css` is the last code task.

**Tech stack:** `tailwindcss` 4.3.5 and `@tailwindcss/cli` 4.3.5, both published 2026-11-06, which is 15 days before plan date. `@tailwindcss/typography` 0.5.20, published 2026-06-08. Node ≥ 22.22.2 (CI uses 24). `@playwright/test` 1.64.1 with Chrome `/usr/bin/google-chrome-stable`. No other new dependencies: the pixel diff decodes PNGs in the browser.

**Design:** `docs/arh-w-dev/designs/2026-11-19-ui-redesign-design.md`. The binding parts for this segment are §3 (Committed CSS, Tailwind sources, Dark mode, Online partial goldens), §5.3 (the `--color-gray-*` variable form) and §5.7 wave 1.

**Execution:** the mode persisted at workflow init for run `run-7429291d-8129-432b-beab-c61fff1112cd`.

**Probe evidence (scratch, 2026-11-21, removed afterwards):**
- `npm run build` at c81977a reproduces the committed `tailwind.css` byte for byte.
- `@tailwindcss/upgrade@4.3.5` changed 96 templates and 7 JS files.
- The tool left `rounded-t-sm` unchanged (`admin/traffic.html:165-166`) and left the selector `app.js:4224 '.flex-shrink-0.pt-2'` stale.
- The v4 default palette differs from v3, for example gray-800 is `#1e2939` against v3 `#1f2937`. Typography 0.5.20 writes its prose colours as oklch literals.
- 4.3.5 still emits `flex-shrink-*`, `rounded`, `shadow` and `outline-none`, the last one with a changed meaning. It emits nothing for `*-opacity-*`.
- `--default-ring-width` and `--default-ring-color` are honoured.
- Plain rules inside `@layer utilities` are emitted after the generated utilities.
- `@custom-variant hover (&:hover)` removes the `@media (hover:hover)` wrapper.
- Opacity utilities emit a literal fallback first, then the `var()` form inside `@supports (color:color-mix(in lab, red, red))`.

## Orchestrator decisions (2026-11-21)

- CI also runs on `selfhost` (T1), so the freshness and class checks guard this run's PRs.
- The pixel diff is local evidence (T5 pastes `test-results/visual-report/report.md` into the PR); the CI frontend job has no Postgres or Chrome, and a CI visual job is a follow-up.
- As-built project specs are written at the segment's completion stage by the spec-keeper (see T6).
- Amendment (2026-11-21): the first acceptance attempt `s1-T5.a1` gave 14/34 screens within 0.1 %. Task T7 repairs the v3 compatibility gaps it found; T5's next attempt runs after T7.

## Global Constraints

- No visual change. Acceptance: pixel diff of the key screens (1280/390, light/dark) between the base `c81977a` and the wave's build, with a threshold of 0.1 % per screen. Every remaining difference is listed in the PR.
- Sources: `@import "tailwindcss" source(none)` plus explicit `@source` entries for `backend/app/templates`, `backend/app/static/js`, `backend/app/routers/**/*.py` and `backend/app/services/**/*.py`. `@source not "./backend/app/templates/landing.html"`. Edits in `docs/` or `specs/` never change the CSS.
- Classes built in Python strings are migrated by hand: grep `routers/` and `services/` for the utilities v4 renamed or removed.
- The v3 defaults that v4 changed (border colour, ring width, placeholder colour, button cursor, hover on touch devices) are kept through a compatibility layer in `input.css`.
- A check script fails if any `gray-*` utility resolves to a literal colour. It must accept the form `var(--color-gray-*)`, including `/opacity` through `color-mix(… var(--color-gray-N) …)`.
- Committed CSS: `backend/app/static/css/tailwind.css` is committed. CI (`.github/workflows/ci.yml:76-80`) rebuilds it and fails on any diff. The build is not in Docker and stays outside it.
- Dark mode stays class-based (`.dark` on `<html>`, set by `init.js` from `localStorage.colorScheme`). The v3 `darkMode: 'class'` selector `:is(.dark *)` is preserved.
- CSP unchanged, no CDN. No `hx-on`, no inline handlers.
- Online partial goldens (`backend/tests/fixtures/partials_online/`) are regenerated in the same PR with `RF_UPDATE_GOLDENS=1`. The reviewer checks that the golden diff contains only class renames.
- New dependency versions are exact and were published at least two weeks before 2026-11-21.
- Workers: no commits, at most 5 new tests per task, stop after 3 failed approaches, out-of-scope observations go into the report as "noticed" lines.

## Review Focus

1. **JS that looks up an element by a renamed class.** `app.js:4224` runs `area.querySelector('.flex-shrink-0.pt-2')` against `chat.html:33`. The chat input lookup must keep finding its element after the rename. → T2 test `tw4-classes: legacy class in a JS selector is reported`, plus the manual fix in T2.
2. **A v3-only name left in a Python-built fragment.** The scrape errors (`settings/scrape.py:146,161,227,235`), the AI key field (`settings/ai.py:489,521`) and the catch-up spinner (`app/catchup.py:331`) must keep rendering like their template siblings. → T2 test `tw4-classes: legacy class in a Python string is reported, English prose is not`. T3 runs the check over `routers/` and `services/`.
3. **A file outside the declared sources.** An edit in `docs/`, `specs/`, the gitignored `landing.html` or a non-Python file under `routers/` must not change `tailwind.css`. → T1 test `sources: only templates, static/js and routers/services *.py are scanned`.
4. **Gray utilities in every form.** Plain, `/opacity`, `dark:` and `hover:` gray utilities, and the prose colours inside article bodies in dark mode, must resolve to `var(--color-gray-*)` so wave 2's theme remap reaches them. → T1 tests `css-vars: …` and `compat: preflight, prose colours and layering`.
5. **Hover, focus and dark states where a utility used to out-specify an inline rule.** An example is the active sidebar item under `dark:hover:`. Unlayered rules now beat every layered utility, so these states must look as they did. → T2 test `layers: inline <style> blocks and the offline mirror sit in @layer utilities`. T4's `list-hover` key screen covers it in both schemes.

## File map

One owner per file. Planned cross-task interfaces:
- T1's `package.json` scripts call T2's `scripts/check-tw4-classes.mjs` and T4's `tests/visual/run.mjs`.
- T1's `ci.yml` step calls T2's script.

| File | Task | Responsibility |
|---|---|---|
| `package.json`, `package-lock.json` | T1 | exact v4 devDependencies; scripts `build`, `dev`, `check:generated`, `check:sources`, `test:visual` |
| `input.css` | T1 | v4 entry: sources, plugin, variants, `@theme` (v3 palette, ring defaults, `chat-bounce`), compat `@layer base`, custom rules in `@layer utilities` |
| `tailwind.config.js` | T1 (delete) | replaced by `input.css` |
| `scripts/check-css-vars.mjs` | T1 | gray utilities resolve to `var(--color-gray-*)` |
| `tests/js/tailwind-build.test.mjs` | T1 | sources and compat tests on a scratch build of `input.css` |
| `tests/js/check-css-vars.test.mjs` | T1 | css-vars script tests |
| `.github/workflows/ci.yml` | T1 | frontend job: two check steps after the freshness check |
| `backend/app/templates/**/*.html` (not `landing.html`) | T2 | v4 class names; inline `<style>` in `@layer utilities` |
| `backend/app/static/js/**/*.js` (not `vendor/`, `htmx.min.js`) | T2 | v4 class names; `app.js:4224` selector; `templates.js` sidebar style mirror |
| `backend/tests/fixtures/partials_online/*.txt` | T2 | regenerated goldens |
| `scripts/check-tw4-classes.mjs` | T2 | legacy-name scan; base-relative rename count |
| `tests/js/check-tw4-classes.test.mjs`, `tests/js/tailwind-layers.test.mjs` | T2 | tests for the above and the layer wrap |
| `backend/app/routers/web/settings/ai.py`, `backend/app/routers/web/settings/scrape.py`, `backend/app/routers/web/app/catchup.py` | T3 | Python class strings |
| `playwright.visual.config.mjs`, `tests/visual/run.mjs`, `tests/visual/key-screens.spec.mjs`, `tests/visual/diff.mjs` | T4 | base-vs-head screenshot diff harness |
| `tests/js/visual-diff.test.mjs` | T4 | diff and report unit tests |
| `tests/e2e/fixtures/seed.py` | T4 | new `role <email> <role>` subcommand |
| `backend/app/static/css/tailwind.css` | T5 | regenerated (last code task) |
| `README.md`, `CLAUDE.md`, `CHANGELOG.md` | T6 | as-built docs and upgrade note |
| `input.css`, both check scripts and their tests, one `article_row.html` comment, `tests/visual/run.mjs` | T7 (amendment) | v3 compat repair after the first acceptance run; T7 is the later owner of these T1/T2/T4 files |

## Tasks

Waves: 1 → {T1, T2, T4}; 2 → {T3}; 3 → {T5} (first attempt, blocked); 4 → {T7}; 5 → {T5}; 6 → {T6}. Before T5, no task runs `npm run build` into the committed `tailwind.css`. Earlier builds go to a scratch output under `$(mktemp -d)`, or, in T7, to the worker's own worktree copy that is restored before the report.

### Task T1: Tailwind 4 toolchain and `input.css`

**Size** L · agent: worker · blocked_by: —

**Files:**
- Modify: `package.json`, `package-lock.json`, `input.css:1-3` (header; the rest gets wrapped), `.github/workflows/ci.yml:5,7` (add `selfhost`) and `:79-80` (append steps)
- Delete: `tailwind.config.js`
- Create: `scripts/check-css-vars.mjs`
- Test: `tests/js/tailwind-build.test.mjs`, `tests/js/check-css-vars.test.mjs`

**Interfaces.**

Produces:
- `input.css`. It is built by `tailwindcss -i input.css -o <out> --minify`. Its header, in order:
  - `@import "tailwindcss" source(none);`
  - `@source "./backend/app/templates";`
  - `@source not "./backend/app/templates/landing.html";`
  - `@source "./backend/app/static/js";`
  - `@source "./backend/app/routers/**/*.py";`
  - `@source "./backend/app/services/**/*.py";`
  - `@plugin "@tailwindcss/typography";`
  - `@custom-variant dark (&:is(.dark *));`
  - `@custom-variant hover (&:hover);`
- The `@theme` block:
  - v3 hex values for `--color-{gray,blue,red,green,amber,yellow,orange,purple,indigo}-{50…950}`, taken from `tailwindcss@3.4.19/lib/public/colors.js`, unpacked in scratch;
  - `--default-ring-width: 3px`;
  - `--default-ring-color: color-mix(in oklab, var(--color-blue-500) 50%, transparent)`;
  - `--animate-chat-bounce: chat-bounce 0.8s ease-in-out infinite` with `@keyframes chat-bounce` (0 %/100 % `translateY(0)`, 50 % `translateY(-4px)`).
- The `@layer base` block:
  - `*, ::after, ::before, ::backdrop, ::file-selector-button { border-color: var(--color-gray-200, currentcolor) }`;
  - `input::placeholder, textarea::placeholder { color: var(--color-gray-400) }`;
  - `button:not(:disabled), [role="button"]:not(:disabled) { cursor: pointer }`.
- The `@layer utilities` block:
  - first `.prose { … }`, which sets every `--tw-prose-*` and `--tw-prose-invert-*` variable to the `var(--color-gray-N)` (or `#fff` / `rgb(0 0 0 / 50%)`) that typography's `gray` theme used under v3;
  - then the existing custom CSS of `input.css` (from the old line 5 to the end), unchanged.
- `scripts/check-css-vars.mjs`:
  - `export function grayLiterals(css: string): { checked: number, fallbacks: number, failures: Array<{ selector: string, value: string }> }`. It works on minified v4 output.
  - A gray utility is any rule whose class (after unescaping, last variant segment) matches `/^-?[a-z-]+-gray-(50|[1-9]00|950)(\/\d+)?$/`.
  - It passes when the selector has a declaration containing `var(--color-gray-N)`, either directly or inside `@supports (color:color-mix(in lab, red, red))`.
  - A literal before an `@supports` var form counts as a fallback, not a failure.
- CLI `node scripts/check-css-vars.mjs [file]`. The default file is `backend/app/static/css/tailwind.css`.
  - Success prints `css-vars: OK — <n> gray utilities use var(--color-gray-*) (<k> with a literal @supports fallback)` and exits 0.
  - Failure prints `css-vars: FAIL — <m> of <n> gray utilities resolve to a literal colour`, then one line per failure (`  <selector> → <value>`), and exits 1.
- `package.json`:
  - devDependencies: exact `"tailwindcss": "4.3.5"`, `"@tailwindcss/cli": "4.3.5"`, `"@tailwindcss/typography": "0.5.20"`;
  - scripts: `build` and `dev` unchanged;
  - `"check:generated": "npm run build && git diff --exit-code backend/app/static/css/tailwind.css"`;
  - `"check:sources": "node scripts/check-tw4-classes.mjs && node scripts/check-css-vars.mjs"`;
  - `"test:visual": "node tests/visual/run.mjs"`.
- `ci.yml`: `on.push.branches` and `on.pull_request.branches` gain `selfhost` (today only `dev`, `master`, lines 5 and 7), so the checks run on this run's PRs. The frontend job gets two steps after "Fail if committed tailwind.css is stale":
  - `Check gray utilities use CSS variables` runs `node scripts/check-css-vars.mjs`;
  - `Check for Tailwind 3 class names` runs `node scripts/check-tw4-classes.mjs` (T2).

Steps:
- [ ] **RED:** `tests/js/tailwind-build.test.mjs`. A `before` hook builds the repo `input.css` with `node_modules/.bin/tailwindcss -i input.css -o <tmp>/tw.css --minify`. Assertions run on the output with all whitespace removed, and every needle below is normalised the same way. The needles are patterns from the probe, not byte-exact minifier output: adjust escaping to the real build, but never the asserted value.
  - `sources: only templates, static/js and routers/services *.py are scanned`. Copy `input.css` into a `mkdtemp` root and symlink `node_modules`. Write probe files:
    - `backend/app/templates/p.html` with `skew-x-[13deg]`;
    - `backend/app/templates/landing.html` with `skew-x-[17deg]`;
    - `backend/app/static/js/p.js` with `skew-x-[19deg]`;
    - `backend/app/routers/web/p.py` with `skew-x-[23deg]`;
    - `backend/app/services/p.py` with `skew-x-[29deg]`;
    - `docs/p.md` with `skew-x-[31deg]`;
    - `specs/p.md` with `skew-x-[37deg]`;
    - `backend/app/routers/p.txt` with `skew-x-[41deg]`.

    Build, then assert that 13, 19, 23 and 29 are present and 17, 31, 37 and 41 are absent.
  - `compat: palette, dark, hover, ring, keyframes`. Assert all of:
    - the output contains `--color-gray-100:#f3f4f6`, `--color-gray-800:#1f2937`, `--color-blue-500:#3b82f6` and `--color-red-600:#dc2626`;
    - `.dark\:bg-gray-800:is(.dark *)` exists;
    - there is no `@media (hover:hover){` and `.hover\:bg-gray-100:hover{` exists;
    - the rule for `.focus\:ring-2:focus` (12 uses in templates) contains `calc(2px` and `var(--color-blue-500) 50%`;
    - `@keyframes chat-bounce` and `.animate-chat-bounce{animation:var(--animate-chat-bounce)}` exist.
  - `compat: preflight, prose colours and layering`. Assert all of:
    - the output contains `border-color:var(--color-gray-200,currentcolor)`, `color:var(--color-gray-400)` on `::placeholder`, and `cursor:pointer` on `button:not(:disabled)`;
    - `.prose{` sets `--tw-prose-body:var(--color-gray-700)` after typography's own `.prose` rule;
    - `.story-chip{` appears after the last generated utility, inside `@layer utilities`.
- [ ] **RED:** `tests/js/check-css-vars.test.mjs`:
  - `css-vars: literal fails, var and @supports fallback pass`:
    - `grayLiterals('.text-gray-500{color:#6b7280}')` → `failures: [{ selector: '.text-gray-500', value: '#6b7280' }]`;
    - `grayLiterals('.bg-gray-100{background-color:var(--color-gray-100)}')` → `failures: []`, `checked: 1`;
    - `grayLiterals('.bg-gray-50\\/50{background-color:#f9fafb80}@supports (color:color-mix(in lab, red, red)){.bg-gray-50\\/50{background-color:color-mix(in oklab,var(--color-gray-50) 50%,transparent)}}')` → `failures: []`, `fallbacks: 1`.
  - `css-vars: a scratch build of input.css passes`: `grayLiterals(build)` gives `failures.length === 0` and `checked > 0`. The real count goes into the report.
- [ ] Run: `node --test tests/js/tailwind-build.test.mjs tests/js/check-css-vars.test.mjs`. Expected: `# fail 5`.
- [ ] **GREEN:** install with `npm install -D --save-exact tailwindcss@4.3.5 @tailwindcss/cli@4.3.5 @tailwindcss/typography@0.5.20`. Write the `input.css` header, `@theme`, the compat layers and the wrap, delete `tailwind.config.js`, then write `scripts/check-css-vars.mjs`, the package scripts and the `ci.yml` steps as in Produces.
- [ ] Run: `node --test tests/js/tailwind-build.test.mjs tests/js/check-css-vars.test.mjs`. Expected: `# pass 5` and `# fail 0`.
- [ ] Run: `O=$(mktemp -d) && npx tailwindcss -i input.css -o $O/tw.css --minify && node scripts/check-css-vars.mjs $O/tw.css; rm -r $O`. Expected: `css-vars: OK — …`.
- [ ] Run: `npm test`. Expected: `# fail 0`.
- [ ] Run: `git status --short backend/app/static/css/tailwind.css`. Expected: empty output (T5 owns the file).

### Task T2: Templates and JS on v4 class names

**Size** L · agent: worker · blocked_by: —

**Files:**
- Modify: `backend/app/templates/**/*.html`, `backend/app/static/js/**/*.js` (as the tool emits, except `vendor/` and `htmx.min.js`), including:
  - `templates/base.html:45-480` (the `<style>` body);
  - `templates/app/partials/sidebar.html:392-400` (the `<style>` body);
  - `templates/admin/traffic.html:165-166`;
  - `static/js/app.js:4224`;
  - `static/js/offline/templates.js:589-595` (`SIDEBAR_STYLE`).
- Modify (regenerated): `backend/tests/fixtures/partials_online/*.txt`
- Create: `scripts/check-tw4-classes.mjs`
- Test: `tests/js/check-tw4-classes.test.mjs`, `tests/js/tailwind-layers.test.mjs`

**Interfaces.**

Produces `scripts/check-tw4-classes.mjs`, which has two functions.

`export function legacyHits(files: Array<{ path: string, text: string }>): Array<{ path: string, line: number, token: string }>`:
- It scans for this regex (`u` flag):

  ```
  /(?<![\w-])(?:[\w-]+:)*!?(flex-shrink(?:-\d+)?|flex-grow(?:-\d+)?|overflow-ellipsis|decoration-(?:slice|clone)|break-words|(?:bg|text|border|divide|ring|placeholder)-opacity-\d+)!?(?![\w-])(?!\s*:)/
  ```

- It is permanent: these are the names v4 removed or deprecated. None of them collides with English.
- The trailing `(?!\s*:)` skips CSS properties such as `flex-shrink:0` in `error_bar.html:9` and `app.js:2493`.
- At c81977a the regex has 199 hits over the four roots.

`export function renameMismatches(pairs: Array<{ path: string, base: string, head: string }>): Array<{ path: string, token: string, expected: number, found: number }>`:
- It reads `class="…"` attribute values only, splits them on whitespace and keeps variant prefixes.
- The family is every token whose name (variants and `!` stripped) is in the domain or range of RENAME:
  - `shadow-sm→shadow-xs`, `shadow→shadow-sm`;
  - `drop-shadow-sm→drop-shadow-xs`, `drop-shadow→drop-shadow-sm`;
  - `blur-sm→blur-xs`, `blur→blur-sm`;
  - `backdrop-blur-sm→backdrop-blur-xs`, `backdrop-blur→backdrop-blur-sm`;
  - `rounded{,-t,-r,-b,-l,-tl,-tr,-br,-bl,-s,-e,-ss,-se,-es,-ee}-sm→…-xs`, and the bare side forms `→…-sm`;
  - `outline-none→outline-hidden`;
  - `ring→ring-3`;
  - `flex-shrink(-N)→shrink(-N)`, `flex-grow(-N)→grow(-N)`;
  - `overflow-ellipsis→text-ellipsis`;
  - `decoration-(slice|clone)→box-decoration-…`;
  - `break-words→wrap-break-word`.
- For each family token, the multiset of RENAME(base family tokens) must equal the multiset of head family tokens. Each mismatch is reported.

CLI `node scripts/check-tw4-classes.mjs [--base <rev>] [--roots templates,js,routers,services]`:
- The default roots are all four. It skips `vendor/`, `htmx.min.js` and `landing.html`.
- `--base` reads the base files with `git show <rev>:<path>`, read-only, and checks templates only.
- Output is `tw4-classes: OK (<n> files)` with exit 0, or `tw4-classes: FAIL` with exit 1. The failure lines are `<path>:<line> <token>` or `<path> <token> expected <e> found <f>`.

Steps:
- [ ] **RED:** `tests/js/check-tw4-classes.test.mjs`:
  - `tw4-classes: legacy class in a JS selector is reported`: `legacyHits([{ path: 'a.js', text: "x.querySelector('.flex-shrink-0.pt-2')" }])` → `[{ path: 'a.js', line: 1, token: 'flex-shrink-0' }]`.
  - `tw4-classes: legacy class in a Python string is reported, English prose is not`:
    - input text: `f'<svg class="w-5 animate-spin flex-shrink-0">'\n"""a score rounded to a whole number"""\nclass="rounded-full" style="flex-shrink:0"`;
    - expected: exactly one hit, line 1, `flex-shrink-0`.
  - `tw4-classes: base-relative rename counts`:
    - with `base: 'class="rounded rounded-sm shadow focus:outline-none"'`, `head: 'class="rounded-sm rounded-xs shadow-sm focus:outline-hidden"'` → `[]`;
    - with the same base and `head: 'class="rounded-sm rounded-sm shadow-sm focus:outline-hidden"'` → it includes `{ token: 'rounded-xs', expected: 1, found: 0 }`.
- [ ] **RED:** `tests/js/tailwind-layers.test.mjs`, test `layers: inline <style> blocks and the offline mirror sit in @layer utilities`:
  - the first non-blank content after `<style>` in `base.html` and in `app/partials/sidebar.html` starts with `@layer utilities {`;
  - `SIDEBAR_STYLE` in `offline/templates.js` starts with `'<style>@layer utilities{'`.
- [ ] Run: `node --test tests/js/check-tw4-classes.test.mjs tests/js/tailwind-layers.test.mjs`. Expected: `# fail 4`.
- [ ] **GREEN:** write `scripts/check-tw4-classes.mjs` as in Produces. Then run the official tool off-tree:
  1. Create `S=$(mktemp -d)`.
  2. Run `git archive c81977a | tar -x -C $S`.
  3. In `$S`: `git init -q`, `git add -A`, `git -c user.name=x -c user.email=x@x commit -qm base`, `npm ci`, `npx -y @tailwindcss/upgrade@4.3.5`.
  4. Copy back only the changed files under `backend/app/templates/` and `backend/app/static/js/`.
  5. Run `rm -r $S`.

  The arbitrary-value canonicalisations the tool emits are kept: `max-w-[52rem]→max-w-208`, `max-w-[32rem]→max-w-lg` and the like render identically.
- [ ] **GREEN (manual fixes):**
  - `admin/traffic.html:165-166`: `rounded-t-sm`→`rounded-t-xs`.
  - `app.js:4224`: `'.flex-shrink-0.pt-2'`→`'.shrink-0.pt-2'`.
  - Wrap the `<style>` bodies of `base.html` and `sidebar.html` in `@layer utilities { … }`. Wrap the `SIDEBAR_STYLE` rules in `@layer utilities{…}`, inside the same `<style>`.
  - Fix every other line that `--base` reports.
  - Regenerate the goldens: `cd backend && RF_UPDATE_GOLDENS=1 uv run pytest tests/test_partials_online_unchanged.py`.
- [ ] Run: `node --test tests/js/check-tw4-classes.test.mjs tests/js/tailwind-layers.test.mjs`. Expected: `# pass 4`.
- [ ] Run: `node scripts/check-tw4-classes.mjs --base c81977a --roots templates,js`. Expected: `tw4-classes: OK`.
- [ ] Run: `git diff --word-diff backend/app/templates backend/app/static/js | grep -oE '\[-[^]]*-\]\{\+[^}]*\+\}' | sort | uniq -c`. This covers tool edits outside `class="…"`, including every JS edit. Expected: only these kinds of pair:
  - RENAME pairs;
  - the tool's arbitrary-value canonicalisations, such as `[-max-w-[52rem]-]{+max-w-208+}`, `[-min-w-[48rem]-]{+min-w-3xl+}`, `[-min-h-[2.5rem]-]{+min-h-10+}` and `[--top-[0.5px]-]{+top-[-0.5px]+}`;
  - important-modifier moves, such as `[-!border-gray-200-]{+border-gray-200!+}`;
  - the listed manual fixes.

  Nothing else is allowed: no edits to text, ids, `hx-*` or CSS properties.
- [ ] Run: `git diff --word-diff backend/tests/fixtures/partials_online | grep -oE '\[-[^]]*-\]\{\+[^}]*\+\}' | sort | uniq -c`. Expected: only RENAME pairs, nothing else. Examples: `[-rounded-]{+rounded-sm+}`, `[-flex-shrink-0-]{+shrink-0+}`, `[-focus:outline-none-]{+focus:outline-hidden+}`.
- [ ] Run: `npm test && (cd backend && uv run pytest -q)`. Expected: `# fail 0`, then `passed` with no `failed`.

### Task T3: Python-built class strings

**Size** S · agent: worker · blocked_by: T2

**Files:**
- Modify:
  - `backend/app/routers/web/settings/ai.py:489,521` (`rounded`→`rounded-sm`);
  - `backend/app/routers/web/settings/scrape.py:146,161,227,235` (`rounded`→`rounded-sm`);
  - `backend/app/routers/web/app/catchup.py:331` (`flex-shrink-0`→`shrink-0`).

**Interfaces.**
- Consumes: the `check-tw4-classes.mjs` CLI from T2.
- Produces: none.

Steps:
- [ ] **RED:** Run `node scripts/check-tw4-classes.mjs --roots routers,services`. Expected: `tw4-classes: FAIL` and `backend/app/routers/web/app/catchup.py:331 flex-shrink-0`.
- [ ] Run this grep:

  ```
  grep -rnP '(?<![\w-])(flex-shrink(-\d+)?|flex-grow(-\d+)?|shadow(-sm)?|drop-shadow(-sm)?|blur(-sm)?|backdrop-blur(-sm)?|rounded(-[trblse]{1,2})?(-sm)?|outline-none|ring|overflow-ellipsis|decoration-(slice|clone)|break-words|(bg|text|border|divide|ring|placeholder)-opacity-\d+)(?![\w-])' backend/app/routers backend/app/services --include='*.py'
  ```

  Expected: 10 lines, namely `ai.py:489,521`, `scrape.py:146,161,227,235`, `catchup.py:331`, and the three prose comments `services/article.py:581`, `relevance_service.py:529` and `stats_service.py:119`.
- [ ] **GREEN:** make the hand edits listed under Files, and leave the three comments alone. In v4, bare `rounded` is a fixed `.25rem`, while `rounded-sm` follows `--radius-sm`, which wave 2 retokenises.
- [ ] Run: the same grep. Expected: exactly the 3 comment lines, `article.py:581`, `relevance_service.py:529` and `stats_service.py:119`.
- [ ] Run: `node scripts/check-tw4-classes.mjs`. Expected: `tw4-classes: OK`.
- [ ] Run: `cd backend && uv run pytest -q`. Expected: `passed` with no `failed`.

### Task T4: Base-vs-head key-screen diff harness

**Size** L · agent: worker · blocked_by: —

**Files:**
- Create: `playwright.visual.config.mjs`, `tests/visual/run.mjs`, `tests/visual/key-screens.spec.mjs`, `tests/visual/diff.mjs`
- Modify: `tests/e2e/fixtures/seed.py` (add a subcommand)
- Test: `tests/js/visual-diff.test.mjs`

**Interfaces.**

Produces `tests/visual/diff.mjs`:
- `export function diffRgba(a: Uint8ClampedArray, b: Uint8ClampedArray, width: number, height: number, tolerance = 3): { pixels: number, ratio: number }`. A pixel differs when any RGBA channel differs by more than `tolerance`. The function is self-contained, so the spec can evaluate it in the page through `diffRgba.toString()`.
- `export function formatReport(results: Array<{ screen: string, width: number, height: number, pixels: number, ratio: number, sizeMismatch?: boolean }>, threshold = 0.001): { lines: string[], failed: number }`:
  - Line format: `visual  <screen>  <ratio % to 4 places>  (<pixels> px)  ok|FAIL`.
  - A size mismatch counts as ratio 1.
  - The last line is `visual: <ok>/<n> screens within 0.1% (max <ratio %>)`.

Produces two changes to `seed.py`:
- a `role <email> <role>` subcommand, which sets `users.role` and prints nothing;
- `NOW` taken from `E2E_SEED_NOW` (ISO 8601) when it is set.

The rows show `formatted_date`, a clock time derived from `published_at = NOW - age_h`. Both phases must therefore seed with one shared instant, or every list shot differs. Any other volatile region T4 finds is masked through a per-screen `mask` selector list in `KEY_SCREENS` and named in the report.

Produces the key screens, in `KEY_SCREENS` in the spec:

| name | path | account |
|---|---|---|
| `login` | `/login` | anonymous |
| `list` | `/app` | alice |
| `article` | `/app?open_article_id=<articles.w1.id>` | alice |
| `catch-me-up` | `/app/catch-me-up` | alice |
| `settings-preferences` | `/settings/preferences` | alice |
| `settings-feeds` | `/settings/feeds` | alice |
| `help` | `/help` | alice |
| `admin-settings` | `/admin/settings` | alice with role `admin` |

- Every screen is captured at 1280×800 and 390×844, in light and dark: 32 shots.
- `list-hover` adds 2 shots: 1280×800, light and dark, with the mouse over the first `.article-row` and then over the first `.nav-item`, screenshot taken after the second hover.
- The colour scheme is set with `addInitScript(() => localStorage.setItem('colorScheme', 'light'|'dark'))`.
- Screenshots: viewport only, `animations: 'disabled'`, `caret: 'hide'`. They are taken after `networkidle` and `document.fonts.ready`.

Produces `playwright.visual.config.mjs`:
- chrome project only;
- `testDir: './tests/visual'`;
- reuses `tests/e2e/env.mjs`, `global-setup.mjs`, `global-teardown.mjs` and the fixture server;
- the app webServer runs on port 4251 with `cwd: path.join(process.env.RF_VISUAL_TREE, 'backend')` and `uv run --frozen uvicorn app.main:app …`. Templates and static files resolve against the cwd, so the base tree serves base templates, Python and CSS from its own `.venv`.
- No new port: the base and head phases run one after another.

Produces `tests/visual/run.mjs` (`npm run test:visual`):
1. Resolve `RF_VISUAL_BASE` (default `c81977a`) with `git rev-parse --verify`. Capture `E2E_SEED_NOW = new Date().toISOString()` once and pass it to both phases.
2. Create `T = mkdtemp(os.tmpdir()/rf-visual-)` and run `git archive <base> | tar -x -C T/tree`.
3. Run Playwright with `RF_VISUAL_SIDE=base`, `RF_VISUAL_TREE=T/tree` and `RF_VISUAL_SHOTS=T/shots`.
4. Run Playwright again with `RF_VISUAL_SIDE=head` and `RF_VISUAL_TREE=<repo root>`. The head phase decodes both PNGs in the page (canvas `getImageData`) and diffs them with `diffRgba`.
5. Write `test-results/visual-report/report.md`, with the `formatReport` lines and the diff PNG paths of screens with `pixels > 0`, and print the lines.
6. Remove `T` in `finally`. Exit 1 when `failed > 0`.

Each phase calls `seed()` from `tests/e2e/helpers.mjs` and `seed.py role alice@e2e.example admin` before logging in.

Each phase also proves that it serves its own tree:
- it fetches the stylesheet linked from `/login` and asserts that its sha256 equals the sha256 of `$RF_VISUAL_TREE/backend/app/static/css/tailwind.css`;
- it prints `visual: <side> css sha256 <first 12 hex>`.

Steps:
- [ ] **RED:** `tests/js/visual-diff.test.mjs`:
  - `diff: identical and within-tolerance pixels do not count`: two 2×2 buffers, one channel off by 3 → `{ pixels: 0, ratio: 0 }`; off by 4 → `{ pixels: 1, ratio: 0.25 }`.
  - `report: threshold, size mismatch and summary line`:
    - input `[{ screen: 'list@1280-dark', pixels: 0, ratio: 0 }, { screen: 'article@390-light', pixels: 900, ratio: 0.002 }, { screen: 'help@1280-light', sizeMismatch: true }]`;
    - expected `failed === 2`;
    - the last line is `visual: 1/3 screens within 0.1% (max 100.0000%)`.
- [ ] Run: `node --test tests/js/visual-diff.test.mjs`. Expected: `# fail 2`.
- [ ] **GREEN:** `diff.mjs`, `seed.py role`, the config, the spec and `run.mjs`, as in Produces. In the head phase, the spec also runs one test, `compat: button cursor and placeholder colour`:
  - `getComputedStyle` of `form[data-rf-login] button[type=submit]` gives `cursor` `pointer`;
  - `getComputedStyle(#email, '::placeholder').color` is `rgb(156, 163, 175)`.

  It also runs `harness: an altered shot is detected`. The test takes the base PNG of `login@1280-light`, paints a 40×40 `#ff0000` square on a canvas copy, and sends it through the same in-page decode-and-`diffRgba` path against the original. Expected: `ratio > 0.001`. This shows the pipeline does not pass by decoding blanks.
- [ ] Run: `node --test tests/js/visual-diff.test.mjs`. Expected: `# pass 2`.
- [ ] Run: `RF_VISUAL_BASE=c81977a node tests/visual/run.mjs`. It needs the dev Postgres on 127.0.0.1:4250 with the `readfine_e2e` database. In T4's worktree the head equals the base, so this proves the harness. Expected:
- both css sha256 lines are equal;
- `harness: an altered shot is detected` passes;
- `visual: 34/34 screens within 0.1% (max 0.0000%)` and exit code 0.
- [ ] Run: `npm run test:e2e -- --project=chrome`. Expected: `passed` with no `failed`, which shows the offline suite is untouched by the `seed.py` change.

### Task T5: Regenerate `tailwind.css` and accept the wave

**Size** M · agent: worker · blocked_by: T1, T2, T3, T4

**Files:**
- Modify (generated): `backend/app/static/css/tailwind.css`

**Interfaces.**
- Consumes: `npm run build`, `check:generated`, `check:sources` and `test:visual` (T1); `check-css-vars.mjs` (T1); `check-tw4-classes.mjs` (T2); the harness (T4).
- Produces: the committed v4 `tailwind.css`, and `test-results/visual-report/report.md`, which the orchestrator pastes into the PR as the list of remaining differences.

Steps:
- [ ] **RED:** Run `npm run check:generated`. Expected: a non-empty `git diff`, exit code 1, because the committed file is still v3.
- [ ] Run: `node scripts/check-css-vars.mjs`. Expected: `css-vars: FAIL — …`, because v3 writes gray utilities as literals.
- [ ] **GREEN:** Run `npm run build`. Expected: `Done in`.
- [ ] Run: `O=$(mktemp -d) && cp backend/app/static/css/tailwind.css $O/a.css && npm run build && cmp $O/a.css backend/app/static/css/tailwind.css && echo deterministic; rm -r $O`. Expected: `deterministic`.
- [ ] `npm run check:generated` compares the build against the commit, so the orchestrator verifier runs it on the applied tree. Expected there: exit code 0 and an empty diff.
- [ ] Run: `npm run check:sources`. Expected: `tw4-classes: OK` and `css-vars: OK — …`.
- [ ] Run: `npm run test:visual`. Expected:
  - the two `visual: base css sha256 …` and `visual: head css sha256 …` lines show different hashes;
  - `harness: an altered shot is detected` passes;
  - `visual: 34/34 screens within 0.1%`. Every screen with `pixels > 0` is listed in `report.md`. A screen over 0.1 % is not fixed here:
  - a compat or palette cause goes back to T1 through return-to-repair;
  - a class or cascade cause goes back to T2.
- [ ] Run: `npm test && (cd backend && uv run pytest -q) && npm run test:e2e -- --project=chrome`. Expected: `# fail 0`, then `passed` twice with no `failed`.

### Task T7: v3 compatibility repair after the first acceptance run

**Size** L · agent: worker · blocked_by: T1, T2, T3, T4

Added by amendment 2026-11-21 after attempt `s1-T5.a1`: the acceptance run gave 14/34 screens within 0.1 % (max 13.05 %). T5's declared dependencies stay as they are (its first attempt is on record); the orchestrator dispatches T5's next attempt only after T7 is completed.

**Files:**
- Modify: `input.css` (compat block), `scripts/check-css-vars.mjs`, `tests/js/tailwind-build.test.mjs`, `tests/js/check-css-vars.test.mjs`, `scripts/check-tw4-classes.mjs`, `tests/js/check-tw4-classes.test.mjs`, `backend/app/templates/app/partials/article_row.html` (one comment), `tests/visual/run.mjs`
- Do not modify: `backend/app/static/css/tailwind.css` (T5 owns it; build to a scratch file to prove the fix).

**Causes found by `s1-T5.a1`, each fixed in `input.css` so templates keep v4 names:**
1. `text-*` line height. v3 gave each font size an absolute line height (`text-xs` 1rem, `text-sm` 1.25rem, `text-base` 1.5rem, `text-lg` 1.75rem, `text-xl` 1.75rem, `text-2xl` 2rem, `text-3xl` 2.25rem, `text-4xl` 2.5rem); v4 uses a ratio, so `base.html`'s small-bucket rule that changes only `font-size` now changes row height (list@390: 69.00 → 70.41 px). Pin the v3 values with `--text-*--line-height` in `@theme`.
2. Form controls. v4 preflight sets `background-color: transparent` on `input`, `select`, `textarea`; v3 kept the UA background (white inputs, light-grey selects in light mode). Restore it in the compat `@layer base` without overriding any `bg-*` utility.
3. `space-y-*` / `space-x-*`. v3 wrote `.space-y-2>:not([hidden])~:not([hidden]){margin-top:…}`: a top margin on every child after the first, with specificity above a child's own `my-*`. v4 writes a bottom margin on every child but the last inside `:where()`, so a child with its own margin (`scope_selector.html` `<hr class="my-1">`) moves by 4 px. Restore the v3 selector, side and specificity for `space-x-*` and `space-y-*`.
4. `divide-*` changed its selector the same way in v4. Check it first as the cause of the 1 px horizontal shift of feed names in the `settings-feeds` table, and restore the v3 form if it is.
5. login@390 and help@390 differ by about 1.5 % and 3.4 % in both themes, and none of causes 1–3 obviously applies. Diagnose them from the diff images kept from `s1-T5.a1` (copied into the brief) and a computed-style probe of the base tree against this tree.

Acceptance is the outcome, not this list: any further v3/v4 difference on these screens is in scope while its fix lies in `input.css`. A cause that needs a template class change is reported with screen, ratio and class, not fixed here.

**Deferred review findings folded in:** `check-css-vars` fails on 0 gray utilities and accepts a literal only as an `@supports` fallback, and reports the colour declaration (s1T1-F1, F2, F5); `check-tw4-classes --base` verifies the revision first (s1T2-F1); the `article_row.html` comment goes back to "inset shadow" (s1T2-F3); `run.mjs` maps a child killed by a signal to exit 130 instead of the dead handlers (s1T4-N1).

Steps:
- [ ] **RED:** in `tests/js/tailwind-build.test.mjs`, `compat: v3 line heights, form backgrounds and space margins` — on the scratch build assert `.text-xs` has `line-height` resolving to `1rem` (via `--text-xs--line-height`), `input,select,textarea` have no `background-color:transparent` from preflight, and the `.space-y-2` rule's selector and declarations match the v3 rule in `git show c81977a:backend/app/static/css/tailwind.css` (`.space-y-2>:not([hidden])~:not([hidden])`, `margin-top`). In `tests/js/check-css-vars.test.mjs`, `css-vars: empty input and unfenced literal fail`. Run `node --test --test-reporter=tap tests/js/tailwind-build.test.mjs tests/js/check-css-vars.test.mjs`. Expected: `# fail 2`.
- [ ] **GREEN:** compat rules in `input.css`; script fixes. Same command. Expected: `# fail 0`.
- [ ] Run the harness against a scratch build: copy `backend/app/static/css/tailwind.css` aside, run `npm run build` inside the worker's own worktree, run `RF_VISUAL_BASE=c81977a node tests/visual/run.mjs` with `E2E_DATABASE_URL` at a throwaway database (never the shared `readfine_e2e`), then copy the saved file back so `tailwind.css` is not in the patch (workers make no git writes). Expected: `visual: 34/34 screens within 0.1%`. If a screen stays above 0.1 %, report screen, ratio and cause.
- [ ] Run: `npm test` and `node scripts/check-tw4-classes.mjs --base nosuchrev`. Expected: `# fail 0`; the second exits non-zero.

### Task T6: As-built docs

**Size** S · agent: worker · blocked_by: T5

**Files:**
- Modify:
  - `README.md:450-475` ("Requirements": Node ≥ 22.22.2 instead of 18+; "CSS build": Tailwind 4, `input.css` is the config, the sources include Python under `routers/` and `services/`, plus `npm run check:sources` and `npm run test:visual`);
  - `CLAUDE.md:51-56` ("CSS / Tailwind conventions": Tailwind 4 names; class strings in Python under `routers/` and `services/` are scanned; custom CSS goes inside `@layer utilities`);
  - `CHANGELOG.md:13` (under `[Unreleased]`).

**Interfaces.** Consumes the as-built names from T1–T5. Produces none.

Project-level specs (`/projects/readfine/specs`: TRACKS line, handoff, backlog) live outside the worktree and are updated by the orchestrator's spec-keeper at this segment's completion stage, not by this task.

Steps:
- [ ] **RED:** Run `grep -nE 'Node.js 18|tailwind.config' README.md CLAUDE.md`. Expected: at least one line (`README.md:453`).
- [ ] **GREEN:** update the three docs. The `CHANGELOG.md` `[Unreleased]` entry:
  - "Changed: stylesheet built with Tailwind CSS 4; no visual change."
  - An `### Upgrade notes` line: "If you serve your own `landing.html`, migrate its classes to Tailwind 4 names (as `landing.example.html` now uses) — its classes still come only from `landing.example.html`."
- [ ] Run: `grep -nE 'Node.js 18|tailwind.config' README.md CLAUDE.md`. Expected: no output.
- [ ] Run: `grep -n 'Tailwind CSS 4' CHANGELOG.md`. Expected: one line under `## [Unreleased]`.

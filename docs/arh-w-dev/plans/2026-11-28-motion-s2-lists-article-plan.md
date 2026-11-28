# Motion s2 — Lists, article and article actions (draft)

Status: plan / draft · 2026-11-28 · run `run-24209be3-a48b-4f12-a7a1-b7eb02530254`, segment `s2` of 4 · `native` · branch: next segment after the s1 PR merges (base to be fixed when s2 is planned in full).

Design: `docs/arh-w-dev/designs/2026-11-28-motion-design.md`, §10 point 2, with §6.3, §6.4.1, §6.6.1–6.6.2, §6.8 (double animation), §7 (rows, article, stars, counters), §9. Owner (§15): star particles **yes**; swipe right to close the article **no**; vibration **no**.

This is a task/wave draft. Exact RED/GREEN steps, commands and Phase declarations are written when s2 is planned in full, against the as-built s1.

## Коротко для владельца

Списки появляются каскадом (не больше 10 строк), строки при пометке «прочитано», архиве и удалении уходят плавно, звезда отвечает пружиной и частицами, статья открывается коротким переходом (не дольше 165 мс), счётчики «подпрыгивают» с уже готовым числом. Офлайн-снимок не меняется.

## Interfaces consumed from s1

- `RFMotion.play(name, target, opts)` → `{stop, finished} | null`; `definePreset(name, spec)`; `springs`/`springEase('snap'|'pop'|'panel')`; `activeCount()`/`idle()`; `trace` under `data-rf-motion-trace`.
- Engine rules and i9 (a stop ends all keys of that instance): `swipe-snap` must stop the press instance on the same row before it starts; press-on-star stops before `star-on`.
- `scripts/check-motion-calls.mjs` `ALLOW`: s2 removes the `read.js` transitional `.animate(` and adds the `_shellTransition` helper and its six call sites (already pre-declared by s1-T3 bounds).
- `motion.css` reduced block and closing-overlay rules; `key-screens.spec.mjs` already awaits `idle()`.

## File ownership problem

`motion.js` (~800 lines after s1) must not have two owners in one wave. Recommended: s2-T1 creates `static/js/ui/motion-presets.js` (loaded after `motion.js` in `base.html`, registers s2 presets through `RFMotion.definePreset`) and owns the shared `motion.js` changes (layer, VT wrapper, registry selectors) alone; later tasks only consume. `check-motion-calls.mjs` then treats `ui/motion-presets.js` like `ui/motion.js` (s2-T1 updates the check and its test).

## Tasks

| ID | Size | blocked_by | Goal | Files |
|---|---|---|---|---|
| s2-T1 | L | — | Layer and registry: `#rf-motion-layer` (particles), `motion-presets.js` with `list-enter` rules (navigation vs. refresh, T17-R2), exact visibility test, skeleton/load-more, replace-by-id for all swap paths (§6.4.1 items 4–6), `star-on`/`star-off` + particles with overlap check, `read-dot`, `mark-all-wave`, `count-pop`, `ai-ready`, `swipe-snap`/`swipe-commit` (`translate`, `stop`), `exit-collapse`/`flip` for rows | `ui/motion.js`, new `ui/motion-presets.js`, `scripts/check-motion-calls.mjs`, `tests/js/motion.test.mjs`, `tests/js/motion-presets.test.mjs`, new `tests/js/motion-lists.test.mjs`, `tests/js/check-motion-calls.test.mjs` |
| s2-T2 | M | — | View Transition wrapper consumers in templates: `data-motion-transition` in `main.html` (`#article-detail` at `:321`), static `<script src>` for `motion-presets.js` in `base.html` (after `:576`), `motion.css` rules for `html[data-rf-vt]` (shell names `none`, `rf-sidebar`/`rf-tab-bar` kept) | `templates/main.html`, `templates/base.html`, `styles/motion.css`, new `tests/js/motion-vt-css.test.mjs` |
| s2-T3 | L | s2-T1 | `app.js`: `_shellTransition(key, fn)` and six call sites (`:3505`, `:3520`, `:3774` mobile-detail; `:1396`/`:1406-1409` story-detail; `:1048-1051` deeplink close), key folding and reset in `RFMotion.transition`; article open via `detail.swapOverride` (`settle:0ms`, guard), veto rules (§6.6.2); inline article; star (`:2732` event), read/archive one-owner, wave, saved-removal and inline close via FLIP (`:710`, `:1477`) | `static/js/app.js`, `tests/js/app-motion.test.mjs` (new) |
| s2-T4 | M | s2-T1 | `ui/read.js`: swipe snap-back (`:249-256`) through `play('swipe-snap')`, remove the transitional `.animate(`; row clear (`:244`), mark-all wave (`mark-all-wave`, listener `:108`), skeleton (`~:190-205`) consume presets | `static/js/ui/read.js`, `tests/js/ui-read.test.mjs`, `scripts/check-motion-calls.mjs` + its test (drops the `read.js` allowance; sequential owner after s2-T1) |
| s2-T5 | S | s2-T1…T4 | Regeneration: `tailwind.css`, DOM contract (new `data-motion-transition`, layer id) | generated files |
| s2-T6 | L | s2-T5 | Browser acceptance: e2e for cascade cap, no traces after star/read/archive/swipe, VT ≤ 165 ms and veto, reduced motion still, harness layer check (`#rf-motion-layer` empty at capture); visual layout vs. s1 head | `tests/e2e/motion.spec.mjs`, `tests/e2e/read.spec.mjs`, `tests/visual/key-screens.spec.mjs` |
| s2-T7 | S | s2-T6 | As-built docs (CLAUDE.md motion block, CHANGELOG, FEATURES) and spec material | docs |

Waves: {T1, T2} → {T3, T4} → T5 → T6 → T7. Work norm ~ 90+40+90+40+15+90+15 = 380 min.

## Check outline

- Per task: `TMPDIR=/var/tmp node --test` on owned tests; `node scripts/check-motion-calls.mjs` (T1, T3, T4); scratch CSS build (T2); `npm run check:sources` and `check:generated` (T5).
- Branch: `pytest-full`, `npm test`, `check:generated`, `check:sources`, Chrome e2e, touched WebKit specs, `visual-layout` against the s1 merge commit — same container prefix and rules as the s1 plan (`rf-int-pg-motion`, `127.0.0.1:4253`, `readfine_e2e` only; never 4250 or `readfine_pytest`/`readfine_test`).
- Snapshot guard: `OFFLINE_TEMPLATE_VERSION` stays `7`, hash `6a5a389617b4977d`; no edit to the 22 closure templates (`article_row.html`, `star_icon.html`, `article_detail.html` are in it — rows and stars are bound by registry selectors).

## Risks

- `app.js` is 3951 lines; the six-site helper and swap override are the biggest regression surface (keyboard nav `:2374-2389`, `:2485` overlay checks). T3 needs focused unit tests per key and the existing e2e suite green.
- `swapOverride` + `settle:0ms` interacts with htmx 2.0.4 settle classes; veto must skip VT when a swap is already running.
- FLIP leave must not delay removal from state (invariant: no animation delays state or input).
- s2-T1 and s2-T3 exceed one L and the 5-new-tests cap; both will be split when s2 is planned in full.
- No service-worker precache list names JS files (checked: only `base.html` and `dev/ui.html` mention `motion.js`), so `motion-presets.js` needs only the `base.html` tag; re-check the offline specs anyway.
- Particles: overlap check and reduced-motion skip; layer must stay empty at rest (harness check).
- Line references above were read at `8281192`; s1 does not touch `app.js`/`read.js` except `read.js` stays as-is, so they should hold, but re-verify when planning in full.

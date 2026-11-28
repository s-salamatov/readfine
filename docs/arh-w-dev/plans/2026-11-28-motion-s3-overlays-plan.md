# Motion s3 — Panels, dialogs, menus, toasts, palette (draft)

Status: plan / draft · 2026-11-28 · run `run-24209be3-a48b-4f12-a7a1-b7eb02530254`, segment `s3` of 4 · `native` · branch: after the s2 PR merges.

Design: `docs/arh-w-dev/designs/2026-11-28-motion-design.md`, §10 point 3, with §6.2, §6.4.2 (drawer close), §6.5 (overlays), §6.7, §6.11, §7 (overlays, menus, toasts, tabs, details), §9. Owner (§15): Undo countdown bar **no**.

Task/wave draft; full steps, commands and Phase declarations come when s3 is planned against the as-built s2.

## Коротко для владельца

Панели и листы выезжают пружиной и закрываются быстро; меню, тосты, поиск, вкладки, раскрывающиеся разделы и выбор меток получают короткую анимацию; отложенное удаление показывает Undo с плавным уходом строки. Перед этапом нужно решить вопрос Q2 (см. ниже).

## Blocking decision: Q2 (from the s1 plan)

§6.2/§8 put `data-motion` defaults into the macros in `templates/ui/{overlay,display,forms,nav,readfine}.html`. Those files are in the offline snapshot closure (version `7`, hash `6a5a389617b4977d`); any edit forces version 8 and a refetch of every device's offline shell, contradicting §6.7.

- **Recommended:** bind overlays, alerts, empty states, skeletons and field errors by registry selectors in `motion-presets.js` (as s2 does for rows and stars); no closure edit.
- Alternative: one deliberate version bump in s3 (owner approval, offline e2e rerun).

The draft below assumes the recommendation.

## Interfaces consumed

- From s1: `play`, `definePreset`, `springEase('panel'|'pop')`, `activeCount`/`idle`, `trace`; `motion.css` closing-overlay `pointer-events: none` and token exits; reduced-motion 0.01 ms block (Basecoat waits for `transitionend`, so never `transition: none`).
- From s2: `motion-presets.js` registry and selector binding; FLIP leave helper; `#rf-motion-layer`.
- i9: closing a panel stops its own `panel-in` instance (all keys) before its exit; the phone sidebar's `visibility` exception (rule 3) is the only non-rest last frame.

## Tasks

| ID | Size | blocked_by | Goal | Files |
|---|---|---|---|---|
| s3-T1 | L | — | Presets `panel-in`, `menu-in`, `toast-in`, `exit-fade`/`exit-collapse` (exits otherwise in CSS on tokens), palette, tabs indicator, `<details>` fold, tag picker, phone sidebar (`transform`/`visibility` exception), registry selectors for overlays (Q2) | `ui/motion-presets.js`, `tests/js/motion-presets.test.mjs`, new `tests/js/motion-overlays.test.mjs` |
| s3-T2 | M | — | CSS side of the native drawer close (§6.4.2): `.drawer:not([open])` exit with `transition-behavior: allow-discrete` on `display`/`overlay`, `--t-fast-max`; toast/popover/menu exits on tokens | `styles/motion.css`, `tests/js/motion-css.test.mjs` |
| s3-T3 | M | s3-T1 | `ui/dialog.js`: after `basecoat:initialized` replace each `.drawer`'s `close` with native `HTMLDialogElement.prototype.close` (today Basecoat holds input ~550 ms, a live budget violation; vendor file untouched); open/close hooks call presets; `data-rf-close` keeps `dialog.close()` so Basecoat transitions run; sidebar watcher (`basecoat:initialized` capture listener `:211`) unchanged in behaviour; focus return untouched | `static/js/ui/dialog.js`, `tests/js/ui-dialog.test.mjs` |
| s3-T4 | M | s3-T1 | `ui/pending.js` deferred delete: FLIP row leave (`hideRow` `:124`) and Undo restore (click listener `:351`), no countdown; `ui/toast.js`, `ui/palette.js`, `ui/shell.js` (offline banner, sign-out modal), admin sidebar consume presets | `static/js/ui/pending.js`, `static/js/ui/toast.js`, `static/js/ui/palette.js`, `static/js/ui/shell.js`, their tests |
| s3-T5 | S | s3-T1…T4 | Regeneration (`tailwind.css`, DOM contract) | generated files |
| s3-T6 | L | s3-T5 | e2e: closing overlay lets clicks through at once (all overlay kinds), Undo restores the row with no trace, reduced motion keeps overlays working; visual layout vs. s2 head | `tests/e2e/motion.spec.mjs`, overlay specs, `tests/visual/key-screens.spec.mjs` |
| s3-T7 | S | s3-T6 | As-built docs and spec material (close backlog "s3 inputs" items now covered: `nav.html` breakpoint, toast `onclick` if fixed) | docs |

Waves: {T1, T2} → {T3, T4} → T5 → T6 → T7.

## Check outline

Node tests per owned file; `check-motion-calls.mjs` (T1, T3, T4); scratch CSS build (T2); `check:sources`/`check:generated` (T5); branch checks as in s1 (container `rf-int-pg-motion` on `127.0.0.1:4253`, `readfine_e2e`; never 4250 or `readfine_pytest`/`readfine_test`). Snapshot guard: version `7`, hash unchanged (unless Q2 alternative chosen).

## Risks

- Basecoat 1.1.0 drives `aria-hidden`/`open` itself; presets must not fight its transitions (double animation) — the 0.01 ms rule and `pointer-events` from s1 are the safety net.
- Drawer close timing change touches every sheet; e2e must cover Escape, backdrop and `data-rf-close` paths.
- Toast `onclick` in the backlog item (CSP) is out of scope unless the owner folds it in.
- Line references read at `8281192`; re-verify after s2.

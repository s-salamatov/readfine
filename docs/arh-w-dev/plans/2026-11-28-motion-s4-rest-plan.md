# Motion s4 — Settings, assistant, sign-in, loading states (draft)

Status: plan / draft · 2026-11-28 · run `run-24209be3-a48b-4f12-a7a1-b7eb02530254`, segment `s4` of 4 · `native` · branch: after the s3 PR merges.

Design: `docs/arh-w-dev/designs/2026-11-28-motion-design.md`, §10 point 4, with §6.3, §7 (settings, sources, assistant, auth, indicators, skeletons, admin), §9. Carry-over m10 is owned here.

Task/wave draft; full steps, commands and Phase declarations come when s4 is planned against the as-built s3.

## Коротко для владельца

Сохранение настройки коротко подсвечивается, откат — заметно «отскакивает»; ошибки форм, подсказки и липкая панель появляются плавно; ассистент и Catch me up показывают ответ с короткой анимацией; вход и регистрация получают мягкое появление; индикаторы загрузки наконец действительно проявляются. В конце убирается старый путь `RFMotion.animate`, и вся анимация идёт через один слой.

## Interfaces consumed

- From s1: `play`, `definePreset`, `springEase`, `activeCount`/`idle`, `trace`; `check-motion-calls.mjs` with the `feeds-settings.js` transitional allowance and the `// rf-motion:legacy-animate` fence in `motion.js`.
- From s2/s3: `motion-presets.js` registry selectors (Q2 approach for field errors, empty states, skeletons).
- i9: `flash` on a settings row stops the row's press instance first.

## Tasks

| ID | Size | blocked_by | Goal | Files |
|---|---|---|---|---|
| s4-T1 | M | — | Presets: `flash`, `revert`, `confirm`, `attention`, `busy-in` and its `htmx:beforeSend` listener (m10, JS side), field-error, hint, sticky bar, greeting, assistant reply, auth entrance; registry selectors | `ui/motion-presets.js`, `tests/js/motion-presets.test.mjs`, new `tests/js/motion-rest.test.mjs` |
| s4-T2 | M | — | m10: `busy-in` never plays because htmx 2.0.4 injects `.htmx-request .htmx-indicator{opacity:1; transition: opacity 200ms ease-in;}` (`includeIndicatorStyles: true`) and rule 3 skips during a CSS opacity transition. `motion.css` overrides that transition for `.htmx-indicator` (higher specificity, not `transition: none` on overlays); the preset (s4-T1) starts on `htmx:beforeSend` (the design says `beforeRequest`, but the class is added before `beforeSend` fires) | `styles/motion.css`, `tests/js/motion-css.test.mjs` |
| s4-T3 | M | s4-T1 | `ui/settings.js`: save confirmation and `rf:settingreverted` after `restore()` (`:63`; callers `:116`, `:146`; event dispatch `:101`) play presets; relevance hints | `static/js/ui/settings.js`, `tests/js/ui-settings.test.mjs` |
| s4-T4 | S | s4-T1 | `feeds-settings.js:60-66`: `RFMotion.animate` → `RFMotion.play('flash', row)`; source sheet consumers | `static/js/feeds-settings.js`, new `tests/js/feeds-settings.test.mjs` (none exists today) |
| s4-T5 | M | s4-T1 | `ui/assistant.js` (reduced check `:217` stays as text fallback) and Catch me up; auth templates entrance via selectors (no closure edit); admin consumers | `static/js/ui/assistant.js`, `static/js/ui/admin.js`, tests |
| s4-T6 | M | s4-T3, s4-T4, s4-T5 | Remove the legacy path: delete the fence in `motion.js` (`TIMING_KEYS`, cap helpers, `TRANSFORMS`, `RFMotion.animate`, `RFMotion.stagger`) and their tests; `check-motion-calls.mjs` drops the fence exemption and the `feeds-settings.js` allowance | `ui/motion.js`, `tests/js/motion.test.mjs`, `scripts/check-motion-calls.mjs`, `tests/js/check-motion-calls.test.mjs` |
| s4-T7 | S | s4-T2, s4-T6 | Regeneration (`tailwind.css`, DOM contract) | generated files |
| s4-T8 | L | s4-T7 | e2e: indicator becomes visible under load (m10), setting revert visible, no traces, reduced motion still; final §7 inventory check by `trace` over the key screens; visual layout vs. s3 head | `tests/e2e/motion.spec.mjs`, settings/assistant specs, `tests/visual/key-screens.spec.mjs` |
| s4-T9 | S | s4-T8 | As-built docs (CLAUDE.md motion block without transitional notes), CHANGELOG, FEATURES; spec material (close motion track) | docs |

Waves: {T1, T2} → {T3, T4, T5} → T6 → T7 → T8 → T9.

## Check outline

Node tests per owned file; `check-motion-calls.mjs` after T4 and T6 (must stay green: allowance removed only together with the call); `check:sources`/`check:generated` (T7); branch checks as in s1 (container `rf-int-pg-motion`, `127.0.0.1:4253`, `readfine_e2e`; never 4250 or `readfine_pytest`/`readfine_test`). `RFMotion.tokens` keeps its five keys.

## Risks

- s4-T1 may exceed the 5-new-tests cap; split when s4 is planned in full.
- Removing `RFMotion.animate`/`stagger` breaks any remaining caller; the call check plus a repo-wide grep in T6 guard it.
- The `.htmx-indicator` override must not change resting appearance (indicator hidden at rest) — visual check.
- 20 templates use `htmx-indicator`; e2e must sample at least sources, settings and assistant.
- Line references read at `8281192`; re-verify after s3.

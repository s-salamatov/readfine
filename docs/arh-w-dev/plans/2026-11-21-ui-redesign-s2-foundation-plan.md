# UI redesign s2 — Foundation Implementation Plan

Status: plan / draft (task/wave level, to be detailed before the segment starts) · 2026-11-21 · run `run-7429291d`

**Goal:** the shared design system, motion layer and safety rails that every zone wave builds on; visible result is new colours and fonts with no layout change.

**Architecture:** shadcn tokens per app theme in `input.css` with a `--color-gray-*` remap; Basecoat CSS imported, Basecoat JS and anime.js vendored by a build script; Jinja macros in `templates/ui/`; `static/js/ui/motion.js`; CI guards (DOM contract, offline drift harness, colour lint, inline-handler check, template-version bump test); moved-pages helper.

**Tech stack:** Tailwind 4, `basecoat-css` 1.1.0, anime.js 4, Jinja2, pytest, `node --test`, Playwright.

**Design:** §5.3, §5.4 (moved pages, Basecoat and CSP), §5.5, §5.7 wave 2.

**Execution:** as persisted at workflow init.

## Global Constraints

- Themes Neutral (default), Paper, Graphite, each light and dark; selection per device in `localStorage` (`colorScheme`, `appTheme`); no migration.
- Motion tokens 125 / 165 / 300 / 400 / 700 ms; everything instant under `prefers-reduced-motion: reduce`.
- Fonts Geist and Source Serif 4, latin-subset woff2, under 200 KB total, `font-display: swap`, via `@font-face` in `input.css`.
- No inline event handler attribute in templates; no hex/`rgb()` literal outside the token file except the listed offline page.
- Every change to snapshot-rendered output bumps `OFFLINE_TEMPLATE_VERSION`.
- Vendored files committed, covered by the CI freshness check; loaded with static `<script src>` (shell cache discovery).

## Review Focus (to be pinned in the detailed plan)

- An old screen under Paper / Graphite dark shows no light-grey patch from a leftover hex colour.
- `theme-color` meta follows the active theme on iOS.
- A Basecoat dialog opens without any inline `onclick`.
- A runtime-built id (`article-row-<id>`) passes the contract check as a prefix.
- A partial changed without a `templates.js` update fails the drift test in CI.

## File map (draft)

| File | Task |
|---|---|
| `input.css` (tokens, themes, gray remap, fonts, Basecoat import), `backend/app/static/fonts/*` | S2-T1 |
| `backend/app/static/js/init.js`, `preferences.js`, `backend/app/templates/base.html` (inline style → tokens, theme bootstrap) | S2-T2 |
| `scripts/vendor-assets.mjs`, `package.json`, `backend/app/static/js/vendor/basecoat/*`, `vendor/anime/*` | S2-T3 |
| `backend/app/templates/ui/*.html`, `ui/dialog.js`, `/dev/ui` gallery route | S2-T4 |
| `backend/app/static/js/ui/motion.js` | S2-T5 |
| `docs/ui-dom-contract.md`, `scripts/check-dom-contract.mjs` | S2-T6 |
| `backend/tests/test_offline_drift.py`, `backend/tests/fixtures/offline_drift/*`, `tests/js/offline-drift.test.mjs`, `tests/js/offline-drift/adapters.mjs` | S2-T7 |
| `backend/tests/test_offline_template_version.py`, `backend/app/services/sync/__init__.py` | S2-T8 |
| `backend/app/routers/web/moved_pages.py` (helper + table), its test | S2-T9 |
| `scripts/lint-colours.mjs`, `scripts/check-inline-handlers.mjs`, `.github/workflows/ci.yml` | S2-T10 |
| admin, auth and public templates re-tokened through macros | S2-T11 |
| `backend/app/static/css/tailwind.css`, vendored copies (regenerated) | S2-T12 |
| specs | S2-T13 |

## Tasks (draft)

| ID | Size | blocked_by | Deliverable |
|---|---|---|---|
| S2-T1 | M | — | Tokens and three themes, gray remap, fonts, Basecoat CSS import |
| S2-T2 | M | T1 | Theme bootstrap with `appTheme`, hex colours of `base.html`/`showToast`/`theme-color` moved to tokens |
| S2-T3 | S | — | Vendor script and vendored Basecoat JS + anime.js |
| S2-T4 | L | T1, T3 | `templates/ui/` macros (button … empty state, article row, feed icon, score badge, health dot), `ui/dialog.js` with `data-rf-open`, DEBUG-only `/dev/ui` gallery |
| S2-T5 | M | T3 | `motion.js`: tokens, reduced-motion guard, `data-motion` enter animations, View Transition wrapper with `skipTransition` and CSS reduced-motion rules |
| S2-T6 | M | — | DOM contract file and check with prefix patterns and rendered-page coverage |
| S2-T7 | L | — | Offline drift harness (pytest half, node half, adapters, normalisation) |
| S2-T8 | S | — | Template-version bump test over the snapshot template closure and `row_render_context` |
| S2-T9 | S | — | Moved-pages helper: 308 + `no-store` for GET, non-GET aliases, table-driven test |
| S2-T10 | S | T2 | Colour lint and inline-handler check in CI |
| S2-T11 | M | T4 | Admin, auth and public pages re-tokened |
| S2-T12 | S | all code tasks | Regenerated CSS and vendored files |
| S2-T13 | S | T12 | Specs |

Waves: 1 → {T1, T3, T6, T7, T8, T9}; 2 → {T2, T4, T5}; 3 → {T10, T11}; 4 → {T12}; 5 → {T13}.

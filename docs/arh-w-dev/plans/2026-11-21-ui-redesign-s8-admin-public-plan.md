# UI redesign s8 — Admin and public pages Implementation Plan

Status: plan / draft (task/wave level, to be detailed before the segment starts) · 2026-11-21 · run `run-7429291d`

**Goal:** full redesign of admin pages and public pages (landing, features, changelog, help, legal) in the new system; removal of the non-GET aliases of moved pages.

**Architecture:** admin templates rebuilt from macros, admin JS moved into `static/js/ui/admin.js`; public pages share a public layout; `landing.example.html` updated (the live `landing.html` is a per-instance copy); alias routes removed with a test that old non-GET paths now answer 404.

**Tech stack:** Jinja2, HTMX, Basecoat, FastAPI, pytest, Playwright.

**Design:** §5.2 (admin and public), §5.4 (moved pages), §5.7 wave 8.

**Execution:** as persisted at workflow init.

## Global Constraints

- Last segment; depends on s1–s7.
- Admin features unchanged; only presentation.
- After this segment `app.js` holds no zone code (only bootstrap), or the remainder is listed as a follow-up.

## Review Focus (to be pinned in the detailed plan)

- Public pages render without login and without app JS.
- The admin traffic chart reads in dark mode.
- Landing customisations on an instance survive (example vs live copy).
- Old non-GET aliases are gone and GET redirects still work.
- Legal pages print/scroll correctly on the phone.

## Tasks (draft)

| ID | Size | blocked_by | Deliverable |
|---|---|---|---|
| S8-T1 | L | — | Admin pages redesign, `ui/admin.js` |
| S8-T2 | M | — | Public layout, landing.example, features, changelog, help, legal |
| S8-T3 | S | — | Remove non-GET aliases, tests |
| S8-T4 | S | T1–T3 | Final app.js cleanup check, contract, CSS |
| S8-T5 | S | T4 | Specs, backlog item "Redesign UI and animations" closed, i18n stays in backlog |

Waves: 1 → {T1, T2, T3}; 2 → {T4}; 3 → {T5}.

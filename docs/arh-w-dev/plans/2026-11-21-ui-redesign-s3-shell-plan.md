# UI redesign s3 — Shell and navigation Implementation Plan

Status: plan / draft (task/wave level, to be detailed before the segment starts) · 2026-11-21 · run `run-7429291d`

**Goal:** the new frame of the app: sidebar with the four zones, "+" add source, ⌘K palette, account menu, phone tab bar, shortcuts sheet, toasts and the shared delayed-delete machinery.

**Architecture:** sidebar and shell partials rebuilt from `ui/` macros, mirrored in `offline/templates.js` in the same PR; palette as a GET partial plus static actions; `showToast` on Basecoat's toaster with JSON `HX-Trigger` parsing; `ui/pending.js` and the `POST /settings/deletes` batch route used later by waves 5 and 7. Shell code moves from `app.js` into `static/js/ui/shell.js`.

**Tech stack:** Jinja2, HTMX 2.0.4, Basecoat, FastAPI, pytest, `node --test`, Playwright.

**Design:** §5.1, §5.2 (shell, palette), §5.4 (toasts, delayed delete), §5.7 wave 3.

**Execution:** as persisted at workflow init.

## Global Constraints

- Phone tab bar: Feed · Search · Add · Assistant · Folders.
- All of today's keyboard shortcuts keep working; ⌘K / Ctrl+K and `/` open the palette; the shortcuts sheet lists them.
- `showToast` stays the only toast event name; values with user text built with `json.dumps`.
- Delayed delete: 10 s window; flush on timer, boosted navigation, `htmx:beforeHistorySave`, `visibilitychange` hidden, `beforeunload`; one keepalive batch with `x-csrftoken`; per-user `pg_advisory_xact_lock`; per-item results; sent keys kept in `sessionStorage` (`rf.deletedKeys`, 2 min).
- `sidebar.html` and its `templates.js` mirror change together; drift test green.

## Review Focus (to be pinned in the detailed plan)

- Back/forward right after a delete does not show the deleted row.
- Two deletes pending when the tab closes both reach the server in one request.
- An expired session during a flush is reported as a failure, not success.
- The palette with no results and with a server error shows a clear state.
- Focus is trapped in the palette and sheets and returns on close.

## File map (draft)

| File | Task |
|---|---|
| `templates/app/partials/sidebar.html`, `user_menu_items.html`, `base.html` shell parts | S3-T1 |
| `static/js/offline/templates.js` (sidebar mirror), drift fixtures | S3-T1 |
| `templates/app/partials/palette.html`, palette route, `static/js/ui/palette.js` | S3-T2 |
| `templates/app/partials/tabbar.html`, `static/js/ui/shell.js`, app.js shell code removed | S3-T3 |
| `templates/app/partials/shortcuts.html`, keyboard map, `tests/js/keyboard-shortcuts.test.mjs` | S3-T4 |
| `static/js/ui/toast.js`, `app.js` `showToast` + trigger parsing | S3-T5 |
| `static/js/ui/pending.js`, `routers/web/settings/deletes.py`, `main.py` 401 branch, tests | S3-T6 |
| `docs/ui-dom-contract.md` updates, CSS regeneration | S3-T7 |
| specs | S3-T8 |

## Tasks (draft)

| ID | Size | blocked_by | Deliverable |
|---|---|---|---|
| S3-T1 | L | — | New sidebar (zones, "+", search entry, account menu with theme / app theme / offline) and its offline mirror |
| S3-T2 | M | — | Command palette (GET partial, static actions, debounce) |
| S3-T3 | M | T1 | Phone tab bar and sidebar sheet; shell code moved to `ui/shell.js` |
| S3-T4 | S | T2 | Shortcuts sheet with ⌘K, keyboard test kept green |
| S3-T5 | S | — | `showToast` on Basecoat toaster, JSON trigger parsing, list of notices |
| S3-T6 | L | T5 | `pending.js` and `POST /settings/deletes` batch route with lock and per-item results |
| S3-T7 | S | T1–T6 | Contract updates, regenerated CSS |
| S3-T8 | S | T7 | Specs |

Waves: 1 → {T1, T2, T5}; 2 → {T3, T4, T6}; 3 → {T7}; 4 → {T8}.

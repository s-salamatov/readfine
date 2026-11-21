# UI redesign s4 — Read zone Implementation Plan

Status: plan / draft (task/wave level, to be detailed before the segment starts) · 2026-11-21 · run `run-7429291d`

**Goal:** the list and article as designed: View menu, chips, skeletons, swipe, story clusters, article toolbar, AI panel (Summary / Context / Ask), progress, phone full-screen article, mark-all with Undo, restyled offline banner and pages.

**Architecture:** list and article partials rebuilt from macros, mirrored in `templates.js` and the snapshot templates (`OFFLINE_TEMPLATE_VERSION` bumped); mark-all routes return a stamp; `undo_scope_read` service and `POST /htmx/articles/mark-read/undo`; read-zone code moves from `app.js` into `static/js/ui/read.js`.

**Tech stack:** Jinja2, HTMX, Basecoat, anime.js via `motion.js`, SQLAlchemy async, pytest, Playwright.

**Design:** §5.2 (list, article), §5.4 (mark-all undo), §5.5 (offline pages, snapshots), §5.7 wave 4.

**Execution:** as persisted at workflow init.

## Global Constraints

- `mark_scope_read` and `mark_saved_search_read` return `(stamp, count)`; `ops.py:444` updated.
- Mark-all `HX-Trigger`: `{"sidebarRefresh": true, "rf:markedall": {"stamp": "<ISO µs>", "count": N}}`; the stamp is opaque on the client.
- Undo: one `UPDATE … WHERE user_id=:user AND read_at=:stamp AND suppressed_by='bulk' AND is_read=true`; stamps older than 10 minutes rejected; idempotent; empty body + `sidebarRefresh` + `showToast`.
- Offline mark-all toast has no Undo; undo while the connection dropped reports "Couldn't undo while offline".
- Online partial goldens regenerated in the same PR; `OFFLINE_TEMPLATE_VERSION` bumped; drift test green.
- Swipe: right = star, left = read; works with touch emulation; off under reduced motion only for the animation, not the action.

## Review Focus (to be pinned in the detailed plan)

- Another user's rows with the same stamp stay read after an undo.
- An article read properly after mark-all stays read after the undo.
- The article page without JS is readable and its actions work as today.
- A device with old snapshots shows the new markup after one sync.
- Keyboard j/k/s/m/v on the new list behave as today.

## File map (draft)

| File | Task |
|---|---|
| `services/article.py` (`mark_scope_read`, `undo_scope_read`), `services/saved_search_service.py`, `services/ops.py` | S4-T1 |
| `routers/web/app/shell.py`, `saved_searches.py`, undo route, tests | S4-T2 |
| list partials (`article_list*.html`, `article_row.html`, badges, story blocks), View menu | S4-T3 |
| article partials (`article_detail.html`, `ai_blocks.html`, toolbar) | S4-T4 |
| `static/js/ui/read.js` (swipe, progress, undo toast, mark-all), app.js read code removed | S4-T5 |
| `static/js/offline/templates.js`, drift fixtures, `services/sync/__init__.py` version bump, online goldens | S4-T6 |
| offline banner and diagnostics templates | S4-T7 |
| contract updates, regenerated CSS | S4-T8 |
| specs | S4-T9 |

## Tasks (draft)

| ID | Size | blocked_by | Deliverable |
|---|---|---|---|
| S4-T1 | M | — | Stamp + count from mark-all services; `undo_scope_read` |
| S4-T2 | M | T1 | JSON triggers on all mark-all routes; undo route |
| S4-T3 | L | — | List redesign |
| S4-T4 | L | — | Article redesign with AI panel |
| S4-T5 | L | T2, T3, T4 | `ui/read.js` |
| S4-T6 | M | T3, T4 | Offline mirror, goldens, template version |
| S4-T7 | S | — | Offline banner and diagnostics |
| S4-T8 | S | T5, T6, T7 | Contract and CSS |
| S4-T9 | S | T8 | Specs |

Waves: 1 → {T1, T3, T4, T7}; 2 → {T2, T6}; 3 → {T5}; 4 → {T8}; 5 → {T9}.

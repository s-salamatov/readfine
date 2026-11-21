# UI redesign s7 — Settings zone Implementation Plan

Status: plan / draft (task/wave level, to be detailed before the segment starts) · 2026-11-21 · run `run-7429291d`

**Goal:** regrouped Settings (Reading & appearance, Relevance & filters, Labels, AI provider, Account, Stats) with a sub-navigation, immediate-save toggles, delayed delete for labels and filters.

**Architecture:** pages rebuilt from macros; old paths through the moved-pages helper; offline settings section keeps `[data-rf-offline-settings]` and `#offline-diagnostics`, `offline/page.js:1277` pointed at the new URL; label and filter delete use `pending.js`.

**Tech stack:** Jinja2, HTMX, Basecoat, FastAPI, pytest, Playwright.

**Design:** §5.1 (regrouping table), §5.2 (Settings), §5.4, §5.7 wave 7.

**Execution:** as persisted at workflow init.

## Global Constraints

- Every setting available today stays reachable; mapping as in the design's regrouping table.
- Immediate-save toggles confirm with a toast; forms that need it get a sticky save.
- Label delete shows "Turned off N filters" when it applies.
- Depends on s1–s3 only.

## Review Focus (to be pinned in the detailed plan)

- The offline status long-press opens diagnostics at the new URL.
- An immediate-save toggle that fails restores its previous state and says so.
- `/settings` index redirects to the first page the user can see.
- Tokens page: a newly created token is shown once and copyable.
- Settings sub-navigation becomes tabs at 390 px without overflow.

## Tasks (draft)

| ID | Size | blocked_by | Deliverable |
|---|---|---|---|
| S7-T1 | M | — | Settings layout and sub-navigation, index redirect |
| S7-T2 | L | T1 | Reading & appearance (incl. This device / offline) and Relevance & filters |
| S7-T3 | M | T1 | Labels, AI provider, Account (profile + tokens), Stats |
| S7-T4 | M | T2, T3 | Delayed delete for labels and filters; inline confirm removed |
| S7-T5 | S | T2, T3 | Moved pages, `page.js` diagnostics link, redirect tests |
| S7-T6 | S | T4, T5 | Contract, CSS |
| S7-T7 | S | T6 | Specs |

Waves: 1 → {T1}; 2 → {T2, T3}; 3 → {T4, T5}; 4 → {T6}; 5 → {T7}.

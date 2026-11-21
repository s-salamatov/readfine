# UI redesign s6 — Assistant zone Implementation Plan

Status: plan / draft (task/wave level, to be detailed before the segment starts) · 2026-11-21 · run `run-7429291d`

**Goal:** one Assistant page: chat with a scope switch (this article, feed or folder, everything), Catch me up, briefing schedules and the interest profile.

**Architecture:** existing routes reused (`ai.py` chat 303/413, `catchup.py:37`, briefing configs `catchup.py:654/696/808`); `briefing_modal.html` becomes a sheet; interest profile moves from the AI settings page; old paths through the moved-pages helper; zone code in `static/js/ui/assistant.js`.

**Tech stack:** Jinja2, HTMX, Basecoat, FastAPI, pytest, Playwright.

**Design:** §5.1, §5.2 (Assistant), §5.7 wave 6.

**Execution:** as persisted at workflow init.

## Global Constraints

- No new AI behaviour; only presentation and routing.
- Ask from an article opens chat scoped to that article (wired in s4, page here).
- Depends on s1–s3 only.

## Review Focus (to be pinned in the detailed plan)

- Switching scope mid-conversation starts a clearly new thread, not a mixed one.
- Chat streaming/polling still works under the new layout on the phone.
- A briefing schedule saved in the sheet appears in the list without reload.
- `/app/catch-me-up` bookmarks still open Catch me up.
- AI provider not configured: the page explains what to set up.

## Tasks (draft)

| ID | Size | blocked_by | Deliverable |
|---|---|---|---|
| S6-T1 | L | — | Assistant page with chat and scope switch |
| S6-T2 | M | — | Catch me up and briefing schedules on the page, briefing sheet |
| S6-T3 | S | — | Interest profile section |
| S6-T4 | S | T1–T3 | Moved pages, `ui/assistant.js`, app.js chat code removed |
| S6-T5 | S | T4 | Contract, CSS |
| S6-T6 | S | T5 | Specs |

Waves: 1 → {T1, T2, T3}; 2 → {T4}; 3 → {T5}; 4 → {T6}.

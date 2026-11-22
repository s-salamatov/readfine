# UI redesign s5 — Sources zone Implementation Plan

Status: plan / draft (task/wave level, to be detailed before the segment starts) · 2026-11-21 · run `run-7429291d`

**Goal:** a Sources zone: add-source sheet with discovery, feeds table grouped by folder with health, folder editing, feed edit, OPML and scraping setup as sheets, delayed delete for feeds.

**Architecture:** new pages under the Sources zone built from macros; old `/settings/feeds*`, `/settings/folders*`, `/settings/opml*` paths go through the moved-pages helper (308 + `no-store` for GET, non-GET aliases); feed delete uses `pending.js`; hard-coded redirect targets (`feeds.py:459`, `filters.py:170`) moved.

**Tech stack:** Jinja2, HTMX, Basecoat, FastAPI, pytest, Playwright.

**Design:** §5.1, §5.2 (add source, Sources), §5.4 (delayed delete, moved pages), §5.7 wave 5.

**Execution:** as persisted at workflow init.

## Global Constraints

- Discovery uses the existing `POST /settings/feeds/test` (`detect_feeds`); captcha and other errors explained inline.
- Two-click inline confirmation removed for feeds; cleanup notices (filters deactivated, briefings disabled, saved searches emptied) shown as toasts.
- Depends on s1–s3 only.

## Review Focus (to be pinned in the detailed plan)

- An address with credentials in the URL is split the same way the test route splits it.
- A bookmark to `/settings/feeds` lands on the new page.
- A form posted from a stale tab to an old path still works.
- Unsubscribing a feed that is a filter's only scope shows the deactivation notice.
- The feeds table at 390 px scrolls inside its container, not the page.

## Tasks (draft)

| ID | Size | blocked_by | Deliverable |
|---|---|---|---|
| S5-T1 | M | — | Add-source sheet with discovery, folder and Advanced auth fields |
| S5-T2 | L | — | Feeds table with folders, health, unread, last fetch, per-feed menu, inline folder rename/move |
| S5-T3 | M | — | Feed edit, OPML and scraping setup as sheets |
| S5-T4 | M | T2 | Delayed delete for feeds; removal of inline confirm; notices |
| S5-T5 | S | T1–T3 | Moved-page entries, hard-coded targets, redirect tests |
| S5-T6 | S | T4, T5 | Contract and CSS |
| S5-T7 | S | T6 | Specs |

Waves: 1 → {T1, T2, T3}; 2 → {T4, T5}; 3 → {T6}; 4 → {T7}.

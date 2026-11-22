"""Admin pages II rebuilt from the ui/ macros (s2-T24, owner decision Q5).

Feeds, users, invitations, the audit and fetch logs and the scoring eval render
through card, badge, button, field + input / select / switch, alert, empty_state and
dialog, draw their colours from the theme tokens, and keep the contract app.js,
admin-feeds.js and the htmx routes rely on: ids, names, data-*, hx-* and the visible
English strings. The row menus keep app.js's [data-menu-toggle] / [data-menu] (fixed
position, so a table's overflow does not clip them) and the two-click .swap-confirm.
"""
import re
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from bs4 import BeautifulSoup

from app.templating import templates
from tests.test_csp import _INLINE_HANDLER
from tests.test_restyle_auth_pages import COLOUR_LITERAL, LEGACY_PALETTE, _render

TEMPLATES = Path(__file__).resolve().parents[1] / "app" / "templates"
NOW = datetime(2026, 11, 20, 9, 30, tzinfo=timezone.utc)

SOURCES = [
    "admin/feeds.html", "admin/users.html", "admin/invitations.html", "admin/audit_log.html",
    "admin/fetch_logs.html", "admin/scoring_eval.html", "admin/partials/feeds_table.html",
    "admin/partials/feed_edit_form.html", "admin/partials/users_table.html",
    "admin/partials/users_count.html", "admin/partials/invitations_table.html",
]
# app.js (setToggleActive, outside this task) toggles these literal classes on the
# [data-feeds-group] buttons, so the server-rendered state has to use the same ones.
APP_JS_GROUP_TOGGLE = re.compile(r"bg-blue-50 border-blue-300 text-blue-700|border-gray-200 text-gray-600 hover:border-gray-300")


def _feed(id, title, status="active", **kw):
    base = dict(
        id=id, title=title, status=status, is_private=False, feed_url=f"https://ex{id}.test/rss",
        last_error=None, block_count=0, fetch_error_count=0, feed_type="rss", dormant=False,
        subscriber_count=2, fetch_interval_min=None, auto_interval_min=60, derived_interval_min=None,
        last_fetched_at=NOW, last_fetch_duration_ms=1200, next_fetch_rel="in 20m", next_fetch_at=NOW,
        last_published_at=NOW, has_failure_trail=False, type_config=None,
    )
    base.update(kw)
    return SimpleNamespace(**base)


FEEDS = [
    {"feed": _feed(1, "Alpha news", fetch_interval_min=30), "article_count": 120},
    {"feed": _feed(2, "Broken feed", "error", last_error="HTTP 500 from host", has_failure_trail=True,
                   subscriber_count=0, is_private=True,
                   feed_url="https://u:secret@ex2.test/rss?token=abc"), "article_count": 3},
    {"feed": _feed(3, "Quiet site", "paused", dormant=True, last_fetched_at=None,
                   last_published_at=None, next_fetch_rel=None), "article_count": 0},
]
FEEDS_CTX = {
    "feeds": FEEDS, "feed_counts": [(1, "error"), (1, "paused"), (1, "dormant")], "feed_groups": None,
    "group_mode": "az", "default_interval_min": 60, "has_rate_limits": True,
}
HOST_CTX = dict(FEEDS_CTX, group_mode="host", feed_groups=[
    {"label": "ex.test", "count": 2, "has_error": True, "feeds": FEEDS[:2]},
    {"label": "Other", "count": 1, "has_error": False, "feeds": FEEDS[2:]},
])
ADMIN = SimpleNamespace(id=1, display_name="Root", email="root@ex.test", role="admin", is_active=True,
                        email_verified=True, last_active_at=NOW, created_at=NOW)


def _user_item(user, **kw):
    item = dict(user=user, dormant=False, dormant_on=None, dormant_stops_feeds=True, inactive_days=0,
                feed_count=4, article_count=900, read_count=12, filter_count=3, score_filter_count=1,
                terms=SimpleNamespace(count=5, source="manual", enabled=True, updated_at=NOW),
                ai_scoring_recent=40, ai_ops_recent=7, ai_ops_breakdown=[("summary", 5), ("chat", 2)])
    item.update(kw)
    return item


USERS = [
    _user_item(ADMIN),
    _user_item(SimpleNamespace(id=2, display_name="Dora", email="dora@ex.test", role="user", is_active=False,
                               email_verified=True, last_active_at=None, created_at=NOW),
               dormant=True, inactive_days=45, terms=None, read_count=0, filter_count=0),
    _user_item(SimpleNamespace(id=3, display_name="Nova", email="nova@ex.test", role="user", is_active=True,
                               email_verified=False, last_active_at=NOW, created_at=NOW),
               dormant_on=NOW, inactive_days=12),
]
USERS_CTX = {"users": USERS, "current_user": ADMIN, "active_7d": 2}
INVITES = [
    SimpleNamespace(id=7, token="tok7", email="guest@ex.test", expires_at=NOW, used_at=None, creator=ADMIN),
    SimpleNamespace(id=8, token="tok8", email=None, expires_at=None, used_at=NOW, creator=None),
]
INVITES_CTX = {"invitations": INVITES, "base_url": "https://rf.test"}
EVAL = {
    "users": [{"id": 2, "name": "Dora", "n": 40, "engaged": 9}], "user_id": 2, "days": 90,
    "presets": [30, 90, 180], "retention": {"purge_after_days": 120, "effective_days": 120},
    "min_engaged": 20, "n": 300, "engaged_total": 30, "engaged_rate": 0.1, "auc": 0.71,
    "lexical": {"n": 500, "engaged_total": 12, "engaged_rate": 0.024, "auc": 0.62},
    "head_to_head": {"n": 250, "engaged_total": 25, "auc_ai": 0.7, "auc_lexical": 0.6},
    "exposure": {"aggregate_only": False, "filter_name": "Low score", "action": "mark_read", "threshold": 0.3,
                 "dropped_share": 0.2, "dropped_engaged_rate": 0.01, "auc": 0.64, "n": 240,
                 "engaged_rate": 0.12, "engaged_total": 28},
    "calibration": [{"lo": 0.0, "hi": 0.5, "count": 100, "engaged": 5, "rate": 0.05},
                    {"lo": 0.5, "hi": 1.0, "count": 0, "engaged": 0, "rate": None}],
    "histogram": [{"lo": 0.0, "hi": 0.05, "count": 10}, {"lo": 0.05, "hi": 0.1, "count": 0}],
}

# (template, path, context, macro markers, selectors that must match, visible strings)
CASES = {
    "feeds": (
        "admin/feeds.html", "/admin/feeds", FEEDS_CTX,
        ['class="card', 'class="badge', 'class="btn'],
        ['#feeds-table[data-group-mode="az"]', 'button[data-feeds-group="az"][hx-get="/admin/feeds/table?group=az"]'
         '[hx-target="#feeds-table"][hx-swap=outerHTML]', 'button[data-feeds-group="host"]',
         'button[data-action="open-rate-limits"][hx-get="/admin/rate-limits"][hx-target="#rate-limits-content"]',
         "dialog#feed-edit-overlay #feed-edit-content", "dialog#rate-limits-overlay #rate-limits-content",
         "button[data-menu-toggle] + [data-menu].hidden",
         'button[data-action="open-feed-edit"][hx-get="/admin/feeds/1/edit?group=az"][hx-target="#feed-edit-content"]'
         "[hx-swap=innerHTML]",
         'button[hx-post="/admin/feeds/1/force-fetch?group=az"][hx-target="#feeds-table"]'
         '[hx-indicator="#force-fetch-spinner-1"][hx-disabled-elt=this]', "#force-fetch-spinner-1.htmx-indicator",
         'button[hx-post="/admin/feeds/3/pause?group=az"]', 'button[hx-post="/admin/feeds/2/clear-error?group=az"]',
         'button.swap-confirm[data-confirm-text="Confirm delete"][data-confirm-class]'
         '[hx-delete="/admin/feeds/2?group=az"][hx-target="#feeds-table"][hx-swap=outerHTML]',
         'a[href="https://ex1.test/rss"][target=_blank]', "[data-expand]", 'time[datetime]',
         'script[src*="js/admin-feeds.js"]'],
        ["Feeds", "A–Z", "By host", "Rate limits", "Edit feed", "Learned rate limits", "Feed", "Type", "Status",
         "Subs", "Articles", "Interval", "Last / next fetch", "Last published", "Edit", "Force fetch", "Unpause",
         "Reset errors", "Delete", "dormant", "next in 20m", "HTTP 500 from host", "error", "paused"],
    ),
    "feeds-host-table": (
        "admin/partials/feeds_table.html", "/admin/feeds/table", HOST_CTX,
        ['class="badge'],
        ['#feeds-table[data-group-mode="host"]', 'button[hx-post="/admin/feeds/1/pause?group=host"]',
         "td[colspan='9']"],
        ["ex.test", "Other", "Alpha news"],
    ),
    "feeds-empty": (
        "admin/feeds.html", "/admin/feeds", dict(FEEDS_CTX, feeds=[], feed_counts=[], has_rate_limits=False),
        ['class="empty'], ["dialog#feed-edit-overlay #feed-edit-content"], ["No feeds yet."],
    ),
    "feed-edit-form": (
        "admin/partials/feed_edit_form.html", "/admin/feeds/1/edit",
        {"feed": _feed(4, "Scraped", feed_type="scrape", type_config={"article_links_selector": "h3 a"},
                       subscriber_count=1), "group_mode": "az", "default_interval_min": 60,
         "auto_interval_min": 90, "url_error": "Not a feed", "selector_error": "Bad selector"},
        ['class="field', 'class="input', 'class="select', 'role="switch"', 'class="btn'],
        ['form[hx-post="/admin/feeds/4/edit?group=az"][hx-target="#feeds-table"][hx-swap=outerHTML]',
         'input[name=feed_url][maxlength="2048"][spellcheck=false][placeholder]', "input[name=skip_verify][value='1']",
         'input[name=title][value="Scraped"]', "select[name=status] option[value=active]",
         "select[name=fetch_interval_min] option[value='']", 'input[name=article_links_selector][value="h3 a"]',
         'input[type=hidden][name=feed_id][value="4"]',
         'button[type=button][hx-post="/settings/feeds/scrape-preview"][hx-include="closest form"]'
         '[hx-target="#admin-scrape-preview"][hx-indicator="#admin-preview-spinner"]',
         "#admin-preview-spinner.htmx-indicator", "#admin-scrape-preview", "button[type=submit].btn",
         'button[type=button][data-action="close-feed-edit"]'],
        ["Feed address", "Save without fetching it first", "Leave blank to keep the current address.",
         "1 person is", "Title", "Shown to subscribers who haven't set a custom title.", "Fetch interval",
         "Auto (~1.5h)", "CSS selector for article links", "Preview", "Not a feed", "Bad selector",
         "Save changes", "Cancel"],
    ),
    "users": (
        "admin/users.html", "/admin/users", USERS_CTX,
        ['class="card', 'class="badge'],
        ["#users-table table", "h1 #users-count", 'button[data-menu-toggle] + [data-menu]',
         'button[hx-post="/admin/users/2/activate"][hx-target="#users-table"][hx-swap=innerHTML]',
         'button.swap-confirm[data-confirm-text="Confirm delete"][data-confirm-class]'
         '[hx-delete="/admin/users/2"][hx-target="#users-table"][hx-swap=innerHTML]',
         'button[hx-delete="/admin/users/3"]'],
        ["Users", "User", "Read 7d", "Scored 7d", "AI 7d", "Last active", "Idle", "Joined", "admin", "dormant",
         "unverified", "active", "inactive", "Activate", "Deactivate", "Delete", "&lt;24h", "45d",
         "(3 · 2 active 7d · 1 dormant)"],
    ),
    "invitations": (
        "admin/invitations.html", "/admin/invitations", INVITES_CTX,
        ['class="card', 'class="field', 'class="input', 'class="btn', 'class="badge'],
        ['form[hx-post="/admin/invitations"][hx-target="#invitations-table"][hx-swap=innerHTML]'
         "[data-reset-on-request]", "input[type=email][name=email]", "input[type=date][name=expires_at]",
         "button[type=submit]", "#invitations-table table",
         'button.copy-btn[data-copy="https://rf.test/register?invite=tok7"]',
         'button.swap-confirm[data-confirm-text="Confirm"][data-confirm-class]'
         '[hx-delete="/admin/invitations/7"][hx-target="#invitations-table"][hx-swap=innerHTML]'],
        ["Invitations", "Create invitation", "Email (optional)", "Expires (optional)", "Generate link", "Link",
         "Created by", "used", "active", "Revoke"],
    ),
    "audit-log": (
        "admin/audit_log.html", "/admin/audit-log",
        {"logs": [SimpleNamespace(admin=ADMIN, action="feed_edit", target_type="feed", target_id=4,
                                  detail={"title": "x"}, created_at=NOW)]},
        ['class="card'], ["table time[datetime]"],
        ["Audit log", "(last 100)", "Admin", "Action", "Target", "Detail", "Time", "feed_edit", "feed #4"],
    ),
    "fetch-logs": (
        "admin/fetch_logs.html", "/admin/fetch-logs",
        {"logs": [SimpleNamespace(feed=None, http_status=None, error_message="Timeout", failed_at=NOW)]},
        ['class="card'], ["table [data-expand]", "table time[datetime]"],
        ["Fetch logs", "(last 100 errors)", "HTTP", "Error", "Deleted feed", "Timeout"],
    ),
    "scoring-eval": (
        "admin/scoring_eval.html", "/admin/scoring-eval", {"eval": EVAL},
        ['class="card', 'class="alert', 'class="select', 'class="btn'],
        ['form[method=get][action="/admin/scoring-eval"] select#eval-user[name=user_id]',
         'input[type=hidden][name=days][value="90"]', 'a[href="/admin/scoring-eval?days=30&user_id=2"]',
         "form button[type=submit]"],
        ["Scoring eval", "This user's own filters shape the answer.", "Window:", "User:", "Show",
         "All users (aggregate)", "Basic relevance", "AI score", "Scored articles", "Engaged",
         "The AUC is somewhere between these two", "Calibration", "Score distribution", "Score bucket",
         "Engagement rate", "stops at 120d"],
    ),
}


@pytest.mark.parametrize("case", list(CASES))
def test_admin_list_pages_use_macros_and_keep_ids(case):
    name, path, ctx, markers, selectors, strings = CASES[case]
    html, soup = _render(name, path, **ctx)
    for marker in markers:
        assert marker in html, f"{case}: macro marker {marker!r} missing"
    for sel in selectors:
        assert soup.select_one(sel) is not None, f"{case}: {sel} missing"
    page_text = soup.get_text(" ")
    for text in strings:
        assert text in html or text in page_text, f"{case}: {text!r} missing"
    assert not _INLINE_HANDLER.search(html), f"{case}: inline event handler"
    assert not COLOUR_LITERAL.search(html), f"{case}: colour literal"


def test_admin_list_sources_draw_from_tokens():
    for rel in SOURCES:
        text = APP_JS_GROUP_TOGGLE.sub("", (TEMPLATES / rel).read_text(encoding="utf-8"))
        hits = sorted({m.group(0) for m in LEGACY_PALETTE.finditer(text)})
        assert not hits, f"{rel}: legacy palette classes {hits}"


def test_feed_edit_form_in_overlay_sets_own_hx_target():
    _, page = _render("admin/feeds.html", "/admin/feeds", **FEEDS_CTX)
    for overlay, content, trigger in (("feed-edit-overlay", "feed-edit-content", '[data-action="open-feed-edit"]'),
                                      ("rate-limits-overlay", "rate-limits-content",
                                       '[data-action="open-rate-limits"]')):
        dialog = page.select_one(f"dialog#{overlay}")
        assert dialog is not None and "dialog" in dialog["class"], overlay
        assert dialog.select_one(f"#{content}") is not None, content
        opener = page.select_one(trigger)
        assert opener["data-rf-open"] == overlay
        assert opener["hx-target"] == f"#{content}"
    # The form arrives by htmx inside the dialog: it posts itself into the table, and the
    # only closer is the Cancel button, never the submit (dialog.js prevents the default).
    _, form_soup = _render(*CASES["feed-edit-form"][:2], **CASES["feed-edit-form"][2])
    form = form_soup.select_one("form")
    assert (form["hx-target"], form["hx-swap"]) == ("#feeds-table", "outerHTML")
    closers = form_soup.select("[data-rf-close]")
    assert [c.get_text(strip=True) for c in closers] == ["Cancel"]
    assert all(c.name == "button" and c.get("type") == "button" for c in closers)
    assert form.select_one("button[type=submit]").get("data-rf-close") is None


async def test_smtp_test_result_uses_alert_classes(monkeypatch):
    from app.routers.web import admin

    saved = SimpleNamespace(smtp_host="mx", smtp_port=587, smtp_user="u", smtp_from_email="f@x",
                            smtp_password_encrypted=None)

    async def fake_settings(db):
        return saved

    class FakeRequest:
        async def form(self):
            return {}

    # admin renders the macro itself (app.ui_fragments.alert_html, s2-T37), so the
    # result is compared with the macro rendered in a template, not with a copy.
    # tests/test_ui_fragments.py checks the exact output.
    alert_tpl = templates.env.from_string(
        '{% from "ui/display.html" import alert %}{{ alert(text="x", variant=v, live=true) }}')

    def attrs_of(markup):
        el = BeautifulSoup(markup, "html.parser").find()
        return el.name, el.get("class"), el.get("data-variant"), el.get("role"), el.find("section") is not None

    monkeypatch.setattr(admin, "get_app_settings", fake_settings)
    user = SimpleNamespace(email="a<b@x.test")
    outcomes = [(None, "success", "Test email sent to a&lt;b@x.test."),
                (ValueError("no host"), "destructive", "SMTP not configured (missing host or from address)."),
                (OSError("refused"), "destructive", "Failed to send test email: OSError: refused")]
    for exc, variant, text in outcomes:
        def fake_send(*a, _exc=exc, **k):
            if _exc:
                raise _exc
        monkeypatch.setattr(admin, "send_email", fake_send)
        body = (await admin.admin_test_smtp(FakeRequest(), user=user, db=None)).body.decode()
        assert text in body, body
        assert attrs_of(body) == attrs_of(alert_tpl.render(v=variant)), body
        assert "text-green-600" not in body and "text-red-600" not in body


POSITIONED = re.compile(r"(?:^|\s)(?:relative|absolute|fixed|sticky)(?:\s|$)")


@pytest.mark.parametrize("case", ["feeds", "users", "invitations", "scoring-eval"])
def test_admin_table_scrollers_contain_positioned_descendants(case):
    # s2-T28 defect 1: at 390 px the "Actions" header's .sr-only span (position:absolute)
    # took <main> (position:relative from Basecoat's `.sidebar + *`) as its containing
    # block, so neither the overflow-x-auto scroller nor the card's overflow:hidden clipped
    # it, and the whole page scrolled sideways to the table's full width. Each scroller
    # has to be the containing block of the positioned descendants inside it.
    name, path, ctx, *_ = CASES[case]
    _, soup = _render(name, path, **ctx)
    scrollers = soup.select(".overflow-x-auto")
    assert scrollers, f"{case}: no table scroller"
    for scroller in scrollers:
        assert POSITIONED.search(" ".join(scroller.get("class", []))), \
            f"{case}: {scroller.get('id') or scroller.name} scrolls but is not positioned"
    if case != "scoring-eval":
        assert soup.select(".overflow-x-auto .sr-only"), f"{case}: the Actions header label moved"


def test_scoring_eval_selected_window_chip_is_filled():
    # s2-T28 defect 14: the selected window used variant=secondary, barely apart from the
    # outline chips in dark. The selected chip is the primary fill; the links stay.
    _, soup = _render("admin/scoring_eval.html", "/admin/scoring-eval", eval=EVAL)
    chips = soup.select('a.btn[href^="/admin/scoring-eval?days="]')
    assert [c.get_text(strip=True) for c in chips] == ["30d", "90d", "180d"]
    selected = [c for c in chips if c.get("aria-current") == "true"]
    assert [c["href"] for c in selected] == ["/admin/scoring-eval?days=90&user_id=2"]
    assert selected[0].get("data-variant") is None, "the selected chip is the primary fill"
    assert all(c.get("data-variant") == "outline" for c in chips if c not in selected)

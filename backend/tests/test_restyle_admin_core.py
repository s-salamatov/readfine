"""Admin pages I (dashboard, traffic, settings) are built from the ui/ macros (s2-T23).

Every branch of each page renders (macro errors only show at render time, and this task
has no browser run): with the macro markers (card, btn, field, badge, alert, switch,
sidebar), with every id and string that admin-settings.js, traffic-chart.js, app.js and
the dashboard's in-page links rely on, and with no inline event handler. The sources
carry no colour literal and no hand-written Tailwind palette colour.
"""
import re
from datetime import date, datetime, timezone
from html import unescape
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services import traffic_service
from app.templating import templates
from tests.test_csp import _INLINE_HANDLER
from tests.test_ui_macros import _FUNC, _HEX

APP = Path(__file__).resolve().parents[1] / "app"
NOW = datetime(2026, 11, 20, 9, 30, tzinfo=timezone.utc)


def _request(path="/admin"):
    return SimpleNamespace(state=SimpleNamespace(csp_nonce="test-nonce"), session={},
                           url=SimpleNamespace(path=path), query_params={})


def _render(template, context, path="/admin"):
    return templates.env.get_template(template).render(request=_request(path), **context)


def _has_class(html, name):
    return re.search(r'class="(?:[^"]* )?%s[ "]' % re.escape(name), html) is not None


def _ids(html):
    return set(re.findall(r'\bid="([^"]+)"', html))


def _text(html):
    return " ".join(unescape(re.sub(r"<[^>]+>", " ", html)).split())


# ── contexts ──────────────────────────────────────────────────────────────────

def _feed(status="error", **kw):
    return SimpleNamespace(id=7, title="Broken Feed", feed_url="https://example.test/rss",
                           status=status, block_count=0, fetch_error_count=3, **kw)


def _user():
    return SimpleNamespace(display_name="Alice", email="alice@example.test")


def _article(**kw):
    return SimpleNamespace(title="Some article", url="https://example.test/a", feed=SimpleNamespace(title="Feed A"),
                           readable_error="HTTP 403 Forbidden", readable_retries=2,
                           readable_failed_at=NOW, readable_next_retry_at=NOW, **kw)


def _stats(full):
    rows = full
    return {
        "user_count": 12, "active_readers": {7: 3, 30: 8}, "feed_count": 40, "article_count": 9000,
        "error_feed_count": 2 if full else 0, "disabled_feed_count": 1 if full else 0,
        "fetch_error_feed_total": 5 if full else 0,
        "fetch_error_feeds": [SimpleNamespace(feed=_feed(), error_message="HTTP 500 Internal Server Error",
                                              fails_24h=1, fails_7d=0, fails=4, last_failed_at=NOW)] if rows else [],
        "redirect_conflicts": [SimpleNamespace(feed_title="Old", feed_id=1, target_url="https://t.test/f",
                                               holder_title="New", holder_id=2, detected_at=NOW)] if rows else [],
        "briefing_errors": [SimpleNamespace(user=_user(), name="Morning", briefing_interval="daily", period="day",
                                            briefing_last_error="quota", briefing_retry_count=2,
                                            briefing_next_send_at=None)] if rows else [],
        "auto_profile_errors": [SimpleNamespace(user=None, ai_preference_last_error="bad key",
                                                ai_preference_fail_count=3, ai_preference_auto_days=None,
                                                ai_preference_last_error_at=NOW)] if rows else [],
        "readable_pending": 4 if full else 0, "readable_failed": 6 if full else 0,
        "readable_failed_recent": [_article()] if rows else [], "readable_failed_recent_total": 3 if full else 0,
        "readable_pending_recent": [_article()] if rows else [],
        "readable_revived_recent": [SimpleNamespace(title="Revived", readable_revival_attempts=2,
                                                    readable_revived_at=NOW)] if rows else [],
        "readable_revival_pending": 2 if full else 0,
    }


def _traffic(weekly=False, has_data=True):
    bar = SimpleNamespace(date=date(2026, 11, 19), last_date=date(2026, 11, 25), visitors=3, views=10)
    funnel = SimpleNamespace(landing=100, register=20, signups=4, signups_from=date(2026, 10, 1),
                             signup_sources=[SimpleNamespace(source="news.test", count=3, muted=False),
                                             SimpleNamespace(source="internal", count=1, muted=True)])
    return SimpleNamespace(
        timezone="UTC", presets=[7, 30, 90], days=30, start=date(2026, 10, 21), end=date(2026, 11, 20),
        has_data=has_data, visitors_avg=2.5, visitors_avg_change=10.0, visitors_peak=9,
        visitors_peak_day=date(2026, 11, 2), views_total=300, views_change=-5.0, bot_total=40, bot_change=None,
        visitors_floor=9, visitors_ceiling=60, chart_weekly=weekly, chart=[bar, bar],
        pages=[SimpleNamespace(path="/features", views=50, visitors_avg=1.5, bot_views=3)],
        sources=[], funnel=funnel,
    )


def _settings(smtp, registration):
    return SimpleNamespace(
        registration_enabled=registration, max_feeds_per_user=200, dormant_after_days=None,
        dormant_warning_enabled=False, default_fetch_interval_min=60, min_fetch_interval_min=15,
        max_fetch_interval_min=720, default_purge_after_days=45, ai_enabled=True, traffic_stats_enabled=False,
        legal_operator_name=None, legal_contact_email=None, legal_jurisdiction=None,
        smtp_host="smtp.example.test" if smtp else None, smtp_port=587, smtp_user=None,
        smtp_password_encrypted=b"x" if smtp else None, smtp_from_email=None, smtp_use_tls=True,
        feedback_enabled=False, briefing_extra_recipients_enabled=False,
    )


DASH_IDS = {"fetch-errors", "readable"}
SETTINGS_IDS = {"legal-section", "traffic-closed-note", "smtp-test-result", "smtp-spinner", "smtp_use_tls",
                "dormant_after_days"}

# case -> (template, context, path, markers, ids, strings)
CASES = {
    "dashboard-full": ("admin/dashboard.html", {"stats": _stats(True), "traffic_views_7d": 77}, "/admin",
                       ("card", "badge", "sidebar"),
                       DASH_IDS | {"redirect-conflicts", "briefing-errors", "profile-errors"},
                       ("Dashboard", "Feeds in error", "1 feed has fetching switched off", "Full fetch log",
                        "Feed redirect conflicts", "Briefing errors", "Interest profile generation errors",
                        "no retry - needs manual fix", "off - needs manual fix", "Showing 1 of 5 feeds",
                        "Feeds revived", "Page views last 7 days", "Back to app")),
    "dashboard-empty": ("admin/dashboard.html", {"stats": _stats(False), "traffic_views_7d": None}, "/admin",
                        ("card", "sidebar"), DASH_IDS,
                        ("All clear:", "No fetch errors.", "No failures in the last 30 days.")),
    "traffic-off": ("admin/traffic.html", {"traffic": None, "client_ip_unreliable": True}, "/admin/traffic",
                    ("alert",), set(),
                    ("Counting public page visits is switched off.", "Settings → Traffic",
                     "Visitor counts need the real client address")),
    "traffic-nodata": ("admin/traffic.html", {"traffic": _traffic(has_data=False), "client_ip_unreliable": False},
                       "/admin/traffic", ("btn",), set(), ("No visits recorded in this window.", "30d")),
    "traffic-daily": ("admin/traffic.html", {"traffic": _traffic(), "show_funnel": True, "landing_counted": True,
                                             "client_ip_unreliable": False}, "/admin/traffic",
                      ("card", "btn"), {"traffic-bars", "traffic-readout", "how-to-read"},
                      ("Visitors per day", "Per day", "Pages", "Sources", "Nothing yet.", "Registration funnel",
                       "Landing page", "Accounts by source:", "How to read these numbers", "Why a range?",
                       "2026-11-19: 3 visitors, 10 views")),
    "traffic-weekly": ("admin/traffic.html", {"traffic": _traffic(weekly=True), "show_funnel": False,
                                              "landing_counted": False, "client_ip_unreliable": False},
                       "/admin/traffic", ("card",), {"traffic-bars", "traffic-readout", "how-to-read"},
                       ("Per week", "Registration is closed, so there is no funnel to draw",
                        "2026-11-19 to 2026-11-25: 3 visitors per day, 10 views")),
    "settings-smtp": ("admin/settings.html", {"s": _settings(True, True), "saved": True, "error": None,
                                              "legal_configured": False, "public_url_set": False},
                      "/admin/settings", ("field", "btn", "alert", "select", "input"),
                      SETTINGS_IDS | {"legal-warning", "dormant-url-note", "dormant_warning_enabled"},
                      ("Global settings", "Settings saved.", "Legal pages incomplete", "Save settings",
                       "Send test email", "Password saved", "Email a warning 7 days before pausing")),
    "settings-plain": ("admin/settings.html", {"s": _settings(False, False), "saved": False, "error": "Bad port",
                                               "legal_configured": True, "public_url_set": True},
                       "/admin/settings", ("field", "btn", "alert"), SETTINGS_IDS,
                       ("Bad port", "No password set", "Open registration", "Purge after (days)",
                        "45 (current)")),
}


@pytest.mark.parametrize("case", CASES)
def test_admin_core_pages_use_macros_and_keep_ids(case, monkeypatch):
    template, context, path, markers, ids, strings = CASES[case]
    # The Traffic nav item only shows while counting is on, as the page itself is reached.
    monkeypatch.setattr(traffic_service, "_enabled", template == "admin/traffic.html")
    html = _render(template, context, path)
    for marker in markers:
        assert _has_class(html, marker), f"{case}: no {marker} macro markup"
    assert ids <= _ids(html), f"{case}: lost ids {sorted(ids - _ids(html))}"
    text = _text(html)
    for s in strings:
        assert s in text, f"{case}: lost string {s!r}"
    assert not _INLINE_HANDLER.search(html), f"{case}: inline event handler"
    # The admin sub-navigation is the ui/nav.html sidebar, toggled through data-rf-open
    # below md (never the shell's own #sidebar id).
    assert re.search(r'<aside id="admin-nav" class="sidebar[ "]', html), f"{case}: no admin sidebar"
    assert 'data-rf-open="admin-nav"' in html
    assert 'aria-current="page"' in html
    nav = html.split('<aside id="admin-nav"', 1)[1].split("</aside>", 1)[0]
    for href in ("/admin", "/admin/feeds", "/admin/fetch-logs", "/admin/users", "/admin/settings",
                 "/admin/scoring-eval", "/admin/invitations", "/admin/audit-log", "/app", "/settings"):
        assert f'href="{href}"' in nav, f"{case}: nav lost {href}"
    # Traffic is listed only while counting is on.
    assert ('href="/admin/traffic"' in nav) == (template == "admin/traffic.html")
    if template == "admin/traffic.html":
        # traffic-chart.js walks every <button> inside #traffic-bars: the bars and nothing else.
        if "traffic-bars" in ids:
            bars = html.split('id="traffic-bars"', 1)[1].split('id="traffic-readout"', 1)[0]
            assert bars.count("<button") == bars.count("data-readout=") == len(context["traffic"].chart)
            assert '<details id="how-to-read"' in html
    if template == "admin/settings.html":
        assert 'action="/admin/settings"' in html and 'method="POST"' in html and 'hx-boost="true"' in html
        assert 'hx-post="/admin/settings/test-smtp"' in html and 'hx-include="closest form"' in html
        assert "js/admin-settings.js" in html
        names = set(re.findall(r'\bname="([^"]+)"', html.split('action="/admin/settings"', 1)[1]))
        expected = {"registration_enabled", "max_feeds_per_user", "dormant_after_days", "default_fetch_interval_min",
                    "min_fetch_interval_min", "max_fetch_interval_min", "default_purge_after_days", "ai_enabled",
                    "traffic_stats_enabled", "legal_operator_name", "legal_contact_email", "legal_jurisdiction",
                    "smtp_host", "smtp_port", "smtp_user", "smtp_password", "smtp_from_email", "smtp_use_tls",
                    "feedback_enabled", "briefing_extra_recipients_enabled"}
        if context["s"].smtp_host:
            expected.add("dormant_warning_enabled")
        assert expected <= names, f"{case}: lost names {sorted(expected - names)}"


def test_status_notices_use_alert_variants_and_flow_inline():
    """Review T28-4/5: the trusted-proxy notice is a warning whose body flows as one
    paragraph; "Settings saved." is a success no wider than the cards (max-w-2xl, as the
    form), and the settings warnings are warnings."""
    def alert_with(html, needle):
        for m in re.finditer(r'<div class="(alert[^"]*)"([^>]*)>(.*?)</div>', html, re.S):
            if needle in _text(m.group(3)):
                return m.group(1).split(), m.group(2), m.group(3)
        raise AssertionError(f"no alert with {needle!r}")

    def one_paragraph(body):
        section = re.search(r"<section>\s*(.*?)\s*</section>", body, re.S).group(1)
        return section.startswith("<p>") and section.endswith("</p>") and section.count("<p>") == 1

    traffic = _render("admin/traffic.html", {"traffic": None, "client_ip_unreliable": True}, "/admin/traffic")
    _, extra, body = alert_with(traffic, "TRUSTED_PROXY_COUNT")
    assert 'data-variant="warning"' in extra
    # Text and <code> sit in one <p>, never as loose grid items of the section.
    assert one_paragraph(body), body
    assert re.search(r"<code>TRUSTED_PROXY_COUNT</code>\s+or\s+<code>TRUST_CLOUDFLARE</code>", body)

    smtp = _render("admin/settings.html", {"s": _settings(True, True), "saved": True, "error": None,
                                           "legal_configured": False, "public_url_set": False}, "/admin/settings")
    cls, extra, _ = alert_with(smtp, "Settings saved.")
    assert 'data-variant="success"' in extra and "max-w-2xl" in cls
    for needle in ("Legal pages incomplete", "PUBLIC_URL is not set"):
        _, extra, body = alert_with(smtp, needle)
        assert 'data-variant="warning"' in extra and one_paragraph(body), needle
    plain = _render("admin/settings.html", {"s": _settings(False, True), "saved": False, "error": "Bad port",
                                            "legal_configured": True, "public_url_set": True}, "/admin/settings")
    cls, extra, _ = alert_with(plain, "Bad port")
    assert 'data-variant="destructive"' in extra and "max-w-2xl" in cls
    cls, extra, body = alert_with(plain, "Email verification is disabled")
    assert 'data-variant="warning"' in extra and "max-w-2xl" in cls and one_paragraph(body)


def test_settings_toggle_targets_keep_hidden_hook():
    # admin-settings.js toggles the `hidden` class on these ids; the class must sit on the
    # element that carries the id, in the state the server renders.
    closed = _render("admin/settings.html", {"s": _settings(True, False), "saved": False, "error": None,
                                             "legal_configured": False, "public_url_set": False})
    opened = _render("admin/settings.html", {"s": _settings(True, True), "saved": False, "error": None,
                                             "legal_configured": False, "public_url_set": False})

    def classes(html, el_id):
        m = re.search(r'<[a-z]+\b[^>]*\bid="%s"[^>]*>' % el_id, html)
        assert m, el_id
        return re.search(r'class="([^"]*)"', m.group(0)).group(1).split()

    for el_id in ("legal-section", "legal-warning"):
        assert "hidden" in classes(closed, el_id) and "hidden" not in classes(opened, el_id)
    assert "hidden" not in classes(closed, "traffic-closed-note") and "hidden" in classes(opened, "traffic-closed-note")
    assert "hidden" in classes(closed, "dormant-url-note")
    for name in ("registration_enabled", "dormant_warning_enabled", "traffic_stats_enabled", "ai_enabled",
                 "feedback_enabled", "briefing_extra_recipients_enabled", "smtp_use_tls"):
        assert re.search(r'<input type="checkbox" role="switch" class="input[^"]*"[^>]*name="%s"' % name, opened), name


def test_rate_limits_fragment_keeps_its_swap_contract():
    # The fragment replaces #rate-limits-content (outerHTML) on open and on Clear, so its
    # root stays that div. The dialog around it lives in admin/feeds.html (s2-T24).
    spacing = SimpleNamespace(host="api.example.test", seconds=90, source="429", learned_at=NOW)
    html = _render("admin/partials/rate_limits_modal.html", {"spacings": [spacing], "now": NOW})
    assert html.lstrip().startswith('<div id="rate-limits-content"')
    clear = re.search(r"<button\b[^>]*>\s*Clear\s*</button>", html)
    assert clear and 'class="btn' in clear.group(0)
    assert 'hx-post="/admin/rate-limits/api.example.test/clear"' in clear.group(0)
    assert 'hx-target="#rate-limits-content"' in clear.group(0) and 'hx-swap="outerHTML"' in clear.group(0)
    assert "data-rf-close" not in html  # dialog.js would preventDefault the Clear click
    assert "<dialog" not in html and "data-rf-open" not in html  # feeds.html owns the dialog and its trigger
    assert _has_class(html, "badge") and "throttled" in html and "1.5m" in html
    assert not _INLINE_HANDLER.search(html)
    empty = _render("admin/partials/rate_limits_modal.html", {"spacings": [], "now": NOW})
    assert "No learned rate limits." in _text(empty) and empty.lstrip().startswith('<div id="rate-limits-content"')


_PALETTE_CLASS = re.compile(
    r"(?<![\w-])(?:[a-z0-9-]+:)*(?:bg|text|border|divide|ring|shadow|from|to)-"
    r"(?:gray|blue|white|black|red|green|amber|yellow)\b")
SOURCES = ("templates/admin/base.html", "templates/admin/dashboard.html", "templates/admin/traffic.html",
           "templates/admin/settings.html", "templates/admin/partials/rate_limits_modal.html",
           "static/js/admin-settings.js", "static/js/traffic-chart.js")


def test_admin_core_sources_have_no_colour_literal_or_palette_class():
    for name in SOURCES:
        text = (APP / name).read_text()
        text = re.sub(r"\{#[\s\S]*?#\}", " ", text)
        palette = _PALETTE_CLASS.search(text)
        assert not palette, f"{name}: {palette.group(0)}"
        text = re.sub(r'(?<![\w-])(?:href|for|hx-target|hx-include|hx-indicator)\s*=\s*(?:"[^"]*"|\'[^\']*\')',
                      " ", text)
        text = re.sub(r"""(?:querySelector(?:All)?|closest|getElementById)\(\s*(?:'[^']*'|"[^"]*")""", " ", text)
        text = re.sub(r"""location\.hash\s*===?\s*'[^']*'""", " ", text)
        assert not _HEX.search(text) and not _FUNC.search(text), name

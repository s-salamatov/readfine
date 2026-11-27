"""The public pages (help, features, changelog, legal) are built from the ui/ macros (s2-T25).

Each page renders with the macro markers (card, kbd, alert, badge), keeps every id it had
at 1d7f2f4 (in-app deep links such as /help#scrape and #custom-endpoint land on them),
keeps the strings other code and readers rely on, carries no inline event handler, and
its template source has no colour literal (the colour lint's patterns).
"""
import re
from html import unescape
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.templating import templates
from app.utils.changelog import parse_changelog
from tests.test_csp import _INLINE_HANDLER
from tests.test_ui_macros import _FUNC, _HEX

TEMPLATES = Path(__file__).resolve().parents[1] / "app" / "templates"

# The ids help.html carried at 1d7f2f4, frozen here so the test needs no git history.
HELP_IDS = {
    "shortcuts", "import", "scrape", "scoring", "basic-relevance", "filters", "score-filters",
    "terms-or-filters", "regex", "layout", "stories", "saved", "saved-searches", "install",
    "share", "stats", "ai-key", "custom-endpoint", "catchup", "purge", "api", "privacy",
    "feed-error", "paused-feeds",
}

CHANGELOG = """# Changelog

## [Unreleased]

### Added
- A thing that is not out yet.

## [2.4.0] - 2026-11-01

### Fixed
- Feeds load faster.

### Upgrade notes
- Run the migration before starting the new image.
"""

LEGAL = {
    "legal_operator_name": "Example Operator",
    "legal_contact_email": "ops@example.test",
    "legal_jurisdiction": "Testland",
    "legal_last_updated": "2026-11-21",
}

FEATURES = {
    "intro": "Everything Readfine does.",
    "categories": [
        {"name": "Reading", "summary": "How articles are read.",
         "features": [{"title": "Clean view", "desc": "A **clean** view with `code` and [a link](/help)."}]},
    ],
}

# page -> (template, context, markers that must appear, ids that must appear, strings)
PAGES = {
    "help": ("help.html", {}, ("card", "kbd", "alert", "badge"), HELP_IDS,
             ("Help & getting started", "Getting started", "Getting around the reader",
              "A workflow that works well", "FAQ", "Jump to a question", "All shortcuts")),
    "features": ("features.html", {"features": FEATURES}, ("card",), set(),
                 ("Features", "Everything Readfine does.", "Reading", "How articles are read.", "Clean view")),
    "changelog": ("changelog.html", {"releases": parse_changelog(CHANGELOG), "is_admin": True},
                  ("card", "badge"), {"unreleased", "v2.4.0"},
                  ("What's new", "Latest changes", "(not yet in a release)", "Version 2.4.0",
                   "2026-11-01", "Feeds load faster.", "Upgrade notes", "(admins only)")),
    "changelog-none": ("changelog.html", {"releases": None, "is_admin": False}, ("alert",), set(),
                       ("The release notes aren't included in this installation.", "on GitHub")),
    "terms": ("legal/terms.html", LEGAL | {"footer_current": "terms"}, ("card",), set(),
              ("Terms of Service", "Last updated: 2026-11-21", "1. Service", "7. Governing law",
               "Example Operator", "ops@example.test", "Testland")),
    "privacy": ("legal/privacy.html", LEGAL | {"footer_current": "privacy"}, ("card",), set(),
                ("Privacy Policy", "Last updated: 2026-11-21", "Example Operator")),
}

_PALETTE_CLASS = re.compile(r"(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|divide|shadow)-(?:gray|blue|white)\b")

SOURCES = ("help.html", "features.html", "changelog.html",
           "legal/base.html", "legal/privacy.html", "legal/terms.html")


def _request():
    return SimpleNamespace(state=SimpleNamespace(csp_nonce="test-nonce"), session={},
                           url=SimpleNamespace(path="/"), query_params={})


def _render(template, context):
    return templates.env.get_template(template).render(request=_request(), **context)


def _has_class(html, name):
    return re.search(r'class="%s[ "]' % re.escape(name), html) is not None


@pytest.mark.parametrize("page", PAGES)
def test_public_pages_use_macros_and_keep_contract(page):
    template, context, markers, ids, strings = PAGES[page]
    html = _render(template, context)
    for marker in markers:
        assert _has_class(html, marker), f"{page}: no {marker} macro markup"
    rendered_ids = set(re.findall(r'\bid="([^"]+)"', html))
    assert ids <= rendered_ids, f"{page}: lost ids {sorted(ids - rendered_ids)}"
    text = " ".join(unescape(html).split())  # visible strings, whatever the escaping
    for s in strings:
        assert s in text, f"{page}: lost string {s!r}"
    assert not _INLINE_HANDLER.search(html), f"{page}: inline event handler"


def test_changelog_hides_admin_notes_and_features_keep_markdown_hook():
    member = _render("changelog.html", {"releases": parse_changelog(CHANGELOG), "is_admin": False})
    assert "Feeds load faster." in member
    assert "Upgrade notes" not in member and "(admins only)" not in member
    features = _render("features.html", {"features": FEATURES})
    hook = re.search(r'<dd class="feature-desc[ "][^>]*>(.*?)</dd>', features, re.S)
    assert hook, "features: .feature-desc hook lost"
    assert "<strong>clean</strong>" in hook.group(1) and "<code>code</code>" in hook.group(1)


def test_public_page_sources_have_no_colour_literal():
    for name in SOURCES:
        text = (TEMPLATES / name).read_text()
        # The hand-written Tailwind greys and blues are gone too: colours come from the
        # theme tokens (text-foreground, text-muted-foreground, border-border, ...).
        palette = _PALETTE_CLASS.search(text)
        assert not palette, f"{name}: {palette.group(0)}"
        # Masked as scripts/check-colours.mjs does: Jinja comments and id references.
        text = re.sub(r"\{#[\s\S]*?#\}", " ", text)
        text = re.sub(r'(?<![\w-])(?:href|for)\s*=\s*(?:"[^"]*"|\'[^\']*\')', " ", text)
        assert not _HEX.search(text) and not _FUNC.search(text), name


# ── s8-T3: public pages on their own layout ───────────────────────────────────

ROUTES = ("/features", "/changelog", "/help", "/privacy", "/terms")

# Every template the public pages are built from. Off base.html they no longer get its
# inline legacy-dark overrides, so tokens are the only dark styling they have.
PUBLIC_SOURCES = SOURCES + ("public/base.html", "partials/public_header.html",
                            "partials/public_footer.html", "partials/back_to_reader.html")
_LEGACY_PALETTE = re.compile(
    r"(?<![\w\[(-])(?:[a-z-]+:)*(?:bg|text|border|divide|ring|shadow|fill|stroke|outline|"
    r"decoration|placeholder|from|via|to)-(?:gray|blue)-\d")
_DARK_VARIANT = re.compile(r"(?<![\w-])dark:")


@pytest.fixture
def public_get(unauth_client):
    """GET a public page; the legal pages read the operator details from a stub."""
    from unittest.mock import AsyncMock, patch

    def get(path, **kw):
        with patch("app.routers.web.legal.get_app_settings",
                   new=AsyncMock(return_value=SimpleNamespace(**LEGAL))):
            return unauth_client.get(path, **kw)
    return get


def _script_srcs(html):
    return {src.split("?", 1)[0] for src in re.findall(r"<script\b[^>]*\bsrc=\"([^\"]+)\"", html)}


def _assert_public_page(path, resp):
    assert resp.status_code == 200, (path, resp.status_code)
    html = resp.text
    assert re.search(r"<h1\b", html), f"{path}: no h1"
    assert _script_srcs(html) == {"/static/js/init.js"}, (path, sorted(_script_srcs(html)))
    assert not re.search(r"\shx-[a-z-]+=", html), f"{path}: hx- attribute"
    assert "data-rf-open" not in html, f"{path}: data-rf-open"


def test_public_pages_render_signed_out_without_app_js(public_get):
    for path in ROUTES:
        resp = public_get(path)
        _assert_public_page(path, resp)
        assert 'href="/app"' not in resp.text, f"{path}: back link signed out"
    for name in PUBLIC_SOURCES:
        path = TEMPLATES / name
        assert path.exists(), f"{name} missing"
        text = re.sub(r"\{#[\s\S]*?#\}", " ", path.read_text())
        found = _LEGACY_PALETTE.search(text) or _DARK_VARIANT.search(text)
        assert not found, f"{name}: {found.group(0)}"


def test_public_pages_signed_in_keep_back_link_without_app_js(public_get, unauth_client):
    import json
    from base64 import b64encode
    from datetime import datetime, timezone
    from unittest.mock import AsyncMock, patch

    from itsdangerous import TimestampSigner

    from app.config import settings

    payload = b64encode(json.dumps({"user_id": 1, "tv": 0}).encode())
    unauth_client.cookies.set("session", TimestampSigner(settings.secret_key).sign(payload).decode(),
                              domain="testserver.local")
    user = SimpleNamespace(id=1, role="user", display_name="U", is_active=True, session_token_version=0,
                           last_active_at=datetime.now(timezone.utc))
    with patch("app.auth.dependencies._get_user_by_id", new=AsyncMock(return_value=user)):
        for path in ROUTES:
            resp = public_get(path)
            _assert_public_page(path, resp)
            assert re.search(r'<a\b[^>]*href="/app"[^>]*>[\s\S]*?Back to reader', resp.text), \
                f"{path}: no back link"


# Every id help.html carried at a4255bc (the s8 base), frozen here.
HELP_IDS_S8 = [
    "shortcuts", "import", "scrape", "scoring", "basic-relevance", "filters", "score-filters",
    "terms-or-filters", "regex", "layout", "stories", "saved", "saved-searches", "install", "share",
    "stats", "ai-key", "custom-endpoint", "catchup", "translation", "purge", "api", "privacy",
    "feed-error", "paused-feeds",
]
OLD_HELP_PATHS = re.compile(r'href="/settings/(?:feeds|opml|preferences|filters)\b')
OLD_HELP_NAMES = ("Settings → Feeds", "Settings → OPML", "Settings → Preferences", "Settings &gt; Preferences",
                  "Settings → Filters", "Settings → Tokens", "Settings → Profile")
# Old names that are the start of a current one.
OLD_HELP_PREFIXES = (r"Settings → Relevance(?! &amp; filters)", r"Settings → AI(?! provider)")
CURRENT_HELP_NAMES = ("Reading &amp; appearance", "Relevance &amp; filters", "Sources", "AI provider", "Account")
CANONICAL_HELP_LINKS = ("/sources", "/sources/add", "/sources/opml", "/settings/reading",
                        "/settings/relevance", "/settings/ai")


def test_help_uses_current_names_and_canonical_links():
    html = _render("help.html", {})
    ids = set(re.findall(r'\bid="([^"]+)"', html))
    assert set(HELP_IDS_S8) <= ids, sorted(set(HELP_IDS_S8) - ids)
    old = OLD_HELP_PATHS.search(html)
    assert not old, old.group(0)
    for name in OLD_HELP_NAMES:
        assert name not in html, f"old name {name!r}"
    for pattern in OLD_HELP_PREFIXES:
        assert not re.search(pattern, html), f"old name {pattern!r}"
    for name in CURRENT_HELP_NAMES:
        assert name in html, f"current name {name!r} missing"
    for href in CANONICAL_HELP_LINKS:
        assert re.search(r'href="%s(?:[#?][^"]*)?"' % re.escape(href), html), f"no link to {href}"
    assert "collapsible" not in html.lower(), "the retired Collapsible sidebar mode"
    assert "to open search" not in html, "stale / text: / opens the command palette"
    assert "in the reader.</p>" not in html, "Catch me up lives on the Assistant page"
    assert 'href="/assistant/catch-up"' in html
    assert re.search(r'href="/assistant\?section=profile#assistant-profile"[^>]*\bdata-rf-online-only\b', html)
    # "On this page": a nav (a <details> below sm) whose links land on ids on the page.
    navs = re.findall(r'<nav\b[^>]*aria-label="On this page"[^>]*>([\s\S]*?)</nav>', html)
    assert navs, "no On this page nav"
    assert re.search(r"<details\b[^>]*>\s*<summary\b[^>]*>On this page</summary>", html)
    for nav in navs:
        targets = re.findall(r'href="#([^"]+)"', nav)
        assert len(targets) >= 4, targets
        assert set(targets) <= ids, sorted(set(targets) - ids)


def test_legal_pages_print_and_wrap_classes(public_get):
    for path in ("/privacy", "/terms"):
        html = public_get(path).text
        # The card macro renders bare <header>/<footer>; only the page's own carry classes.
        header = re.search(r'<header class="([^"]*)"', html)
        footer = re.search(r'<footer class="([^"]*)"', html)
        assert header and "print:hidden" in header.group(1).split(), (path, header and header.group(1))
        assert footer and "print:hidden" in footer.group(1).split(), (path, footer and footer.group(1))
        assert re.search(r'class="[^"]*(?<![\w:-])wrap-break-word(?![\w-])', html), f"{path}: no wrap-break-word"
        assert re.search(r'class="[^"]*\bcard\b[^"]*\bprint:shadow-none\b', html), f"{path}: card shadow in print"
        assert re.search(r'class="[^"]*\bcard\b[^"]*\bprint:ring-0\b', html), f"{path}: card ring in print"
    privacy = public_get("/privacy").text
    assert re.search(r'<div class="[^"]*\brf-scroll-x\b[^"]*"[^>]*>\s*<table\b', privacy), "table not in rf-scroll-x"

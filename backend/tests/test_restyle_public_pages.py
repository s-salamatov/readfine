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

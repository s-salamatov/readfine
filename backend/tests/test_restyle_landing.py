"""landing.example.html through the ui/ macros, theme bootstrap via init.js (s2-T26).

The landing loads init.js instead of its own inline copy of the colour-scheme logic,
so it gets data-rf-theme and the theme-color sync like the app; its sections are
built from the ui/ macros and carry no colour literal; its copy, links and JSON-LD
stay. The live landing.html is a gitignored per-instance copy and is not tested here.
"""
import json
import re
from pathlib import Path
from types import SimpleNamespace

from app.templating import templates
from tests.test_csp import _EVAL_PATTERNS, _INLINE_HANDLER

TEMPLATE = "landing.example.html"
SOURCE = Path(__file__).resolve().parents[1] / "app" / "templates" / TEMPLATE
NONCE = "t3stn0nce"
REGISTER_URL = "/register?src=news.ycombinator.com"

# The colour lint's patterns and masks (scripts/check-colours.mjs: HEX, FUNC, MASKS).
_HEX = re.compile(r"(?<![&\w])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])")
_FUNC = re.compile(r"\b(?:rgba?|hsla?|oklch|oklab)\(")
_MASKS = (
    re.compile(r"\{#[\s\S]*?#\}"),
    re.compile(r"""(?<![\w-])(?:href|for|hx-target|hx-select|hx-include|hx-indicator)\s*=\s*(?:"[^"]*"|'[^']*')"""),
)

# Visible copy and link targets that people, crawlers and the backend rely on.
STRINGS = (
    "Readfine – your RSS reader with AI",
    "Sign in", "Sign up", "Create a free account", "See features", "See the full feature list",
    "View on GitHub", "Create an account",
    "Everything in one reader", "How it works", "See it in action", "Open source, and yours to run",
    "RSS, Atom &amp; scraping", "Save anything you find", "Filters", "One story, not five",
    "Relevance scoring", "Clean reading view", "AI on your own keys and models",
    "Catch me up &amp; briefings", "Reads like an app",
    "STEP 1", "STEP 2", "STEP 3", "STEP 4", "Pick your topics", "Add your sources", "Best first",
    "Read &amp; ask", "Self-host it", "Run the AI locally too",
    "Free to sign up · up to 150 feeds · bring your own AI key or endpoint",
    "Built with AI (Claude Code), and I use it every day myself.",
    "Built with AI (Claude Code), in the open, on GitHub.",
    "Terms of Service", "Privacy Policy", "What's new", "&copy; Readfine",
)
HREFS = (
    "/login", "/features", "/help", "/changelog", "/terms", "/privacy", "#features",
    "https://github.com/jakublibik/readfine",
)


def _render():
    """landing.example.html with the context routers/web/auth.py:root passes."""
    request = SimpleNamespace(state=SimpleNamespace(csp_nonce=NONCE))
    return templates.env.get_template(TEMPLATE).render(
        request=request, base_url="http://testserver/", register_url=REGISTER_URL,
    )


def _head(html):
    return html.split("</head>", 1)[0]


def test_landing_example_renders_with_macros_and_init_js():
    html = _render()
    head = _head(html)

    for marker in ('class="btn"', 'class="card', 'class="badge"'):
        assert marker in html, f"no {marker} in the landing"

    # init.js is a plain external script in <head>: synchronous, before first paint.
    init_tags = re.findall(r"<script\b[^>]*\bsrc=\"[^\"]*/js/init\.js[^\"]*\"[^>]*>", head)
    assert len(init_tags) == 1, init_tags
    assert not re.search(r"\b(?:async|defer|type=\"module\")", init_tags[0]), init_tags[0]

    # The only inline script left is the JSON-LD block, nonce'd and still valid JSON.
    inline = re.findall(r"<script\b(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)</script>", html)
    assert len(inline) == 1, [attrs for attrs, _ in inline]
    attrs, body = inline[0]
    assert 'type="application/ld+json"' in attrs and f'nonce="{NONCE}"' in attrs
    data = json.loads(body)
    assert data["@type"] == "WebApplication" and data["url"] == "http://testserver/"
    assert "colorScheme" not in html and "prefers-color-scheme" not in html

    # One theme-color meta without content: syncThemeColor() fills it.
    metas = re.findall(r"<meta\b[^>]*name=\"theme-color\"[^>]*>", head)
    assert metas == ['<meta name="theme-color">'], metas


def test_landing_example_has_no_colour_literal():
    source = SOURCE.read_text(encoding="utf-8")
    for text, where in ((source, "source"), (_render(), "rendered")):
        for mask in _MASKS:
            text = mask.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), text)
        found = _HEX.findall(text) + _FUNC.findall(text)
        assert not found, f"colour literal in the {where} landing: {found}"


def test_landing_example_keeps_copy_links_and_no_inline_handlers():
    html = _render()
    text = re.sub(r"\s+", " ", html)
    for s in STRINGS:
        assert s in text, f"lost string: {s!r}"
    for href in HREFS:
        assert f'href="{href}"' in html, f"lost link: {href}"
    # Every sign-up link carries the visitor's source (routers/web/auth.py:root).
    assert html.count(f'href="{REGISTER_URL}"') == 3
    assert 'href="/register"' not in html
    github = re.search(r'<a\b[^>]*href="https://github.com/jakublibik/readfine"[^>]*>', html).group(0)
    assert 'target="_blank"' in github and 'rel="noopener noreferrer"' in github, github
    assert 'id="features"' in html
    assert not _INLINE_HANDLER.search(html)
    assert not any(p.search(html) for p, _ in _EVAL_PATTERNS)


# Basecoat's lg button (vega.css: h-10 px-2.5 text-sm) is still smaller than the base's
# hero CTAs (px-5 py-2.5 text-base: 44px tall), so on a 390px phone the hero buttons
# read as small (T28-15). The hero CTAs keep size="lg" and add the base's height,
# padding and type size; utilities sit above Basecoat's components layer.
HERO_CTA_CLASSES = ("h-11", "px-5", "text-base")


def test_landing_example_hero_ctas_are_large():
    html = _render()
    hero = re.search(r"<!-- Hero -->([\s\S]*?)</section>", html).group(1)
    ctas = re.findall(r"<a\b[^>]*>[^<]*</a>", hero)
    labels = {re.sub(r"<[^>]*>", "", a).strip(): a for a in ctas}
    assert set(labels) == {"Create a free account", "See features"}, list(labels)
    for label, tag in labels.items():
        classes = re.search(r'class="([^"]*)"', tag).group(1).split()
        assert classes[0] == "btn", (label, classes)
        assert 'data-size="lg"' in tag, (label, tag)
        for cls in HERO_CTA_CLASSES:
            assert cls in classes, f"{label!r} lacks {cls}: {classes}"
    assert f'href="{REGISTER_URL}"' in labels["Create a free account"]
    assert 'href="#features"' in labels["See features"]
    assert 'data-variant="outline"' in labels["See features"]

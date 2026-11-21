"""Rendered pages for the DOM contract check (design §5.5, s2-T11).

``scripts/check-dom-contract.mjs`` verifies every entry of ``docs/ui-dom-contract.md``
against rendered HTML first and falls back to a literal in the sources only for what no
rendered page shows. This module supplies that HTML: a fixed page set rendered from the
real templates with fixture contexts (no DB), normalised and kept as
``tests/fixtures/dom_contract/<page>.html``.

The normalisation is the offline drift harness's (``normalise`` in
``test_offline_drift.py``: one node per line, attributes and class tokens sorted), so the
check reads both fixture sets the same way. On top of it the output is made
deterministic: static URLs carry no ``?v=`` hash, the CSP nonce, the viewer, the
version strings and the instance-wide flags are pinned, and the bodies of inline
non-JSON ``<script>`` blocks are dropped (code, not markup: an ``id="…"`` inside a
script must not count as rendered; the check scans the template source for those).

When a template changes on purpose, regenerate with
``RF_UPDATE_GOLDENS=1 uv run pytest tests/test_dom_contract_pages.py`` and review the
diff. Adding a page: add it to ``_pages()``.
"""
import os
import re
from pathlib import Path
from types import SimpleNamespace

import pytest
from bs4 import BeautifulSoup

from app.templating import templates
from app.utils.datetime_format import current_viewer_tz
from app.utils.formats import current_viewer_format
from app.utils.request_context import current_viewer
from tests.test_offline_drift import (
    AID, LABELS, _article, _item, _list, _request, _sidebar, normalise,
)

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "dom_contract"
CONTRACT = Path(__file__).resolve().parents[2] / "docs" / "ui-dom-contract.md"
NONCE = "contract-nonce"
VIEWER = (1, "ann")


def _page(template: str, path: str = "/", viewer=VIEWER, **ctx) -> str:
    request = _request()
    request.scope["path"] = path
    request.scope["session"] = {"user_id": viewer[0]} if viewer else {}
    request.state.csp_nonce = NONCE
    token = current_viewer.set(viewer)
    try:
        return templates.env.get_template(template).render(request=request, **ctx)
    finally:
        current_viewer.reset(token)


def _row() -> str:
    article = _item(is_starred=True, is_saved=True, ai_score=0.8, lexical_score=0.3,
                    labels=LABELS[:3], story_id=5, story_others=2, story_total=3, story_read=1)
    return _page("app/partials/article_row.html", article=article, density="comfortable",
                 label_display="dots", show_ai_score=True, story_unfoldable=True,
                 chat_article_ids={AID})


def _detail() -> str:
    article = _article(is_starred=True, is_saved=True, share_token="tok",
                       ai_summary="**Sum**", ai_summary_truncated=True, ai_context="Ctx",
                       ai_score=0.8, lexical_score=0.3, labels=LABELS[:2], story_id=5)
    return _page("app/partials/article_detail.html", article=article, mark_read_on_scroll=False,
                 ai_available=True, summary_pending=False, chat_available=True,
                 chat_messages=[], related_count=2, show_score=True)


def _shortcuts() -> str:
    module = templates.env.get_template("app/partials/shortcuts.html").module
    return str(module.shortcut_list())


def _settings() -> SimpleNamespace:
    return SimpleNamespace(
        timezone="Europe/Berlin", format_profile="iso", articles_per_page=50,
        default_sort_order="newest", unread_filter="adaptive", story_dedup="collapse",
        list_density_web="comfortable", list_density_mobile="compact",
        label_display="indicator", reading_font_size="md", reading_font_family="sans",
        mark_read_on_scroll=True, mark_read_auto_advance=False,
        open_original_when_empty=False, bucket_small_max=640, bucket_medium_max=1100,
    )


def _pages():
    """page -> render(). The minimum set of s2-T11, the shell included."""
    return {
        "article_row": _row,
        "article_detail": _detail,
        "article_list": lambda: _list(
            [_item(), _item(id=AID + 1, is_read=True)], saved_view=True, has_more=True,
            more_qs="cursor_id=4243"),
        "sidebar": _sidebar,
        "shortcuts": _shortcuts,
        "login": lambda: _page("auth/login.html", path="/login", viewer=None,
                               registration_open=True, email="", next="",
                               error="Wrong email or password."),
        "preferences": lambda: _page("settings/preferences.html", path="/settings/preferences",
                                     s=_settings(), saved=True, suppressed_week=3,
                                     suppressed_days=7, active="preferences",
                                     bookmarklet="javascript:void(0)"),
        "main": lambda: _page(
            "app/main.html", path="/app", user=SimpleNamespace(id=1, display_name="ann"),
            bucket_small_max=640, bucket_medium_max=1100, reading_font_size="md",
            reading_font_family="sans", label_display="indicator",
            open_original_when_empty=False, chat_available=True, catchup_available=True,
            open_article_id=None, has_labeled=True, feeds_resumed=True, scores_pending=True),
    }


def _strip_scripts(html: str) -> str:
    """Inline non-JSON script bodies dropped; the tag and its attributes stay."""
    soup = BeautifulSoup(html, "html.parser")
    for el in soup.find_all("script"):
        if (el.get("type") or "").strip().lower() != "application/json":
            el.clear()
    return str(soup)


def render(name: str) -> str:
    return normalise(_strip_scripts(_pages()[name]()))


@pytest.fixture(autouse=True)
def _pinned(monkeypatch):
    """Everything a page reads from the process or the release, pinned: the static
    hash, the version strings, the instance flags other tests may flip, the viewer's
    number format and timezone."""
    g = templates.env.globals
    monkeypatch.setitem(g, "static_url", lambda path: "/static/" + path.lstrip("/"))
    monkeypatch.setitem(g, "app_version", "0.0.0")
    monkeypatch.setitem(g, "offline_template_version", "0")
    monkeypatch.setitem(g, "app_ai_enabled", lambda: True)
    monkeypatch.setitem(g, "app_feedback_available", lambda: True)
    monkeypatch.setitem(g, "app_traffic_stats_enabled", lambda: False)
    monkeypatch.setitem(g, "ai_error_fresh", lambda: False)
    monkeypatch.setitem(g, "viewer_is_admin", lambda: False)
    fmt = current_viewer_format.set("iso")
    tz = current_viewer_tz.set("UTC")
    yield
    current_viewer_tz.reset(tz)
    current_viewer_format.reset(fmt)


@pytest.mark.parametrize("name", sorted(_pages()))
def test_rendered_pages_are_fresh(name):
    got = render(name)
    assert "?v=" not in got, "a static URL kept its content hash"
    path = FIXTURE_DIR / f"{name}.html"
    if os.environ.get("RF_UPDATE_GOLDENS"):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(got)
    assert path.exists(), f"missing page {path.name}; see module docstring"
    assert path.read_text() == got, f"{path.name} is stale; see module docstring"


def _offline_spec_ids() -> list[str]:
    items = []
    for line in CONTRACT.read_text().splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) == 3 and cells[1] == "id" and "tests/e2e/offline.spec.mjs" in cells[2]:
            items.append(cells[0].strip("`"))
    return items


def test_contract_ids_appear_in_rendered_pages():
    """Every id the offline e2e suite selects by is on a rendered page, literally or,
    for a prefix entry (``article-row-*``), as an id with that head. The pages read are
    the files the check reads, and they are exactly the page set (an orphan file would
    count as a rendered page)."""
    on_disk = {p.stem for p in FIXTURE_DIR.glob("*.html")}
    assert on_disk == set(_pages()), f"orphan or missing pages: {on_disk ^ set(_pages())}"
    ids = set()
    for p in FIXTURE_DIR.glob("*.html"):
        ids.update(re.findall(r'(?<![\w-])id="([^"]*)"', p.read_text()))
    wanted = _offline_spec_ids()
    assert wanted, "no id entries with tests/e2e/offline.spec.mjs among their consumers"
    absent = [
        item for item in wanted
        if not (any(i.startswith(item[:-1]) for i in ids) if item.endswith("*") else item in ids)
    ]
    assert not absent, f"not on any rendered page: {absent}"

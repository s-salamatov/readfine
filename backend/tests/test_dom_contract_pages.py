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
from datetime import datetime, timezone
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


def _page(template: str, path: str = "/", viewer=VIEWER, sheet=False, **ctx) -> str:
    request = _request()
    request.scope["path"] = path
    if sheet:
        request.scope["headers"] = [(b"hx-target", b"rf-source-sheet-body")]
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


def _sources_context():
    """Fixed subscription and Feed IDs intentionally belong to different domains."""
    folder = SimpleNamespace(id=7, name="News")
    feed = SimpleNamespace(
        id=42, title="Contract source", feed_url="https://example.invalid/feed.xml",
        feed_type="rss", status="active", block_count=0, fetch_error_count=0,
        is_private=False, fetch_interval_min=60, auto_interval_min=60,
        last_fetched_at=None, next_fetch_rel=None, last_published_at=None,
    )
    subscription = SimpleNamespace(
        id=71, feed_id=42, feed=feed, folder=folder, custom_title=None,
        readable_auto_disabled=False,
    )
    return dict(user_feeds=[subscription], folders=[folder, SimpleNamespace(id=8, name="Empty")],
                folder_order="name", folders_arranged=False, filled_folder_ids=[7],
                feed_unread_counts={42: 3}, article_counts={42: 5},
                block_badge_threshold=3, block_disable_threshold=10,
                default_fetch_interval_min=60, added=None)


def _sources_representations():
    # A fixture inventory of separate real responses, not a combined app document.
    # Macro-generated helper IDs must be checked against rendered sheet markup too.
    return "\n<!-- Separate Sources response -->\n".join([
        _page("settings/feeds.html", path="/sources", **_sources_context()),
        _page("settings/opml.html", path="/sources/opml", sheet=True),
        _page("settings/scrape_setup.html", path="/sources/scrape", sheet=True,
              url="https://example.invalid/", title="Contract scrape", selector="[",
              html_sample="", fetch_error="Fixture: page unavailable", ai_selector_available=False,
              **_sources_context()),
    ])


def _assistant_context():
    """Fixed presentation values matching the three route context adapters."""
    from app.models.user import UserSettings
    from app.services.catchup_service import CUSTOM_PROMPT_MAX
    from tests.test_briefing import make_config
    settings = UserSettings(user_id=1, ai_scoring_enabled_default=True,
                            ai_preference_text="High relevance: software and science",
                            ai_preference_auto_days=14, ai_preference_prev_text="Previous interests")
    subscription = _sources_context()["user_feeds"][0]
    subscription.folder_id = subscription.folder.id
    return dict(
        user=SimpleNamespace(id=1, display_name="ann"), section="chat", article=None,
        chat_available=True, chat_setup=None,
        catchup_context=dict(
            catchup_available=True, ai_scoring_available=True,
            user_feeds=[subscription], labels=LABELS[:2], saved_configs=[make_config()],
            default_catchup_prompt="Summarize selected articles.", custom_prompt_max=CUSTOM_PROMPT_MAX,
            period_descs={"today": "from 01 Jan 00:00 · 1 day", "7days": "from 26 Dec 00:00 · 7 days"},
            smtp_available=True, main_model_configured=True, scope_value=None),
        profile_context=dict(s=settings, pref_strong_count=21, pref_auto_status="off",
                             pref_auto_detail={}, gen_blocked=None, gen_blocked_detail={},
                             provider_labels={}, profile_max_chars=5000, profile_min_chars=10),
    )


def _assistant_briefing():
    from tests.test_briefing import make_config
    return _page("app/partials/briefing_modal.html", path="/htmx/catchup-configs/1/briefing",
                 config=make_config(), smtp_available=True, is_admin=False,
                 tz_str="UTC", recipients_allowed=True)


def _relevance_context():
    """One filter with a condition and a label action, so the Filters card renders its
    row (delayed delete hooks included) next to the scoring and Stories cards."""
    labels = [SimpleNamespace(**label) for label in LABELS[:2]]
    flt = SimpleNamespace(
        id=31, name="Contract filter", position=0, is_active=True, stop_on_match=False,
        disabled_reason=None,
        conditions=[SimpleNamespace(field="title", operator="contains", value="rust")],
        actions=[SimpleNamespace(action_type="add_label", action_value="1")],
    )
    s = SimpleNamespace(basic_scoring_enabled=True, ai_score_show_in_list=True,
                        ai_scoring_enabled_default=False, relevance_terms="rust\npython",
                        relevance_terms_updated_at=None, story_dedup="collapse")
    return dict(s=s, active="relevance", term_count=2, corpus_ready=True,
                terms_max_chars=5000, filters=[flt], labels=labels, score_sources=["basic"],
                suppressed_week=0, suppressed_days=7)


def _pages():
    """page -> render(). The minimum set of s2-T11, the shell included."""
    return {
        "assistant": lambda: _page("assistant/page.html", path="/assistant", **_assistant_context()),
        "assistant_briefing": _assistant_briefing,
        "article_row": _row,
        "article_detail": _detail,
        "article_list": lambda: _list(
            [_item(), _item(id=AID + 1, is_read=True)], saved_view=True, has_more=True,
            more_qs="cursor_id=4243"),
        "sidebar": _sidebar,
        "sources": _sources_representations,
        "sources_add": lambda: _page("sources/add.html", path="/sources/add", **_sources_context()),
        "shortcuts": _shortcuts,
        "login": lambda: _page("auth/login.html", path="/login", viewer=None,
                               registration_open=True, email="", next="",
                               error="Wrong email or password."),
        "reading": lambda: _page("settings/reading.html", path="/settings/reading",
                                 s=_settings(), bookmarklet="javascript:void(0)"),
        "relevance": lambda: _page("settings/relevance.html", path="/settings/relevance",
                                   **_relevance_context()),
        "labels": lambda: _page("settings/labels.html", path="/settings/labels",
                                labels=[SimpleNamespace(**label) for label in LABELS[:3]]),
        "account": lambda: _page("settings/profile.html", path="/settings/profile",
                                 user=SimpleNamespace(id=1, email="ann@example.invalid",
                                                      display_name="ann", role="user")),
        "tokens": lambda: _page("settings/tokens.html", path="/settings/tokens", tokens=[
            SimpleNamespace(id=9, name="CLI", token_prefix="rf_abcd",
                            created_at=datetime(2026, 1, 2, 3, 4, tzinfo=timezone.utc),
                            last_used_at=None)]),
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
    if name == "sources_add":
        # app.js uses this ID to opt authenticated subscriptions into privacy.
        fragment = _page("sources/add.html", path="/sources/add", sheet=True, **_sources_context())
        checkbox = BeautifulSoup(fragment, "html.parser").select_one("#feed-is-private")
        assert checkbox is not None and checkbox.get("name") == "is_private"
        assert checkbox.get("type") == "checkbox"
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

"""The offline renderers in ``static/js/offline/templates.js`` draw what the server draws.

The service worker answers some requests offline with HTML strings built by
``templates.js``; each renderer is a hand copy of a Jinja partial (or a Python
helper). Nothing ties the copy to its source, so a partial changed without its
mirror would quietly draw a different fragment offline.

This is the server half of the drift harness. Each case renders a fragment from its
real source with a fixed context, normalises it (``normalise`` below) and keeps it as
``tests/fixtures/offline_drift/<case>.html``. The JS half
(``tests/js/offline-drift.test.mjs``) renders the same case through ``templates.js``
from the IndexedDB-shaped record its adapter builds (``tests/js/offline-drift/
adapters.mjs``), normalises it the same way and compares it with that file.

``fixtures/offline_drift/cases.json`` is the case list both halves keep. An entry with
``source: null`` is an offline-only renderer with no server counterpart, listed with
its reason and not rendered here.

When a partial changes on purpose, regenerate with
``RF_UPDATE_GOLDENS=1 uv run pytest tests/test_offline_drift.py``, update the mirror in
``templates.js`` and run the JS half. Adding a case: add it to ``_cases()``, to
``cases.json`` and to ``CASES`` in the adapters.
"""
import json
import os
import re
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Callable

import pytest
from bs4 import BeautifulSoup, Comment, NavigableString, Tag
from starlette.requests import Request

from app.routers.web.app.common import _badge_html
from app.schemas.article import ArticleListItem, ArticleResponse, StoryMember
from app.services.counts_service import SidebarCounts
from app.templating import templates
from app.utils.datetime_format import current_viewer_tz
from app.utils.formats import current_viewer_format

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "offline_drift"
CASES_JSON = FIXTURE_DIR / "cases.json"
WHEN = datetime(2020, 1, 2, 3, 4, tzinfo=timezone.utc)
AID = 4242

# Same data as LABELS in tests/js/offline-drift/adapters.mjs. The first name carries
# characters both sides must escape.
LABELS = [
    {"id": 1, "name": "R&D <x>", "color": "#e11d48"},
    {"id": 2, "name": "Work", "color": "#2563eb"},
    {"id": 3, "name": "Three", "color": "#16a34a"},
    {"id": 4, "name": "Four", "color": "#ca8a04"},
    {"id": 5, "name": "Five", "color": "#9333ea"},
    {"id": 6, "name": "Six", "color": "#0891b2"},
    {"id": 7, "name": "Seven", "color": "#db2777"},
]
SUMMARY_MD = "**Key** point & <i>more</i>\n\n- one\n- two"
CONTEXT_MD = "Context *here*."


# ---- normalisation (mirrored by normalise() in tests/js/offline-drift.test.mjs) ------

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
        "source", "track", "wbr"}


def _collapse(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _esc_text(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _esc_attr(s: str) -> str:
    return _esc_text(s).replace('"', "&quot;")


def _attrs(tag: Tag) -> str:
    out = []
    for name, value in tag.attrs.items():
        value = " ".join(value) if isinstance(value, list) else (value or "")
        name = name.lower()
        value = " ".join(sorted(value.split())) if name == "class" else _collapse(value)
        out.append((name, value))
    return "".join(f' {n}="{_esc_attr(v)}"' if v else f" {n}" for n, v in sorted(out))


def normalise_css(text: str) -> list[str]:
    """CSS as one leaf rule per line, each wrapped in its at-rules so every line is
    valid CSS on its own (``@layer utilities{@media (x){.a{b:c}}}``): comments
    dropped, whitespace collapsed and removed around ``{};:,>!`` and inside
    parentheses, the last ``;`` of a block dropped, ``0.5`` written ``.5``."""
    text = re.sub(r"/\*[\s\S]*?\*/", "", text)
    text = _collapse(text)
    text = re.sub(r"\s*([{};:,>!])\s*", r"\1", text)
    text = re.sub(r"\(\s+", "(", re.sub(r"\s+\)", ")", text))
    text = text.replace(";}", "}")
    text = re.sub(r"(^|[^\w.-])0\.(\d)", r"\1.\2", text)
    out: list[str] = []
    stack: list[str] = []
    buf = ""
    for ch in text:
        if ch == "{":
            stack.append(buf.strip())
            buf = ""
        elif ch == "}":
            if buf.strip():
                out.append("".join(p + "{" for p in stack) + buf.strip() + "}" * len(stack))
            buf = ""
            if stack:
                stack.pop()
        else:
            buf += ch
    return out


def normalise_json(text: str) -> str:
    """A JSON data block as compact JSON with sorted keys."""
    return json.dumps(json.loads(text), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def normalise(html: str) -> str:
    """One node per line, indented by depth: tags and attribute names lower-case,
    attributes sorted, ``class`` tokens sorted, an empty value written as the bare
    name, text whitespace collapsed (whitespace-only text dropped), comments dropped,
    entities decoded and re-escaped one way. Ends with a newline unless empty.

    ``<style>`` and ``<script>`` hold raw text and are written unescaped, one line
    per item: a style as ``normalise_css`` rules, a ``type="application/json"``
    script as ``normalise_json``, any other script whitespace-collapsed."""
    lines: list[str] = []

    def walk(node, depth: int) -> None:
        for child in node.children:
            pad = "  " * depth
            if isinstance(child, Comment):
                continue
            if isinstance(child, NavigableString):
                text = _collapse(str(child))
                if text:
                    lines.append(pad + _esc_text(text))
                continue
            if not isinstance(child, Tag):
                continue
            name = child.name.lower()
            lines.append(f"{pad}<{name}{_attrs(child)}>")
            if name in VOID:
                continue
            if name in ("style", "script"):
                raw = "".join(str(t) for t in child.children)
                if name == "style":
                    body = normalise_css(raw)
                elif (child.get("type") or "").strip().lower() == "application/json":
                    body = [normalise_json(raw)] if raw.strip() else []
                else:
                    body = [_collapse(raw)] if raw.strip() else []
                lines.extend("  " * (depth + 1) + b for b in body)
            else:
                walk(child, depth + 1)
            lines.append(f"{pad}</{name}>")

    walk(BeautifulSoup(html, "html.parser"), 0)
    return "\n".join(lines) + "\n" if lines else ""


# ---- rendering from the real sources --------------------------------------------------

def _request() -> Request:
    return Request({
        "type": "http", "method": "GET", "path": "/", "query_string": b"",
        "headers": [(b"host", b"testserver")], "scheme": "http",
        "server": ("testserver", 80), "root_path": "",
    })


def _item(**kw) -> ArticleListItem:
    base = dict(
        id=AID, feed_id=7, feed_title="Feed T", url="https://pub.example/a",
        title="Title", author="Ann", summary="Sum", snippet="Snip",
        published_at=WHEN, formatted_date="02.01.2020", estimated_read_min=3,
        image_url=None, is_read=False, is_starred=False, is_archived=False,
    )
    story = {k: kw.pop(k) for k in ("story_others", "story_total", "story_read") if k in kw}
    base.update(kw)
    item = ArticleListItem(**base)
    for k, v in story.items():
        setattr(item, k, v)
    return item


def _article(**kw) -> ArticleResponse:
    base = dict(
        id=AID, feed_id=7, feed_title="Feed T", url="https://pub.example/a",
        title="Title", author="Ann", content="<p>Body</p>", content_source="feed",
        readable_content=None, readable_status="skipped", published_at=WHEN,
        estimated_read_min=3, word_count=500, image_url=None, is_read=False,
        is_starred=False, is_archived=False, read_at=None,
    )
    base.update(kw)
    return ArticleResponse(**base)


def _partial(template: str, **ctx) -> str:
    return templates.env.get_template(f"app/partials/{template}").render(request=_request(), **ctx)


def _macro(template: str, name: str, *args, **kw) -> str:
    module = templates.env.get_template(f"app/partials/{template}").module
    return str(getattr(module, name)(*args, **kw))


def _inner(html: str, selector: str) -> str:
    """Inner HTML of the first element matching ``selector``; '' when there is none
    (the JS renderer then has to answer '' too)."""
    el = BeautifulSoup(html, "html.parser").select_one(selector)
    return el.decode_contents() if el else ""


def _outer(html: str, selector: str) -> str:
    el = BeautifulSoup(html, "html.parser").select_one(selector)
    return str(el) if el else ""


def _row(article: ArticleListItem, density: str = "comfortable", label_display: str = "indicator",
         **ctx) -> str:
    return _partial("article_row.html", article=article, density=density,
                    label_display=label_display, **ctx)


def _content(article: ArticleResponse, **ctx) -> str:
    base = dict(chat_available=False, related_count=0, show_score=True)
    base.update(ctx)
    return _partial("article_content.html", article=article, **base)


def _picker(assigned_ids: list[int], all_labels: list[dict], oob: bool = False,
            label_display: str = "indicator") -> str:
    return _partial("label_picker.html", article_id=AID, all_labels=all_labels,
                    assigned=set(assigned_ids), show_oob=oob,
                    assigned_labels=[lab for lab in all_labels if lab["id"] in assigned_ids],
                    label_display=label_display)


def _story_member(**kw) -> StoryMember:
    base = dict(id=AID + 1, title="Other <take>", url="https://www.news.example/b",
                feed_title="Feed T", published_at=WHEN, is_read=False, is_starred=False,
                ai_score=None, lexical_score=None)
    base.update(kw)
    return StoryMember(**base)


def _story_members(members: list[StoryMember], show_ai_score: bool = True) -> str:
    return _partial("story_members.html", article_id=AID, members=members,
                    show_ai_score=show_ai_score, show_similarity=False, suppress_threshold=0.5)


# ---- article_list.html: the list header and the list page around its rows -----------

LIST_CFG = dict(mark_read_on_scroll=True, density="comfortable", label_display="indicator",
                title_bar_count=None, title_bar_count_type=None)
# Same data as SAVED_SEARCH in the adapters.
SAVED_SEARCH = SimpleNamespace(id=3, name="Daily <AI> & more")
# Same data as VIEW_CHOICES and folderChips(SIDEBAR_LISTS, 10) in the adapters.
VIEW_CHOICES = {"density": "compact", "sort": "oldest", "unread": "unread_only", "stories": "off"}
FOLDER_CHIPS = [
    {"label": "All", "nav": "/htmx/articles", "active": False},
    {"label": "Alpha & co", "nav": "/htmx/articles?folder_id=10", "active": True},
    {"label": "beta", "nav": "/htmx/articles?folder_id=11", "active": False},
]


def _list(articles: list | None = None, **ctx) -> str:
    request = _request()
    request.state.csp_nonce = "drift-nonce"
    base = dict(articles=articles or [], has_feeds=True, **LIST_CFG)
    base.update(ctx)
    return templates.env.get_template("app/partials/article_list.html").render(request=request, **base)


def _list_header(html: str) -> str:
    """The header and, under it, the folder chips: templates.js listHeader draws both."""
    return _outer(html, "[data-list-header]") + _outer(html, "[data-rf-chips]")


def _list_page(html: str) -> str:
    """The list without its header and chips (cases of their own) and with each row,
    snapshot HTML the server renders for both sides, as a placeholder the adapter
    passes too."""
    soup = BeautifulSoup(html, "html.parser")
    for el in soup.select("[data-list-header], [data-rf-chips]"):
        el.decompose()
    for el in soup.select("div.article-row[data-article-id]"):
        el.replace_with(BeautifulSoup(f'<div data-drift-row="{el["data-article-id"]}"></div>',
                                      "html.parser"))
    return str(soup)


# ---- sidebar.html ---------------------------------------------------------------------
# Same data as the sidebar fixtures in the adapters. Lists in the server's order, which
# the offline renderer reproduces by sorting (labels by position, saved searches by
# name, folders by name with "No folder" last, feeds by title).

def _uf(feed_id: int, title: str, folder: SimpleNamespace | None, custom_title: str | None = None,
        status: str = "active", last_error: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(feed_id=feed_id, folder_id=folder.id if folder else None, folder=folder,
                           custom_title=custom_title,
                           feed=SimpleNamespace(title=title, status=status, last_error=last_error))


ALPHA = SimpleNamespace(id=10, name="Alpha & co")
BETA = SimpleNamespace(id=11, name="beta")
SIDEBAR_FEEDS = [
    _uf(101, "Ann's blog", ALPHA, custom_title="Ann <custom>"),
    _uf(102, "Zeta news", ALPHA),
    _uf(103, "Broken feed", BETA, status="error", last_error="HTTP 500"),
    _uf(104, "Loose feed", None),
]
SIDEBAR_COUNTS = dict(
    nav_total=9, nav_unread=5, nav_starred=2, nav_unread_starred=0,
    nav_archived=0, nav_unread_archived=0, nav_saved=3, nav_unread_saved=1,
    nav_labeled=4, nav_unread_labeled=0,
    feed_total_counts={101: 4, 102: 1, 103: 2, 104: 130},
    feed_unread_counts={101: 3, 102: 0, 103: 0, 104: 120},
    folder_total_counts={10: 5, 11: 2, None: 130},
    folder_unread_counts={10: 3, 11: 0, None: 120},
    label_counts={1: 3, 2: 1}, label_unread_counts={1: 2},
)
SIDEBAR_SAVED = [SimpleNamespace(id=3, name="Daily <AI> & more"), SimpleNamespace(id=4, name="zed")]


def _sidebar(feeds=SIDEBAR_FEEDS, labels=LABELS[:2], saved=SIDEBAR_SAVED, counts=SIDEBAR_COUNTS,
             **ctx) -> str:
    base = dict(
        user=SimpleNamespace(display_name="ann", role="user"),
        user_feeds=feeds, user_labels=labels, saved_searches=saved, **counts,
        pinned=True, chat_available=True, catchup_available=True, mark_read_auto_advance=True,
        # Globals the user menu reads, pinned so the fixture does not follow the release
        # or the instance settings.
        app_version="0.0.0", app_feedback_available=lambda: False, ai_error_fresh=lambda: False,
    )
    base.update(ctx)
    return _partial("sidebar.html", **base)


def _without_style(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for el in soup.select("style"):
        el.decompose()
    return str(soup)


ROW_LABELS = f"#article-labels-{AID}"
STORY_MARKER = "span.whitespace-nowrap[title]"
STORY_LINE = "div.mt-1.pl-6"


def _cases() -> dict[str, Callable[[], str]]:
    """case name -> renderer of its source. Names start with the source they render."""
    two, seven = LABELS[:2], LABELS
    return {
        # badges.html and the _badge_html helper (routers/web/app/common.py)
        "badges-unread": lambda: _macro("badges.html", "badge_unread", 12345),
        "badges-total": lambda: _macro("badges.html", "badge_total", 7),
        "badge_html-unread": lambda: _badge_html(5, 9),
        "badge_html-total": lambda: _badge_html(0, 1234),
        # state buttons
        "read_button-read": lambda: _partial("read_button.html", article=_article(is_read=True)),
        "read_button-unread": lambda: _partial("read_button.html", article=_article()),
        "star_icon-starred": lambda: _partial("star_icon.html", article=_article(is_starred=True)),
        "star_icon-unstarred": lambda: _partial("star_icon.html", article=_article()),
        "archive_button-archived": lambda: _partial("archive_button.html",
                                                    article=_article(is_archived=True)),
        "archive_button-active": lambda: _partial("archive_button.html", article=_article()),
        "share_button-shared": lambda: _partial("share_button.html",
                                                article=_article(share_token="tok")),
        "share_button-unshared": lambda: _partial("share_button.html", article=_article()),
        # the row's label trigger, per label_display
        "article_row-labels-indicator-some": lambda: _inner(_row(_item(labels=two)), ROW_LABELS),
        "article_row-labels-indicator-empty": lambda: _inner(_row(_item()), ROW_LABELS),
        "article_row-labels-dots-seven": lambda: _inner(
            _row(_item(labels=seven), label_display="dots"), ROW_LABELS),
        "article_row-labels-dots-seven-compact": lambda: _inner(
            _row(_item(labels=seven), density="compact", label_display="dots"), ROW_LABELS),
        "article_row-labels-dots-empty": lambda: _inner(
            _row(_item(), label_display="dots"), ROW_LABELS),
        "article_row-labels-none": lambda: _inner(
            _row(_item(labels=two), label_display="none"), ROW_LABELS),
        # the detail's label parts (article_content.html, included by article_detail.html)
        "article_content-labels-chips": lambda: _inner(
            _content(_article(labels=two)), f"#detail-labels-{AID}"),
        "article_content-labels-chips-empty": lambda: _inner(
            _content(_article()), f"#detail-labels-{AID}"),
        "article_content-label-dot-some": lambda: _inner(
            _content(_article(labels=two)), f"#detail-labels-btn-{AID}"),
        "article_content-label-dot-empty": lambda: _inner(
            _content(_article()), f"#detail-labels-btn-{AID}"),
        # label_picker.html
        "label_picker-list": lambda: _picker([2], two),
        "label_picker-empty": lambda: _picker([], []),
        "label_picker-oob": lambda: _picker([1, 2], seven, oob=True),
        "label_picker-oob-unassigned": lambda: _picker([], two, oob=True),
        "label_picker-oob-dots": lambda: _picker([l["id"] for l in seven], seven, oob=True,
                                                 label_display="dots"),
        # ai_blocks.html
        "ai_blocks-summary": lambda: _macro("ai_blocks.html", "ai_summary", AID, SUMMARY_MD),
        "ai_blocks-summary-truncated": lambda: _macro("ai_blocks.html", "ai_summary", AID,
                                                      SUMMARY_MD, truncated=True),
        "ai_blocks-context": lambda: _macro("ai_blocks.html", "ai_context", AID, CONTEXT_MD),
        # score_badge.html
        "score_badge-ai-high": lambda: _macro("score_badge.html", "score_badge",
                                              _item(ai_score=0.82, lexical_score=0.31)),
        "score_badge-basic-mid": lambda: _macro("score_badge.html", "score_badge",
                                                _item(ai_score=None, lexical_score=0.52)),
        "score_badge-ai-low": lambda: _macro("score_badge.html", "score_badge",
                                             _item(ai_score=0.13, lexical_score=None)),
        "score_badge-none": lambda: _macro("score_badge.html", "score_badge",
                                           _item(ai_score=None, lexical_score=None)),
        # the detail footer's scores (article_content.html)
        "article_content-score-both": lambda: _inner(
            _content(_article(ai_score=0.82, lexical_score=0.52)), "[data-rf-slot=score-badge]"),
        "article_content-score-basic": lambda: _inner(
            _content(_article(ai_score=None, lexical_score=0.13)), "[data-rf-slot=score-badge]"),
        # story_block.html and the row story parts (article_row.html)
        "story_block-one": lambda: _partial("story_block.html", article=_article(), related_count=1),
        "story_block-many": lambda: _partial("story_block.html", article=_article(), related_count=4),
        "story_block-none": lambda: _partial("story_block.html", article=_article(), related_count=0),
        "article_row-story-marker": lambda: _outer(
            _row(_item(story_others=3, story_total=3), density="compact"), STORY_MARKER),
        "article_row-story-marker-filtered": lambda: _outer(
            _row(_item(story_others=2, story_total=7, story_read=1), density="compact"),
            STORY_MARKER),
        "article_row-story-line": lambda: _outer(
            _row(_item(story_others=1, story_total=1)), STORY_LINE),
        "article_row-story-line-interactive-filtered": lambda: _outer(
            _row(_item(story_others=2, story_total=7, story_read=1), story_unfoldable=True),
            STORY_LINE),
        # story_members.html (the unfolded story footer)
        "story_members-mixed": lambda: _story_members([
            _story_member(is_starred=True, ai_score=0.82, lexical_score=0.31),
            _story_member(id=AID + 2, title="Read one", feed_title=None, is_read=True,
                          lexical_score=0.52, url="https://www.other.example/c"),
            _story_member(id=AID + 3, title="Bare", url=None, published_at=None),
        ]),
        "story_members-no-score": lambda: _story_members(
            [_story_member(ai_score=0.82)], show_ai_score=False),
        "story_members-read-by-reader": lambda: _story_members(
            [_story_member(is_read=True, read_by_reader=True)]),
        "story_members-same-link": lambda: _story_members([_story_member(same_link=True)]),
        # article_list.html: the header variants
        "article_list-header-plain": lambda: _list_header(_list(
            view_title="R&D <x>", view_choices=VIEW_CHOICES, title_bar_count=1234,
            title_bar_count_type="unread")),
        "article_list-header-chips": lambda: _list_header(_list(
            view_title="Alpha & co", view_choices=VIEW_CHOICES, folder_chips=FOLDER_CHIPS)),
        "article_list-header-saved": lambda: _list_header(_list(saved_view=True)),
        "article_list-header-saved-search-unread": lambda: _list_header(_list(
            saved_search=SAVED_SEARCH, saved_search_values='{"q": "ai"}', result_count=1234,
            view_unread=True, view_filtered=True)),
        "article_list-header-saved-search-total": lambda: _list_header(_list(
            saved_search=SAVED_SEARCH, saved_search_values='{"q": "ai"}', result_count=1)),
        "article_list-header-search": lambda: _list_header(_list(
            search_query='R&D "x"', filter_active=True, filter_count=0, result_count=2)),
        # article_list.html: rows, sentinel, end spacer or empty state, cfg island
        "article_list-page-rows-more": lambda: _list_page(_list(
            [_item(), _item(id=AID + 1, is_read=True)], has_more=True,
            more_qs="cursor_id=4243&feed_id=7")),
        "article_list-page-rows-end": lambda: _list_page(_list([_item()], has_more=False)),
        "article_list-page-empty-saved": lambda: _list_page(_list(saved_view=True)),
        "article_list-page-empty-saved-search": lambda: _list_page(_list(
            saved_search=SAVED_SEARCH, result_count=0)),
        "article_list-page-empty-saved-search-unread": lambda: _list_page(_list(
            saved_search=SAVED_SEARCH, result_count=0, view_unread=True, view_filtered=True,
            title_bar_count=0, title_bar_count_type="unread")),
        "article_list-page-empty-search": lambda: _list_page(_list(
            search_query="nothing", filter_active=True, result_count=0, mark_read_on_scroll=False)),
        "article_list-page-empty-plain": lambda: _list_page(_list(density="compact")),
        # sidebar.html: rail, full part, the empty account, and its <style> block
        "sidebar-rail": lambda: _outer(_sidebar(), "#sidebar-rail"),
        "sidebar-full": lambda: _outer(_sidebar(), "#sidebar-full"),
        "sidebar-empty": lambda: _without_style(_sidebar(
            feeds=[], labels=[], saved=[], counts=asdict(SidebarCounts()), chat_available=False,
            catchup_available=False, mark_read_auto_advance=False)),
        "sidebar-style": lambda: _outer(_sidebar(), "style"),
    }


@pytest.fixture(autouse=True)
def _iso_numbers():
    """Badges go through ``|num``, which reads the viewer's format profile, and dates
    through ``|localtime``, which reads the viewer's timezone; pin the defaults
    (``iso`` and ``UTC``, what the adapters pass) whatever an earlier test left behind."""
    token = current_viewer_format.set("iso")
    tz_token = current_viewer_tz.set("UTC")
    yield
    current_viewer_tz.reset(tz_token)
    current_viewer_format.reset(token)


def _cases_json() -> list[dict]:
    return json.loads(CASES_JSON.read_text())


@pytest.mark.parametrize("name", sorted(_cases()))
def test_drift_fixtures_are_fresh(name):
    got = normalise(_cases()[name]())
    path = FIXTURE_DIR / f"{name}.html"
    if os.environ.get("RF_UPDATE_GOLDENS"):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(got)
    assert path.exists(), f"missing fixture {path.name}; see module docstring"
    assert path.read_text() == got, f"{path.name} is stale; see module docstring"


def test_drift_cases_match_js_adapters():
    """The case list here equals cases.json, the list the JS adapters are checked
    against. Offline-only entries (source null) carry a reason and no fixture."""
    entries = _cases_json()
    names = [e["name"] for e in entries]
    assert len(names) == len(set(names)), "duplicate names in cases.json"
    assert sorted(e["name"] for e in entries if e["source"]) == sorted(_cases())
    for e in entries:
        if e["source"] is None:
            assert e.get("reason"), f"{e['name']}: an offline-only case needs a reason"
            assert not (FIXTURE_DIR / f"{e['name']}.html").exists()
    on_disk = {p.stem for p in FIXTURE_DIR.glob("*.html")}
    assert on_disk == set(_cases()), f"orphan or missing fixtures: {on_disk ^ set(_cases())}"

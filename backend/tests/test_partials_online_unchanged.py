"""The overlay hooks leave the online rendering of the article partials unchanged.

The offline overlay (``data-rf-*`` attributes, see ``app.services.sync.snapshots``)
is added to the same partials the online app renders. Online, those partials must
draw exactly what they drew before the hooks: same elements, same text, same
``hx-*`` and every other attribute; only ``data-rf-*`` may be added, and nothing
that the snapshot-only flag (``rf_snapshot``) emits may leak in.

The goldens under ``tests/fixtures/partials_online/`` were captured from the partials
as they were before the hooks, with the ``data-rf-*`` attributes stripped. When a
partial changes on purpose, regenerate them with
``RF_UPDATE_GOLDENS=1 uv run pytest tests/test_partials_online_unchanged.py`` and
review the diff: it must show the intended change and nothing else.
"""
import os
from datetime import datetime, timezone
from pathlib import Path

import pytest
from bs4 import BeautifulSoup
from starlette.requests import Request

from app.schemas.article import ArticleListItem, ArticleResponse
from app.templating import templates

GOLDEN_DIR = Path(__file__).parent / "fixtures" / "partials_online"
WHEN = datetime(2020, 1, 2, 3, 4, tzinfo=timezone.utc)
LABELS = [{"id": i, "name": f"L{i}", "color": f"#00000{i}"} for i in range(1, 7)]


def _request() -> Request:
    return Request({
        "type": "http", "method": "GET", "path": "/", "query_string": b"",
        "headers": [(b"host", b"testserver")], "scheme": "http",
        "server": ("testserver", 80), "root_path": "",
    })


def _item(**kw) -> ArticleListItem:
    base = dict(
        id=4242, feed_id=7, feed_title="Feed T", url="https://pub.example/a",
        title="Title <b>", author="Ann", summary="Sum", snippet="Snip",
        published_at=WHEN, formatted_date="02.01.2020", estimated_read_min=3,
        image_url=None, is_read=False, is_starred=False, is_archived=False,
    )
    base.update(kw)
    return ArticleListItem(**base)


def _full_item(**kw) -> ArticleListItem:
    item = _item(is_read=True, is_starred=True, is_archived=True, is_saved=True,
                 ai_score=0.8, lexical_score=0.3, labels=LABELS, story_id=5, **kw)
    item.story_others, item.story_total, item.story_read = 2, 3, 1
    return item


BODY = (
    '<p>Hello <img src="https://img.example/a.jpg" alt="a"></p>'
    '<figure data-video-provider="youtube" data-video-id="abcdefghijk">'
    '<a href="https://www.youtube.com/watch?v=abcdefghijk">'
    '<img src="/img/video-thumb/youtube/abcdefghijk" alt="Video thumbnail"></a>'
    '<figcaption>&#9654; Watch on YouTube</figcaption></figure>'
)


def _article(**kw) -> ArticleResponse:
    base = dict(
        id=4242, feed_id=7, feed_title="Feed T", url="https://pub.example/a",
        title="Title <b>", author="Ann", content=BODY, content_source="feed",
        readable_content=None, readable_status="skipped", published_at=WHEN,
        estimated_read_min=3, word_count=500, image_url=None, is_read=False,
        is_starred=False, is_archived=False, read_at=None,
    )
    base.update(kw)
    return ArticleResponse(**base)


def _full_article(**kw) -> ArticleResponse:
    return _article(
        is_read=True, is_starred=True, is_archived=True, is_saved=True,
        share_token="tok", ai_summary="**Sum**", ai_summary_truncated=True,
        ai_context="Ctx", ai_score=0.8, lexical_score=0.3, labels=LABELS[:2],
        story_id=5, **kw,
    )


DETAIL_FULL_CTX = dict(mark_read_on_scroll=False, ai_available=True, summary_pending=False,
                       chat_available=True, chat_messages=[], related_count=2, show_score=True)
DETAIL_MIN_CTX = dict(mark_read_on_scroll=True, ai_available=False, summary_pending=False,
                      chat_available=False, chat_messages=[], related_count=0, show_score=False)


def _cases():
    """name -> (template, context). Covers each branch a hook sits in."""
    cases = {}
    for d in ("compact", "comfortable", "summary"):
        for ld in ("indicator", "dots", "none"):
            cases[f"row-{d}-{ld}-plain"] = ("article_row.html", dict(
                article=_item(), density=d, label_display=ld, show_ai_score=False))
            cases[f"row-{d}-{ld}-full"] = ("article_row.html", dict(
                article=_full_item(), density=d, label_display=ld, show_ai_score=True,
                story_unfoldable=True, chat_article_ids={4242}))
        cases[f"row-{d}-child"] = ("article_row.html", dict(
            article=_full_item(), density=d, label_display="dots", show_ai_score=True,
            story_child=99))
        cases[f"row-{d}-saving"] = ("article_row.html", dict(
            article=_item(feed_id=None, readable_active=True, published_at=None),
            density=d, label_display="indicator"))
    cases["detail-plain"] = ("article_detail.html", dict(article=_article(), **DETAIL_MIN_CTX))
    cases["detail-full"] = ("article_detail.html", dict(article=_full_article(), **DETAIL_FULL_CTX))
    cases["detail-pending-summary"] = ("article_detail.html", dict(
        article=_article(), **{**DETAIL_FULL_CTX, "summary_pending": True}))
    cases["detail-failed"] = ("article_detail.html", dict(
        article=_article(content=None, readable_status="failed", readable_error="HTTP 403"),
        **DETAIL_MIN_CTX))
    cases["detail-saved-desc"] = ("article_detail.html", dict(
        article=_article(feed_id=None, content=None, summary="desc", readable_status="pending",
                         published_at=None), **DETAIL_MIN_CTX))
    cases["content-full"] = ("article_content.html", dict(
        article=_full_article(), chat_available=False, related_count=1, show_score=True))
    cases["content-plain"] = ("article_content.html", dict(
        article=_article(), chat_available=False, related_count=0, show_score=False))
    cases["read-button-read"] = ("read_button.html", dict(article=_article(is_read=True)))
    cases["read-button-unread"] = ("read_button.html", dict(article=_article()))
    return cases


def render_case(name: str) -> str:
    template, ctx = _cases()[name]
    return templates.env.get_template(f"app/partials/{template}").render(request=_request(), **ctx)


def canonical(html: str) -> str:
    """The rendering as a comparable string, with every ``data-rf-*`` attribute removed.

    Attribute order is sorted and whitespace runs collapsed (class lists are compared
    as token lists), so a hook placed anywhere in a tag compares equal to the tag
    without it, while any change to an element, its text or another attribute does not.
    """
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup.find_all(True):
        for attr in [a for a in tag.attrs if a.startswith("data-rf-")]:
            del tag.attrs[attr]
        for attr, value in list(tag.attrs.items()):
            if isinstance(value, list):
                tag.attrs[attr] = " ".join(value)
            elif isinstance(value, str):
                tag.attrs[attr] = " ".join(value.split())
        tag.attrs = dict(sorted(tag.attrs.items()))
    lines = []
    for el in soup.descendants:
        if isinstance(el, str):
            text = " ".join(el.split())
            if text:
                lines.append(f"T {text}")
        else:
            lines.append(f"<{el.name} {el.attrs}")
    return "\n".join(lines) + "\n"


@pytest.mark.parametrize("name", sorted(_cases()))
def test_partials_online_unchanged(name):
    got = canonical(render_case(name))
    path = GOLDEN_DIR / f"{name}.txt"
    if os.environ.get("RF_UPDATE_GOLDENS"):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(got)
    assert path.exists(), f"missing golden {path.name}; see module docstring"
    assert got == path.read_text()


def test_hooks_present_online():
    """The online rendering carries the always-on hooks (not the snapshot-only slots)."""
    row = render_case("row-comfortable-dots-full")
    assert 'data-rf-article="4242"' in row
    assert 'data-rf-slot="star-button"' in row and 'data-rf-slot="labels"' in row
    assert 'data-rf-time="2020-01-02T03:04:00+00:00"' in row
    detail = render_case("detail-full")
    assert 'data-rf-article="4242"' in detail and 'data-rf-slot="read-button"' in detail
    # snapshot-only placeholders never render online
    for html in (row, detail, render_case("detail-plain")):
        assert "data-rf-placeholder" not in html

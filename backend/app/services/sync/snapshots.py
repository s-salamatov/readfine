"""Per-user offline snapshots: the article row and detail as this user's browser draws them.

The device keeps these HTML fragments and shows them offline. They are rendered with
the same partials and the same context helpers as the live routes (the row poll and
the article detail), with the reader's own density, label display, score display,
timezone and date format, so offline looks like online.

What changes without the article changing (read, star, archive, saved, labels, scores,
AI summary/context, the story count) is *not* baked in: every snapshot is rendered in a
neutral state (unread, unstarred, unarchived, unsaved, no labels, no scores, no AI
blocks, no story marker) with ``rf_snapshot`` set, which draws the empty
``data-rf-slot`` elements the device overlay fills from its local copy of the state.
What is per reader rather than per article is rendered for real: the AI actions and
the chat entry point appear when this reader has AI (that availability is part of
``prefs_version``), the chat one marked ``data-rf-online-only``.

Nothing session-bound goes in: the partials carry no CSRF token or CSP nonce (the
CSRF header is added by the page's htmx config, not by these fragments), the share
token is part of the neutral state, and the live pollers (row poll, readable
progress) are left out by rendering with ``readable_active`` off.

Article images are rewritten to signed same-origin ``/m/...`` URLs (see ``media``);
a URL that is neither a same-origin path, ``data:``, nor absolute http(s) is dropped:
``src``/``srcset`` of ``<img>`` and ``<source>``, and ``poster`` of ``<video>``. Video
and audio files themselves are not proxied (images only in this version), and a
YouTube/Vimeo player iframe, should a body still hold one, becomes the thumbnail
facade the app stores for videos anyway.
"""
import asyncio
import re
from html.parser import HTMLParser
from urllib.parse import urlsplit

from bs4 import BeautifulSoup
from fastapi import Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.article import Article, UserArticleState
from app.models.user import User, UserSettings
from app.services.sync import OFFLINE_TEMPLATE_VERSION
from app.services.sync.full_text import full_text_flag
from app.services.sync.manifest import prefs_version
from app.services.sync.media import sign_media_url
from app.services.sync.scope import in_offline_scope
from app.templating import templates
from app.utils.datetime_format import current_viewer_tz
from app.utils.formats import current_viewer_format
from app.utils.video import collect_video_figures, rewrite_thumb_srcs

MAX_SNAPSHOT_IDS = 50

# The state fields the overlay owns, and the neutral value each snapshot is drawn with.
_NEUTRAL_ROW = {
    "is_read": False, "is_starred": False, "is_archived": False, "is_saved": False,
    "labels": [], "ai_score": None, "lexical_score": None, "readable_active": False,
}
_NEUTRAL_DETAIL = {
    **_NEUTRAL_ROW, "read_at": None, "share_token": None, "ai_summary": None,
    "ai_summary_truncated": False, "ai_context": None,
}


# What a browser strips from a URL before parsing it, and what it reads "\\" as. Done
# here first, so the decision below is made on the URL the browser would actually load.
_URL_STRIP_RE = re.compile(r"[\t\n\r]")
_SAME_ORIGIN_RE = re.compile(r"^/(?![/\\])")
# The tags offline_body rewrites; a body without any is returned as it is.
_MEDIA_TAG_RE = re.compile(r"<\s*(?:img|source|video|iframe)\b", re.IGNORECASE)


def _proxied(url: str, user_id: int) -> str | None:
    """The URL the snapshot carries for an image *url*, or None to drop it.

    ``data:`` stays as it is; a same-origin path stays as it is; an absolute http(s)
    URL (protocol-relative included) is signed. Anything else -- a relative path the
    body has no base for, another scheme -- is dropped rather than left for the
    browser to resolve against our origin or to run.
    """
    url = _URL_STRIP_RE.sub("", url).strip()
    if url[:5].lower() == "data:":
        return url
    url = url.replace("\\", "/")
    if _SAME_ORIGIN_RE.match(url):
        return url
    if url.startswith("//"):
        url = "https:" + url
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    return sign_media_url(url, user_id)


def _proxied_srcset(value: str, user_id: int) -> str | None:
    out = []
    for cand in value.split(","):
        parts = cand.split(None, 1)
        if not parts:
            continue
        url = _proxied(parts[0], user_id)
        if url is None:
            continue
        out.append(" ".join([url, *parts[1:]]))
    return ", ".join(out) or None


def _set_or_drop(tag, attr: str, value: str | None) -> None:
    if value is None:
        del tag[attr]
    else:
        tag[attr] = value


def offline_body(html: str | None, user_id: int) -> str | None:
    """An article body ready for a snapshot: images signed, player iframes as facades."""
    if not html:
        return html
    if not _MEDIA_TAG_RE.search(html):
        return html  # nothing to rewrite: skip the parse
    # Legacy img.youtube.com / vumbnail thumbnails go to our own video-thumb proxy first,
    # exactly as the live render does, so they are not signed as third-party images.
    soup = BeautifulSoup(rewrite_thumb_srcs(html), "html.parser")
    for iframe in soup.find_all("iframe"):
        figures = collect_video_figures(str(iframe))
        if figures:
            iframe.replace_with(BeautifulSoup(figures[0], "html.parser"))
    for tag in soup.find_all(["img", "source", "video"]):
        # <source> inside <video>/<audio> is a media file, not an image: left alone.
        if tag.name == "source" and tag.parent is not None and tag.parent.name != "picture":
            continue
        if tag.name in ("img", "source") and tag.has_attr("src"):
            _set_or_drop(tag, "src", _proxied(tag["src"], user_id))
        if tag.name in ("img", "source") and tag.has_attr("srcset"):
            _set_or_drop(tag, "srcset", _proxied_srcset(tag["srcset"], user_id))
        if tag.name == "video" and tag.has_attr("poster"):
            _set_or_drop(tag, "poster", _proxied(tag["poster"], user_id))
    return str(soup)


class _MediaScan(HTMLParser):
    """Collects the same-origin image URLs of a fragment without building a tree (the
    snapshot batch scans 100 fragments; BeautifulSoup took most of its time)."""

    def __init__(self, seen: dict[str, None]):
        super().__init__(convert_charrefs=True)
        self.seen = seen
        self.stack: list[str] = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        values = []
        if tag in ("img", "source"):
            # <source> is an image only inside <picture>; in <video>/<audio> it is a
            # media file.
            if tag == "img" or (self.stack and self.stack[-1] == "picture"):
                if a.get("src"):
                    values.append(a["src"])
                for cand in (a.get("srcset") or "").split(","):
                    parts = cand.split()
                    if parts:
                        values.append(parts[0])
        elif tag == "video" and a.get("poster"):
            values.append(a["poster"])
        for v in values:
            if v.startswith("/") and not v.startswith("//"):
                self.seen.setdefault(v, None)
        if tag in ("picture", "video", "audio"):
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in ("picture", "video", "audio") and tag in self.stack:
            while self.stack and self.stack.pop() != tag:
                pass


def media_urls(*fragments: str) -> list[str]:
    """Every same-origin image URL in the fragments, in order, once: what the device caches."""
    seen: dict[str, None] = {}
    for html in fragments:
        scan = _MediaScan(seen)
        scan.feed(html)
        scan.close()
    return list(seen)


def _offline_bodies(pairs: list[tuple[str | None, str | None]], user_id: int):
    """The BeautifulSoup work of a snapshot batch, run off the event loop: the offline
    bodies for each (content, readable_content) pair."""
    return [(offline_body(c, user_id), offline_body(r, user_id)) for c, r in pairs]


def _media_of(rendered: list[tuple[str, str]]) -> list[list[str]]:
    return [media_urls(row, detail) for row, detail in rendered]


async def _load(user: User, ids: list[int], db: AsyncSession):
    """Article, state and feed names for every id at once, keyed by id. The neutral
    snapshot draws no labels, so none are fetched."""
    from app.models.feed import Feed, UserFeed
    from app.services.article import (
        add_article_access_joins,
        article_access_predicate,
        visible_article_clause,
    )
    from app.services.sync.scope import id_array
    from sqlalchemy import any_

    stmt = add_article_access_joins(
        select(
            Article, UserArticleState,
            Feed.title.label("feed_title"),
            UserFeed.custom_title.label("custom_title"),
            UserFeed.extract_readable.label("extract_readable"),
            UserFeed.id.is_not(None).label("subscribed"),
            UserFeed.readable_auto_disabled,
        ).outerjoin(Feed, Feed.id == Article.feed_id),
        user.id,
    ).where(
        Article.id == any_(id_array(ids)),
        Article.trimmed_at.is_(None),
        article_access_predicate(),
        visible_article_clause(),
    )
    return {row[0].id: row for row in (await db.execute(stmt)).all()}


async def render_snapshots(request: Request, user: User, ids: list[int], db: AsyncSession) -> list[dict]:
    """Row and detail snapshots for the requested ids that are in the user's offline scope.

    Ids outside the scope are omitted without saying why, as in ``article_records``.
    Returned in id order.

    Cost: one scope query limited to the requested ids, one query for the articles
    and states, and the HTML rewriting (BeautifulSoup) in a worker thread, so a batch
    of 50 does not hold up the event loop; the Jinja renders stay on it.
    """
    # Lazy: the route module imports a great deal, and services should not pull it in
    # at import time. The context helpers live there because the live routes own them.
    from app.routers.web.app.articles import detail_render_context, list_density, row_render_context
    from app.routers.web.app.common import _ai_availability
    from app.services.article import _article_response, _to_list_item

    if not ids:
        return []
    allowed = await in_offline_scope(user, ids, db)
    if not allowed:
        return []
    rows = await _load(user, allowed, db)
    allowed = [aid for aid in allowed if aid in rows]
    if not allowed:
        return []
    settings = await db.scalar(select(UserSettings).where(UserSettings.user_id == user.id))
    prefs = await prefs_version(user.id, db)
    # Per reader, not per article (and part of prefs_version): the AI actions and the
    # chat entry point are drawn when this reader has them, so the device can queue a
    # summary/context offline; the AI *content* stays neutral and comes from the overlay.
    ai = await _ai_availability(settings, db)
    row_tpl = templates.env.get_template("app/partials/article_row.html")
    detail_tpl = templates.env.get_template("app/partials/article_detail.html")
    bodies = await asyncio.to_thread(
        _offline_bodies,
        [(rows[aid][0].content, rows[aid][0].readable_content) for aid in allowed], user.id,
    )

    # The date formatting reads the viewer from context vars, which the auth dependency
    # sets per request. Set them here too, so the snapshot is right however it is called
    # (formatted_date is computed while the list item is built, hence before fetching).
    tz_token = current_viewer_tz.set((settings.timezone if settings else None) or "UTC")
    fmt_token = current_viewer_format.set((settings.format_profile if settings else None) or "iso")
    try:
        rendered = []
        full_text_by_id = {}
        for aid, (content, readable) in zip(allowed, bodies):
            article_row, state, feed_title, custom_title, extract_readable, subscribed, auto_disabled = rows[aid]
            full_text = full_text_flag(
                readable_status=article_row.readable_status,
                has_readable_content=bool(article_row.readable_content),
                url=article_row.url, trimmed=article_row.trimmed_at is not None, subscribed=subscribed,
                extract_readable=extract_readable, readable_auto_disabled=auto_disabled,
            )
            full_text_by_id[aid] = full_text
            item = _to_list_item(article_row, state, feed_title, custom_title, extract_readable, [])
            article = _article_response(article_row, state, feed_title, custom_title, [])
            item = item.model_copy(update=_NEUTRAL_ROW)
            article = article.model_copy(update={
                **_NEUTRAL_DETAIL, "content": content, "readable_content": readable,
            })
            row_html = row_tpl.render(
                request=request, rf_snapshot=True,
                **row_render_context(item, settings, density=list_density(request, settings)),
            )
            detail_html = detail_tpl.render(
                request=request, rf_snapshot=True, rf_full_text=full_text,
                **detail_render_context(
                    article, settings, ai_available=ai.quality, summary_pending=False,
                    chat_available=ai.chat, chat_messages=[], related_count=0,
                ),
            )
            rendered.append((row_html, detail_html))
            await asyncio.sleep(0)  # let other requests in between two renders
    finally:
        current_viewer_format.reset(fmt_token)
        current_viewer_tz.reset(tz_token)
    media = await asyncio.to_thread(_media_of, rendered)
    return [{
        "id": aid,
        "content_version": rows[aid][0].content_version,
        "template_version": OFFLINE_TEMPLATE_VERSION,
        "prefs_version": prefs,
        "full_text": full_text_by_id[aid],
        "row_html": row_html,
        "detail_html": detail_html,
        "media": m,
    } for aid, (row_html, detail_html), m in zip(allowed, rendered, media)]

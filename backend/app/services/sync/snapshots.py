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
import re
from urllib.parse import urlsplit

from bs4 import BeautifulSoup
from fastapi import Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.article import Article
from app.models.user import User, UserSettings
from app.services.article import get_article, get_article_list_item
from app.services.sync import OFFLINE_TEMPLATE_VERSION
from app.services.sync.manifest import prefs_version
from app.services.sync.media import sign_media_url
from app.services.sync.scope import offline_scope_ids
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


def media_urls(*fragments: str) -> list[str]:
    """Every same-origin image URL in the fragments, in order, once: what the device caches."""
    seen: dict[str, None] = {}
    for html in fragments:
        soup = BeautifulSoup(html, "html.parser")
        for tag in soup.find_all(["img", "source", "video"]):
            values = []
            if tag.name in ("img", "source"):
                if tag.name == "source" and tag.parent is not None and tag.parent.name != "picture":
                    continue
                if tag.get("src"):
                    values.append(tag["src"])
                for cand in (tag.get("srcset") or "").split(","):
                    parts = cand.split()
                    if parts:
                        values.append(parts[0])
            elif tag.get("poster"):
                values.append(tag["poster"])
            for v in values:
                if v.startswith("/") and not v.startswith("//"):
                    seen.setdefault(v, None)
    return list(seen)


async def render_snapshots(request: Request, user: User, ids: list[int], db: AsyncSession) -> list[dict]:
    """Row and detail snapshots for the requested ids that are in the user's offline scope.

    Ids outside the scope are omitted without saying why, as in ``article_records``.
    Returned in id order.
    """
    # Lazy: the route module imports a great deal, and services should not pull it in
    # at import time. The context helpers live there because the live routes own them.
    from app.routers.web.app.articles import detail_render_context, list_density, row_render_context
    from app.routers.web.app.common import _ai_availability

    if not ids:
        return []
    allowed = sorted(set(await offline_scope_ids(user, db)) & set(ids))
    if not allowed:
        return []
    settings = await db.scalar(select(UserSettings).where(UserSettings.user_id == user.id))
    content_versions = dict((await db.execute(
        select(Article.id, Article.content_version).where(Article.id.in_(allowed))
    )).all())
    prefs = await prefs_version(user.id, db)
    # Per reader, not per article (and part of prefs_version): the AI actions and the
    # chat entry point are drawn when this reader has them, so the device can queue a
    # summary/context offline; the AI *content* stays neutral and comes from the overlay.
    ai = await _ai_availability(settings, db)
    row_tpl = templates.env.get_template("app/partials/article_row.html")
    detail_tpl = templates.env.get_template("app/partials/article_detail.html")

    # The date formatting reads the viewer from context vars, which the auth dependency
    # sets per request. Set them here too, so the snapshot is right however it is called
    # (formatted_date is computed while the list item is built, hence before fetching).
    tz_token = current_viewer_tz.set((settings.timezone if settings else None) or "UTC")
    fmt_token = current_viewer_format.set((settings.format_profile if settings else None) or "iso")
    try:
        out = []
        for aid in allowed:
            item = await get_article_list_item(user, aid, db)
            article = await get_article(user, aid, db)
            if item is None or article is None:
                continue
            item = item.model_copy(update=_NEUTRAL_ROW)
            article = article.model_copy(update={
                **_NEUTRAL_DETAIL,
                "content": offline_body(article.content, user.id),
                "readable_content": offline_body(article.readable_content, user.id),
            })
            row_html = row_tpl.render(
                request=request, rf_snapshot=True,
                **row_render_context(item, settings, density=list_density(request, settings)),
            )
            detail_html = detail_tpl.render(
                request=request, rf_snapshot=True,
                **detail_render_context(
                    article, settings, ai_available=ai.quality, summary_pending=False,
                    chat_available=ai.chat, chat_messages=[], related_count=0,
                ),
            )
            out.append({
                "id": aid,
                "content_version": content_versions.get(aid),
                "template_version": OFFLINE_TEMPLATE_VERSION,
                "prefs_version": prefs,
                "row_html": row_html,
                "detail_html": detail_html,
                "media": media_urls(row_html, detail_html),
            })
        return out
    finally:
        current_viewer_format.reset(fmt_token)
        current_viewer_tz.reset(tz_token)

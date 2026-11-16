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

Nothing session-bound goes in: the partials carry no CSRF token or CSP nonce (the
CSRF header is added by the page's htmx config, not by these fragments), the share
token is part of the neutral state, and the live pollers (row poll, readable
progress) are left out by rendering with ``readable_active`` off.

Article images are rewritten to signed same-origin ``/m/...`` URLs (see ``media``):
``src``/``srcset`` of ``<img>`` and ``<source>``, and ``poster`` of ``<video>``. Video
and audio files themselves are not proxied (images only in this version), and a
YouTube/Vimeo player iframe, should a body still hold one, becomes the thumbnail
facade the app stores for videos anyway.
"""
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


def _is_same_origin(url: str, host: str) -> bool:
    if url.startswith("/") and not url.startswith("//"):
        return True
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and bool(host) and parts.netloc == host


def _proxied(url: str, user_id: int, host: str) -> str:
    """The URL the snapshot carries for an image *url*: signed if it is someone else's."""
    url = url.strip()
    if not url or url.startswith("data:"):
        return url
    if _is_same_origin(url, host):
        if url.startswith("/"):
            return url
        # Our own host spelled out: the path form, so the device lists and caches it.
        parts = urlsplit(url)
        return (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    if url.startswith("//"):
        url = "https:" + url
    if urlsplit(url).scheme not in ("http", "https"):
        return url
    return sign_media_url(url, user_id)


def _proxied_srcset(value: str, user_id: int, host: str) -> str:
    out = []
    for cand in value.split(","):
        parts = cand.strip().split(None, 1)
        if not parts:
            continue
        parts[0] = _proxied(parts[0], user_id, host)
        out.append(" ".join(parts))
    return ", ".join(out)


def offline_body(html: str | None, user_id: int, host: str) -> str | None:
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
        if tag.name in ("img", "source") and tag.get("src"):
            tag["src"] = _proxied(tag["src"], user_id, host)
        if tag.name in ("img", "source") and tag.get("srcset"):
            tag["srcset"] = _proxied_srcset(tag["srcset"], user_id, host)
        if tag.name == "video" and tag.get("poster"):
            tag["poster"] = _proxied(tag["poster"], user_id, host)
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
    host = request.headers.get("host", "")
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
                "content": offline_body(article.content, user.id, host),
                "readable_content": offline_body(article.readable_content, user.id, host),
            })
            row_html = row_tpl.render(
                request=request, rf_snapshot=True,
                **row_render_context(item, settings, density=list_density(request, settings)),
            )
            detail_html = detail_tpl.render(
                request=request, rf_snapshot=True,
                **detail_render_context(
                    article, settings, ai_available=False, summary_pending=False,
                    chat_available=False, chat_messages=[], related_count=0,
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

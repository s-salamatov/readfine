"""Sync manifest: per-article and per-list version tokens a device diffs against."""
import hashlib
import json

from sqlalchemy import Text, cast, func, select
from sqlalchemy.dialects.postgresql import aggregate_order_by
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.article import Article, UserArticleState
from app.models.feed import Feed, Folder, UserFeed
from app.models.label import ArticleLabel, Label
from app.models.saved_search import SavedSearch
from app.models.user import User, UserSettings
from app.services.sync import OFFLINE_TEMPLATE_VERSION

_PREF_FIELDS = (
    "list_density_web", "list_density_mobile", "label_display", "ai_score_show_in_list",
    "timezone", "default_sort_order", "articles_per_page", "mark_read_on_scroll",
    "story_dedup", "reading_font_size", "reading_font_family",
    # The date order the snapshots are rendered with (formatted_date, localtime).
    "format_profile",
    # Which articles a feed or folder list opens with (adaptive / unread_only /
    # show_all); the device's lists apply it (offline/lists.js).
    "unread_filter",
)


def _part(p) -> str:
    if p is None:
        return ""
    if isinstance(p, (dict, list)):
        return json.dumps(p, sort_keys=True)
    return str(p)


def _digest(parts) -> str:
    return hashlib.sha1("\x1f".join(_part(p) for p in parts).encode()).hexdigest()[:12]


async def article_versions(user_id: int, ids: list[int], db: AsyncSession) -> dict[int, str]:
    """12-hex version per article id: changes iff content or this user's state/labels do.

    One SELECT; labels are a correlated ``string_agg`` of sorted label ids. Hashing is
    done here (Postgres has no built-in sha1 without pgcrypto). Ids the user has no
    state row for hash with NULL state columns (is_read treated as false).
    """
    if not ids:
        return {}
    label_ids = (
        select(func.string_agg(cast(ArticleLabel.label_id, Text), aggregate_order_by(",", ArticleLabel.label_id)))
        .where(ArticleLabel.user_id == user_id, ArticleLabel.article_id == Article.id)
        .correlate(Article)
        .scalar_subquery()
    )
    stmt = (
        select(
            Article.id, Article.content_version,
            func.coalesce(UserArticleState.is_read, False),
            func.coalesce(UserArticleState.is_starred, False),
            func.coalesce(UserArticleState.is_archived, False),
            UserArticleState.saved_at, UserArticleState.hidden_at,
            UserArticleState.ai_score, UserArticleState.lexical_score, UserArticleState.ai_summary, UserArticleState.ai_context,
            UserArticleState.share_token, Article.story_id, label_ids,
        )
        .outerjoin(
            UserArticleState,
            (UserArticleState.article_id == Article.id) & (UserArticleState.user_id == user_id),
        )
        .where(Article.id.in_(ids))
    )
    rows = (await db.execute(stmt)).all()
    return {r[0]: _digest(r[1:]) for r in rows}


async def prefs_version(user_id: int, db: AsyncSession) -> str:
    """Hash of the display preferences and AI availability; part of every snapshot's key.

    AI availability (admin switch, configured model, chat on) decides whether the
    snapshot's detail carries the AI actions and the chat entry point.
    """
    from app.routers.web.app.common import _ai_availability  # lazy: route package

    row = (await db.execute(
        select(*(getattr(UserSettings, f) for f in _PREF_FIELDS)).where(UserSettings.user_id == user_id)
    )).first()
    settings = await db.scalar(select(UserSettings).where(UserSettings.user_id == user_id))
    ai = await _ai_availability(settings, db)
    return _digest([*(row or ()), ai.quality, ai.chat])


async def list_versions(user: User, db: AsyncSession) -> dict[str, str]:
    """Short hash per list the offline shell renders, plus the template version."""
    uid = user.id
    folders = (await db.execute(
        select(Folder.id, Folder.name, Folder.position).where(Folder.user_id == uid).order_by(Folder.id)
    )).all()
    feeds = (await db.execute(
        select(UserFeed.id, UserFeed.feed_id, UserFeed.custom_title, Feed.title, UserFeed.folder_id,
               UserFeed.position, UserFeed.updated_at)
        .join(Feed, Feed.id == UserFeed.feed_id)
        .where(UserFeed.user_id == uid).order_by(UserFeed.id)
    )).all()
    labels = (await db.execute(
        select(Label.id, Label.name, Label.position, Label.color).where(Label.user_id == uid).order_by(Label.id)
    )).all()
    searches = (await db.execute(
        select(SavedSearch.id, SavedSearch.name, SavedSearch.params, SavedSearch.updated_at)
        .where(SavedSearch.user_id == uid).order_by(SavedSearch.id)
    )).all()

    def h(rows) -> str:
        return _digest(_digest(r) for r in rows)

    return {
        "folders": h(folders),
        "feeds": h(feeds),
        "labels": h(labels),
        "saved_searches": h(searches),
        "prefs": await prefs_version(uid, db),
        "templates": OFFLINE_TEMPLATE_VERSION,
    }

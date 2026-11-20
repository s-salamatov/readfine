"""Sync payloads: article records and the user's lists, as the device stores them."""
from sqlalchemy import any_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.article import Article, UserArticleState
from app.models.feed import Feed, Folder, UserFeed
from app.models.label import Label
from app.models.saved_search import SavedSearch
from app.models.user import User, UserSettings
from app.services.article import (
    add_article_access_joins,
    article_access_predicate,
    list_articles,
    visible_article_clause,
)
from app.services.saved_search_service import view_filters
from app.services.sync.full_text import full_text_flag
from app.services.sync.manifest import _PREF_FIELDS, _digest, article_version_fields, list_versions
from app.services.sync.scope import id_array, in_offline_scope, offline_scope_ids
from app.utils.markdown import md_render_ai


def _ai_html(text: str | None) -> str | None:
    """Stored AI output as the detail panel draws it (the ``ai_markdown`` filter), so
    the device can show it offline without a Markdown renderer of its own."""
    return md_render_ai(text) if text else None


async def article_records(
    user: User, ids: list[int], db: AsyncSession, *, scoped: bool = True,
) -> list[dict]:
    """Records for the requested ids that are in the user's offline scope, id order.

    Ids outside the scope (other users' articles, trimmed, hidden, past the unread
    limit) are silently omitted: the endpoint never reveals whether they exist.

    ``scoped=False`` widens this to every article the user may reach (the access rule
    of the article views). The action replay answers with it, so an op that takes an
    article out of the scope (reading an unkept one) still reports the state it left;
    the next manifest then drops the article from the device.
    """
    if not ids:
        return []
    if scoped:
        allowed = set(await in_offline_scope(user, ids, db))
    else:
        allowed = set((await db.execute(
            add_article_access_joins(select(Article.id), user.id).where(
                Article.id == any_(id_array(ids)), article_access_predicate(), visible_article_clause(),
            )
        )).scalars().all())
    if not allowed:
        return []
    # Version inputs and full-text eligibility must come from the same statement.
    stmt = add_article_access_joins(
        select(
            Article.id, Article.feed_id, Article.title, Article.url, Article.author,
            Article.published_at, Article.fetched_at, Article.image_url,
            Article.estimated_read_min, Article.word_count, UserArticleState.ai_summary_truncated,
            func.coalesce(Article.readable_content != "", False).label("has_readable_content"),
            Article.trimmed_at.is_not(None).label("trimmed"),
            article_version_fields(user.id),
        ),
        user.id,
    ).where(Article.id == any_(id_array(sorted(allowed)))).order_by(Article.id)
    rows = (await db.execute(stmt)).all()

    out = []
    for r in rows:
        v = r.version_fields
        out.append({
            "id": r.id, "feed_id": r.feed_id, "title": r.title, "url": r.url, "author": r.author,
            "published_at": r.published_at.isoformat() if r.published_at else None,
            "fetched_at": r.fetched_at.isoformat() if r.fetched_at else None,
            "story_id": v.story_id, "image_url": r.image_url,
            "estimated_read_min": r.estimated_read_min, "word_count": r.word_count,
            "is_read": v.is_read,
            "is_starred": v.is_starred,
            "is_archived": v.is_archived,
            "saved_at": v.saved_at.isoformat() if v.saved_at else None,
            "hidden_at": v.hidden_at.isoformat() if v.hidden_at else None,
            "share_token": v.share_token,
            "ai_score": v.ai_score,
            "lexical_score": v.lexical_score,
            "ai_summary": v.ai_summary,
            "ai_summary_truncated": bool(r.ai_summary_truncated),
            "ai_context": v.ai_context,
            "ai_summary_html": _ai_html(v.ai_summary),
            "ai_context_html": _ai_html(v.ai_context),
            "label_ids": [int(label_id) for label_id in v.label_ids_csv.split(",")] if v.label_ids_csv else [],
            "version": _digest(v),
            "content_version": v.content_version,
            "full_text": full_text_flag(
                readable_status=v.readable_status, has_readable_content=r.has_readable_content,
                url=r.url, trimmed=r.trimmed, subscribed=v.subscribed,
                extract_readable=v.extract_readable, readable_auto_disabled=v.readable_auto_disabled,
            ),
        })
    return out


async def user_lists(user: User, db: AsyncSession) -> dict:
    """Folders, feeds, labels, saved searches (with in-scope member ids), prefs, versions."""
    uid = user.id
    folders = (await db.execute(
        select(Folder.id, Folder.name, Folder.position).where(Folder.user_id == uid).order_by(Folder.id)
    )).all()
    feeds = (await db.execute(
        select(UserFeed.id, UserFeed.feed_id, UserFeed.custom_title, Feed.title,
               UserFeed.folder_id, UserFeed.position)
        .join(Feed, Feed.id == UserFeed.feed_id)
        .where(UserFeed.user_id == uid).order_by(UserFeed.id)
    )).all()
    labels = (await db.execute(
        select(Label.id, Label.name, Label.color, Label.position).where(Label.user_id == uid).order_by(Label.id)
    )).all()
    searches = (await db.execute(
        select(SavedSearch.id, SavedSearch.name, SavedSearch.params)
        .where(SavedSearch.user_id == uid).order_by(SavedSearch.id)
    )).all()
    prefs_row = (await db.execute(
        select(UserSettings).where(UserSettings.user_id == uid)
    )).scalar_one_or_none()

    scope = set(await offline_scope_ids(user, db)) if searches else set()
    saved = []
    for sid, name, params in searches:
        member = (await db.execute(await list_articles(user, db, **view_filters(params), _ids=True))).scalars().all()
        saved.append({"id": sid, "name": name, "params": params,
                      "member_ids": sorted(set(member) & scope)})

    return {
        "folders": [{"id": i, "name": n, "position": p} for i, n, p in folders],
        "feeds": [
            {"user_feed_id": i, "feed_id": f, "title": custom or title, "folder_id": fo, "position": p}
            for i, f, custom, title, fo, p in feeds
        ],
        "labels": [{"id": i, "name": n, "color": c, "position": p} for i, n, c, p in labels],
        "saved_searches": saved,
        "prefs": {f: getattr(prefs_row, f) for f in _PREF_FIELDS} if prefs_row else {},
        "versions": await list_versions(user, db),
    }

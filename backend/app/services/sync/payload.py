"""Sync payloads: article records and the user's lists, as the device stores them."""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.article import Article, UserArticleState
from app.models.feed import Feed, Folder, UserFeed
from app.models.label import ArticleLabel, Label
from app.models.saved_search import SavedSearch
from app.models.user import User, UserSettings
from app.services.article import (
    add_article_access_joins,
    article_access_predicate,
    list_articles,
    visible_article_clause,
)
from app.services.saved_search_service import view_filters
from app.services.sync.manifest import _PREF_FIELDS, article_versions, list_versions
from app.services.sync.scope import offline_scope_ids
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
        allowed = set(await offline_scope_ids(user, db)) & set(ids)
    else:
        allowed = set((await db.execute(
            add_article_access_joins(select(Article.id), user.id).where(
                Article.id.in_(ids), article_access_predicate(), visible_article_clause(),
            )
        )).scalars().all())
    if not allowed:
        return []
    ordered = sorted(allowed)
    stmt = (
        select(
            Article.id, Article.feed_id, Article.title, Article.url, Article.author,
            Article.published_at, Article.fetched_at, Article.story_id, Article.image_url,
            Article.estimated_read_min, Article.word_count, Article.content_version,
            UserArticleState,
        )
        .outerjoin(
            UserArticleState,
            (UserArticleState.article_id == Article.id) & (UserArticleState.user_id == user.id),
        )
        .where(Article.id.in_(ordered))
    )
    rows = {r[0]: r for r in (await db.execute(stmt)).all()}
    label_rows = (await db.execute(
        select(ArticleLabel.article_id, ArticleLabel.label_id)
        .where(ArticleLabel.user_id == user.id, ArticleLabel.article_id.in_(ordered))
        .order_by(ArticleLabel.article_id, ArticleLabel.label_id)
    )).all()
    labels: dict[int, list[int]] = {}
    for article_id, label_id in label_rows:
        labels.setdefault(article_id, []).append(label_id)
    versions = await article_versions(user.id, ordered, db)

    out = []
    for aid in ordered:
        r = rows.get(aid)
        if r is None:
            continue
        s = r[12]  # UserArticleState or None
        out.append({
            "id": aid, "feed_id": r[1], "title": r[2], "url": r[3], "author": r[4],
            "published_at": r[5].isoformat() if r[5] else None,
            "fetched_at": r[6].isoformat() if r[6] else None,
            "story_id": r[7], "image_url": r[8], "estimated_read_min": r[9], "word_count": r[10],
            "is_read": bool(s and s.is_read),
            "is_starred": bool(s and s.is_starred),
            "is_archived": bool(s and s.is_archived),
            "saved_at": s.saved_at.isoformat() if s and s.saved_at else None,
            "hidden_at": s.hidden_at.isoformat() if s and s.hidden_at else None,
            "share_token": s.share_token if s else None,
            "ai_score": s.ai_score if s else None,
            "lexical_score": s.lexical_score if s else None,
            "ai_summary": s.ai_summary if s else None,
            "ai_summary_truncated": bool(s and s.ai_summary_truncated),
            "ai_context": s.ai_context if s else None,
            "ai_summary_html": _ai_html(s.ai_summary if s else None),
            "ai_context_html": _ai_html(s.ai_context if s else None),
            "label_ids": labels.get(aid, []),
            "version": versions.get(aid),
            "content_version": r[11],
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

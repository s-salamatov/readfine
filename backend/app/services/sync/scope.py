"""Offline scope: the set of articles a user's device keeps.

Two parts, unioned:
  * kept: starred, archived or saved articles, any read state, regardless of
    subscription (same rule as ``article_access_predicate``), not trimmed;
  * unread: the newest ``unread_limit`` unread articles reachable through a
    subscription, not trimmed, not hidden, not suppressed. An unread article may
    have no ``user_article_states`` row at all (outer join).
"""
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.article import Article, UserArticleState
from app.models.feed import UserFeed
from app.models.user import User
from app.services.article import (
    add_article_access_joins,
    permanently_kept_predicate,
    unread_clause,
    visible_article_clause,
)

DEFAULT_UNREAD_LIMIT = 3000


async def offline_scope_ids(
    user: User, db: AsyncSession, *, unread_limit: int = DEFAULT_UNREAD_LIMIT
) -> list[int]:
    """Article ids the user's device should hold, sorted ascending."""
    kept_stmt = (
        add_article_access_joins(select(Article.id), user.id)
        .where(visible_article_clause(), permanently_kept_predicate())
    )
    unread_stmt = (
        add_article_access_joins(select(Article.id), user.id)
        .where(
            visible_article_clause(),
            UserFeed.id.is_not(None),
            unread_clause(),
            UserArticleState.hidden_at.is_(None),
            UserArticleState.suppressed_at.is_(None),
        )
        .order_by(
            func.coalesce(Article.published_at, Article.fetched_at).desc(),
            Article.id.desc(),
        )
        .limit(unread_limit)
    )
    kept = (await db.execute(kept_stmt)).scalars().all()
    unread = (await db.execute(unread_stmt)).scalars().all()
    return sorted(set(kept) | set(unread))

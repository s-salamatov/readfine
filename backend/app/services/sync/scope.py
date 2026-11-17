"""Offline scope: the set of articles a user's device keeps.

Two parts, unioned:
  * kept: starred, archived or saved articles, any read state, regardless of
    subscription (same rule as ``article_access_predicate``), not trimmed;
  * unread: the newest ``unread_limit`` unread articles reachable through a
    subscription, not trimmed, not hidden, not suppressed. An unread article may
    have no ``user_article_states`` row at all (outer join).

``unread_limit`` defaults to the ``OFFLINE_UNREAD_LIMIT`` setting (3000).
"""
from sqlalchemy import Integer, any_, bindparam, func, select, union
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.article import Article, UserArticleState
from app.models.feed import UserFeed
from app.models.user import User
from app.services.article import (
    add_article_access_joins,
    permanently_kept_predicate,
    unread_clause,
    visible_article_clause,
)


def unread_limit_setting() -> int:
    return settings.offline_unread_limit


def _kept_stmt(user_id: int):
    return (
        add_article_access_joins(select(Article.id), user_id)
        .where(visible_article_clause(), permanently_kept_predicate())
    )


def _unread_stmt(user_id: int, unread_limit: int):
    return (
        add_article_access_joins(select(Article.id), user_id)
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


def id_array(ids) -> bindparam:
    """One array bind for a list of ids of any length (``= ANY(:ids)``): an ``IN`` list
    takes one bind per id, and asyncpg refuses more than 32767 in one statement."""
    return bindparam("ids", sorted(set(ids)), type_=ARRAY(Integer))


async def offline_scope_ids(
    user: User, db: AsyncSession, *, unread_limit: int | None = None
) -> list[int]:
    """Article ids the user's device should hold, sorted ascending."""
    limit = unread_limit_setting() if unread_limit is None else unread_limit
    kept = (await db.execute(_kept_stmt(user.id))).scalars().all()
    unread = (await db.execute(_unread_stmt(user.id, limit))).scalars().all()
    return sorted(set(kept) | set(unread))


async def in_offline_scope(
    user: User, ids, db: AsyncSession, *, unread_limit: int | None = None
) -> list[int]:
    """Those of ``ids`` that are in the user's offline scope, sorted ascending.

    One query, and only the requested ids come back: the unread part is still the
    newest ``unread_limit`` (a subquery the database ranks), but the full scope list
    is never built in Python.
    """
    ids = sorted(set(ids))
    if not ids:
        return []
    limit = unread_limit_setting() if unread_limit is None else unread_limit
    wanted = id_array(ids)
    kept = _kept_stmt(user.id).where(Article.id == any_(wanted))
    newest = _unread_stmt(user.id, limit).subquery()
    unread = select(newest.c.id).where(newest.c.id == any_(wanted))
    rows = (await db.execute(union(kept, unread))).scalars().all()
    return sorted(set(rows))

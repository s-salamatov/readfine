"""Queue readable extraction for articles kept by recently synced devices."""
from datetime import datetime, timedelta, timezone

from sqlalchemy import any_, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.article import Article
from app.models.feed import UserFeed
from app.models.user import User
from app.services.sync.scope import id_array, offline_scope_ids

ACTIVE_DAYS = 14
MARK_BATCH = 200
STAMP_EVERY = timedelta(hours=1)


async def stamp_offline_synced(user: User, db: AsyncSession, *, now: datetime) -> bool:
    """Record a manifest request if the previous stamp is over an hour old."""
    cutoff = now - STAMP_EVERY
    if user.offline_synced_at is not None and user.offline_synced_at >= cutoff:
        return False

    # Recheck the stamp in SQL in case concurrent requests loaded the same user.
    result = await db.execute(
        update(User)
        .where(
            User.id == user.id,
            or_(User.offline_synced_at.is_(None), User.offline_synced_at < cutoff),
        )
        .values(offline_synced_at=now)
        .returning(User.id)
        .execution_options(synchronize_session="fetch")
    )
    return result.scalar_one_or_none() is not None


async def mark_backfill_for_user(user: User, db: AsyncSession, *, now: datetime) -> int:
    """Queue eligible skipped articles in the user's offline scope."""
    ids = await offline_scope_ids(user, db)
    eligible_feeds = select(UserFeed.feed_id).where(
        UserFeed.user_id == user.id,
        UserFeed.extract_readable.is_(True),
        UserFeed.readable_auto_disabled.is_(False),
    )
    marked = 0
    for start in range(0, len(ids), MARK_BATCH):
        result = await db.execute(
            update(Article)
            .where(
                Article.id == any_(id_array(ids[start:start + MARK_BATCH])),
                Article.readable_status == "skipped",
                Article.url.is_not(None),
                Article.url != "",
                Article.trimmed_at.is_(None),
                Article.feed_id.in_(eligible_feeds),
            )
            .values(readable_status="pending", readable_priority=1, readable_queued_at=now)
            .execution_options(synchronize_session=False)
        )
        await db.commit()
        marked += result.rowcount
    return marked


async def mark_backfill(db: AsyncSession, *, now: datetime | None = None) -> int:
    """Mark articles for users whose devices synced within the active window."""
    now = now if now is not None else datetime.now(timezone.utc)
    users = await db.scalars(
        select(User).where(User.offline_synced_at >= now - timedelta(days=ACTIVE_DAYS))
    )
    marked = 0
    for user in users:
        marked += await mark_backfill_for_user(user, db, now=now)
    return marked

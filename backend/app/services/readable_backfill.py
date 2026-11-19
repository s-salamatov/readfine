"""Queue readable extraction at ingest and for recently synced devices."""
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import any_, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.article import Article
from app.models.feed import UserFeed
from app.models.user import User
from app.services.sync.scope import id_array, offline_scope_ids

logger = logging.getLogger(__name__)

ACTIVE_DAYS = 14
MARK_BATCH = 200
STAMP_EVERY = timedelta(hours=1)


async def queue_new_for_readable(
    feed_id: int, new_ids: list[int], db: AsyncSession, now: datetime,
) -> bool:
    """Queue eligible new articles and report whether the batch has pending work."""
    if not new_ids:
        return False

    batch = (Article.feed_id == feed_id, Article.id == any_(id_array(new_ids)))
    eligible_subscriber = select(UserFeed.feed_id).where(
        UserFeed.feed_id == feed_id,
        UserFeed.extract_readable.is_(True),
        UserFeed.readable_auto_disabled.is_(False),
    ).exists()

    # Keep the fetch's own writes outside the savepoints for queue operations.
    await db.flush()
    try:
        async with db.begin_nested():
            await db.execute(
                update(Article)
                .where(
                    *batch,
                    Article.readable_status == "skipped",
                    Article.url.is_not(None),
                    Article.url != "",
                    Article.trimmed_at.is_(None),
                    eligible_subscriber,
                )
                .values(readable_status="pending", readable_priority=1, readable_queued_at=now)
                .execution_options(synchronize_session=False)
            )
    except Exception:
        logger.exception("Could not queue readable extraction for new articles in feed %d", feed_id)

    # Filters may already have queued work, even if the ingest UPDATE failed.
    try:
        async with db.begin_nested():
            return bool(await db.scalar(select(
                select(Article.id).where(*batch, Article.readable_status == "pending").exists()
            )))
    except Exception:
        logger.exception("Could not check for pending readable extraction in feed %d", feed_id)
        return False


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

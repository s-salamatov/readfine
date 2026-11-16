"""Change tracking for offline sync (migration 0127).

``articles.content_version`` and the ``*_changed_at`` columns of ``user_article_states``
are maintained by database triggers, because articles and states are written from many
places (fetcher, services, inline UPDATEs in routers) and an application-side stamp
would sooner or later be missing from one of them. These tests drive the real writers
against the real database, inside a transaction that is always rolled back.
"""
import importlib.util
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import pytest_asyncio
from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.config import settings as app_settings
from app.models.article import Article, UserArticleState
from app.models.feed import Feed, UserFeed
from app.models.user import User
from app.services.article import mark_scope_read, toggle_article_state

pytestmark = pytest.mark.integration

NOW = datetime.now(timezone.utc)
LONG_AGO = NOW - timedelta(days=3)
MIGRATION = Path(__file__).parent.parent / "alembic" / "versions" / "0127_offline_sync.py"


@pytest_asyncio.fixture
async def pg():
    engine = create_async_engine(app_settings.database_url)
    try:
        conn = await engine.connect()
    except Exception as exc:
        await engine.dispose()
        from tests.conftest import db_unreachable
        db_unreachable(exc)
    trans = await conn.begin()
    session = AsyncSession(bind=conn, expire_on_commit=False)
    try:
        yield session
    finally:
        await session.close()
        await trans.rollback()
        await conn.close()
        await engine.dispose()


async def _user(pg) -> User:
    user = User(email=f"sync_{uuid.uuid4().hex[:12]}@test.invalid", password_hash="x",
                display_name="t")
    pg.add(user)
    await pg.flush()
    return user


async def _feed(pg, user) -> Feed:
    u = uuid.uuid4().hex[:12]
    feed = Feed(feed_url=f"https://ex.invalid/{u}.xml", title=f"Feed {u[:4]}",
                subscriber_count=1)
    pg.add(feed)
    await pg.flush()
    pg.add(UserFeed(user_id=user.id, feed_id=feed.id))
    await pg.flush()
    return feed


async def _article(pg, feed) -> Article:
    u = uuid.uuid4().hex
    article = Article(feed_id=feed.id, guid=u, guid_hash=u, title="T",
                      published_at=LONG_AGO, fetched_at=LONG_AGO)
    pg.add(article)
    await pg.flush()
    return article


async def _version(pg, article_id) -> int:
    return await pg.scalar(select(Article.content_version).where(Article.id == article_id))


async def _stamps(pg, user, article):
    row = (await pg.execute(
        select(UserArticleState.read_changed_at, UserArticleState.star_changed_at,
               UserArticleState.archive_changed_at, UserArticleState.saved_changed_at)
        .where(UserArticleState.user_id == user.id,
               UserArticleState.article_id == article.id)
    )).one()
    return row


async def test_content_version_bumps_on_readable_content_change(pg):
    article = await _article(pg, await _feed(pg, await _user(pg)))
    assert await _version(pg, article.id) == 0

    await pg.execute(update(Article).where(Article.id == article.id)
                     .values(readable_content="body"))
    assert await _version(pg, article.id) == 1

    # Not a content field: the version must stay put.
    await pg.execute(update(Article).where(Article.id == article.id)
                     .values(fetched_at=NOW))
    assert await _version(pg, article.id) == 1

    # Same value written again is not a change.
    await pg.execute(update(Article).where(Article.id == article.id)
                     .values(readable_content="body"))
    assert await _version(pg, article.id) == 1


async def test_story_change_bumps_content_version(pg):
    feed = await _feed(pg, await _user(pg))
    article = await _article(pg, feed)
    other = await _article(pg, feed)

    await pg.execute(update(Article).where(Article.id == article.id)
                     .values(story_id=other.id))
    assert await _version(pg, article.id) == 1

    await pg.execute(update(Article).where(Article.id == article.id)
                     .values(story_id=None))
    assert await _version(pg, article.id) == 2


async def test_read_changed_at_set_on_toggle(pg):
    user = await _user(pg)
    article = await _article(pg, await _feed(pg, user))

    await toggle_article_state(user, article.id, "is_read", pg)

    read, star, archive, saved = await _stamps(pg, user, article)
    assert read is not None
    assert star is None and archive is None and saved is None

    # Toggling back is a change too: the stamp must be a fresh one, not cleared.
    await pg.execute(text("UPDATE user_article_states SET read_changed_at = :t"),
                     {"t": LONG_AGO})
    await toggle_article_state(user, article.id, "is_read", pg)
    read, *_ = await _stamps(pg, user, article)
    assert read > LONG_AGO


async def test_insert_stamps_only_non_default_flags(pg):
    user = await _user(pg)
    article = await _article(pg, await _feed(pg, user))

    pg.add(UserArticleState(user_id=user.id, article_id=article.id, is_read=False,
                            is_starred=True, saved_at=NOW))
    await pg.flush()

    read, star, archive, saved = await _stamps(pg, user, article)
    assert read is None and archive is None
    assert star is not None and saved is not None


async def test_read_changed_at_set_by_mark_scope_read(pg):
    user = await _user(pg)
    feed = await _feed(pg, user)
    fresh = await _article(pg, feed)      # no state row yet: upsert path
    existing = await _article(pg, feed)   # unread state row: update path
    pg.add(UserArticleState(user_id=user.id, article_id=existing.id, is_read=False))
    await pg.flush()
    assert (await _stamps(pg, user, existing))[0] is None

    await mark_scope_read(user, pg, before=NOW + timedelta(minutes=1), feed_id=feed.id)

    assert (await _stamps(pg, user, fresh))[0] is not None
    assert (await _stamps(pg, user, existing))[0] is not None


async def test_star_changed_at_not_touched_by_dwell_update(pg):
    user = await _user(pg)
    article = await _article(pg, await _feed(pg, user))
    await toggle_article_state(user, article.id, "is_starred", pg)
    await pg.execute(text("UPDATE user_article_states SET star_changed_at = :t, "
                          "read_changed_at = NULL"), {"t": LONG_AGO})

    # What htmx_article_dwell does: a bare dwell_seconds UPDATE.
    await pg.execute(
        update(UserArticleState)
        .where(UserArticleState.user_id == user.id,
               UserArticleState.article_id == article.id)
        .values(dwell_seconds=UserArticleState.dwell_seconds + 30))

    read, star, archive, saved = await _stamps(pg, user, article)
    assert star == LONG_AGO
    assert read is None and archive is None and saved is None


async def test_sync_applied_ops_table_shape(pg):
    cols = {r[0]: r[1] for r in (await pg.execute(text(
        "SELECT column_name, data_type FROM information_schema.columns "
        "WHERE table_name = 'sync_applied_ops'"))).all()}
    assert cols == {"user_id": "integer", "op_id": "uuid",
                    "applied_at": "timestamp with time zone", "result": "jsonb"}
    pk = (await pg.execute(text(
        "SELECT a.attname FROM pg_index i JOIN pg_attribute a "
        "ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) "
        "WHERE i.indrelid = 'sync_applied_ops'::regclass AND i.indisprimary "
        "ORDER BY a.attnum"))).scalars().all()
    assert pk == ["user_id", "op_id"]


async def test_migration_downgrade_removes_triggers(pg):
    """Runs the migration's own downgrade() in the test transaction (Postgres DDL is
    transactional, so the rollback puts everything back)."""
    spec = importlib.util.spec_from_file_location("mig_0127", MIGRATION)
    mig = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mig)

    async def triggers():
        return set((await pg.execute(text(
            "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN "
            "('articles'::regclass, 'user_article_states'::regclass)"))).scalars().all())

    before = await triggers()
    assert {"trg_articles_content_version", "trg_uas_change_stamps"} <= before

    conn = await pg.connection()

    def _downgrade(sync_conn):
        with Operations.context(MigrationContext.configure(sync_conn)):
            mig.downgrade()

    await conn.run_sync(_downgrade)

    assert await triggers() == before - {"trg_articles_content_version",
                                         "trg_uas_change_stamps"}
    for fn in ("articles_bump_content_version", "uas_stamp_changes"):
        assert await pg.scalar(text("SELECT to_regproc(:f)"), {"f": fn}) is None
    assert await pg.scalar(text("SELECT to_regclass('sync_applied_ops')")) is None
    cols = set((await pg.execute(text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name IN ('articles', 'user_article_states')"))).scalars().all())
    assert not cols & {"content_version", "read_changed_at", "star_changed_at",
                       "archive_changed_at", "saved_changed_at"}

"""Readable queue schema checks against PostgreSQL."""

from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.config import settings
from app.models.article import Article
from app.models.user import User
from tests.conftest import db_unreachable

pytestmark = pytest.mark.integration


@pytest_asyncio.fixture
async def pg():
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            try:
                await session.connection()
            except Exception as exc:
                db_unreachable(exc)
            yield session
    finally:
        await engine.dispose()


async def _new_article(pg):
    guid = uuid4().hex
    article = Article(guid=guid, guid_hash=guid, title="Readable queue test")
    pg.add(article)
    await pg.flush()
    return article


async def test_new_columns_default_on_demand(pg):
    article = await _new_article(pg)
    user = User(
        email=f"queue-{uuid4().hex}@test.invalid",
        password_hash="unused",
        display_name="Readable queue test",
    )
    pg.add(user)
    await pg.flush()
    await pg.refresh(article)
    await pg.refresh(user)

    assert article.readable_priority == 0
    assert article.readable_queued_at is None
    assert user.offline_synced_at is None


async def test_queue_index_exists(pg):
    indexdef = await pg.scalar(text("""
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'articles'
          AND indexname = 'ix_articles_readable_queue'
    """))

    assert indexdef is not None
    assert "(readable_status, readable_priority, readable_queued_at)" in indexdef


async def test_priority_change_does_not_bump_content_version(pg):
    article = await _new_article(pg)
    original_version = article.content_version

    await pg.execute(
        text("UPDATE articles SET readable_priority = 1 WHERE id = :id"),
        {"id": article.id},
    )
    await pg.refresh(article)

    assert article.readable_priority == 1
    assert article.content_version == original_version

"""Offline scope and sync manifest, against the real database (rolled back)."""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import delete, update
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.config import settings as app_settings
from app.models.article import Article, UserArticleState
from app.models.feed import Feed, UserFeed
from app.models.label import Label
from app.models.user import User
from app.services.label_service import assign_label
from app.services.sync import OFFLINE_TEMPLATE_VERSION
from app.services.sync.manifest import article_versions, list_versions
from app.services.sync.scope import offline_scope_ids

pytestmark = pytest.mark.integration

NOW = datetime.now(timezone.utc)


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
    user = User(email=f"sm_{uuid.uuid4().hex[:12]}@test.invalid", password_hash="x", display_name="t")
    pg.add(user)
    await pg.flush()
    return user


async def _feed(pg, user, subscribe=True) -> Feed:
    u = uuid.uuid4().hex[:12]
    feed = Feed(feed_url=f"https://ex.invalid/{u}.xml", title=f"Feed {u[:4]}", subscriber_count=1)
    pg.add(feed)
    await pg.flush()
    if subscribe:
        pg.add(UserFeed(user_id=user.id, feed_id=feed.id))
        await pg.flush()
    return feed


async def _article(pg, feed, age_hours=1, **kw) -> Article:
    u = uuid.uuid4().hex
    when = NOW - timedelta(hours=age_hours)
    article = Article(feed_id=feed.id, guid=u, guid_hash=u, title="T",
                      published_at=when, fetched_at=when, **kw)
    pg.add(article)
    await pg.flush()
    return article


async def _state(pg, user, article, **kw):
    pg.add(UserArticleState(user_id=user.id, article_id=article.id, **kw))
    await pg.flush()


async def test_scope_includes_unread_starred_archived_saved(pg):
    user = await _user(pg)
    feed = await _feed(pg, user)
    unread = await _article(pg, feed)
    starred, archived, saved = [await _article(pg, feed) for _ in range(3)]
    await _state(pg, user, starred, is_read=True, is_starred=True)
    await _state(pg, user, archived, is_read=True, is_archived=True)
    await _state(pg, user, saved, is_read=True, saved_at=NOW)
    assert set(await offline_scope_ids(user, pg)) == {unread.id, starred.id, archived.id, saved.id}


async def test_scope_excludes_read_unkept_and_trimmed(pg):
    user = await _user(pg)
    feed = await _feed(pg, user)
    read = await _article(pg, feed)
    await _state(pg, user, read, is_read=True)
    trimmed_unread = await _article(pg, feed, trimmed_at=NOW)
    trimmed_star = await _article(pg, feed, trimmed_at=NOW)
    await _state(pg, user, trimmed_star, is_read=True, is_starred=True)
    assert await offline_scope_ids(user, pg) == []
    assert trimmed_unread.id not in await offline_scope_ids(user, pg)


async def test_scope_excludes_hidden_and_suppressed_unread(pg):
    user = await _user(pg)
    feed = await _feed(pg, user)
    hidden, suppressed = await _article(pg, feed), await _article(pg, feed)
    await _state(pg, user, hidden, hidden_at=NOW)
    await _state(pg, user, suppressed, suppressed_at=NOW, suppressed_by="similar")
    assert await offline_scope_ids(user, pg) == []


async def test_scope_unread_limit_keeps_newest(pg):
    user = await _user(pg)
    feed = await _feed(pg, user)
    oldest = await _article(pg, feed, age_hours=30)
    mid = await _article(pg, feed, age_hours=20)
    newest = await _article(pg, feed, age_hours=10)
    ids = await offline_scope_ids(user, pg, unread_limit=2)
    assert set(ids) == {mid.id, newest.id}
    assert oldest.id not in ids


async def test_unread_article_without_state_row_in_scope(pg):
    user = await _user(pg)
    article = await _article(pg, await _feed(pg, user))
    assert await offline_scope_ids(user, pg) == [article.id]


async def test_unsubscribe_removes_unkept_from_scope(pg):
    user = await _user(pg)
    feed = await _feed(pg, user)
    unread = await _article(pg, feed)
    starred = await _article(pg, feed)
    await _state(pg, user, starred, is_read=True, is_starred=True)
    assert set(await offline_scope_ids(user, pg)) == {unread.id, starred.id}
    await pg.execute(delete(UserFeed).where(UserFeed.user_id == user.id))
    assert await offline_scope_ids(user, pg) == [starred.id]


async def test_version_changes_on_label_toggle(pg):
    user = await _user(pg)
    article = await _article(pg, await _feed(pg, user))
    label = Label(user_id=user.id, name="L")
    pg.add(label)
    await pg.flush()
    before = (await article_versions(user.id, [article.id], pg))[article.id]
    assert len(before) == 12
    assert await assign_label(user, article.id, label.id, pg)
    after = (await article_versions(user.id, [article.id], pg))[article.id]
    assert after != before


async def test_version_changes_on_read_toggle(pg):
    user = await _user(pg)
    article = await _article(pg, await _feed(pg, user))
    await _state(pg, user, article, is_read=False)
    before = (await article_versions(user.id, [article.id], pg))[article.id]
    await pg.execute(update(UserArticleState).where(UserArticleState.article_id == article.id)
                     .values(is_read=True))
    after = (await article_versions(user.id, [article.id], pg))[article.id]
    assert after != before


async def test_version_stable_on_dwell(pg):
    user = await _user(pg)
    article = await _article(pg, await _feed(pg, user))
    await _state(pg, user, article, is_read=False)
    before = (await article_versions(user.id, [article.id], pg))[article.id]
    await pg.execute(update(UserArticleState).where(UserArticleState.article_id == article.id)
                     .values(dwell_seconds=42))
    assert (await article_versions(user.id, [article.id], pg))[article.id] == before


async def test_article_versions_empty_and_unknown(pg):
    user = await _user(pg)
    assert await article_versions(user.id, [], pg) == {}
    assert await article_versions(user.id, [-1], pg) == {}


async def test_list_versions_keys_and_change(pg):
    user = await _user(pg)
    before = await list_versions(user, pg)
    assert set(before) == {"folders", "feeds", "labels", "saved_searches", "prefs", "templates"}
    assert before["templates"] == OFFLINE_TEMPLATE_VERSION
    pg.add(Label(user_id=user.id, name="X"))
    await pg.flush()
    after = await list_versions(user, pg)
    assert after["labels"] != before["labels"]
    assert after["folders"] == before["folders"]


def test_manifest_endpoint_requires_session(unauth_client):
    assert unauth_client.get("/sync/v1/manifest").status_code == 401


async def test_manifest_shape(pg):
    import httpx
    from app.auth.dependencies import get_current_user
    from app.database import get_db
    from app.main import app

    user = await _user(pg)
    article = await _article(pg, await _feed(pg, user))

    async def _db():
        yield pg

    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = _db
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as c:
            resp = await c.get("/sync/v1/manifest")
    finally:
        app.dependency_overrides.clear()
    assert resp.status_code == 200
    body = resp.json()
    datetime.fromisoformat(body["server_time"])
    assert [a[0] for a in body["articles"]] == [article.id]
    assert all(isinstance(a, list) and len(a) == 2 for a in body["articles"])
    assert set(body["lists"]) == {"folders", "feeds", "labels", "saved_searches", "prefs", "templates"}

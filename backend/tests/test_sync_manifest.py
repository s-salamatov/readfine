"""Offline scope and sync manifest, against the real database (rolled back)."""
import json
import re
import uuid
from base64 import b64encode
from datetime import datetime, timedelta, timezone

import httpx
import pytest
import pytest_asyncio
from itsdangerous import TimestampSigner
from sqlalchemy import delete, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings as app_settings
from app.models.article import Article, UserArticleState
from app.models.feed import Feed, UserFeed
from app.models.label import Label
from app.models.user import User, UserSettings
from app.services.label_service import assign_label
from app.services.sync import OFFLINE_TEMPLATE_VERSION
from app.services.sync.manifest import article_versions, changes_token, list_versions
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


async def test_full_text_flag_tracks_reader_and_status(pg):
    from app.services.sync.full_text import full_text_flag

    eligible = {
        "readable_status": "pending", "has_readable_content": False,
        "url": "https://ex.invalid/article", "trimmed": False, "subscribed": True,
        "extract_readable": True, "readable_auto_disabled": False,
    }
    for overrides, expected in (
        ({}, False),
        ({"readable_status": "skipped"}, False),
        ({"readable_status": "success"}, False),
        ({"url": None}, None),
        ({"trimmed": True}, None),
        ({"subscribed": False, "extract_readable": None, "readable_auto_disabled": None}, None),
        ({"extract_readable": False}, None),
        ({"readable_auto_disabled": True}, None),
        ({"readable_status": "failed", "has_readable_content": True}, None),
        ({"readable_status": "success", "has_readable_content": True, "url": None,
          "trimmed": True, "subscribed": False, "extract_readable": False,
          "readable_auto_disabled": True}, True),
    ):
        assert full_text_flag(**(eligible | overrides)) is expected, overrides

    user, other = await _user(pg), await _user(pg)
    feed = await _feed(pg, user)
    pg.add(UserFeed(user_id=other.id, feed_id=feed.id, extract_readable=False))
    article = await _article(pg, feed, url=eligible["url"], readable_status="pending")
    await _state(pg, user, article, is_read=True, is_starred=True)

    async def versions(reader):
        return (await article_versions(reader.id, [article.id], pg))[article.id], await changes_token(reader.id, pg)

    subscription = UserFeed.user_id == user.id
    other_before = await versions(other)
    article_before, token_before = await versions(user)
    for change in (
        update(UserFeed).where(subscription).values(extract_readable=False),
        update(UserFeed).where(subscription).values(readable_auto_disabled=True),
        delete(UserFeed).where(subscription),
    ):
        await pg.execute(change)
        article_after, token_after = await versions(user)
        assert article_after != article_before
        assert token_after != token_before
        assert await versions(other) == other_before
        article_before, token_before = article_after, token_after
    assert await offline_scope_ids(user, pg) == [article.id]

    # Hold content_version fixed to exercise the digest's explicit status input.
    content_version = article.content_version
    await pg.execute(update(Article).where(Article.id == article.id).values(readable_status="failed"))
    await pg.execute(update(Article).where(Article.id == article.id).values(content_version=content_version))
    article_after, _ = await versions(user)
    assert article_after != article_before


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
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost", headers={"X-Readfine-User": str(user.id)}) as c:
            resp = await c.get("/sync/v1/manifest")
    finally:
        app.dependency_overrides.clear()
    assert resp.status_code == 200
    body = resp.json()
    datetime.fromisoformat(body["server_time"])
    assert re.fullmatch(r"[0-9a-f]{12}", body["token"])
    assert [a[0] for a in body["articles"]] == [article.id]
    assert all(isinstance(a, list) and len(a) == 2 for a in body["articles"])
    assert set(body["lists"]) == {"folders", "feeds", "labels", "saved_searches", "prefs", "templates"}
    assert body["limits"] == {"media_budget_mb": 2048}


@pytest_asyncio.fixture
async def freshness_accounts(pg):
    # Trigger stamps use transaction time; the route test also needs a second writer.
    sessions = async_sessionmaker(pg.bind.engine, expire_on_commit=False)
    async with sessions() as db:
        reader, other = await _user(db), await _user(db)
        feed = await _feed(db, reader, subscribe=False)
        other_feed = await _feed(db, other)
        await db.commit()
    try:
        yield sessions, reader, other, feed, other_feed
    finally:
        feed_ids = [feed.id, other_feed.id]
        async with sessions.begin() as db:
            await db.execute(delete(User).where(User.id.in_([reader.id, other.id])))
            await db.execute(delete(Article).where(Article.feed_id.in_(feed_ids)))
            await db.execute(delete(Feed).where(Feed.id.in_(feed_ids)))


async def test_changes_token_tracks_only_reader_fast_path(freshness_accounts):
    from app.services.sync import manifest as manifest_service

    sessions, reader, other, feed, other_feed = freshness_accounts
    async with sessions() as db:
        async def token():
            return await manifest_service.changes_token(reader.id, db)

        async def commit_and_check(before, reason, *, changes=True):
            await db.commit()
            after = await token()
            assert (after != before) == changes, reason
            return after

        before = await token()
        assert re.fullmatch(r"[0-9a-f]{12}", before)
        assert before == await token()

        db.add(UserFeed(user_id=reader.id, feed_id=feed.id))
        before = await commit_and_check(before, "subscribe")
        article = await _article(db, feed)
        before = await commit_and_check(before, "new subscribed article")
        article_row = update(Article).where(Article.id == article.id)
        for field, value in (
            ("content", "Feed body"),
            ("readable_content", "Full text"),
            ("readable_status", "success"),
            ("trimmed_at", NOW),
        ):
            await db.execute(article_row.values({field: value}))
            before = await commit_and_check(before, field)
        await db.execute(article_row.values(trimmed_at=None))
        before = await commit_and_check(before, "restore trimmed article")

        await _state(db, reader, article)
        state_row = update(UserArticleState).where(
            UserArticleState.user_id == reader.id, UserArticleState.article_id == article.id
        )
        for field, value in (
            ("is_read", True), ("is_starred", True), ("is_archived", True), ("saved_at", NOW),
        ):
            await db.execute(state_row.values({field: value}))
            before = await commit_and_check(before, field)

        await db.execute(state_row.values(dwell_seconds=42))
        await commit_and_check(before, "dwell", changes=False)
        label = Label(user_id=reader.id, name="Token test")
        db.add(label)
        await db.flush()
        assert await assign_label(reader, article.id, label.id, db)
        await commit_and_check(before, "label membership", changes=False)
        await db.execute(state_row.values(ai_summary="Summary", ai_context="Context", ai_score=0.5))
        await commit_and_check(before, "AI state", changes=False)

        other_article = await _article(db, other_feed)
        await _state(db, other, article, is_read=True)
        await _state(db, other, other_article, is_starred=True)
        await commit_and_check(before, "another reader's feed and state", changes=False)

        prefs = UserSettings(user_id=reader.id)
        db.add(prefs)
        await db.commit()
        before = await token()
        prefs.timezone = "Europe/Paris"
        before = await commit_and_check(before, "prefs")
        subscription = update(UserFeed).where(UserFeed.user_id == reader.id, UserFeed.feed_id == feed.id)
        await db.execute(subscription.values(extract_readable=False))
        before = await commit_and_check(before, "extract off")
        await db.execute(subscription.values(readable_auto_disabled=True))
        before = await commit_and_check(before, "auto-disable")
        await db.execute(delete(UserFeed).where(UserFeed.user_id == reader.id, UserFeed.feed_id == feed.id))
        before = await commit_and_check(before, "unsubscribe")
        assert article.id in await offline_scope_ids(reader, db)
        await db.execute(article_row.values(content="Updated kept article"))
        await commit_and_check(before, "unsubscribed kept article", changes=False)


async def test_changes_route_requires_own_session_and_manifest_uses_early_token(
    freshness_accounts, monkeypatch
):
    from app.database import get_db
    from app.main import app
    from app.routers.web import sync

    sessions, reader, other, feed, _ = freshness_accounts
    async with sessions.begin() as db:
        db.add(UserFeed(user_id=reader.id, feed_id=feed.id))
        article = await _article(db, feed)

    async def request_db():
        async with sessions() as db:
            yield db

    def session_headers(user):
        payload = b64encode(json.dumps({"user_id": user.id, "tv": user.session_token_version}).encode())
        cookie = TimestampSigner(app_settings.secret_key).sign(payload).decode()
        return {"Cookie": f"session={cookie}"}

    monkeypatch.setitem(app.dependency_overrides, get_db, request_db)
    path = "/sync/changes"
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://localhost") as client:
        response = await client.get(path, headers={"X-Readfine-User": str(reader.id)})
        assert response.status_code == 401
        assert response.headers["cache-control"] == "no-store"

        signed_in = session_headers(reader)
        for headers in (signed_in, {**signed_in, "X-Readfine-User": str(other.id)}):
            response = await client.get(path, headers=headers)
            assert response.status_code == 409
            assert response.json() == {"error": "account_mismatch"}
            assert response.headers["cache-control"] == "no-store"

        own = {**signed_in, "X-Readfine-User": str(reader.id)}
        poll = await client.get(path, headers=own)
        assert poll.status_code == 200
        assert poll.headers["cache-control"] == "no-store"
        assert set(poll.json()) == {"token"}
        early_token = poll.json()["token"]
        assert re.fullmatch(r"[0-9a-f]{12}", early_token)
        idle = await client.get("/sync/v1/manifest", headers=own)
        assert idle.status_code == 200
        assert idle.json()["token"] == early_token

        article_versions = sync.article_versions

        async def versions_after_write(user_id, ids, db):
            async with sessions.begin() as writer:
                await writer.execute(update(Article).where(Article.id == article.id).values(content="New body"))
            return await article_versions(user_id, ids, db)

        with monkeypatch.context() as race:
            race.setattr(sync, "article_versions", versions_after_write)
            concurrent = await client.get("/sync/v1/manifest", headers=own)
        assert concurrent.status_code == 200
        assert concurrent.json()["articles"] != idle.json()["articles"]
        assert concurrent.json()["token"] == early_token
        next_poll = await client.get(path, headers=own)
        assert next_poll.status_code == 200
        assert next_poll.json()["token"] != early_token

        for _ in range(28):
            assert (await client.get(path, headers=own)).status_code == 200
        limited = await client.get(path, headers=own)
        assert limited.status_code == 429
        assert limited.headers["cache-control"] == "no-store"
        assert limited.json() == {"detail": "Rate limit exceeded"}
        other_headers = {**session_headers(other), "X-Readfine-User": str(other.id)}
        assert (await client.get(path, headers=other_headers)).status_code == 200


async def test_article_versions_takes_any_number_of_ids(pg):
    """One array bind, not one bind per id (asyncpg allows at most 32767)."""
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user))
    versions = await article_versions(user.id, [art.id] + list(range(10**9, 10**9 + 40000)), pg)
    assert list(versions) == [art.id]


async def test_unread_limit_is_a_setting(pg, monkeypatch):
    from app.config import settings

    user = await _user(pg)
    feed = await _feed(pg, user)
    arts = [await _article(pg, feed, age_hours=h) for h in (1, 2, 3)]
    monkeypatch.setattr(settings, "offline_unread_limit", 2)
    assert await offline_scope_ids(user, pg) == sorted(a.id for a in arts[:2])

"""Offline readable backfill against the real database (rolled back)."""
from datetime import datetime, timedelta
from unittest.mock import AsyncMock

import httpx
import pytest
from sqlalchemy import update

from app.config import settings
from app.models.feed import UserFeed
from tests.test_sync_manifest import NOW, _article, _feed, _state, _user, pg  # noqa: F401
from tests.test_sync_payload import _client

pytestmark = pytest.mark.integration

ARTICLE_URL = "https://ex.invalid/article"


async def test_manifest_stamps_offline_synced_at_at_most_hourly(pg):
    from app.services.readable_backfill import stamp_offline_synced

    user = await _user(pg)
    assert await stamp_offline_synced(user, pg, now=NOW)
    await pg.commit()
    await pg.refresh(user)
    assert user.offline_synced_at == NOW

    assert not await stamp_offline_synced(user, pg, now=NOW + timedelta(minutes=30))
    assert user.offline_synced_at == NOW

    later = NOW + timedelta(minutes=61)
    assert await stamp_offline_synced(user, pg, now=later)
    await pg.commit()
    await pg.refresh(user)
    assert user.offline_synced_at == later


async def test_manifest_commits_only_when_stamp_changes(pg, monkeypatch):
    user = await _user(pg)
    commit = AsyncMock(wraps=pg.commit)
    monkeypatch.setattr(pg, "commit", commit)
    app = await _client(pg, user)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://localhost",
            headers={"X-Readfine-User": str(user.id)},
        ) as client:
            first = await client.get("/sync/v1/manifest")
            second = await client.get("/sync/v1/manifest")
    finally:
        app.dependency_overrides.clear()

    assert first.status_code == second.status_code == 200
    commit.assert_awaited_once()
    await pg.refresh(user)
    assert user.offline_synced_at == datetime.fromisoformat(first.json()["server_time"])


async def test_marks_only_skipped_in_scope_with_extraction_on(pg):
    from app.services.readable_backfill import mark_backfill

    user = await _user(pg)
    user.offline_synced_at = NOW - timedelta(days=1)
    enabled, disabled, blocked, unsubscribed = [
        await _feed(pg, user, subscribe=subscribe)
        for subscribe in (True, True, True, False)
    ]
    await pg.execute(update(UserFeed).where(UserFeed.feed_id == disabled.id)
                     .values(extract_readable=False))
    await pg.execute(update(UserFeed).where(UserFeed.feed_id == blocked.id)
                     .values(readable_auto_disabled=True))
    eligible = await _article(pg, enabled, url=ARTICLE_URL)
    completed = await _article(pg, enabled, url=ARTICLE_URL, readable_status="success")
    demand = await _article(pg, enabled, url=ARTICLE_URL, readable_status="pending",
                            readable_priority=0, readable_queued_at=NOW - timedelta(hours=1))
    read = await _article(pg, enabled, url=ARTICLE_URL)
    await _state(pg, user, read, is_read=True)
    kept = await _article(pg, unsubscribed, url=ARTICLE_URL)
    await _state(pg, user, kept, is_read=True, is_starred=True)
    exclusions = [
        await _article(pg, disabled, url=ARTICLE_URL),
        await _article(pg, blocked, url=ARTICLE_URL),
        read,
        kept,
        await _article(pg, enabled),
        await _article(pg, enabled, url=""),
        await _article(pg, enabled, url=ARTICLE_URL, trimmed_at=NOW),
    ]

    assert await mark_backfill(pg, now=NOW) == 1
    for article in [eligible, completed, demand, *exclusions]:
        await pg.refresh(article)
    assert (eligible.readable_status, eligible.readable_priority, eligible.readable_queued_at) == (
        "pending", 1, NOW,
    )
    assert completed.readable_status == "success"
    assert (demand.readable_status, demand.readable_priority, demand.readable_queued_at) == (
        "pending", 0, NOW - timedelta(hours=1),
    )
    assert all(article.readable_status == "skipped" for article in exclusions)


async def test_users_idle_over_14_days_are_not_marked(pg):
    from app.services.readable_backfill import mark_backfill

    articles = []
    for last_sync in (NOW - timedelta(days=15), None):
        user = await _user(pg)
        user.offline_synced_at = last_sync
        articles.append(await _article(pg, await _feed(pg, user), url=ARTICLE_URL))

    assert await mark_backfill(pg, now=NOW) == 0
    for article in articles:
        await pg.refresh(article)
        assert article.readable_status == "skipped"


async def test_marks_in_batches_of_200(pg, monkeypatch):
    from app.services.readable_backfill import mark_backfill_for_user

    monkeypatch.setattr(settings, "offline_unread_limit", 450)
    user = await _user(pg)
    feed = await _feed(pg, user)
    for _ in range(450):
        await _article(pg, feed, url=ARTICLE_URL)
    commit = AsyncMock(wraps=pg.commit)
    monkeypatch.setattr(pg, "commit", commit)

    assert await mark_backfill_for_user(user, pg, now=NOW) == 450
    assert commit.await_count == 3

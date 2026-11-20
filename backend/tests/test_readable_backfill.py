"""Offline readable backfill against the real database."""
import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import httpx
import pytest
from apscheduler.events import EVENT_JOB_ERROR, EVENT_JOB_EXECUTED, EVENT_JOB_MAX_INSTANCES
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import settings
from app.fetcher import scheduler as scheduler_module
from app.models.article import Article
from app.models.feed import Feed, UserFeed
from app.services import readable_service
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
    calls = []
    original_commit = pg.commit

    async def commit():
        await original_commit()
        calls.append("commit")

    monkeypatch.setattr(pg, "commit", commit)
    monkeypatch.setattr(scheduler_module, "scheduler", AsyncIOScheduler(timezone="UTC"))
    sched = scheduler_module.create_scheduler()
    modify_job = sched.modify_job

    def record_wake(job_id, *, next_run_time):
        calls.append("wake-marker")
        assert job_id == "mark_readable_backfill"
        assert next_run_time.tzinfo is timezone.utc
        assert before <= next_run_time <= datetime.now(timezone.utc)
        return modify_job(job_id, next_run_time=next_run_time)

    monkeypatch.setattr(sched, "modify_job", record_wake)
    app = await _client(pg, user)
    before = datetime.now(timezone.utc)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://localhost",
            headers={"X-Readfine-User": str(user.id)},
        ) as client:
            first = await client.get("/sync/v1/manifest")
            calls_after_first = calls.copy()
            second = await client.get("/sync/v1/manifest")
    finally:
        app.dependency_overrides.clear()

    assert first.status_code == second.status_code == 200
    assert calls_after_first == calls == ["commit", "wake-marker"]
    await pg.refresh(user)
    assert user.offline_synced_at == datetime.fromisoformat(first.json()["server_time"])


@pytest.mark.parametrize("first_raises", [False, True], ids=["return", "error"])
async def test_executor_completion_runs_one_queued_follow_up(pg, monkeypatch, first_raises):
    sessions = async_sessionmaker(pg.bind.engine, expire_on_commit=False)
    monkeypatch.setattr(scheduler_module.db, "async_session_factory", sessions)
    monkeypatch.setattr(scheduler_module, "scheduler", AsyncIOScheduler(timezone="UTC"))
    sched = scheduler_module.create_scheduler()
    for job in sched.get_jobs():
        if job.id != "process_readable":
            sched.remove_job(job.id)

    first_read = asyncio.Event()
    release_first = asyncio.Event()
    rejected = asyncio.Event()
    first_finished = asyncio.Event()
    follow_up_finished = asyncio.Event()
    completion_codes = []
    picked = []
    flags_at_entry = []
    active_passes = peak_active_passes = 0

    def observe_job(event):
        if event.job_id != "process_readable":
            return
        if event.code == EVENT_JOB_MAX_INSTANCES:
            rejected.set()
        else:
            completion_codes.append(event.code)
            if len(completion_codes) == 1:
                first_finished.set()
            else:
                follow_up_finished.set()

    sched.add_listener(observe_job, EVENT_JOB_MAX_INSTANCES | EVENT_JOB_EXECUTED | EVENT_JOB_ERROR)

    async def pick_pending(session):
        nonlocal active_passes, peak_active_passes
        flags_at_entry.append(getattr(scheduler_module, "wake_pending", None))
        active_passes += 1
        peak_active_passes = max(active_passes, peak_active_passes)
        first_pass = len(flags_at_entry) == 1
        try:
            ids = (await session.scalars(
                select(Article.id).where(
                    Article.feed_id == feed.id, Article.readable_status == "pending",
                )
            )).all()
            picked.extend(ids)
            if first_pass:
                first_read.set()
                await release_first.wait()
            await session.execute(
                update(Article).where(Article.id.in_(ids)).values(readable_status="success")
            )
            await session.commit()
            if first_pass and first_raises:
                raise RuntimeError("pass A failed")
        finally:
            active_passes -= 1

    monkeypatch.setattr(readable_service, "process_pending_readable", pick_pending)
    async with sessions() as ingest:
        feed = await _feed(ingest, None, subscribe=False)
        article_a = await _article(ingest, feed, url=ARTICLE_URL, readable_status="pending")
        await ingest.commit()
        try:
            sched.modify_job("process_readable", next_run_time=datetime.now(timezone.utc))
            sched.start()
            await asyncio.wait_for(first_read.wait(), timeout=1)
            article_b = await _article(ingest, feed, url=ARTICLE_URL, readable_status="pending")
            await ingest.commit()
            scheduler_module.wake_readable()
            scheduler_module.wake_readable()
            await asyncio.wait_for(rejected.wait(), timeout=1)
            assert scheduler_module.wake_pending is True

            release_first.set()
            await asyncio.wait_for(follow_up_finished.wait(), timeout=1)
            assert picked == [article_a.id, article_b.id]
            assert peak_active_passes == 1
            assert flags_at_entry == [False, False]
            assert completion_codes == [
                EVENT_JOB_ERROR if first_raises else EVENT_JOB_EXECUTED, EVENT_JOB_EXECUTED,
            ]
            assert sched.get_job("process_readable").next_run_time > (
                datetime.now(timezone.utc) + timedelta(seconds=1)
            )
        finally:
            try:
                if sched.running:
                    sched.pause()
                    release_first.set()
                    try:
                        if first_read.is_set():
                            await asyncio.wait_for(first_finished.wait(), timeout=1)
                    finally:
                        sched.shutdown()
                        await asyncio.sleep(0)  # AsyncIOScheduler queues shutdown on the loop.
            finally:
                await ingest.rollback()
                await ingest.execute(delete(Article).where(Article.feed_id == feed.id))
                await ingest.execute(delete(Feed).where(Feed.id == feed.id))
                await ingest.commit()


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

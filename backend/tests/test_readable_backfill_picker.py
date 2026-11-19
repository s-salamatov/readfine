"""Readable queue ordering, host pacing and cancellation against PostgreSQL."""

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.fetcher import host_throttle
from app.models.article import Article, ArticleAiJob, UserArticleState
from app.models.feed import UserFeed
from app.models.label import ArticleLabel, Label
from app.models.user import UserSettings
from app.services import ai_pipeline_service, ai_scoring_service, ai_service, readable_service as readable
from tests.test_sync_manifest import _article, _feed, _user, pg  # noqa: F401


@pytest.fixture(autouse=True)
def reset_host_pacing(monkeypatch):
    host_throttle.clear()
    monkeypatch.setattr(readable, "_backfill_next_at", {}, raising=False)
    yield
    host_throttle.clear()


async def _queue(pg, feed, host, priority=1, **fields):
    return await _article(
        pg, feed, url=f"https://{host}/article", readable_status="pending",
        readable_priority=priority, **fields,
    )


def _record_extraction(monkeypatch, *, result=None):
    extract = AsyncMock(return_value=result or readable.ReadableResult(content="<p>Text</p>"))
    pipeline = AsyncMock()
    monkeypatch.setattr(readable, "_extract_for_batch", extract)
    monkeypatch.setattr(ai_pipeline_service, "run_pipeline_for_article_all_users", pipeline)
    return extract, pipeline


async def test_on_demand_runs_before_backfill_and_backfill_newest_first(pg, monkeypatch):
    feed = await _feed(pg, await _user(pg))
    now = datetime.now(timezone.utc)
    queued = await _queue(pg, feed, "queued.test", 0, readable_queued_at=now)
    legacy = await _queue(pg, feed, "legacy.test", 0)
    backfill = [await _queue(pg, feed, f"backfill-{i}.test") for i in range(3)]
    extract, _ = _record_extraction(monkeypatch)

    assert await readable.process_pending_readable(pg) == 5
    assert [call.args[0].id for call in extract.await_args_list] == [
        legacy.id, queued.id, backfill[2].id, backfill[1].id, backfill[0].id,
    ]


async def test_backfill_capped_at_30_and_skips_waiting_hosts(pg, monkeypatch):
    feed = await _feed(pg, await _user(pg))
    distinct_hosts = [await _queue(pg, feed, f"host-{i}.test") for i in range(40)]
    waiting = await _queue(pg, feed, "a.test")
    extract, _ = _record_extraction(monkeypatch)
    now = datetime.now(timezone.utc)
    host_throttle.note_block("a.test", now + timedelta(minutes=2))

    assert await readable.process_pending_readable(pg) == 30
    assert [c.args[0].id for c in extract.await_args_list] == [
        a.id for a in reversed(distinct_hosts[-30:])
    ]
    assert waiting.readable_status == "pending"

    older, newer = [await _queue(pg, feed, "same.test") for _ in range(2)]
    long_wait = await _queue(pg, feed, "long-wait.test")
    host_throttle.note_block("long-wait.test", now + timedelta(minutes=2))
    fetches = []

    class FakeDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return now

    async def advance(seconds):
        nonlocal now
        now += timedelta(seconds=seconds)

    async def fetch(article, *_):
        fetches.append((article.id, now))
        await advance(1)
        return readable.ReadableResult(content="<p>Text</p>")

    monkeypatch.setattr(readable, "datetime", FakeDatetime)
    monkeypatch.setattr(readable, "sleep", advance, raising=False)
    extract.side_effect = fetch
    start = now

    assert await readable._run_backfill(pg, [long_wait, newer, older], 3, FakeDatetime.now) == 2
    assert [article_id for article_id, _ in fetches] == [newer.id, older.id]
    assert fetches[1][1] >= fetches[0][1] + timedelta(seconds=5)
    assert now <= start + timedelta(seconds=50)
    assert long_wait.readable_status == "pending"

    slow, untouched = [await _queue(pg, feed, f"{host}.test") for host in ("slow", "untouched")]
    commit = pg.commit

    async def slow_commit():
        await commit()
        await advance(29)

    async def slow_finalize(*args, **kwargs):
        await advance(25)

    async def fetch_forbidden(article, *args):
        await fetch(article, *args)
        return readable.ReadableResult(error="HTTP 403 Forbidden", http_status=403)

    monkeypatch.setattr(pg, "commit", slow_commit)
    monkeypatch.setattr(readable, "_maybe_disable_readable_for_403", slow_finalize)
    extract.side_effect = fetch_forbidden
    fetches.clear()
    start = now
    deadline = start + timedelta(seconds=readable._BACKFILL_TIME_BUDGET_S)

    assert await readable._run_backfill(pg, [slow, untouched], 2, FakeDatetime.now) == 1
    assert fetches == [(slow.id, start)]
    assert deadline <= now <= start + timedelta(seconds=55)
    assert untouched.readable_status == "pending"


@pytest.mark.parametrize("terminal_failure", [False, True])
async def test_backfill_pipeline_runs_only_for_on_demand_or_promoted_rows(
    pg, monkeypatch, terminal_failure,
):
    user = await _user(pg)
    feed = await _feed(pg, user)
    demand = await _queue(pg, feed, "demand.test", 0)
    backfill = await _queue(pg, feed, "backfill.test")
    terminal = await _queue(pg, feed, "terminal.test")
    promoted = await _queue(pg, feed, "promoted.test")
    untouched = await _queue(pg, feed, "untouched.test")
    label = Label(user_id=user.id, name="Score")
    pg.add_all([label, UserSettings(
        user_id=user.id, ai_scoring_enabled_default=True, ai_preference_text="News",
        ai_fast_provider="anthropic", ai_fast_model="claude-haiku-4-5",
    )])
    await pg.flush()
    pg.add_all([
        ArticleLabel(user_id=user.id, label_id=label.id, article_id=article.id)
        for article in (backfill, terminal, promoted, untouched)
    ])
    await pg.flush()
    monkeypatch.setattr(ai_scoring_service, "ai_enabled_globally", AsyncMock(return_value=True))
    monkeypatch.setattr(ai_scoring_service, "ai_work_held_back", AsyncMock(return_value=False))
    extract, pipeline = _record_extraction(monkeypatch)
    now = datetime.now(timezone.utc)
    deadline = now + timedelta(seconds=readable._BACKFILL_TIME_BUDGET_S)

    async def fetch(article, *_):
        nonlocal now
        assert now < deadline
        if article.id == promoted.id:
            await pg.execute(
                update(Article.__table__).where(Article.id == article.id)
                .values(readable_priority=0)
            )
            assert article.readable_priority == 1
            if terminal_failure:
                now = deadline  # The last candidate can finish after the budget.
        if article.id == terminal.id or (article.id == promoted.id and terminal_failure):
            return readable.ReadableResult(error="HTTP 404", http_status=404)
        return readable.ReadableResult(content="<p>Text</p>")

    extract.side_effect = fetch
    assert await readable._run_backfill(
        pg, [backfill, terminal, promoted, untouched], 4, lambda: now,
    ) == 3
    assert backfill.readable_status == "success"
    assert terminal.readable_status == "failed"
    assert promoted.readable_status == ("failed" if terminal_failure else "success")
    assert untouched.readable_status == "pending"
    assert [c.args[0].id for c in extract.await_args_list] == [backfill.id, terminal.id, promoted.id]
    pipeline.assert_awaited_once_with(promoted, pg)
    assert await pg.scalar(select(ArticleAiJob).where(ArticleAiJob.user_id == user.id)) is None

    extract.side_effect = None
    assert await readable.process_pending_readable(pg) == 2
    assert [c.args[0].id for c in pipeline.await_args_list] == [promoted.id, demand.id]


async def test_backfill_does_not_arm_feed_pacing(pg, monkeypatch):
    feed = await _feed(pg, await _user(pg))
    await _queue(pg, feed, "ok.test")
    limited = await _queue(pg, feed, "limited.test")
    extract, _ = _record_extraction(monkeypatch)
    extract.side_effect = lambda article, *_: (
        readable.ReadableResult(error="HTTP 429", http_status=429)
        if article.id == limited.id else readable.ReadableResult(content="<p>Text</p>")
    )

    assert await readable.process_pending_readable(pg) == 2
    now = datetime.now(timezone.utc)
    assert host_throttle.blocked_until("ok.test", now, include_block=True) is None
    assert host_throttle.blocked_until("limited.test", now, include_block=True) is not None


@pytest.mark.parametrize(("reason", "exhaust_budget"), [
    ("403", False), ("403", True), ("empty", False), ("empty", True),
    ("full_content", False),
])
async def test_feed_disable_drops_backfill_without_scoring(pg, monkeypatch, reason, exhaust_budget):
    user = await _user(pg)
    feed = await _feed(pg, user)
    http_status = 403 if reason == "403" else None
    if http_status == 403:
        error = "HTTP 403 Forbidden"
        threshold = readable._CONSECUTIVE_403_THRESHOLD
    else:
        error = readable._EMPTY_CONTENT_MSG
        threshold = readable._CONSECUTIVE_EMPTY_THRESHOLD

    queued_at = now = datetime.now(timezone.utc)
    backfill = await _queue(pg, feed, "backfill.test", readable_queued_at=queued_at)
    promoted = await _queue(pg, feed, "promoted.test", readable_queued_at=queued_at)
    finished = await _queue(pg, feed, "finished.test")
    # A kept history can exceed asyncpg's limit of 32,767 bind parameters.
    backlog_size = 33_000
    backlog_priority = 0 if reason == "full_content" else 1
    await pg.execute(text("""
        INSERT INTO articles (feed_id, guid, guid_hash, title, readable_status,
                              readable_priority, readable_queued_at, readable_retries)
        SELECT :feed_id, 'large-backfill-' || n, 'large-backfill-' || n, 'Backfill',
               'pending', :priority, :queued_at, 0
        FROM generate_series(1, :backlog_size) AS series(n)
    """), {"feed_id": feed.id, "queued_at": queued_at, "backlog_size": backlog_size,
           "priority": backlog_priority})
    for i in range(threshold - 1):
        await _article(
            pg, feed, url=f"https://failure-{i}.test/", readable_status="failed",
            readable_error=error,
        )
    candidate = await _queue(pg, feed, "candidate.test", readable_retries=readable.MAX_RETRIES - 1)
    other_feed = await _feed(pg, await _user(pg))
    untouched = await _queue(pg, other_feed, "untouched.test")
    label = Label(user_id=user.id, name="Score")
    pg.add_all([label, UserSettings(
        user_id=user.id, ai_scoring_enabled_default=True, ai_preference_text="News",
        ai_fast_provider="anthropic", ai_fast_model="claude-haiku-4-5",
    )])
    await pg.flush()
    pg.add_all([
        ArticleLabel(user_id=user.id, label_id=label.id, article_id=article.id)
        for article in (backfill, promoted, candidate)
    ])
    await pg.flush()

    @asynccontextmanager
    async def fake_client(*args):
        yield object(), "anthropic", "claude-haiku-4-5"

    score = AsyncMock(return_value=(0.91, 10, 2))
    monkeypatch.setattr(ai_service, "ai_client", fake_client)
    monkeypatch.setattr(ai_service, "score_article", score)
    monkeypatch.setattr(ai_scoring_service, "ai_enabled_globally", AsyncMock(return_value=True))
    monkeypatch.setattr(ai_scoring_service, "ai_work_held_back", AsyncMock(return_value=False))
    if reason == "full_content":
        labelled_ids = (await pg.scalars(select(Article.id).where(
            Article.feed_id == feed.id,
            Article.guid.in_(["large-backfill-1", f"large-backfill-{backlog_size}"]),
        ).order_by(Article.id))).all()
        assert len(labelled_ids) == 2
        pg.add_all([
            ArticleLabel(user_id=user.id, label_id=label.id, article_id=article_id)
            for article_id in labelled_ids
        ])
        await pg.flush()
        monkeypatch.setattr(readable, "sample_feed_content", AsyncMock(
            return_value=readable.FullContentSample(20, 20),
        ))

        async with AsyncSession(
            bind=await pg.connection(), expire_on_commit=False, join_transaction_mode="create_savepoint",
        ) as worker:
            assert await readable.maybe_disable_readable_for_feed(feed.id, worker) is True
            await worker.commit()

        subscription = await pg.scalar(select(UserFeed).where(
            UserFeed.user_id == user.id, UserFeed.feed_id == feed.id,
        ))
        assert subscription.extract_readable is False
        assert subscription.readable_auto_disabled_reason == "full_content"
        assert await pg.scalar(select(func.count()).select_from(Article).where(
            Article.feed_id == feed.id,
            Article.guid.like("large-backfill-%"),
            Article.readable_status == "skipped",
            Article.readable_priority == 0,
            Article.readable_queued_at == queued_at,
            Article.readable_error.is_(None),
        )) == backlog_size
        jobs = (await pg.execute(
            select(ArticleAiJob.article_id, ArticleAiJob.operation, ArticleAiJob.status)
            .where(ArticleAiJob.user_id == user.id)
            .order_by(ArticleAiJob.article_id)
        )).all()
        assert jobs == [(article_id, "scoring", "pending") for article_id in labelled_ids]
        score.assert_not_awaited()
        return

    deadline = now + timedelta(seconds=readable._BACKFILL_TIME_BUDGET_S)

    async def fetch(article, *_):
        nonlocal now
        assert now < deadline
        await worker.execute(
            update(Article.__table__).where(Article.id == promoted.id)
            .values(readable_priority=0)
        )
        await worker.execute(
            update(Article.__table__).where(Article.id == finished.id)
            .values(readable_status="success", readable_content="<p>Finished elsewhere</p>")
        )
        # The older success leaves the terminal failure streak intact.
        if exhaust_budget:
            now = deadline
        return readable.ReadableResult(error=error, http_status=http_status)

    extract = AsyncMock(side_effect=fetch)
    monkeypatch.setattr(readable, "_extract_for_batch", extract)
    # Model scheduler session close while keeping fixture data rollback-only.
    async with AsyncSession(
        bind=await pg.connection(), expire_on_commit=False, join_transaction_mode="create_savepoint",
    ) as worker:
        candidates = [await worker.get(Article, a.id) for a in (candidate, untouched)]
        assert await readable._run_backfill(worker, candidates, 2, lambda: now) == 1

    assert [c.args[0].id for c in extract.await_args_list] == [candidate.id]
    assert await pg.scalar(select(UserFeed.extract_readable).where(
        UserFeed.user_id == user.id, UserFeed.feed_id == feed.id,
    )) is False
    assert await pg.scalar(select(func.count()).select_from(Article).where(
        Article.feed_id == feed.id,
        Article.guid.like("large-backfill-%"),
        Article.readable_status == "skipped",
        Article.readable_priority == 0,
        Article.readable_queued_at.is_(None),
        Article.readable_error == error,
    )) == backlog_size
    for article in (backfill, promoted, finished, candidate, untouched):
        await pg.refresh(article)
    assert candidate.readable_status == "failed"
    assert untouched.readable_status == "pending"
    assert backfill.readable_status == promoted.readable_status == "skipped"
    assert (backfill.readable_priority, backfill.readable_queued_at) == (0, None)
    assert (promoted.readable_priority, promoted.readable_queued_at) == (0, queued_at)
    assert promoted.readable_error == error
    score.assert_awaited_once()
    jobs = (await pg.execute(
        select(ArticleAiJob.article_id, ArticleAiJob.operation, ArticleAiJob.status)
        .where(ArticleAiJob.user_id == user.id)
    )).all()
    assert jobs == [(promoted.id, "scoring", "success")]
    assert await pg.scalar(select(UserArticleState.ai_score).where(
        UserArticleState.user_id == user.id, UserArticleState.article_id == promoted.id,
    )) == pytest.approx(0.91)
    assert finished.readable_status == "success"
    assert finished.readable_content == "<p>Finished elsewhere</p>"

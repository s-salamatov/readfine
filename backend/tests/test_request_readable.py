from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import event, select, update

from app.models.article import Article, ArticleAiJob
from app.models.feed import UserFeed
from app.models.filter import Filter, FilterAction, FilterCondition
from app.models.label import Label
from app.models.user import UserSettings
from app.routers.web.app import articles
from app.services import filter_service
from app.services.label_service import assign_label
from tests.conftest import make_mock_db
from tests.test_sync_manifest import _article, _feed, _user, pg  # noqa: F401


NOW = datetime(2026, 11, 19, tzinfo=timezone.utc)


@pytest.mark.integration
@pytest.mark.parametrize(
    ("loaded_status", "loaded_priority", "current_status", "current_priority", "retry_at", "startable"),
    [
        ("skipped", 0, "skipped", 0, NOW + timedelta(hours=1), True),
        ("skipped", 0, "success", 0, None, False),
        ("skipped", 0, "pending", 1, None, True),
        ("pending", 1, "pending", 0, NOW + timedelta(minutes=5), False),
    ],
    ids=["fresh", "completed", "marked", "claimed"],
)
async def test_on_demand_request_uses_current_queue_state(
    pg, loaded_status, loaded_priority, current_status, current_priority, retry_at, startable,
):
    from app.services.readable_service import request_readable

    feed = await _feed(pg, await _user(pg))
    article = await _article(
        pg, feed, readable_status=loaded_status, readable_priority=loaded_priority,
        readable_retries=3, readable_next_retry_at=NOW + timedelta(hours=1),
    )
    article_id = article.id
    pg.expunge(article)
    article = await pg.get(Article, article_id)

    # Change the stored row without updating the trigger's ORM identity.
    queued_at = NOW - timedelta(minutes=1)
    table = Article.__table__
    await pg.execute(
        update(table).where(table.c.id == article_id).values(
            readable_status=current_status, readable_priority=current_priority,
            readable_queued_at=queued_at, readable_next_retry_at=retry_at,
            readable_retries=3 if current_status == "skipped" else 0,
        )
    )
    assert (article.readable_status, article.readable_priority) == (loaded_status, loaded_priority)

    expected = (
        "pending" if current_status == "skipped" else current_status,
        0,
        NOW if current_status == "skipped" else queued_at,
        0,
        None if current_status == "skipped" else retry_at,
    )
    actual_startable = await pg.run_sync(lambda _: request_readable(article, "star", now=NOW))
    await pg.flush()
    persisted = (await pg.execute(
        table.select().where(table.c.id == article_id)
    )).one()
    fields = (
        "readable_status", "readable_priority", "readable_queued_at",
        "readable_retries", "readable_next_retry_at",
    )
    assert tuple(getattr(persisted, field) for field in fields) == expected
    assert tuple(getattr(article, field) for field in fields) == expected
    assert actual_startable is startable


def test_backfill_pending_is_lifted_and_startable():
    from app.services.readable_service import request_readable

    queued_at = NOW - timedelta(minutes=1)
    article = Article(
        readable_status="pending", readable_priority=1, readable_retries=0,
        readable_queued_at=queued_at,
    )
    assert request_readable(article, "open", now=NOW)
    assert article.readable_priority == 0
    assert article.readable_queued_at == queued_at
    assert not request_readable(article, "open", now=NOW + timedelta(minutes=1))
    assert article.readable_queued_at == queued_at

    retry_at = NOW + timedelta(hours=1)
    backing_off = Article(
        readable_status="pending", readable_priority=1, readable_retries=2,
        readable_next_retry_at=retry_at, readable_queued_at=queued_at,
    )
    assert not request_readable(backing_off, "filter", now=NOW)
    assert backing_off.readable_priority == 0
    assert backing_off.readable_queued_at == queued_at
    assert backing_off.readable_retries == 2
    assert backing_off.readable_next_retry_at == retry_at


def test_failed_only_retried_by_sync_op():
    from app.services.readable_service import request_readable

    article = Article(readable_status="failed", readable_priority=1, readable_retries=5)
    assert not request_readable(article, "label", now=NOW)
    assert article.readable_status == "failed"
    assert article.readable_priority == 1
    assert article.readable_retries == 5
    assert request_readable(article, "sync_op", now=NOW)
    assert article.readable_status == "pending"
    assert article.readable_priority == 0
    assert article.readable_retries == 0
    assert article.readable_next_retry_at == article.readable_queued_at == NOW


async def test_open_starts_a_backfill_queued_article(monkeypatch):
    article = Article(
        id=7, feed_id=5, url="https://example.invalid/article",
        readable_status="pending", readable_priority=1, readable_retries=0,
    )
    feed_row = SimpleNamespace(
        extract_readable=True, readable_status="pending", url=article.url,
        fetch_auth_user=None, fetch_auth_pass_encrypted=None, feed_url="https://example.invalid/feed",
    )
    db = make_mock_db()
    db.get.return_value = article
    db.execute.side_effect = [
        MagicMock(first=lambda: feed_row), SimpleNamespace(rowcount=1),
    ]
    monkeypatch.setattr(articles, "touch_last_active", AsyncMock())
    monkeypatch.setattr(articles, "get_article", AsyncMock(return_value=None))
    extract = AsyncMock()
    monkeypatch.setattr(articles, "_extract_readable_bg", extract)

    def close_background(coro, *, name):
        coro.close()

    spawn = MagicMock(side_effect=close_background)
    monkeypatch.setattr(articles, "spawn_background", spawn)

    await articles.htmx_article_detail(
        article.id, SimpleNamespace(session={}), SimpleNamespace(id=1), db,
    )

    assert article.readable_priority == 0
    spawn.assert_called_once()
    extract.assert_called_once_with(7, article.url, None, None, feed_row.feed_url)


@pytest.mark.integration
@pytest.mark.parametrize("mode", ["manual", "retroactive", "retroactive-race"])
async def test_label_on_backfill_article_routes_scoring(pg, monkeypatch, mode):
    user = await _user(pg)
    feed = await _feed(pg, user)
    subscription = await pg.scalar(select(UserFeed).where(UserFeed.user_id == user.id))
    subscription.extract_readable = True
    label = Label(user_id=user.id, name="Test", color="#ffffff")
    pg.add_all([
        label,
        UserSettings(
            user_id=user.id, ai_scoring_enabled_default=True, ai_preference_text="Test",
            ai_fast_provider="openai", ai_fast_model="test",
        ),
    ])
    monkeypatch.setattr("app.services.ai_jobs.ai_enabled_globally", AsyncMock(return_value=True))
    queued_at = NOW - timedelta(minutes=1)
    article = await _article(
        pg, feed, readable_status="pending", readable_priority=1, readable_queued_at=queued_at,
    )
    jobs = select(ArticleAiJob.article_id).where(
        ArticleAiJob.user_id == user.id, ArticleAiJob.operation == "scoring",
    )
    if mode == "manual":
        assert await assign_label(user, article.id, label.id, pg)
        assert (article.readable_status, article.readable_priority) == ("pending", 0)
        assert (await pg.scalars(jobs)).all() == []
        return

    f = Filter(user_id=user.id, name="Test", is_active=True)
    f.conditions.append(FilterCondition(field="title", operator="contains", value="T"))
    f.actions.append(FilterAction(action_type="label", action_value=str(label.id)))
    pg.add(f)
    await pg.flush()
    if mode == "retroactive-race":
        original_plan = filter_service._plan_retroactive_apply
        table = Article.__table__

        async def complete_after_plan(*args):
            plan = await original_plan(*args)
            assert plan.scoring_count == 1
            assert plan.items[0].readable_pending
            await pg.execute(
                update(table).where(table.c.id == article.id).values(readable_status="success")
            )
            assert article.readable_status == "pending"
            return plan

        with monkeypatch.context() as patch:
            patch.setattr(filter_service, "_plan_retroactive_apply", complete_after_plan)
            assert await filter_service.apply_filter_retroactively(user.id, f.id, pg) == (1, 1, 1)
        assert (article.readable_status, article.readable_priority) == ("success", 1)
        assert await filter_service.apply_filter_retroactively(user.id, f.id, pg) == (1, 0, 0)
        assert (await pg.scalars(jobs)).all() == [article.id]
        return

    promoted = [article] + [
        await _article(
            pg, feed, readable_status="pending", readable_priority=1, readable_queued_at=queued_at,
            readable_retries=2, readable_next_retry_at=NOW,
        )
        for _ in range(19)
    ]
    skipped = await _article(
        pg, feed, readable_status="skipped", readable_retries=3, readable_next_retry_at=NOW,
    )
    queue_updates = 0

    def count_queue_updates(conn, cursor, statement, parameters, context, executemany):
        nonlocal queue_updates
        if statement.startswith("UPDATE articles SET readable_"):
            queue_updates += 1

    connection = (await pg.connection()).sync_connection
    event.listen(connection, "before_cursor_execute", count_queue_updates)
    try:
        assert await filter_service.apply_filter_retroactively(user.id, f.id, pg) == (21, 21, 0)
    finally:
        event.remove(connection, "before_cursor_execute", count_queue_updates)

    assert queue_updates == 2
    for item in promoted:
        assert (item.readable_status, item.readable_priority, item.readable_queued_at) == (
            "pending", 0, queued_at,
        )
    assert (promoted[-1].readable_retries, promoted[-1].readable_next_retry_at) == (2, NOW)
    assert (skipped.readable_status, skipped.readable_priority) == ("pending", 0)
    assert (skipped.readable_retries, skipped.readable_next_retry_at) == (0, None)
    assert skipped.readable_queued_at is not None
    assert (await pg.scalars(jobs)).all() == []

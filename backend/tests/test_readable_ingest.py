"""Readable queueing at RSS and scrape ingest against PostgreSQL."""
from datetime import timedelta
from unittest.mock import AsyncMock, Mock

import pytest
from sqlalchemy import delete, event, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.fetcher import rss, scheduler, scrape
from app.models.article import Article
from app.models.feed import Feed, UserFeed
from app.models.filter import Filter, FilterAction, FilterCondition
from app.models.user import User
from app.services import readable_backfill
from app.utils.url_validator import ConditionalResponse, PageResponse
from tests.test_sync_manifest import NOW, _article, _feed, _user, pg  # noqa: F401

pytestmark = pytest.mark.integration
RETRY_AT = NOW + timedelta(hours=1)


async def test_queue_new_rows_for_any_eligible_subscriber(pg):
    enabled, off = await _user(pg), await _user(pg)
    feed, off_feed, blocked_feed, other_feed = [
        await _feed(pg, user) for user in (enabled, off, enabled, enabled)
    ]
    pg.add(UserFeed(user_id=off.id, feed_id=feed.id, extract_readable=False))
    await pg.execute(update(UserFeed).where(UserFeed.feed_id == off_feed.id)
                     .values(extract_readable=False))
    await pg.execute(update(UserFeed).where(UserFeed.feed_id == blocked_feed.id)
                     .values(readable_auto_disabled=True))
    assert enabled.offline_synced_at is off.offline_synced_at is None

    url = "https://ex.invalid/article"
    eligible = await _article(pg, feed, url=url)
    older = await _article(pg, feed, url=url)
    demand = await _article(pg, feed, url=url, readable_status="pending",
                            readable_queued_at=NOW, readable_next_retry_at=RETRY_AT)
    excluded = [
        (await _article(pg, feed, url=url, trimmed_at=NOW), "skipped"),
        (await _article(pg, feed, url=""), "skipped"),
        (await _article(pg, feed), "skipped"),
        (await _article(pg, feed, url=url, readable_status="success"), "success"),
        (await _article(pg, feed, url=url, readable_status="failed"), "failed"),
        (await _article(pg, other_feed, url=url), "skipped"),
    ]
    off_article = await _article(pg, off_feed, url=url)
    blocked_article = await _article(pg, blocked_feed, url=url)
    queue = readable_backfill.queue_new_for_readable

    excluded_ids = [row.id for row, _ in excluded]
    assert await queue(feed.id, [eligible.id, *excluded_ids], pg, NOW) is True
    assert await queue(feed.id, [demand.id], pg, NOW + timedelta(days=1)) is True
    assert await queue(feed.id, excluded_ids, pg, NOW) is False
    assert await queue(feed.id, [], pg, NOW) is False
    assert await queue(off_feed.id, [off_article.id], pg, NOW) is False
    assert await queue(blocked_feed.id, [blocked_article.id], pg, NOW) is False

    await pg.refresh(eligible)
    await pg.refresh(demand)
    assert (eligible.readable_status, eligible.readable_priority, eligible.readable_queued_at) == (
        "pending", 1, NOW,
    )
    assert (demand.readable_status, demand.readable_priority, demand.readable_queued_at,
            demand.readable_next_retry_at) == ("pending", 0, NOW, RETRY_AT)
    for row, status in [*excluded, (older, "skipped"), (off_article, "skipped"),
                        (blocked_article, "skipped")]:
        await pg.refresh(row)
        assert (row.readable_status, row.readable_priority, row.readable_queued_at) == (
            status, 0, None,
        )


async def test_fetches_commit_through_queue_savepoint_failure(pg, monkeypatch, caplog):
    # The shared pg fixture is rolled back, so use a separate connection for real commits.
    engine = pg.bind.engine
    async with engine.connect() as conn, AsyncSession(bind=conn, expire_on_commit=False) as db:
        user = await _user(db)
        user_id = user.id
        db.add(Filter(
            user_id=user_id, name="Star matching articles",
            conditions=[FilterCondition(field="title", operator="contains", value="Filter target")],
            actions=[FilterAction(action_type="star")],
        ))
        feed_ids = []
        wakes = []
        queue_errors = []
        reject_queue = False
        reject_commit = False
        wake_raises = False

        def inject_queue_error(connection, cursor, statement, parameters, context, executemany):
            if statement.startswith("UPDATE articles SET") and context.compiled_parameters:
                values = context.compiled_parameters[0]
                if values.get("readable_priority") == 0 and "readable_next_retry_at" in values:
                    # Give the actual filter's pending row a retry schedule before ingest.
                    position = context.compiled.positiontup.index("readable_next_retry_at")
                    parameters = (*parameters[:position], RETRY_AT, *parameters[position + 1:])
                if values.get("readable_priority") == 1 and reject_queue:
                    queue_errors.append(True)
                    return "SELECT 1 / 0", ()
            return statement, parameters

        def fail_outer_commit(session):
            nonlocal reject_commit
            if reject_commit and not session.in_nested_transaction():
                reject_commit = False
                session.execute(text("SELECT 1 / 0"))

        def wake():
            wakes.append(db.in_transaction())
            if wake_raises:
                raise RuntimeError("scheduler wake failed")

        event.listen(conn.sync_connection, "before_cursor_execute", inject_queue_error, retval=True)
        event.listen(db.sync_session, "before_commit", fail_outer_commit)
        monkeypatch.setattr(scheduler, "wake_readable", wake)
        try:
            for fetcher, fetch, fetch_type in (
                (rss, rss.fetch_feed, "rss"),
                (scrape, scrape.fetch_scrape_feed, "scrape"),
            ):
                feed = await _feed(db, user, subscribe=False)
                feed.feed_type = fetch_type
                feed.type_config = {"article_links_selector": "article h2 a"}
                feed_id = feed.id
                feed_ids.append(feed_id)
                db.add(UserFeed(user_id=user_id, feed_id=feed_id))
                await _article(db, feed, readable_status="success", readable_content="<p>Full body</p>")
                await db.commit()

                monkeypatch.setattr(fetcher, "async_validate_feed_url", AsyncMock())
                for batch in ("queue-error", "control", "commit-error"):
                    reject_queue = batch == "queue-error"
                    reject_commit = batch == "commit-error"
                    wake_raises = batch == "control"
                    root = f"{feed.feed_url}/{batch}"
                    articles = [(f"{root}/filtered", "Filter target"), (f"{root}/normal", "Normal")]
                    if fetch_type == "rss":
                        items = "".join(
                            f"<item><guid>{url}</guid><link>{url}</link><title>{title}</title></item>"
                            for url, title in articles
                        )
                        response = ConditionalResponse(200, f"<rss><channel>{items}</channel></rss>",
                                                       None, None)
                        monkeypatch.setattr(rss, "fetch_url_conditional", Mock(return_value=response))
                    else:
                        html = "".join(
                            f'<article><h2><a href="{url}">{title}</a></h2></article>'
                            for url, title in articles
                        )
                        response = PageResponse(html, None, feed.feed_url)
                        monkeypatch.setattr(scrape, "fetch_url_page", Mock(return_value=response))

                    wakes.clear()
                    caplog.clear()
                    previous_errors = len(queue_errors)
                    count = await fetch(feed, db, defer_stories=True)
                    failed = batch == "commit-error"
                    assert count == (0 if failed else 2)
                    assert not reject_commit
                    assert len(queue_errors) == previous_errors + int(reject_queue)
                    if reject_queue:
                        assert "division by zero" in caplog.text
                    async with AsyncSession(bind=engine) as observer:
                        rows = (await observer.scalars(select(Article).where(
                            Article.feed_id == feed_id,
                        ))).all()
                    completed = next(row for row in rows if row.url is None)
                    assert (completed.readable_status, completed.readable_content) == (
                        "success", "<p>Full body</p>",
                    )
                    new = {row.title: row for row in rows if row.url and row.url.startswith(root)}
                    if failed:
                        assert new == {}
                    else:
                        filtered = new["Filter target"]
                        assert (filtered.readable_status, filtered.readable_priority,
                                filtered.readable_next_retry_at) == ("pending", 0, RETRY_AT)
                        normal = new["Normal"]
                        assert (normal.readable_status, normal.readable_priority) == (
                            ("skipped", 0) if reject_queue else ("pending", 1)
                        )
                    assert wakes == ([] if failed else [False])
                    if wake_raises:
                        assert "scheduler wake failed" in caplog.text
        finally:
            event.remove(db.sync_session, "before_commit", fail_outer_commit)
            event.remove(conn.sync_connection, "before_cursor_execute", inject_queue_error)
            await db.rollback()
            await db.execute(delete(Article).where(Article.feed_id.in_(feed_ids)))
            await db.execute(delete(Feed).where(Feed.id.in_(feed_ids)))
            await db.execute(delete(User).where(User.id == user_id))
            await db.commit()

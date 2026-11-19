"""Transactional round trip for the offline freshness schema."""

import importlib.util
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import settings
from tests.conftest import db_unreachable


@pytest.mark.integration
async def test_freshness_schema_round_trip():
    path = Path(__file__).resolve().parents[1] / "alembic/versions/0129_offline_freshness.py"
    spec = importlib.util.spec_from_file_location("migration_0129", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    def round_trip(conn):
        def article_columns():
            return {column["name"] for column in inspect(conn).get_columns("articles")}

        def article_indexes():
            return {index["name"]: index["column_names"]
                    for index in inspect(conn).get_indexes("articles")}

        def insert_article(fetched_at):
            return conn.scalar(text("""
                INSERT INTO articles (guid, guid_hash, title, readable_status, fetched_at)
                VALUES (:guid, :guid, 'Freshness test', 'pending', :fetched_at)
                RETURNING id
            """), {"guid": uuid4().hex, "fetched_at": fetched_at})

        def freshness(article_id):
            return conn.execute(text("""
                SELECT changed_at, content_version FROM articles WHERE id = :id
            """), {"id": article_id}).one()

        index_name = "ix_articles_feed_changed_at"
        old_fetched_at = datetime(2000, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
        with Operations.context(MigrationContext.configure(conn)):
            revision = conn.scalar(text("SELECT version_num FROM alembic_version"))
            assert revision in {"0128", "0129"}
            if revision == "0129":
                migration.downgrade()
            legacy_id = insert_article(old_fetched_at)

            migration.upgrade()
            assert freshness(legacy_id) == (old_fetched_at, 0)
            new_stamp, _ = freshness(insert_article(old_fetched_at))
            assert new_stamp is not None and new_stamp.utcoffset() is not None
            assert new_stamp == conn.scalar(text("SELECT now()"))
            assert article_indexes()[index_name] == ["feed_id", "changed_at"]

            previous_stamp, version = freshness(legacy_id)
            for assignment in (
                "readable_status = 'success'",
                "content = 'feed body'",
                "readable_content = 'full body'",
                "trimmed_at = now()",
            ):
                conn.execute(text(f"UPDATE articles SET {assignment} WHERE id = :id"),
                             {"id": legacy_id})
                stamp, bumped_version = freshness(legacy_id)
                assert stamp > previous_stamp, assignment
                assert bumped_version == version + 1, assignment
                previous_stamp, version = stamp, bumped_version

            for assignment in (
                "readable_status = 'success', content = 'feed body', "
                "readable_content = 'full body', trimmed_at = now()",
                "readable_retries = readable_retries + 1",
            ):
                conn.execute(text(f"UPDATE articles SET {assignment} WHERE id = :id"),
                             {"id": legacy_id})
                assert freshness(legacy_id) == (previous_stamp, version), assignment

            migration.downgrade()
            assert "changed_at" not in article_columns()
            assert index_name not in article_indexes()

            status_version = conn.scalar(text("""
                UPDATE articles SET readable_status = 'pending' WHERE id = :id
                RETURNING content_version
            """), {"id": legacy_id})
            assert status_version == version
            body_version = conn.scalar(text("""
                UPDATE articles SET content = 'revised body' WHERE id = :id
                RETURNING content_version
            """), {"id": legacy_id})
            assert body_version == version + 1

    engine = create_async_engine(settings.database_url)
    try:
        try:
            conn = await engine.connect()
        except Exception as exc:
            db_unreachable(exc)
        try:
            # Closing the connection rolls back all DDL and row changes.
            await conn.begin()
            await conn.run_sync(round_trip)
        finally:
            await conn.close()
    finally:
        await engine.dispose()

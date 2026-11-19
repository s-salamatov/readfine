"""Stamp article changes for the offline freshness token.

Revision ID: 0129
Revises: 0128
"""

import sqlalchemy as sa
from alembic import op

revision = "0129"
down_revision = "0128"
branch_labels = None
depends_on = None

_CONTENT_COLUMNS_0127 = (
    "title", "content", "readable_content", "summary", "image_url", "trimmed_at", "story_id",
)


def _replace_article_trigger(*, stamp_freshness: bool) -> None:
    columns = _CONTENT_COLUMNS_0127
    stamp = ""
    if stamp_freshness:
        columns += ("readable_status",)
        stamp = "\n        NEW.changed_at := clock_timestamp();"
    condition = "\n       OR ".join(f"NEW.{column} IS DISTINCT FROM OLD.{column}"
                                    for column in columns)

    op.execute(f"""
CREATE OR REPLACE FUNCTION articles_bump_content_version() RETURNS trigger AS $$
BEGIN
    IF {condition}
    THEN
        NEW.content_version := OLD.content_version + 1;{stamp}
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql
""")
    op.execute("DROP TRIGGER trg_articles_content_version ON articles")
    op.execute(
        "CREATE TRIGGER trg_articles_content_version "
        f"BEFORE UPDATE OF {', '.join(columns)} ON articles "
        "FOR EACH ROW EXECUTE FUNCTION articles_bump_content_version()"
    )


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.add_column("articles", sa.Column("changed_at", sa.DateTime(timezone=True), nullable=True))
    op.execute("UPDATE articles SET changed_at = fetched_at")
    op.alter_column("articles", "changed_at", nullable=False, server_default=sa.func.now())
    op.create_index("ix_articles_feed_changed_at", "articles", ["feed_id", "changed_at"])
    _replace_article_trigger(stamp_freshness=True)


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    _replace_article_trigger(stamp_freshness=False)
    op.drop_index("ix_articles_feed_changed_at", table_name="articles")
    op.drop_column("articles", "changed_at")

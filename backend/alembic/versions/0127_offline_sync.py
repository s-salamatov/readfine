"""change tracking for offline sync

An offline client pulls "what changed since my cursor" and pushes queued writes, so the
server has to be able to say when an article's content and a reader's flags last
changed. Done in the database, by triggers, because both tables are written from many
places (the fetcher, services, inline UPDATEs in routers) and a stamp kept in the
application would sooner or later be missing from one of them.

- articles.content_version: bumped when title, content, readable_content, summary,
  image_url, trimmed_at or story_id changes. Bookkeeping columns (fetched_at, retry
  counters, ...) leave it alone, so a client is not told to re-download an unchanged
  article.
- user_article_states.{read,star,archive,saved}_changed_at: set to now() when the flag
  itself changes. On INSERT only flags that start non-default count: a fresh row for an
  unread, unstarred article has not "changed" anything. Dwell, AI scores and the other
  columns never move them.
- sync_applied_ops: idempotency ledger for pushed operations, one row per (user, op).

Adding the columns is metadata-only (constant defaults / NULL), no table rewrite.

Revision ID: 0127
Revises: 0126
Create Date: 2026-11-16
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0127"
down_revision = "0126"
branch_labels = None
depends_on = None

_ARTICLES_FN = """
CREATE FUNCTION articles_bump_content_version() RETURNS trigger AS $$
BEGIN
    IF NEW.title IS DISTINCT FROM OLD.title
       OR NEW.content IS DISTINCT FROM OLD.content
       OR NEW.readable_content IS DISTINCT FROM OLD.readable_content
       OR NEW.summary IS DISTINCT FROM OLD.summary
       OR NEW.image_url IS DISTINCT FROM OLD.image_url
       OR NEW.trimmed_at IS DISTINCT FROM OLD.trimmed_at
       OR NEW.story_id IS DISTINCT FROM OLD.story_id
    THEN
        NEW.content_version := OLD.content_version + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""

_STATES_FN = """
CREATE FUNCTION uas_stamp_changes() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.is_read THEN NEW.read_changed_at := now(); END IF;
        IF NEW.is_starred THEN NEW.star_changed_at := now(); END IF;
        IF NEW.is_archived THEN NEW.archive_changed_at := now(); END IF;
        IF NEW.saved_at IS NOT NULL THEN NEW.saved_changed_at := now(); END IF;
    ELSE
        IF NEW.is_read IS DISTINCT FROM OLD.is_read THEN
            NEW.read_changed_at := now();
        END IF;
        IF NEW.is_starred IS DISTINCT FROM OLD.is_starred THEN
            NEW.star_changed_at := now();
        END IF;
        IF NEW.is_archived IS DISTINCT FROM OLD.is_archived THEN
            NEW.archive_changed_at := now();
        END IF;
        IF NEW.saved_at IS DISTINCT FROM OLD.saved_at THEN
            NEW.saved_changed_at := now();
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""


def upgrade() -> None:
    op.add_column("articles", sa.Column(
        "content_version", sa.BigInteger(), nullable=False, server_default="0"))
    for col in ("read_changed_at", "star_changed_at", "archive_changed_at",
                "saved_changed_at"):
        op.add_column("user_article_states",
                      sa.Column(col, sa.DateTime(timezone=True), nullable=True))

    op.create_table(
        "sync_applied_ops",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("op_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("applied_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("result", postgresql.JSONB(), nullable=False),
        sa.PrimaryKeyConstraint("user_id", "op_id"),
    )
    op.create_index("ix_sync_applied_ops_applied_at", "sync_applied_ops", ["applied_at"])

    op.execute(_ARTICLES_FN)
    op.execute("CREATE TRIGGER trg_articles_content_version BEFORE UPDATE ON articles "
               "FOR EACH ROW EXECUTE FUNCTION articles_bump_content_version()")
    op.execute(_STATES_FN)
    op.execute("CREATE TRIGGER trg_uas_change_stamps "
               "BEFORE INSERT OR UPDATE ON user_article_states "
               "FOR EACH ROW EXECUTE FUNCTION uas_stamp_changes()")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_uas_change_stamps ON user_article_states")
    op.execute("DROP FUNCTION IF EXISTS uas_stamp_changes()")
    op.execute("DROP TRIGGER IF EXISTS trg_articles_content_version ON articles")
    op.execute("DROP FUNCTION IF EXISTS articles_bump_content_version()")
    op.drop_index("ix_sync_applied_ops_applied_at", table_name="sync_applied_ops")
    op.drop_table("sync_applied_ops")
    for col in ("saved_changed_at", "archive_changed_at", "star_changed_at",
                "read_changed_at"):
        op.drop_column("user_article_states", col)
    op.drop_column("articles", "content_version")

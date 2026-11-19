"""Add readable queue metadata and the last offline sync timestamp.

Revision ID: 0128
Revises: 0127
"""

import sqlalchemy as sa
from alembic import op

revision = "0128"
down_revision = "0127"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Existing articles and inserts that omit the priority stay on demand.
    op.add_column(
        "articles",
        sa.Column("readable_priority", sa.SmallInteger(), nullable=False, server_default="0"),
    )
    op.add_column("articles", sa.Column("readable_queued_at", sa.DateTime(timezone=True)))
    op.add_column("users", sa.Column("offline_synced_at", sa.DateTime(timezone=True)))
    op.create_index(
        "ix_articles_readable_queue",
        "articles",
        ["readable_status", "readable_priority", "readable_queued_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_articles_readable_queue", table_name="articles")
    op.drop_column("users", "offline_synced_at")
    op.drop_column("articles", "readable_queued_at")
    op.drop_column("articles", "readable_priority")

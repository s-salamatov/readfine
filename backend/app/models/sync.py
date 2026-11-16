import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class SyncAppliedOp(Base):
    """Idempotency ledger for operations an offline client pushes: one row per
    (user, client-generated op id). A replayed op finds its row and gets the stored
    ``result`` back instead of being applied twice. Rows older than the client's
    replay window are pruned by ``applied_at``."""

    __tablename__ = "sync_applied_ops"
    __table_args__ = (Index("ix_sync_applied_ops_applied_at", "applied_at"),)

    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    op_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    applied_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now())
    result: Mapped[dict] = mapped_column(JSONB, nullable=False)

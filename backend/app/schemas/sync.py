"""Offline action replay: what the device sends to POST /sync/v1/ops and gets back."""
import uuid
from typing import Any, Literal

from pydantic import AwareDatetime, BaseModel, Field

MAX_OPS_PER_REQUEST = 500

OpType = Literal[
    "read", "unread",
    "star", "unstar",
    "archive", "unarchive",
    "label_add", "label_remove",
    "mark_scope_read",
    "save_url", "unsave",
    "share",
    "dwell", "link_opened",
    "ai_summary", "ai_context",
    "extract_readable",
]


class SyncOp(BaseModel):
    """One action the device made, possibly offline. ``op_id`` is generated on the
    device and is the idempotency key; ``at`` is the device clock when it was made."""
    op_id: uuid.UUID
    type: OpType
    article_id: int | None = None
    value: dict[str, Any] = Field(default_factory=dict)
    at: AwareDatetime


class SyncOpsRequest(BaseModel):
    """``client_time`` is the device clock when the batch was sent; the server shifts
    every ``at`` by ``server_now - client_time``. Both carry a UTC offset; a time
    without one is refused (422) rather than guessed."""
    client_time: AwareDatetime
    ops: list[SyncOp] = Field(max_length=MAX_OPS_PER_REQUEST)


class SyncOpResult(BaseModel):
    op_id: uuid.UUID
    status: Literal["applied", "skipped", "failed"]
    reason: str | None = None
    article: dict | None = None

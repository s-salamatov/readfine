"""Batch delete: ``POST /settings/deletes``, the server half of the delayed delete.

The client (``ui/pending.js``) holds deletes for a few seconds and then sends what
it held in one request, so the user can undo in between. The body is
``[{"kind": "feed"|"label"|"filter", "id": int}, ...]`` (1 to 50 items). A feed id
is the subscription's ``UserFeed.id``, the same id ``DELETE /settings/feeds/{id}``
takes. The answer is always 200 JSON::

    {"results": [{"kind", "id", "status": "done"|"failed"}, ...],
     "notices": [{"msg", "type"}, ...]}

with the results in request order. A missing or foreign id is ``done``: there is
nothing of the user's left to delete. When there are notices, the header
``HX-Trigger: {"showToast": [...]}`` carries the same list, so htmx and a plain
``fetch`` read them the same way.

Why the lock sits on its own connection: two batches of one user (a normal flush
and an exit flush from the same tab, or two tabs) must not run at once. Every
delete service commits itself, so a transaction-level lock
(``pg_advisory_xact_lock``) on the request session would be released by the first
item's commit. ``batch_lock`` therefore takes a session-level advisory lock on a
separate pool connection in autocommit mode, holds it for the whole batch and
unlocks it in ``finally``. Autocommit keeps that connection from sitting idle in a
transaction, which ``idle_in_transaction_session_timeout`` could kill. If the
unlock itself fails, the connection is invalidated rather than returned to the pool
still holding the lock.
"""
import json
import logging
from contextlib import asynccontextmanager
from typing import Annotated, Literal

from fastapi import APIRouter, Body, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession

from app.auth.dependencies import get_current_user
from app.database import get_db
from app.models.user import User
from app.services.feed import unsubscribe
from app.services.filter_service import delete_filter
from app.services.label_service import delete_label
from app.services.scope_cleanup import ScopeCleanupResult

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["settings"])

# First key of the two-int advisory lock form; the second is the user id. Any other
# advisory lock in the app must pick a different namespace.
DELETE_BATCH_LOCK_NS = 0x52460001  # "RF" + 1, fits a signed int4
MAX_ITEMS = 50
_PG_INT_MAX = 2**31 - 1


class DeleteItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["feed", "label", "filter"]
    id: Annotated[int, Field(strict=True, gt=0, le=_PG_INT_MAX)]


@asynccontextmanager
async def batch_lock(engine, user_id: int):
    """Hold the user's batch-delete advisory lock on a dedicated connection."""
    params = {"ns": DELETE_BATCH_LOCK_NS, "uid": user_id}
    async with engine.connect() as lock_conn:
        lock_conn = await lock_conn.execution_options(isolation_level="AUTOCOMMIT")
        acquired = False
        try:
            await lock_conn.execute(text("SELECT pg_advisory_lock(:ns, :uid)"), params)
            acquired = True
            yield
        finally:
            if acquired:
                try:
                    await lock_conn.execute(text("SELECT pg_advisory_unlock(:ns, :uid)"), params)
                except BaseException:
                    await lock_conn.invalidate()
                    raise


def _plural(n: int, one: str, many: str) -> str:
    return one if n == 1 else many


def _scope_notice(cleanup: ScopeCleanupResult) -> str:
    """One sentence per category, in the words of ``settings/partials/feeds_list.html``."""
    parts = []
    if names := cleanup.deactivated_filters:
        n = len(names)
        parts.append(f"Deactivated {n} {_plural(n, 'filter', 'filters')} scoped only to "
                     f"what you just removed: {', '.join(names)}.")
    if names := cleanup.unscoped_inactive_filters:
        n = len(names)
        parts.append(f"{n} inactive {_plural(n, 'filter was', 'filters were')} scoped only "
                     f"to what you just removed and would now apply to all feeds: "
                     f"{', '.join(names)}.")
    if names := cleanup.disabled_briefings:
        n = len(names)
        parts.append(f"Disabled the briefing on {n} {_plural(n, 'digest', 'digests')} scoped "
                     f"only to what you just removed: {', '.join(names)}.")
    if names := cleanup.emptied_searches:
        n = len(names)
        parts.append(f"{n} saved {_plural(n, 'search', 'searches')} scoped only to what you "
                     f"just removed will show nothing until you change "
                     f"{_plural(n, 'it', 'them')}: {', '.join(names)}.")
    return " ".join(parts)


def _label_notice(switched_off: list[str]) -> str:
    """Worded as ``routers/web/settings/labels.py`` words it."""
    n = len(switched_off)
    return (f"Turned off {n} filter{'s' if n != 1 else ''} whose only action was "
            f"this label: {', '.join(switched_off)}.")


async def _delete_one(user: User, item: DeleteItem, db: AsyncSession) -> str | None:
    """Delete one item. Returns a notice message, or None. Not found counts as done."""
    if item.kind == "feed":
        try:
            cleanup = await unsubscribe(user, item.id, db)
        except ValueError:
            return None
        return _scope_notice(cleanup) if cleanup.has_changes else None
    if item.kind == "label":
        switched_off = await delete_label(user, item.id, db)
        return _label_notice(switched_off) if switched_off else None
    await delete_filter(user.id, item.id, db)
    return None


@router.post("/deletes")
async def settings_batch_delete(
    items: Annotated[list[DeleteItem], Body(min_length=1, max_length=MAX_ITEMS)],
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    uid = user.id  # read before any rollback can expire the instance
    # The request session's engine, not app.database.engine (None in tests). Not
    # getattr(bind, "engine", bind): AsyncEngine.engine is the *sync* Engine.
    bind = db.bind
    engine = bind.engine if isinstance(bind, AsyncConnection) else bind
    results: list[dict] = []
    notices: list[dict] = []
    async with batch_lock(engine, uid):
        for item in items:
            try:
                msg = await _delete_one(user, item, db)
            except Exception:
                logger.exception("Batch delete failed: user=%s kind=%s id=%s",
                                 uid, item.kind, item.id)
                await db.rollback()
                # The rollback expired the user loaded by this session; the next
                # item reads user.id, which must not lazy-load in async code.
                if user in db:
                    await db.refresh(user)
                results.append({"kind": item.kind, "id": item.id, "status": "failed"})
                continue
            if msg:
                notices.append({"msg": msg, "type": "warning"})
            results.append({"kind": item.kind, "id": item.id, "status": "done"})

    headers = {"HX-Trigger": json.dumps({"showToast": notices})} if notices else None
    return JSONResponse({"results": results, "notices": notices}, headers=headers)

"""Offline sync endpoints (session auth)."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.config import settings as app_settings
from app.database import get_db
from app.models.user import User
from app.rate_limit import get_client_ip, limiter
from app.schemas.sync import SyncOpsRequest
from app.services.sync.manifest import article_versions, list_versions
from app.services.sync.ops import apply_ops
from app.services.sync.payload import article_records, user_lists
from app.services.sync.scope import offline_scope_ids
from app.services.sync.snapshots import MAX_SNAPSHOT_IDS, render_snapshots


def _no_store(response: Response) -> None:
    """Sync answers carry this user's articles and state: never kept by any cache."""
    response.headers["Cache-Control"] = "no-store"


class AccountMismatch(Exception):
    """The device's database belongs to another reader than this session's."""


async def _same_account(request: Request, user: User = Depends(get_current_user)) -> None:
    """Every /sync/v1 request names the reader its device database belongs to
    (``X-Readfine-User``). A tab of reader A still open after B signed in elsewhere in
    the same browser shares B's cookie: without this, A's queued ops would be applied to
    B's account and B's articles written into A's database. Missing or different →
    409 ``{"error": "account_mismatch"}`` before any handler runs. No session is still
    the 401 of ``get_current_user`` (resolved first; cached for the handler).
    """
    if request.headers.get("x-readfine-user", "").strip() != str(user.id):
        raise AccountMismatch()


async def account_mismatch_handler(request: Request, exc: AccountMismatch) -> JSONResponse:
    return JSONResponse({"error": "account_mismatch"}, status_code=409,
                        headers={"Cache-Control": "no-store"})


router = APIRouter(prefix="/sync/v1", tags=["sync"],
                   dependencies=[Depends(_no_store), Depends(_same_account)])


@router.get("/manifest")
async def manifest(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Scope ids with version tokens, and list versions; the device diffs against it."""
    server_time = datetime.now(timezone.utc).isoformat()
    ids = await offline_scope_ids(user, db)
    versions = await article_versions(user.id, ids, db)
    return {
        "server_time": server_time,
        "articles": [[i, versions[i]] for i in ids if i in versions],
        "lists": await list_versions(user, db),
        # Server-side limits the device applies (OFFLINE_MEDIA_BUDGET_MB).
        "limits": {"media_budget_mb": app_settings.offline_media_budget_mb},
    }


class ArticlesRequest(BaseModel):
    ids: list[int] = Field(max_length=200)


def _user_or_ip(request: Request) -> str:
    """Rate-limit key: the signed-in user (from the signed session), else the IP."""
    try:
        user_id = request.session.get("user_id")
    except AssertionError:  # no session middleware in front of this request
        user_id = None
    return f"user:{user_id}" if user_id else get_client_ip(request)


@router.post("/articles")
@limiter.limit(app_settings.rate_limit_sync_fetch, key_func=_user_or_ip)
async def articles(
    request: Request, body: ArticlesRequest,
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    """Records for the requested ids; ids outside the offline scope are omitted.
    Rate limited per user (``RATE_LIMIT_SYNC_FETCH``, 120/minute)."""
    return {"articles": await article_records(user, body.ids, db)}


@router.get("/lists")
async def lists(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Folders, feeds, labels, saved searches and prefs for the offline shell."""
    return await user_lists(user, db)


def _parse_ids(raw: str) -> list[int]:
    try:
        ids = [int(p) for p in raw.split(",") if p.strip()]
    except ValueError:
        raise HTTPException(status_code=422, detail="ids must be comma-separated integers")
    if len(ids) > MAX_SNAPSHOT_IDS:
        raise HTTPException(status_code=422, detail=f"at most {MAX_SNAPSHOT_IDS} ids")
    return ids


@router.get("/snapshots")
@limiter.limit(app_settings.rate_limit_sync_fetch, key_func=_user_or_ip)
async def snapshots(
    request: Request,
    ids: str = Query("", max_length=1000),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Row + detail HTML per article for this user, with the media URLs in them.

    ``ids`` is a comma-separated list, at most 50; ids outside the offline scope are omitted.
    Rate limited per user (``RATE_LIMIT_SYNC_FETCH``, 120/minute).
    """
    return {"snapshots": await render_snapshots(request, user, _parse_ids(ids), db)}


@router.post("/ops")
@limiter.limit(app_settings.rate_limit_sync_ops, key_func=_user_or_ip)
async def ops(
    request: Request,
    body: SyncOpsRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Replay actions the device made offline, in order, each at most once.

    Answers ``{"server_time", "results": [{"op_id", "status", "reason", "article",
    "retryable"}]}`` with one result per op; ``article`` is the article's record after
    the op (the shape ``/articles`` returns), or null. See ``services/sync/ops.py``.
    """
    return await apply_ops(user, body, db)

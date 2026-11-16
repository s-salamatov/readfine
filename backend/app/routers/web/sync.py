"""Offline sync endpoints (session auth)."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.database import get_db
from app.models.user import User
from app.services.sync.manifest import article_versions, list_versions
from app.services.sync.payload import article_records, user_lists
from app.services.sync.scope import offline_scope_ids
from app.services.sync.snapshots import MAX_SNAPSHOT_IDS, render_snapshots



def _no_store(response: Response) -> None:
    """Sync answers carry this user's articles and state: never kept by any cache."""
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(prefix="/sync/v1", tags=["sync"], dependencies=[Depends(_no_store)])


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
    }


class ArticlesRequest(BaseModel):
    ids: list[int] = Field(max_length=200)


@router.post("/articles")
async def articles(body: ArticlesRequest, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Records for the requested ids; ids outside the offline scope are omitted."""
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
async def snapshots(
    request: Request,
    ids: str = Query("", max_length=1000),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Row + detail HTML per article for this user, with the media URLs in them.

    ``ids`` is a comma-separated list, at most 50; ids outside the offline scope are omitted.
    """
    return {"snapshots": await render_snapshots(request, user, _parse_ids(ids), db)}

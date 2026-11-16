"""Offline sync endpoints (session auth)."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.database import get_db
from app.models.user import User
from app.services.sync.manifest import article_versions, list_versions
from app.services.sync.scope import offline_scope_ids

router = APIRouter(prefix="/sync/v1", tags=["sync"])


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

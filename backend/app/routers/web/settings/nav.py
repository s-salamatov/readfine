"""Settings landing route."""
from fastapi import APIRouter, Depends
from fastapi.responses import RedirectResponse

from app.auth.dependencies import get_current_user
from app.models.user import User

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("")
@router.get("/")
async def settings_index(user: User = Depends(get_current_user)):
    """Land on Reading & appearance, the first Settings item every user can see.

    Stats needs feeds, and Sources is its own zone since s5, so neither is the landing.
    """
    return RedirectResponse("/settings/reading", status_code=303)

"""Online-only Assistant page composed from the existing domain contexts."""
from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.database import get_db
from app.models.user import User
from app.routers.web.settings.ai import interest_profile_context
from app.templating import templates

from .ai import assistant_chat_context
from .catchup import catchup_page_context

router = APIRouter()


@router.get("/assistant", response_class=HTMLResponse)
@router.get("/assistant/catch-up", response_class=HTMLResponse)
async def assistant_page(
    request: Request,
    section: str = "chat",
    article_id: int | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if request.url.path == "/assistant/catch-up":
        section = "catch-up"
    elif section not in {"chat", "catch-up", "profile"}:
        section = "chat"
    context = {
        "user": user,
        "section": section,
        **await assistant_chat_context(user, db, article_id),
        "catchup_context": await catchup_page_context(user, db),
        "profile_context": await interest_profile_context(user, db),
    }
    return templates.TemplateResponse(
        request, "assistant/page.html", context, headers={"Cache-Control": "no-store"}
    )

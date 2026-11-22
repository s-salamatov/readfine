"""/dev/ui: the gallery of the ui/ macros, for development only.

main.py includes this router only when settings.debug is on, so a production
instance has no such route (it answers the ordinary 404). The handler checks the flag
again, for an app that toggled it after start-up. No login and no database: the page
renders the macros on sample data and nothing else.
"""
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse

from app.config import settings
from app.templating import templates

router = APIRouter(tags=["dev"], include_in_schema=False)


@router.get("/dev/ui", response_class=HTMLResponse)
async def ui_gallery(request: Request):
    if not settings.debug:
        raise HTTPException(status_code=404)
    return templates.TemplateResponse(request, "dev/ui.html", {})

"""Web routes for OPML import/export in settings."""
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, Query, Request, UploadFile
from fastapi.responses import HTMLResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.config import settings as app_settings_config
from app.database import get_db
from app.models.user import User
from app.rate_limit import limiter
from app.services.opml import MAX_UPLOAD_BYTES, export_opml, import_opml
from app.templating import templates

router = APIRouter(tags=["settings"])


def _opml_page(request: Request, context: dict) -> HTMLResponse:
    return templates.TemplateResponse(
        request, "settings/opml.html", context,
        headers={"Cache-Control": "no-store", "Vary": "HX-Target"},
    )


@router.get("/sources/opml", response_class=HTMLResponse)
async def settings_opml(
    request: Request,
    user: User = Depends(get_current_user),
):
    return _opml_page(request, {})


@router.get("/sources/opml/export")
async def settings_opml_export(
    include: list[str] | None = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # No selection at all (an old bookmark, a script) exports everything. The form
    # always sends at least its "head" marker, so unticking every box there gives
    # an empty file rather than a full one.
    xml = await export_opml(user, db, sections=include)
    filename = f"readfine-{datetime.now(timezone.utc).strftime('%Y%m%d')}.opml"
    return Response(
        content=xml.encode("utf-8"),
        media_type="application/xml",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/settings/opml/import", response_class=HTMLResponse)
@router.post("/sources/opml/import", response_class=HTMLResponse)
@limiter.limit(app_settings_config.rate_limit_opml_import)
async def settings_opml_import(
    request: Request,
    file: UploadFile = File(...),
    import_feeds: bool = Form(False),
    import_labels: bool = Form(False),
    import_prefs: bool = Form(False),
    import_filters: bool = Form(False),
    import_profile: bool = Form(False),
    import_searches: bool = Form(False),
    import_catchup: bool = Form(False),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    context = {"import_sections": {
        "feeds": import_feeds, "labels": import_labels, "prefs": import_prefs,
        "filters": import_filters, "profile": import_profile,
        "searches": import_searches, "catchup": import_catchup,
    }}
    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        return _opml_page(request, {**context,
            "error": "File too large (max 1 MB).",
        })

    try:
        result = await import_opml(
            user=user,
            xml_bytes=raw,
            import_feeds=import_feeds,
            import_labels=import_labels,
            import_prefs=import_prefs,
            import_filters=import_filters,
            import_profile=import_profile,
            import_searches=import_searches,
            import_catchup=import_catchup,
            db=db,
        )
    except ValueError as exc:
        return _opml_page(request, {**context,
            "error": str(exc),
        })

    response = _opml_page(request, {**context,
        "import_result": result,
    })
    response.headers["HX-Trigger"] = json.dumps({
        "sidebarRefresh": True,
        "rf:sourceschanged": {"kind": "opml"},
        "showToast": {"msg": "OPML import processed. See the report for details.", "type": "ok"},
    })
    return response

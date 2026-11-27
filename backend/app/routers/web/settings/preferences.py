"""Web routes for Settings → Reading & appearance."""
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.config import settings as app_config
from app.database import get_db
from app.models.user import User, UserSettings
from app.services.briefing_service import reschedule_briefings
from app.services.preference_values import clamp_articles_per_page, clamp_buckets
from app.templating import templates
from app.utils.datetime_format import is_valid_timezone
from app.utils.parsing import safe_int

from .common import _get_or_create_settings

router = APIRouter(prefix="/settings", tags=["settings"])


def _bookmarklet(request: Request) -> str:
    """A `javascript:` link that opens the share target with the current page filled in.

    The address is this instance's own, from PUBLIC_URL when set, so the link keeps
    working on a self-hosted install. It arrives at /share-target as cross-site, which
    turns off saving on load: the page shows the address and waits for Save.

    noopener, or the page the bookmarklet was clicked on keeps a handle on our tab and
    can later send it somewhere else, such as a fake login.
    """
    base = (app_config.public_url or str(request.base_url)).rstrip("/")
    target = json.dumps(f"{base}/share-target?url=")
    return (
        f"javascript:void(window.open({target}+encodeURIComponent(location.href)"
        "+'&title='+encodeURIComponent(document.title),'_blank','noopener'))"
    )


def _reading_page(request: Request, s: UserSettings, **extra) -> HTMLResponse:
    return templates.TemplateResponse(request, "settings/reading.html", {
        "s": s, "bookmarklet": _bookmarklet(request), **extra,
    })


async def _set_timezone(s: UserSettings, value: str, user: User, db: AsyncSession) -> None:
    """Store a changed, valid timezone and move the briefings to it."""
    if is_valid_timezone(value) and value != s.timezone:
        s.timezone = value
        await reschedule_briefings(user.id, value, db)


@router.get("/reading", response_class=HTMLResponse)
async def settings_reading(
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return _reading_page(request, await _get_or_create_settings(user, db))


@router.post("/reading/save", response_class=HTMLResponse)
async def settings_reading_form_save(
    request: Request,
    tz: str = Form("", alias="timezone"),
    articles_per_page: str = Form(""),
    bucket_small_max: str = Form(""),
    bucket_medium_max: str = Form(""),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The sticky Save: the timezone and the number fields, and nothing else.

    The other choices on the page save one at a time as they change. When a field is
    not a whole number, the form comes back with its error and nothing is written.
    """
    typed = {
        "timezone": tz.strip(),
        "articles_per_page": articles_per_page,
        "bucket_small_max": bucket_small_max,
        "bucket_medium_max": bucket_medium_max,
    }
    numbers = {name: safe_int(value) for name, value in typed.items() if name != "timezone"}
    errors = {name: "Enter a whole number" for name, value in numbers.items() if value is None}

    s = await db.scalar(select(UserSettings).where(UserSettings.user_id == user.id))
    if s is None:
        # A row with no onboarded_at would send the reader back to the welcome on the
        # next load (main_app).
        s = UserSettings(user_id=user.id, onboarded_at=datetime.now(timezone.utc))
        db.add(s)
        await db.flush()
    form_partial = "settings/partials/reading_form.html"
    if errors:
        # No commit: a row made just above goes away with the session.
        return templates.TemplateResponse(
            request, form_partial, {"s": s, "typed": typed, "errors": errors},
        )

    s.articles_per_page = clamp_articles_per_page(numbers["articles_per_page"])
    s.bucket_small_max, s.bucket_medium_max = clamp_buckets(
        numbers["bucket_small_max"], numbers["bucket_medium_max"],
    )
    await _set_timezone(s, typed["timezone"], user, db)
    await db.commit()
    return templates.TemplateResponse(
        request, form_partial, {"s": s, "swap_ranges": True},
        headers={"HX-Trigger": json.dumps({"showToast": {"msg": "Saved", "type": "ok"}})},
    )

"""Immediate save of one Settings choice: POST /settings/field (s7-T1, design §5.2).

The Settings pages save every switch, radio and select the moment it changes, through
``ui/settings.js``. This route takes one ``field``/``value`` pair from a closed
allowlist and writes that column and nothing else. The full-form
``POST /settings/preferences`` is not reused for this: it rewrites every field from
the form, and a field the form does not send (an unticked checkbox) would read as
off. The same reason gave the list header's View menu ``htmx_list_view``, the pattern
this follows.

Timezone (it reschedules briefings) and the number fields (articles per page and the
two breakpoints) are not here on purpose: they keep a form with a sticky Save.
"""
import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.database import get_db
from app.models.user import User, UserSettings
from app.services.preference_values import (
    DENSITY_VALUES, FONT_FAMILY_VALUES, FONT_SIZE_VALUES, LABEL_DISPLAY_VALUES,
    SORT_VALUES, UNREAD_FILTER_VALUES,
)
from app.services.story_service import DEDUP_VALUES
from app.utils.formats import is_valid_format

router = APIRouter(prefix="/settings", tags=["settings"])


@dataclass(frozen=True)
class FieldSpec:
    """One saveable choice: the ``UserSettings`` column and how to read its value.

    ``parse`` returns the value to store, or ``None`` when the input is invalid.
    """
    column: str
    parse: Callable[[str], object | None]


def _bool(raw: str) -> bool | None:
    return {"true": True, "false": False}.get(raw)


def _one_of(values) -> Callable[[str], str | None]:
    allowed = frozenset(values)
    return lambda raw: raw if raw in allowed else None


def _format(raw: str) -> str | None:
    return raw if is_valid_format(raw) else None


FIELDS: dict[str, FieldSpec] = {
    "mark_read_on_scroll": FieldSpec("mark_read_on_scroll", _bool),
    "mark_read_auto_advance": FieldSpec("mark_read_auto_advance", _bool),
    "open_original_when_empty": FieldSpec("open_original_when_empty", _bool),
    "list_density_web": FieldSpec("list_density_web", _one_of(DENSITY_VALUES)),
    "list_density_mobile": FieldSpec("list_density_mobile", _one_of(DENSITY_VALUES)),
    "default_sort_order": FieldSpec("default_sort_order", _one_of(SORT_VALUES)),
    "unread_filter": FieldSpec("unread_filter", _one_of(UNREAD_FILTER_VALUES)),
    "label_display": FieldSpec("label_display", _one_of(LABEL_DISPLAY_VALUES)),
    "story_dedup": FieldSpec("story_dedup", _one_of(DEDUP_VALUES)),
    "reading_font_size": FieldSpec("reading_font_size", _one_of(FONT_SIZE_VALUES)),
    "reading_font_family": FieldSpec("reading_font_family", _one_of(FONT_FAMILY_VALUES)),
    "format_profile": FieldSpec("format_profile", _format),
}


@router.post("/field", response_class=HTMLResponse)
async def settings_field_save(
    request: Request,
    field: str = Form(""),
    value: str = Form(""),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> HTMLResponse:
    """Save one allowlisted choice; an unknown field or invalid value is a 400 that
    writes nothing. Answers with an empty body, the "Saved" toast and
    ``rf:settingsaved`` for anything on the page that follows the choice."""
    spec = FIELDS.get(field)
    parsed = spec.parse(value) if spec else None
    if parsed is None:
        return HTMLResponse("", status_code=400)
    settings = await db.scalar(select(UserSettings).where(UserSettings.user_id == user.id))
    if settings is None:
        # A reader without a settings row is already in the app; a row with no
        # onboarded_at would send them back to the welcome on the next load.
        settings = UserSettings(user_id=user.id, onboarded_at=datetime.now(timezone.utc))
        db.add(settings)
    setattr(settings, spec.column, parsed)
    await db.commit()
    return HTMLResponse("", headers={
        "HX-Trigger": json.dumps({
            "showToast": {"msg": "Saved", "type": "ok"},
            "rf:settingsaved": {"field": field, "value": value},
        }),
    })

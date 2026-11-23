"""Small helpers for answering HTMX requests with an error."""
import json

from pydantic import ValidationError
from starlette.responses import Response


def validation_message(exc: ValidationError) -> str:
    """The first error of *exc* as one sentence for a toast or a form."""
    errors = exc.errors(include_url=False)
    if not errors:
        return "Invalid input."
    field = ".".join(str(p) for p in errors[0].get("loc", ()))
    text = errors[0].get("msg", "")
    # A field_validator's ValueError comes out as "Value error, <message>".
    text = text.removeprefix("Value error, ")
    return f"Invalid {field}: {text}." if field else f"Invalid input: {text}."


def error_toast(message: str, status_code: int = 400) -> Response:
    """An error response that shows *message* in a toast.

    htmx does not swap an error response, but it does fire HX-Trigger. app.js
    skips its generic fallback toast for responses that carry one of their own.
    """
    return Response(
        status_code=status_code,
        headers={"HX-Trigger": json.dumps({"showToast": {"msg": message, "type": "error"}})},
    )


def mark_all_trigger(stamp: str, count: int) -> str:
    """The HX-Trigger value of every mark-all route: the sidebar refreshes, and the
    client's Undo toast gets the stamp (opaque text, posted back unchanged to
    ``POST /htmx/articles/mark-read/undo``) and how many articles were marked."""
    return json.dumps({"sidebarRefresh": True, "rf:markedall": {"stamp": stamp, "count": count}})

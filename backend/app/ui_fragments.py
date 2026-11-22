"""HTML fragments that routers return directly, rendered from the ui/ macros.

Some handlers answer an htmx request with a small fragment instead of a template (a
test result, a "not found" inside a dialog). They call the macro here rather than copy
its markup, so the fragment cannot drift from what templates render and its text is
autoescaped exactly as in a template.
"""
from markupsafe import Markup

from app.templating import templates


def alert_html(
    text: str,
    *,
    title: str | None = None,
    variant: str = "default",
    live: bool = False,
) -> str:
    """ui/display.html ``alert(text=…, title=…, variant=…, live=…)`` as a string.

    variant: default | destructive | warning | success (unknown falls back to
    default, as in the macro). live=True adds role="alert" for a message that is
    swapped in after load. text and title are plain strings and are escaped.
    """
    macro = templates.env.get_template("ui/display.html").module.alert
    return Markup(macro(title=title, text=text, variant=variant, live=live))

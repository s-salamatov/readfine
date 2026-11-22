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
) -> Markup:
    """ui/display.html ``alert(text=…, title=…, variant=…, live=…)`` as Markup.

    variant: default | destructive | warning | success (unknown falls back to
    default, as in the macro). live=True adds role="alert" for a message that is
    swapped in after load. text and title are plain strings and are escaped.

    Never pass a ``Markup`` built from user data; plain strings are escaped. A
    ``Markup`` text is inserted as is, so it is only for literal markup (a link to a
    settings page), wrapped in one <p> when it mixes text and inline elements (the
    destructive body is a grid).

    Raises ValueError when both text and title are empty or whitespace: an alert
    with no words is a bug in the caller, not a message.
    """
    if not (text and str(text).strip()) and not (title and str(title).strip()):
        raise ValueError("alert_html needs a text or a title")
    macro = templates.env.get_template("ui/display.html").module.alert
    return Markup(macro(title=title, text=text, variant=variant, live=live))

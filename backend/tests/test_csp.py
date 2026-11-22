"""CSP without 'unsafe-eval', and templates that do not depend on htmx eval.

htmx runs with allowEval off, so an hx-on attribute, an hx-vals="js:..." value or an
hx-trigger event filter would not raise anything: it would just quietly do nothing.
The template scan is there to catch that before a browser does.
"""
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

TEMPLATES = Path(__file__).resolve().parents[1] / "app" / "templates"


@pytest.fixture
def client(mock_db):
    from app.main import app
    from app.database import get_db

    async def override_get_db():
        yield mock_db

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.clear()


def test_csp_has_no_unsafe_eval(client):
    r = client.get("/login")
    csp = r.headers["Content-Security-Policy"]
    script_src = next(p for p in csp.split(";") if p.strip().startswith("script-src"))
    assert "'unsafe-eval'" not in script_src
    assert "'unsafe-inline'" not in script_src
    assert "'nonce-" in script_src


def test_htmx_eval_off_and_no_nonce_for_swapped_scripts(client):
    body = client.get("/login").text
    assert "htmx.config.allowEval = false" in body
    assert "inlineScriptNonce" not in body


_EVAL_PATTERNS = [
    (re.compile(r"\bhx-on[:-]"), "hx-on"),
    (re.compile(r"""hx-(vals|vars|headers)\s*=\s*["']\s*(js|javascript):"""), "js: value"),
    (re.compile(r"""hx-trigger\s*=\s*["'][^"']*\["""), "hx-trigger filter"),
]


def test_templates_do_not_use_htmx_eval():
    found = []
    for path in TEMPLATES.rglob("*.html"):
        text = path.read_text(encoding="utf-8")
        # Jinja comments may mention the attributes by name. Their newlines stay, so
        # the reported line numbers are right.
        text = re.sub(r"\{#.*?#\}", lambda m: "\n" * m.group().count("\n"), text, flags=re.S)
        for pattern, what in _EVAL_PATTERNS:
            for m in pattern.finditer(text):
                line = text.count("\n", 0, m.start()) + 1
                found.append(f"{path.relative_to(TEMPLATES)}:{line} {what}")
    assert not found, "htmx runs with allowEval off; move these to JS:\n" + "\n".join(found)


APP = TEMPLATES.parent

# DOM event handler attributes. The CSP has no 'unsafe-inline' for scripts, so a
# handler written as an attribute never runs.
_EVENT_HANDLERS = [
    "onabort", "onanimationend", "onanimationiteration", "onanimationstart", "onauxclick",
    "onbeforeinput", "onbeforetoggle", "onbeforeunload", "onblur", "oncancel", "onchange",
    "onclick", "onclose", "oncontextmenu", "oncopy", "oncut", "ondblclick", "ondrag",
    "ondragend", "ondragenter", "ondragleave", "ondragover", "ondragstart", "ondrop",
    "onended", "onerror", "onfocus", "onfocusin", "onfocusout", "onhashchange", "oninput",
    "oninvalid", "onkeydown", "onkeypress", "onkeyup", "onload", "onloadeddata",
    "onloadstart", "onmessage", "onmousedown", "onmouseenter", "onmouseleave",
    "onmousemove", "onmouseout", "onmouseover", "onmouseup", "onpaste", "onpause",
    "onplay", "onpointercancel", "onpointerdown", "onpointerenter", "onpointerleave",
    "onpointermove", "onpointerout", "onpointerover", "onpointerup", "onpopstate",
    "onreset", "onresize", "onscroll", "onsearch", "onselect", "onsubmit", "ontoggle",
    "ontouchcancel", "ontouchend", "ontouchmove", "ontouchstart", "ontransitionend",
    "onunload", "onwheel",
]
# A whole attribute name after whitespace or a quote, then "=": content=, once=,
# data-onclick= and aria-... are not handlers. HTML attribute names are
# case-insensitive (onClick= runs too), so templates are matched without case. JS and
# Python are matched in lower case only: `var onError = ...` is a variable, not one.
_HANDLER_SOURCE = r"""(?:(?<=\s)|(?<=["']))(""" + "|".join(_EVENT_HANDLERS) + r""")\s*="""
_INLINE_HANDLER = re.compile(_HANDLER_SOURCE, re.IGNORECASE)
_INLINE_HANDLER_IN_CODE = re.compile(_HANDLER_SOURCE)


def _inline_handler_sources():
    yield from APP.joinpath("templates").rglob("*.html")
    for path in APP.joinpath("static", "js").rglob("*.js"):
        if "vendor" not in path.relative_to(APP).parts and path.name != "htmx.min.js":
            yield path
    yield from APP.joinpath("routers").rglob("*.py")
    yield from APP.joinpath("services").rglob("*.py")


def _inline_handler_hits():
    for path in sorted(_inline_handler_sources()):
        text = path.read_text(encoding="utf-8")
        pattern = _INLINE_HANDLER_IN_CODE
        if path.suffix == ".html":
            text = re.sub(r"\{#.*?#\}", lambda m: "\n" * m.group().count("\n"), text, flags=re.DOTALL)
            pattern = _INLINE_HANDLER
        for m in pattern.finditer(text):
            line = text.count("\n", 0, m.start()) + 1
            yield f"{path.relative_to(APP)}:{line} {m.group(1)}"


@pytest.mark.parametrize(
    "text, hits",
    [
        ('<button onclick="x()">', ["onclick"]),
        ('<button onClick="x()">', ["onClick"]),
        ('<meta content="x">', []),
        ('<a data-onclick="x">', []),
    ],
)
def test_templates_have_no_inline_event_handlers(text, hits):
    assert [m.group(1) for m in _INLINE_HANDLER.finditer(text)] == hits
    found = list(_inline_handler_hits())
    assert not found, (
        "CSP blocks inline handlers; bind them in JS (dialogs open through data-rf-open):\n"
        + "\n".join(found)
    )

"""The page side of offline mode is wired into every signed-in page, and only those.

base.html marks the body with the reader (``data-rf-user``) and loads the offline
scripts, deferred and before app.js, when ``get_current_user`` resolved a valid
session. ``sw-register.js`` is on every page, since app.js registers the worker
through it. A page without a reader carries none of the rest.
"""
import re
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.auth import dependencies as deps
from app.templating import templates
from app.utils.request_context import current_viewer

OFFLINE = ["db.js", "media.js", "search.js", "sync.js", "templates.js", "overlay.js", "sw-register.js", "page.js"]


def _render(viewer) -> str:
    req = Request({
        "type": "http", "method": "GET", "path": "/", "query_string": b"",
        "headers": [(b"host", b"testserver")], "scheme": "http",
        "server": ("testserver", 80), "root_path": "", "state": {},
    })
    req.state.csp_nonce = "n0nce"
    token = current_viewer.set(viewer)
    try:
        return templates.env.from_string('{% extends "base.html" %}').render(request=req)
    finally:
        current_viewer.reset(token)


def _scripts(html: str) -> list[str]:
    return re.findall(r'<script src="/static/js/([^"?]+)', html)


def test_signed_in_page_marks_the_reader_and_loads_offline_before_app():
    html = _render((5, 'Ann "A" <x>'))
    body = re.search(r"<body[^>]*>", html).group(0)
    assert 'data-rf-user="5"' in body
    assert 'data-rf-name="Ann &#34;A&#34; &lt;x&gt;"' in body
    scripts = _scripts(html)
    offline = [s for s in scripts if s.startswith("offline/")]
    # logout-guard.js first, blocking in <head> (test_logout_unchanged.py), then the rest.
    assert offline == ["offline/logout-guard.js"] + ["offline/" + f for f in OFFLINE]
    # MiniSearch (vendored) before search.js, which uses its global.
    assert scripts.index("vendor/minisearch.js") < scripts.index("offline/search.js")
    assert scripts.index("offline/page.js") < scripts.index("app.js")
    # Deferred like app.js, so they run in order before DOMContentLoaded.
    for f in OFFLINE:
        assert re.search(r'offline/' + re.escape(f) + r'\?v=[^"]*" defer>', html), f


def test_page_without_a_reader_only_registers_the_worker():
    html = _render(None)
    assert "data-rf-user" not in html
    assert [s for s in _scripts(html) if s.startswith("offline/")] == ["offline/sw-register.js"]


def _request(session):
    return SimpleNamespace(session=session)


async def test_get_current_user_names_the_viewer_only_for_a_valid_session(monkeypatch):
    user = SimpleNamespace(id=5, display_name="Ann", session_token_version=3)
    monkeypatch.setattr(deps, "_get_user_by_id", AsyncMock(return_value=user))
    token = current_viewer.set(None)
    try:
        assert await deps.get_current_user(_request({"user_id": 5, "tv": 3}), db=None) is user
        assert current_viewer.get() == (5, "Ann")
        current_viewer.set(None)
        # A stale session (password changed elsewhere) is no reader.
        with pytest.raises(HTTPException):
            await deps.get_current_user(_request({"user_id": 5, "tv": 2}), db=None)
        assert current_viewer.get() is None
    finally:
        current_viewer.reset(token)

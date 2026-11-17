"""The page side of offline mode is wired into every signed-in page, lightly.

base.html marks the body with the reader (``data-rf-user``) when ``get_current_user``
resolved a valid session, and loads only ``sw-register.js`` (app.js registers the
worker through it) and the bootstrap ``offline/boot.js``. The full offline scripts
are named on the bootstrap (``data-rf-scripts``), which loads them only for a reader
who uses offline mode on this device (tests/js/offline-boot.test.mjs). A page
without a reader gets no list.
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

FULL = ["offline/db.js", "offline/media.js", "vendor/minisearch.js", "offline/search.js",
        "offline/sync.js", "offline/templates.js", "offline/overlay.js", "offline/page.js"]


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


def _boot_tag(html: str) -> str:
    return re.search(r'<script src="/static/js/offline/boot\.js[^>]*>', html).group(0)


def test_signed_in_page_loads_only_the_bootstrap_and_names_the_rest():
    html = _render((5, 'Ann "A" <x>'))
    body = re.search(r"<body[^>]*>", html).group(0)
    assert 'data-rf-user="5"' in body
    assert 'data-rf-name="Ann &#34;A&#34; &lt;x&gt;"' in body
    scripts = _scripts(html)
    # Only the guard (blocking, test_logout_unchanged.py), sw-register and the bootstrap
    # are script tags; none of the ~285 KB of offline mode itself.
    assert [s for s in scripts if s.startswith(("offline/", "vendor/"))] == [
        "offline/logout-guard.js", "offline/sw-register.js", "offline/boot.js"]
    assert scripts.index("offline/boot.js") < scripts.index("app.js")
    assert scripts.index("offline/sw-register.js") < scripts.index("offline/boot.js")
    tag = _boot_tag(html)
    # Parser-blocking, so it can write the full set in as deferred scripts before app.js.
    assert " defer" not in tag and " async" not in tag
    assert 'data-rf-user="5"' in tag
    listed = re.search(r'data-rf-scripts="([^"]*)"', tag).group(1).split()
    assert [re.sub(r"^/static/js/|\?v=.*$", "", u) for u in listed] == FULL
    assert all("?v=" in u for u in listed)
    assert re.search(r'data-rf-db="/static/js/offline/db\.js\?v=[^"]+"', tag)
    # sw-register stays deferred like app.js.
    assert re.search(r'offline/sw-register\.js\?v=[^"]*" defer>', html)


def test_page_without_a_reader_loads_the_bootstrap_without_a_list():
    html = _render(None)
    assert "data-rf-user" not in html
    assert [s for s in _scripts(html) if s.startswith("offline/")] == [
        "offline/sw-register.js", "offline/boot.js"]
    tag = _boot_tag(html)
    assert "data-rf-scripts" not in tag and "data-rf-user" not in tag


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

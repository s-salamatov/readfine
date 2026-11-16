"""POST /logout keeps its behaviour under offline mode (design 5.7).

The page wipes the device before it posts /logout, and replays the post on the next
online start after an offline logout (offline/page.js, ``rf-logout-pending``). That
replay is a plain ``fetch`` with the session cookie and no CSRF token, so /logout must
keep: clearing the session, answering 302 to /login, and accepting a post without a
token (or without a session at all). The one addition is ``Clear-Site-Data: "storage"``.
"""
import json
from base64 import b64encode

from itsdangerous import TimestampSigner

from app.config import settings


def _sign_in(client, user_id=1):
    signer = TimestampSigner(settings.secret_key)
    payload = b64encode(json.dumps({"user_id": user_id, "tv": 0}).encode())
    # The domain httpx files response cookies under, so the server's update lands.
    client.cookies.set("session", signer.sign(payload).decode(), domain="testserver.local")


def test_logout_unchanged(unauth_client):
    _sign_in(unauth_client)
    # A signed-in session: /login sends it on to the app.
    resp = unauth_client.get("/login", follow_redirects=False)
    assert resp.status_code == 302 and resp.headers["location"] == "/app"
    # No CSRF token, as the offline replay sends it.
    resp = unauth_client.post("/logout", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"] == "/login"
    # Defence in depth for offline mode (the page wiped the device already).
    assert resp.headers["clear-site-data"] == '"storage"'
    # The session is gone: /login renders the sign-in form.
    resp = unauth_client.get("/login", follow_redirects=False)
    assert resp.status_code == 200
    assert "data-rf-login" in resp.text


def test_logout_without_a_session_still_answers_302(unauth_client):
    resp = unauth_client.post("/logout", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"] == "/login"


def test_login_page_warns_when_the_offline_wipe_was_incomplete(unauth_client):
    plain = unauth_client.get("/login")
    assert plain.status_code == 200
    assert "data-rf-offline-wipe-warning" not in plain.text
    flagged = unauth_client.get("/login?offline_wipe=incomplete")
    assert "data-rf-offline-wipe-warning" in flagged.text
    assert "could not be removed from this device" in flagged.text
    # Any other value shows nothing.
    other = unauth_client.get("/login?offline_wipe=%3Cb%3E")
    assert "data-rf-offline-wipe-warning" not in other.text


def test_logout_form_is_marked_for_the_offline_wipe():
    """The user menu's logout form carries data-rf-logout, which page.js intercepts."""
    from pathlib import Path

    from app.templating import templates

    src = Path(templates.env.loader.searchpath[0], "app/partials/user_menu_items.html").read_text()
    assert '<form method="POST" action="/logout" data-rf-logout>' in src


def test_signed_out_forms_are_marked_for_app_js():
    """app.js clears rf-logout-pending where these forms render (only without a session)."""
    from pathlib import Path

    from app.templating import templates

    base = templates.env.loader.searchpath[0]
    assert 'action="/login" data-rf-login' in Path(base, "auth/login.html").read_text()
    assert 'action="/register" data-rf-login' in Path(base, "auth/register.html").read_text()


def _render_base(path, query, viewer):
    from starlette.requests import Request

    from app.templating import templates
    from app.utils.request_context import current_viewer

    req = Request({
        "type": "http", "method": "GET", "path": path, "query_string": query.encode(),
        "headers": [(b"host", b"testserver")], "scheme": "http",
        "server": ("testserver", 80), "root_path": "", "state": {},
    })
    req.state.csp_nonce = "n0nce"
    token = current_viewer.set(viewer)
    try:
        return templates.env.from_string('{% extends "base.html" %}').render(request=req)
    finally:
        current_viewer.reset(token)


def test_logout_guard_loads_blocking_in_head_for_signed_in_pages_only():
    html = _render_base("/app", "", (1, "Ann"))
    head = html.split("</head>")[0]
    assert '<script src="/static/js/offline/logout-guard.js' in head
    tag = head.split("offline/logout-guard.js")[1].split(">")[0]
    assert "defer" not in tag and "async" not in tag
    assert "html.rf-hide body { visibility: hidden !important; }" in head
    assert "logout-guard.js" not in _render_base("/login", "", None)


def test_deleted_login_page_loads_the_device_wipe():
    page = _render_base("/login", "deleted=1", None)
    assert "/static/js/offline/db.js" in page and "/static/js/offline/deleted-wipe.js" in page
    plain = _render_base("/login", "", None)
    assert "deleted-wipe.js" not in plain


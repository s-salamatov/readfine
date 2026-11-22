"""app.ui_fragments renders the ui/ macros for routers that return bare fragments
(s2-T37), and the admin fragments use it instead of hand-copied markup."""
from types import SimpleNamespace

import pytest
from bs4 import BeautifulSoup

from app.templating import templates
from app.ui_fragments import alert_html

VARIANTS = ["default", "destructive", "warning", "success"]

_ALERT_IN_TEMPLATE = templates.env.from_string(
    '{% from "ui/display.html" import alert %}'
    "{{ alert(title=title, text=text, variant=variant, live=live) }}"
)


def _in_template(text, title=None, variant="default", live=False):
    return _ALERT_IN_TEMPLATE.render(text=text, title=title, variant=variant, live=live)


@pytest.mark.parametrize("variant", VARIANTS)
@pytest.mark.parametrize("live", [False, True])
@pytest.mark.parametrize("title", [None, "Heads up"])
def test_alert_html_equals_the_macro_in_a_template(variant, live, title):
    out = alert_html("Something happened.", title=title, variant=variant, live=live)
    assert isinstance(out, str)
    assert out == _in_template("Something happened.", title, variant, live)


@pytest.mark.parametrize("variant", VARIANTS)
def test_alert_html_variant_and_role(variant):
    el = BeautifulSoup(alert_html("x", variant=variant, live=True), "html.parser").find()
    assert el.name == "div"
    assert "alert" in el["class"]
    assert el.get("data-variant") == (None if variant == "default" else variant)
    assert el.get("role") == "alert"
    assert BeautifulSoup(alert_html("x", variant=variant), "html.parser").find().get("role") is None


def test_alert_html_escapes_text_and_title():
    out = alert_html("<script>alert(1)</script>", title="<script>t</script>")
    assert "<script>" not in out
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in out
    assert "&lt;script&gt;t&lt;/script&gt;" in out
    soup = BeautifulSoup(out, "html.parser")
    assert soup.find("script") is None
    assert soup.find("h2").get_text() == "<script>t</script>"
    assert soup.find("section").get_text() == "<script>alert(1)</script>"


# ── Admin fragments ───────────────────────────────────────────────────────────

def _alert_of(body):
    el = BeautifulSoup(body, "html.parser").find()
    assert el is not None and el.name == "div" and "alert" in el.get("class", []), body
    return el


class _FakeRequest:
    def __init__(self, form=None):
        self._form = form or {}

    async def form(self):
        return self._form


async def test_smtp_test_result_renders_the_alert_macro(monkeypatch):
    from app.routers.web import admin

    saved = SimpleNamespace(smtp_host="mx", smtp_port=587, smtp_user="u", smtp_from_email="f@x",
                            smtp_password_encrypted=None)

    async def fake_settings(db):
        return saved

    monkeypatch.setattr(admin, "get_app_settings", fake_settings)
    user = SimpleNamespace(email="a<b@x.test")
    outcomes = [
        (None, "success", "Test email sent to a<b@x.test."),
        (ValueError("no host"), "destructive", "SMTP not configured (missing host or from address)."),
        (OSError("re<fused"), "destructive", "Failed to send test email: OSError: re<fused"),
    ]
    for exc, variant, text in outcomes:
        def fake_send(*a, _exc=exc, **k):
            if _exc:
                raise _exc
        monkeypatch.setattr(admin, "send_email", fake_send)
        resp = await admin.admin_test_smtp(_FakeRequest(), user=user, db=None)
        body = resp.body.decode()
        assert resp.status_code == 200
        assert body == _in_template(text, variant=variant, live=True), body
        el = _alert_of(body)
        assert el.get("data-variant") == variant
        assert el.get("role") == "alert"
        assert el.find("section").get_text() == text
        assert "<b@" not in body and "re<fused" not in body
        for legacy in ("text-red-500", "text-red-600", "text-green-600"):
            assert legacy not in body


def _assert_feed_not_found(resp):
    body = resp.body.decode()
    assert resp.status_code == 404
    assert body == alert_html("Feed not found.", variant="destructive")
    el = _alert_of(body)
    assert el.get("data-variant") == "destructive"
    assert el.find("section").get_text() == "Feed not found."
    assert "text-red-500" not in body


async def test_feed_edit_form_not_found_is_a_destructive_alert(monkeypatch):
    from app.routers.web import admin

    async def no_feed(db, feed_id):
        return None

    monkeypatch.setattr(admin, "get_feed", no_feed)
    resp = await admin.admin_feed_edit_form(7, _FakeRequest(), group="az", user=None, db=None)
    _assert_feed_not_found(resp)


async def test_feed_update_new_url_not_found_is_a_destructive_alert(monkeypatch):
    from app.routers.web import admin

    async def no_feed(db, feed_id):
        return None

    monkeypatch.setattr(admin, "get_feed", no_feed)
    resp = await admin.admin_feed_update(7, _FakeRequest({"feed_url": "https://ex.test/rss"}),
                                         group="az", user=SimpleNamespace(id=1), db=None)
    _assert_feed_not_found(resp)
    assert "HX-Retarget" not in resp.headers


async def test_feed_update_missing_feed_is_a_destructive_alert(monkeypatch):
    from app.routers.web import admin

    async def no_update(db, feed_id, **kw):
        return None

    monkeypatch.setattr(admin, "update_feed_admin", no_update)
    resp = await admin.admin_feed_update(7, _FakeRequest({"title": "T"}),
                                         group="az", user=SimpleNamespace(id=1), db=None)
    _assert_feed_not_found(resp)
    assert "HX-Trigger" not in resp.headers

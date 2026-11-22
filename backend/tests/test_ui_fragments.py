"""app.ui_fragments renders the ui/ macros for routers that return bare fragments
(s2-T37), and the admin fragments use it instead of hand-copied markup."""
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from bs4 import BeautifulSoup

from app.templating import templates
from app.ui_fragments import alert_html
from tests.conftest import make_scalar_result

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


# ── s3-T2: alert_html contract, SMTP render, router not-found fragments ──────

def test_alert_html_returns_markup_and_refuses_an_empty_body():
    from markupsafe import Markup

    assert isinstance(alert_html("Body only."), Markup)
    assert isinstance(alert_html("", title="Title only"), Markup)
    for text, title in (("", None), ("   ", None), ("", ""), (" \n", "  "), (None, None)):
        with pytest.raises(ValueError):
            alert_html(text, title=title)


def test_smtp_render_error_is_not_reported_as_smtp_failure(admin_client, monkeypatch, caplog):
    import logging

    from fastapi.testclient import TestClient

    from app.main import app
    from app.routers.web import admin

    saved = SimpleNamespace(smtp_host="mx", smtp_port=587, smtp_user="u", smtp_from_email="f@x",
                            smtp_password_encrypted=None)

    async def fake_settings(db):
        return saved

    real_alert = admin.alert_html

    def alert_failing_on_success(text, **kw):
        if kw.get("variant") == "success":
            raise RuntimeError("render broke")
        return real_alert(text, **kw)

    monkeypatch.setattr(admin, "get_app_settings", fake_settings)
    monkeypatch.setattr(admin, "send_email", lambda *a, **k: None)
    monkeypatch.setattr(admin, "alert_html", alert_failing_on_success)
    caplog.set_level(logging.WARNING, logger=admin.logger.name)
    # The admin_client fixture installs the overrides; this client returns the 500
    # instead of re-raising it.
    with TestClient(app, raise_server_exceptions=False) as c:
        resp = c.post("/admin/settings/test-smtp")
    assert resp.status_code == 500
    assert "Failed to send" not in resp.text
    assert not [r for r in caplog.records if "SMTP test" in r.getMessage()]


def _not_found_articles(client, mock_db):
    with patch("app.routers.web.app.articles.toggle_article_state", new=AsyncMock(return_value=None)):
        return client.post("/htmx/articles/5/read")


def _not_found_filters(client, mock_db):
    with patch("app.routers.web.settings.filters.get_filter", new=AsyncMock(return_value=None)):
        return client.get("/settings/filters/5/edit")


def _not_found_feeds(client, mock_db):
    mock_db.execute.return_value = make_scalar_result(None)
    return client.get("/settings/feeds/5/edit")


def _not_found_scrape(client, mock_db):
    return client.post("/settings/feeds/scrape-show-prompt", data={"url": ""})


@pytest.mark.parametrize("call, status, text", [
    (_not_found_articles, 404, "Article not found."),
    (_not_found_filters, 404, "Filter not found."),
    (_not_found_feeds, 404, "Feed not found."),
    (_not_found_scrape, 200, "URL is required."),
], ids=["articles", "filters", "feeds", "scrape"])
def test_not_found_responses_render_the_alert_macro(client, mock_db, call, status, text):
    resp = call(client, mock_db)
    assert resp.status_code == status
    assert 'class="alert"' in resp.text
    el = _alert_of(resp.text)
    assert el.get("data-variant") == "destructive"
    assert el.find("section").get_text() == text
    for legacy in ("text-red-500", "text-red-700", "bg-red-50"):
        assert legacy not in resp.text

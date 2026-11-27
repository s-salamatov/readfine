"""Settings shell (s7-T1): the immediate-save endpoint POST /settings/field, the
/settings landing, and the sub-navigation of settings/base.html.

The field tests write real rows through the route's own session (the pattern of
test_settings_deletes.py) and remove them at the end.
"""
import json

import pytest
from bs4 import BeautifulSoup
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User, UserSettings
from tests.test_settings_deletes import _client, _user, env  # noqa: F401  (fixture)

pytestmark = pytest.mark.integration


async def _settings(engine, user_id):
    async with AsyncSession(engine) as s:
        return await s.scalar(select(UserSettings).where(UserSettings.user_id == user_id))


async def test_settings_field_saves_allowlisted_and_rejects_others(env):  # noqa: F811
    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        await s.commit()

    async with _client(engine, user.id) as c:
        r = await c.post("/settings/field", data={"field": "mark_read_on_scroll", "value": "true"})
        assert r.status_code == 200
        assert r.text == ""
        trigger = json.loads(r.headers["hx-trigger"])
        assert trigger["showToast"]["msg"] == "Saved"
        assert trigger["rf:settingsaved"] == {"field": "mark_read_on_scroll", "value": "true"}
        row = await _settings(engine, user.id)
        assert row.mark_read_on_scroll is True
        # The row a first save creates is an onboarded one, as htmx_list_view's is.
        assert row.onboarded_at is not None

        r = await c.post("/settings/field", data={"field": "list_density_web", "value": "compact"})
        assert r.status_code == 200
        assert (await _settings(engine, user.id)).list_density_web == "compact"

        before = await _settings(engine, user.id)
        for field, value in [("story_dedup", "bogus"), ("timezone", "Europe/Berlin"),
                             ("is_admin", "true"), ("mark_read_on_scroll", "yes"), ("", "")]:
            r = await c.post("/settings/field", data={"field": field, "value": value})
            assert r.status_code == 400, (field, value)
            assert r.text == ""
            assert "hx-trigger" not in r.headers
        after = await _settings(engine, user.id)
        assert (after.story_dedup, after.timezone, after.mark_read_on_scroll) == (
            before.story_dedup, before.timezone, before.mark_read_on_scroll)
        async with AsyncSession(engine) as s:
            assert (await s.get(User, user.id)).role != "admin"


CHILD = """{% extends "settings/base.html" %}
{% set active = "account" %}
{% set settings_subnav = [
  {"label": "Profile", "url": "/settings/profile", "active": True},
  {"label": "API tokens", "url": "/settings/tokens", "active": False},
] %}
{% block settings_content %}<p id="child-body">body</p>{% endblock %}"""

LABELS = ["Reading & appearance", "Relevance & filters", "Labels", "AI provider",
          "Account", "Stats"]


def _render(monkeypatch, ai_enabled):
    from starlette.requests import Request

    from app.templating import templates
    from tests.test_offline_drift import SIDEBAR_COUNTS

    monkeypatch.setitem(templates.env.globals, "app_ai_enabled", lambda: ai_enabled)
    request = Request({"type": "http", "method": "GET", "path": "/settings/profile",
                       "headers": []})
    html = templates.env.from_string(CHILD).render(
        request=request, user=User(display_name="Reader", role="user"),
        user_feeds=[], folders=[], **SIDEBAR_COUNTS)
    return BeautifulSoup(html, "html.parser")


async def test_settings_index_and_nav(env, monkeypatch):  # noqa: F811
    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        await s.commit()
    async with _client(engine, user.id) as c:
        r = await c.get("/settings", follow_redirects=False)
    assert r.status_code == 303
    assert r.headers["location"] == "/settings/reading"

    dom = _render(monkeypatch, ai_enabled=True)
    assert dom.select_one("#child-body")
    for nav in dom.select("[data-rf-settings-nav]"):
        links = nav.select("a[data-rf-settings-item]")
        assert [a.get_text(" ", strip=True) for a in links] == LABELS
        current = [a for a in links if a.get("aria-current") == "page"]
        assert [a.get_text(strip=True) for a in current] == ["Account"]
        assert current[0]["href"] == "/settings/profile"
    navs = dom.select("[data-rf-settings-nav]")
    assert len(navs) == 2  # the left column and the phone tab row
    phone = dom.select_one("[data-mobile-nav]")
    assert phone is not None and phone.select_one("a[data-mobile-nav-active]").get_text(
        strip=True) == "Account"
    # Sources and Assistant are their own zones now: footer links, online-only.
    for href in ("/sources", "/assistant"):
        links = dom.select(f'a[href="{href}"]')
        assert links and all(a.has_attr("data-rf-online-only") for a in links), href
    assert dom.select('a[href="/app"]')

    sub = dom.select_one("[data-rf-settings-subnav]")
    assert [(a["href"], a.get("aria-current")) for a in sub.select("a")] == [
        ("/settings/profile", "page"), ("/settings/tokens", None)]

    dom = _render(monkeypatch, ai_enabled=False)
    for nav in dom.select("[data-rf-settings-nav]"):
        labels = [a.get_text(" ", strip=True) for a in nav.select("a[data-rf-settings-item]")]
        assert labels == [lab for lab in LABELS if lab != "AI provider"]

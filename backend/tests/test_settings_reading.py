"""Settings → Reading & appearance: the page, its sticky Save and the legacy full POST
(real Postgres, real commits; the fixtures are the batch-delete tests')."""
import json
from unittest.mock import AsyncMock

import pytest
from bs4 import BeautifulSoup
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import UserSettings
from app.services.preference_values import clamp_articles_per_page, clamp_buckets
# env is a fixture: imported so pytest finds it here.
from tests.test_settings_deletes import _client, _user, env  # noqa: F401

pytestmark = pytest.mark.integration

# Listed literally, not read from settings/fields.py: the page is checked on its own.
AUTOSAVE_NAMES = {
    "mark_read_on_scroll", "mark_read_auto_advance", "open_original_when_empty",
    "reading_font_size", "reading_font_family", "unread_filter", "default_sort_order",
    "list_density_web", "list_density_mobile", "label_display", "format_profile",
}
FORM_NAMES = ["timezone", "articles_per_page", "bucket_small_max", "bucket_medium_max"]


async def _new_user(engine, made, **settings):
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        if settings:
            s.add(UserSettings(user_id=user.id, **settings))
        await s.commit()
    return user


async def _settings(engine, user_id):
    async with AsyncSession(engine) as s:
        return await s.scalar(select(UserSettings).where(UserSettings.user_id == user_id))


async def test_reading_page_autosave_controls_and_device_hooks(env):  # noqa: F811
    engine, made = env
    user = await _new_user(
        engine, made, list_density_web="summary", reading_font_family="serif",
        mark_read_on_scroll=True, mark_read_auto_advance=False, timezone="Europe/Berlin",
    )
    async with _client(engine, user.id) as c:
        r = await c.get("/settings/reading")

    assert r.status_code == 200
    page = BeautifulSoup(r.text, "html.parser")
    assert [h.get_text(strip=True) for h in page.select("h1")] == ["Reading & appearance"]

    controls = page.select("[data-rf-autosave]")
    assert {el.get("name") for el in controls} == AUTOSAVE_NAMES
    assert all(el.name in ("input", "select") for el in controls)
    assert all(el.get("data-rf-autosave-label") for el in controls)
    assert all(el["data-rf-autosave"] == "" for el in controls)  # the default endpoint
    # An immediate-save choice belongs to no form: Enter or Save must not post it.
    assert not any(el.find_parent("form") for el in controls)
    # Saved values are what the controls show.
    assert page.select_one('select[name="list_density_web"] option[selected]')["value"] == "summary"
    assert page.select_one('input[name="mark_read_on_scroll"]').has_attr("checked")
    assert not page.select_one('input[name="mark_read_auto_advance"]').has_attr("checked")
    assert [el["value"] for el in page.select('input[name="reading_font_family"][checked]')] == ["serif"]

    form = page.select_one("form#reading-form")
    assert (form["hx-post"], form["hx-target"], form["hx-swap"]) == (
        "/settings/reading/save", "#reading-form", "outerHTML")
    assert [el["name"] for el in form.select("input[name], select[name]")] == FORM_NAMES
    assert form.select_one('select[name="timezone"] option[selected]')["value"] == "Europe/Berlin"
    assert form.select_one('button[type="submit"]').find_parent(class_="sticky")

    once = [
        "#install-app-row", "#install-app-title", "#install-app-hint", "#install-app-btn",
        "[data-rf-offline-settings]", "#offline-enabled", "[data-rf-offline-toggle]",
        "[data-rf-offline-storage]", "[data-rf-offline-note]", "[data-rf-offline-remove]",
        "#offline-diagnostics",
        "[data-rf-offline-diagnostics][data-rf-app-version][data-rf-template-version]",
        '[data-rf-diag-action="test"]', '[data-rf-diag-action="copy"]',
        "[data-rf-diag-launch]", "[data-rf-diag-out]", "[data-rf-offline-install-note]",
        "select#detail-mode-small", 'select[data-layout-bucket="medium"]',
        'select[data-layout-bucket="large"]',
        "#reading-medium-range", "#reading-large-range",  # swapped by an accepted save
        *(f'input[name="color_scheme_device"][value="{v}"]' for v in ("light", "system", "dark")),
        *(f'input[name="app_theme_device"][value="{v}"]' for v in ("neutral", "paper", "graphite")),
    ]
    assert {sel: len(page.select(sel)) for sel in once} == dict.fromkeys(once, 1)
    assert page.select_one('a[href^="javascript:void(window.open("]')
    assert not page.select("#sidebar-mode-small")
    assert not page.select('[name="story_dedup"]')


async def test_reading_save_clamps_and_rejects_non_integers(env, monkeypatch):  # noqa: F811
    from app.routers.web.settings import preferences

    engine, made = env
    user = await _new_user(engine, made)  # no settings row yet
    reschedule = AsyncMock()
    monkeypatch.setattr(preferences, "reschedule_briefings", reschedule)
    good = {"timezone": "Europe/Berlin", "articles_per_page": "100000",
            "bucket_small_max": "200", "bucket_medium_max": "150"}
    async with _client(engine, user.id) as c:
        r = await c.post("/settings/reading/save", data=good)

    assert r.status_code == 200
    assert json.loads(r.headers["hx-trigger"]) == {"showToast": {"msg": "Saved", "type": "ok"}}
    answer = BeautifulSoup(r.text, "html.parser")
    assert answer.select_one("form#reading-form")
    # The width ranges outside the form follow the new breakpoints.
    assert [(el["id"], el.get_text()) for el in answer.select("[hx-swap-oob]")] == [
        ("reading-medium-range", "321–420px"), ("reading-large-range", "> 420px")]
    saved = await _settings(engine, user.id)
    assert saved.articles_per_page == clamp_articles_per_page(100000)
    assert (saved.bucket_small_max, saved.bucket_medium_max) == clamp_buckets(200, 150)
    assert saved.timezone == "Europe/Berlin"
    assert saved.onboarded_at is not None  # a new row must not send them to the welcome
    assert reschedule.await_count == 1

    bad = {**good, "timezone": "Asia/Tokyo", "articles_per_page": "abc", "bucket_small_max": "700"}
    async with _client(engine, user.id) as c:
        r = await c.post("/settings/reading/save", data=bad)

    assert r.status_code == 200
    assert "hx-trigger" not in r.headers
    form = BeautifulSoup(r.text, "html.parser").select_one("form#reading-form")
    assert [a.get_text(strip=True) for a in form.select('[role="alert"]')] == ["Enter a whole number"]
    assert [el["name"] for el in form.select('[aria-invalid="true"]')] == ["articles_per_page"]
    # What was typed stays on screen, to be corrected.
    assert form.select_one('input[name="bucket_small_max"]')["value"] == "700"
    after = await _settings(engine, user.id)
    for column in FORM_NAMES:
        assert getattr(after, column) == getattr(saved, column), column
    assert reschedule.await_count == 1


async def test_reading_legacy_full_post_still_saves(env):  # noqa: F811
    engine, made = env
    user = await _new_user(engine, made, mark_read_on_scroll=False, list_density_web="comfortable")
    old_form = {
        "timezone": "UTC", "format_profile": "iso", "unread_filter": "show_all",
        "default_sort_order": "oldest", "articles_per_page": "40",
        "list_density_web": "compact", "list_density_mobile": "summary",
        "label_display": "dots", "story_dedup": "collapse_suppress",
        "mark_read_on_scroll": "on", "reading_font_size": "lg", "reading_font_family": "serif",
        "bucket_small_max": "640", "bucket_medium_max": "1100",
    }
    async with _client(engine, user.id) as c:
        r = await c.post("/settings/reading", data=old_form)

    assert r.status_code == 200
    page = BeautifulSoup(r.text, "html.parser")
    assert page.select_one("h1").get_text(strip=True) == "Reading & appearance"
    assert "Settings saved." in r.text
    ids = [el["id"] for el in page.select("[id]")]
    assert len(ids) == len(set(ids)) and not page.select("[hx-swap-oob]")
    saved = await _settings(engine, user.id)
    assert saved.mark_read_on_scroll is True
    assert saved.list_density_web == "compact"
    assert saved.story_dedup == "collapse_suppress"

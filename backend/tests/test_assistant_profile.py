"""Profile adapters against real persistence; only AI transport is replaced."""
import json
import re
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import anthropic
import openai
import pytest
import pytest_asyncio
from bs4 import BeautifulSoup
from fastapi import FastAPI
from sqlalchemy import event, select
from starlette.middleware.sessions import SessionMiddleware

from app import templating
from app.auth.dependencies import get_current_user
from app.database import get_db
from app.models.ai import UserAiKey
from app.models.article import AiUsageLog
from app.models.settings import AppSettings
from app.models.user import User, UserSettings
from app.routers.web.settings import ai
from app.services import ai_service
from tests.test_translation import pg  # noqa: F401

pytestmark = pytest.mark.asyncio
STAMP = datetime(2025, 1, 1, tzinfo=timezone.utc)


def snapshot(s):
    return {c.name: getattr(s, c.name) for c in s.__table__.columns}


def dom(response):
    return BeautifulSoup(response.text, "html.parser")


@pytest_asyncio.fixture
async def profile(pg, monkeypatch):
    user = User(email=f"profile-{uuid.uuid4().hex}@test.invalid", password_hash="x", display_name="Profile reader")
    other = User(email=f"profile-{uuid.uuid4().hex}@test.invalid", password_hash="x", display_name="Profile reader")
    pg.add_all([user, other])
    await pg.flush()
    s = UserSettings(
        user_id=user.id, ai_fast_provider="openai", ai_fast_model="scoring-model",
        ai_quality_provider="anthropic", ai_quality_model="main-model",
        ai_scoring_enabled_default=True, ai_summary_enabled_default=False,
        ai_chat_enabled=True, ai_content_limit=12345, ai_min_content_chars=321,
        ai_summary_prompt="My summary", ai_context_prompt="My context",
        ai_preference_text="Existing profile topics", ai_preference_auto_days=0,
        ai_preference_updated_at=STAMP, ai_preference_source="auto",
        ai_preference_last_error="Old failure", ai_preference_last_error_at=STAMP,
        ai_preference_fail_count=2,
    )
    foreign = UserSettings(user_id=other.id, ai_preference_text="Other reader profile")
    key = UserAiKey(user_id=user.id, provider="anthropic",
                    api_key_encrypted="opaque-test-ciphertext", key_prefix="fixture")
    pg.add_all([s, foreign, key])
    await pg.flush()
    commits = []
    event.listen(pg.sync_session, "after_commit", lambda session: commits.append(True))
    app = FastAPI()
    app.add_middleware(SessionMiddleware, secret_key="test-session-secret")
    app.include_router(ai.router)
    if hasattr(ai, "assistant_router"):
        app.include_router(ai.assistant_router)
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: pg
    monkeypatch.setattr(ai.limiter, "enabled", False)
    monkeypatch.setattr(templating, "_ai_enabled", True)
    # No test can accidentally open a provider connection.
    client = SimpleNamespace(close=AsyncMock())
    transport = AsyncMock(return_value=(client, "anthropic", "main-model"))
    completion = AsyncMock(return_value=ai_service.Completion("Generated <topics> & reading", 23, 7))
    monkeypatch.setattr(ai_service, "get_ai_client", transport)
    monkeypatch.setattr(ai_service, "_complete", completion)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as web:
        yield SimpleNamespace(db=pg, user=user, s=s, foreign=foreign, key=key,
                              app=app, web=web, transport=transport, completion=completion, commits=commits)


async def test_assistant_profile_save_is_narrow(profile):
    """A profile save must not apply missing or injected provider preferences."""
    p = profile
    before = snapshot(p.s)
    key_before = snapshot(p.key)
    response = await p.web.post("/assistant/profile", data={
        "ai_preference_text": "  New interest profile  ", "ai_preference_auto_days": "14",
        "ai_fast_provider": "custom", "ai_quality_model": "injected",
        "ai_summary_enabled_default": "on", "ai_chat_enabled": "",
        "ai_content_limit": "99", "user_id": str(p.foreign.user_id),
    })
    assert response.status_code == 200
    assert json.loads(response.headers["HX-Trigger"])["showToast"]["type"] == "ok"
    await p.db.refresh(p.s)
    allowed = {"ai_preference_text", "ai_preference_auto_days", "ai_preference_updated_at",
               "ai_preference_source", "ai_preference_fail_count", "ai_preference_last_error",
               "ai_preference_last_error_at"}
    assert {k: v for k, v in snapshot(p.s).items() if k not in allowed} == {
        k: v for k, v in before.items() if k not in allowed}
    assert p.s.ai_preference_text == "New interest profile"
    assert p.s.ai_preference_auto_days == 14
    assert p.s.ai_preference_source == "manual"
    assert p.s.ai_preference_fail_count == 0 and p.s.ai_preference_last_error is None
    assert snapshot(p.key) == key_before
    assert p.foreign.ai_preference_text == "Other reader profile"
    stamp = p.s.ai_preference_updated_at
    await p.web.post("/assistant/profile", data={"ai_preference_text": "New interest profile"})
    await p.db.refresh(p.s)
    assert p.s.ai_preference_updated_at == stamp
    assert p.transport.await_count == 0


async def test_assistant_profile_validation_and_schedule(profile):
    """Rejected text cannot partially change a schedule; empty/absent differ."""
    p = profile
    for text, interval, valid, days in [
        (" ", "0", True, 0), ("x" * 9, "14", False, 0),
        ("x" * 10, "14", True, 14), ("x" * 5000, "28", True, 28),
        ("<script>" + "x" * 4993, "0", False, 28),
        ("Valid profile", "invalid", True, 0),
    ]:
        before = snapshot(p.s)
        commits_before = len(p.commits)
        response = await p.web.post("/assistant/profile", data={
            "ai_preference_text": text, "ai_preference_auto_days": interval})
        assert response.status_code == 200
        await p.db.refresh(p.s)
        if valid:
            assert len(p.commits) == commits_before + 1
            assert p.s.ai_preference_text == (text.strip() or None)
            assert p.s.ai_preference_auto_days == days
        else:
            assert len(p.commits) == commits_before
            assert snapshot(p.s) == before
            assert "HX-Trigger" not in response.headers
            assert dom(response).select_one('[role="alert"]')
            assert dom(response).select_one("#ai_preference_text").text == text
            assert dom(response).select_one("#ai_preference_auto_days option[selected]")["value"] == interval
            assert "<script>" not in response.text
    p.s.ai_preference_auto_days = 0
    p.s.ai_preference_updated_at = None
    p.s.ai_preference_fail_count = 3
    p.s.ai_preference_last_error = "Failed"
    await p.db.flush()
    start = datetime.now(timezone.utc)
    await p.web.post("/assistant/profile", data={"ai_preference_auto_days": "14"})
    await p.db.refresh(p.s)
    assert p.s.ai_preference_updated_at >= start
    assert p.s.ai_preference_fail_count == 0 and p.s.ai_preference_last_error is None
    ctx = await ai.interest_profile_context(p.user, p.db)
    assert ctx["pref_auto_status"] == "up_to_date"
    assert (ctx["pref_auto_detail"]["next_at"] - p.s.ai_preference_updated_at).days == 14
    before = snapshot(p.s)
    await p.web.post("/assistant/profile", data={})
    await p.db.refresh(p.s)
    assert snapshot(p.s) == before
    # Empty profiles still generate immediately when the schedule is enabled.
    p.s.ai_preference_text = None
    p.s.ai_preference_auto_days = 0
    p.s.ai_preference_updated_at = None
    assert ai._apply_interest_profile(p.s, {"ai_preference_auto_days": "28"}, STAMP) is None
    assert p.s.ai_preference_updated_at is None


async def test_assistant_profile_generation_and_gates(profile, monkeypatch, caplog):
    """Setup blockers preserve manual drafts; generation spends tokens but never saves."""
    p = profile
    for provider, model, endpoint, scoring, expected in [
        (None, None, None, True, "main model"),
        ("openai", "model", None, True, "API key"),
        ("custom", "model", None, True, "endpoint URL"),
        ("anthropic", "main-model", None, False, "scoring"),
    ]:
        p.s.ai_quality_provider, p.s.ai_quality_model = provider, model
        p.s.ai_custom_base_url, p.s.ai_scoring_enabled_default = endpoint, scoring
        await p.db.flush()
        ctx = await ai.interest_profile_context(p.user, p.db)
        assert not {"keys", "cost_stats"}.intersection(ctx)
        rendered = templating.templates.env.get_template("assistant/profile.html").render(**ctx)
        soup = BeautifulSoup(rendered, "html.parser")
        assert expected in soup.get_text()
        assert soup.select_one('a[href="/settings/ai"]')
        assert soup.select_one("#btn-generate-preference").has_attr("disabled")
        assert soup.select_one("#ai_preference_text").text == "Existing profile topics"
        assert "opaque-test-ciphertext" not in rendered and "fixture" not in rendered
    assert p.transport.await_count == 0
    monkeypatch.setattr(templating, "_ai_enabled", False)
    rendered = templating.templates.env.get_template("assistant/profile.html").render(**ctx)
    soup = BeautifulSoup(rendered, "html.parser")
    assert "Contact your administrator" in soup.get_text()
    assert soup.select_one('#ai_preference_text[disabled]')
    assert soup.select_one('button[type="submit"][disabled]')
    monkeypatch.setattr(templating, "_ai_enabled", True)
    p.s.ai_quality_provider, p.s.ai_quality_model = "anthropic", "main-model"
    p.s.ai_scoring_enabled_default = True
    await p.db.flush()
    before = snapshot(p.s)
    response = await p.web.post("/assistant/profile/generate")
    assert response.status_code == 200
    soup = dom(response)
    assert soup.select_one('[role="status"]')
    assert soup.select_one('#ai_preference_text[hx-swap-oob="true"]').text == "Generated <topics> & reading"
    assert soup.select_one('#pref-char-count[hx-swap-oob="true"]').text == "28"
    assert "0 articles" in soup.select_one("#pref-cold-start-warning").text
    await p.db.refresh(p.s)
    assert snapshot(p.s) == before
    usage = (await p.db.scalars(select(AiUsageLog).where(AiUsageLog.user_id == p.user.id))).one()
    assert (usage.operation, usage.input_tokens, usage.output_tokens) == ("preference_generation", 23, 7)
    # Provider messages and request URLs are untrusted even when HTML-escaped.
    key = "sk-synthetic-profile-secret"
    endpoint = "https://reader:endpoint-password@provider.invalid/v1?api_key=" + key
    raw = f"{key} {endpoint} <provider unavailable>"
    request = httpx.Request("POST", endpoint)
    errors = [(RuntimeError(raw), "Could not generate your profile.")]
    for sdk in (openai, anthropic):
        for cls, status, expected in [
            (sdk.AuthenticationError, 401, "Authentication failed"),
            (sdk.PermissionDeniedError, 403, "Access denied"),
            (sdk.RateLimitError, 429, "Rate limit reached"),
        ]:
            errors.append((cls(raw, response=httpx.Response(status, request=request), body=None), expected))
        errors.extend([
            (sdk.APITimeoutError(request=request), "Timed out"),
            (sdk.APIConnectionError(message=raw, request=request), "Could not reach"),
        ])
    errors.extend([
        (TimeoutError(raw), "Timed out"),
        (httpx.ReadTimeout(raw, request=request), "Timed out"),
        (ConnectionError(raw), "Could not reach"),
        (httpx.ConnectError(raw, request=request), "Could not reach"),
    ])
    failures = []
    for error, expected in errors:
        p.completion.side_effect = error
        for path in ("/assistant/profile/generate",):
            caplog.clear()
            failed = await p.web.post(path)
            assert failed.status_code == 200
            soup = dom(failed)
            assert soup.select_one('[role="alert"]')
            assert not soup.select_one("textarea")  # Keep the unsaved DOM draft.
            label = f"{path}: {type(error).__name__}"
            if expected not in soup.get_text():
                failures.append(f"{label}: missing controlled feedback")
            for secret in (key, endpoint, "endpoint-password", "<provider unavailable>"):
                if secret in failed.text or secret in soup.get_text() or secret in caplog.text:
                    failures.append(f"{label}: provider detail leaked into response or log")
            if type(error).__name__ not in caplog.text:
                failures.append(f"{label}: missing exception class in log")
            await p.db.refresh(p.s)
            assert snapshot(p.s) == before
    assert not failures, "\n".join(failures)


async def test_assistant_profile_revert_and_old_aliases_gone(profile):
    """The /settings/ai aliases are gone (s8); the Assistant routes keep the
    handlers, dependencies, limiter and reversible persistence."""
    p = profile
    routes = {r.path: r for r in p.app.routes if hasattr(r, "endpoint")}
    assert "/settings/ai/generate-preference" not in routes
    assert "/settings/ai/revert-preference" not in routes
    for action in ["generate", "revert"]:
        assert [d.call for d in routes[f"/assistant/profile/{action}"].dependant.dependencies] == [
            get_current_user, get_db, ai.require_ai_enabled]
    assert any("settings_ai_generate_preference" in k for k in ai.limiter._route_limits)
    url = "/assistant/profile/revert"
    p.s.ai_preference_text, p.s.ai_preference_prev_text = "Current profile", "Previous <profile>"
    await p.db.flush()
    response = await p.web.post(url)
    assert response.status_code == 200
    await p.db.refresh(p.s)
    assert (p.s.ai_preference_text, p.s.ai_preference_prev_text) == ("Previous <profile>", "Current profile")
    assert p.s.ai_preference_source == "manual" and p.s.ai_preference_updated_at > STAMP
    assert dom(response).select_one("#ai_preference_text").text == "Previous <profile>"
    await p.web.post(url)
    assert p.s.ai_preference_text == "Current profile"
    p.s.ai_preference_prev_text = None
    await p.db.flush()
    empty = await p.web.post(url)
    assert "No previous version" in empty.text and not dom(empty).select_one("textarea")
    assert (await p.web.post("/assistant/profile/generate")).status_code == 200
    for old in ["/settings/ai/generate-preference", "/settings/ai/revert-preference"]:
        assert (await p.web.post(old)).status_code == 404
    paths = ["/assistant/profile", "/assistant/profile/generate", "/assistant/profile/revert"]
    p.app.dependency_overrides.pop(get_current_user)
    for path in paths:
        assert (await p.web.post(path)).status_code == 401
    p.app.dependency_overrides[get_current_user] = lambda: p.user
    (await p.db.get(AppSettings, 1)).ai_enabled = False
    await p.db.flush()
    calls = p.transport.await_count
    for path in paths:
        assert (await p.web.post(path)).status_code == 403
    assert p.transport.await_count == calls


async def test_ai_settings_retains_provider_form(profile):
    """Moving the editor keeps provider-only submissions; profile fields are elsewhere."""
    p = profile
    page = await p.web.get("/settings/ai")
    assert page.status_code == 200
    soup = dom(page)
    assert soup.select_one('form[action="/settings/ai/preferences"] [name="ai_fast_provider"]')
    assert soup.select_one('a[href="/assistant?section=profile#assistant-profile"]')
    assert not soup.select_one("#ai_preference_text")
    provider_form = {"ai_fast_provider": "openai", "ai_fast_model": "scoring-model",
                     "ai_quality_provider": "anthropic", "ai_quality_model": "main-model",
                     "ai_scoring_enabled_default": "on", "ai_chat_enabled": "on"}
    assert (await p.web.post("/settings/ai/preferences", data=provider_form)).status_code == 200
    await p.db.refresh(p.s)
    assert p.s.ai_preference_text == "Existing profile topics" and p.s.ai_preference_auto_days == 0
    p.s.ai_preference_last_error = "Recent automatic failure"
    p.s.ai_preference_last_error_at = STAMP
    await p.db.flush()
    section = await p.web.post("/assistant/profile", data={})
    soup = dom(section)
    assert len(soup.select("#assistant-profile")) == 1
    assert soup.select_one('form[hx-target="#assistant-profile"][hx-swap="outerHTML"][data-rf-online-only]')
    for selector in ["#ai_preference_text", "#ai_preference_auto_days", "#pref-char-count",
                     "#pref-cold-start-warning", "#preference-message", "#btn-generate-preference"]:
        assert soup.select_one(selector), selector
    assert "Last updated" in section.text and "Last automatic generation failed" in section.text


async def test_ai_preferences_refuses_stale_profile_fields(profile):
    """A tab from before the move still posts the profile with the provider form:
    the whole post is refused as out of date and nothing is written."""
    p = profile
    provider_form = {"ai_fast_provider": "openai", "ai_fast_model": "scoring-model",
                     "ai_quality_provider": "openai", "ai_quality_model": "changed-model",
                     "ai_chat_enabled": "on"}
    before = snapshot(p.s)
    for stale in [{"ai_preference_text": "Stale tab profile with plenty of topics"},
                  {"ai_preference_auto_days": "28"}]:
        response = await p.web.post("/settings/ai/preferences", data={**provider_form, **stale})
        assert response.status_code == 409
        assert json.loads(response.headers["HX-Trigger"])["showToast"] == {
            "msg": "This page is out of date. Reload it and try again.", "type": "error"}
        await p.db.refresh(p.s)
        assert snapshot(p.s) == before
    response = await p.web.post("/settings/ai/preferences", data=provider_form)
    assert response.status_code == 200
    await p.db.refresh(p.s)
    assert (p.s.ai_quality_provider, p.s.ai_quality_model) == ("openai", "changed-model")
    assert p.s.ai_preference_text == "Existing profile topics" and p.s.ai_preference_auto_days == 0


@pytest.mark.parametrize("name", ["help.html", "settings/relevance.html"])
def test_interest_profile_text_points_to_assistant(name):
    """The profile moved: copy that says where to edit it links the Assistant section."""
    env = templating.templates.env
    source = env.loader.get_source(env, name)[0]
    assert 'href="/assistant?section=profile#assistant-profile"' in source
    assert not re.search(r'<a href="/settings/ai"[^>]*>interest profile</a>', source)
    assert not re.search(r"you've read, in <a href=\"/settings/ai\"", source)

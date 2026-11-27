"""Page-only chat contract; access and persistence use the migrated task database."""
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from bs4 import BeautifulSoup
from jinja2 import ChoiceLoader, DictLoader
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from starlette.requests import Request

from app.auth.dependencies import get_current_user
from app.config import settings
from app.database import get_db
from app.main import app
from app.models.article import Article, ArticleAiChat
from app.models.feed import Feed, UserFeed
from app.models.settings import AppSettings
from app.models.user import User, UserSettings
from app.rate_limit import limiter
from app.routers.web.app import ai
from app.services.ai_jobs import normalize_content
from app.templating import templates
from app.utils.url_validator import BlockedAddressError, ResponseTooLarge

DISCLOSURE = "General conversation; it does not search your feeds or library."


def page(**context):
    # These two owners land in the same wave; the page and chat are always real.
    env = templates.env.overlay(loader=ChoiceLoader([DictLoader({
        "assistant/catchup.html": '<section id="assistant-catch-up">Catch me up / Briefings</section>',
        "assistant/profile.html": '<section id="assistant-profile">Interest profile</section>',
    }), templates.env.loader]))
    request = Request({"type": "http", "method": "GET", "path": "/assistant", "query_string": b"", "headers": [], "scheme": "http", "server": ("localhost", 80)})
    request.state.csp_nonce = "fixture"
    return BeautifulSoup(env.get_template("assistant/page.html").render(
        request=request, user=SimpleNamespace(id=1), section="chat", catchup_context={}, profile_context={},
        **dict({"article": None, "chat_available": True, "chat_setup": None}, **context)), "html.parser")


@asynccontextmanager
async def chat_fixture():
    engine = create_async_engine(settings.database_url)
    try:
        async with engine.connect() as conn:
            tx = await conn.begin()
            try:
                async with AsyncSession(conn, expire_on_commit=False, join_transaction_mode="create_savepoint") as db:
                    user = User(id=18101, email="assistant@test.invalid", password_hash="x", display_name="Reader")
                    other = User(id=18102, email="assistant-other@test.invalid", password_hash="x", display_name="Other")
                    db.add_all([user, other, Feed(id=18101, feed_url="https://example.invalid/feed", title="Owned"), Feed(id=18102, feed_url="https://example.invalid/private", title="Private", is_private=True)])
                    await db.flush()
                    prefs = UserSettings(user_id=user.id, ai_chat_enabled=True, ai_quality_provider="custom", ai_quality_model="fixture", ai_custom_base_url="http://localhost:9999", ai_content_limit=20000)
                    article = Article(id=18101, feed_id=18101, guid="owned", guid_hash="a" * 64, title="Owned article", content="<p>fallback</p>", readable_content="<p>Readable content</p>")
                    foreign = Article(id=18102, feed_id=18102, guid="private", guid_hash="b" * 64, title="PRIVATE TITLE", content="PRIVATE BODY")
                    db.add_all([prefs, article, foreign, UserFeed(user_id=user.id, feed_id=18101), UserFeed(user_id=other.id, feed_id=18102)])
                    admin = await db.get(AppSettings, 1)
                    if admin is None:
                        admin = AppSettings(id=1)
                        db.add(admin)
                    admin.ai_enabled = True
                    await db.commit()
                    async def database():
                        yield db
                    async def viewer():
                        return user
                    app.dependency_overrides[get_db] = database
                    app.dependency_overrides[get_current_user] = viewer
                    old_limit = limiter.enabled
                    limiter.enabled = False
                    try:
                        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as client:
                            await client.get("/login")
                            client.headers["x-csrftoken"] = client.cookies["csrftoken"]
                            yield client, db, user, prefs, article, admin
                    finally:
                        app.dependency_overrides.clear()
                        limiter.enabled = old_limit
            finally:
                await tx.rollback()
    finally:
        await engine.dispose()


def test_assistant_chat_template_contract():
    hostile = SimpleNamespace(id=17, title='<img src=x onerror="bad()">')
    dom = page(article=hostile)
    assert len(dom.select("#rf-assistant-chat")) == 1
    assert json.loads(dom.select_one('[name="history"]')["value"]) == []
    send = dom.select_one("#general-chat-submit")
    assert send["hx-post"] == "/htmx/ai-chat"
    assert send["hx-target"] == "#rf-assistant-chat" and send["hx-swap"] == "outerHTML"
    assert send.get_text(strip=True) == "Send" and "hidden" not in send.get("class", [])
    assert not dom.select("#assistant-chat img")
    assert hostile.title in dom.get_text()
    assert [o["value"] for o in dom.select("#assistant-chat-scope option")] == ["general", "article"]
    general = page()
    assert [o["value"] for o in general.select("#assistant-chat-scope option")] == ["general"]
    assert DISCLOSURE in general.get_text()
    for anchor in ["assistant-main", "assistant-chat", "assistant-catch-up", "assistant-profile"]:
        assert len(dom.select("#" + anchor)) == 1
    assert dom.select_one('a[href="/assistant?section=profile#assistant-profile"]')
    for script in ["ui/assistant.js", "catchup.js", "scope-selector.js", "label-selector.js"]:
        assert len(dom.select(f'script[src*="/{script}"]')) == 1


async def test_assistant_chat_response_and_access(caplog):
    async with chat_fixture() as (client, db, user, prefs, article, admin):
        @asynccontextmanager
        async def transport(*args):
            yield object(), "custom", "fixture"
        provider = AsyncMock(return_value=("Answer", 11, 7))
        headers = {"HX-Target": "rf-assistant-chat"}
        async def post(**fields):
            return await client.post("/htmx/ai-chat", headers=headers, data={"message": "Question", "history": "[]", **fields})
        with patch("app.services.ai_service.ai_client", transport), patch("app.services.ai_service.chat_with_article", provider):
            response = await post(include_article="on", article_id=str(article.id))
            assert response.status_code == 200
            dom = BeautifulSoup(response.text, "html.parser")
            assert dom.select_one("#rf-assistant-chat")
            assert dom.select_one("#general-chat-include-article").has_attr("checked")
            assert dom.select_one("#general-chat-article-id")["value"] == str(article.id)
            assert provider.call_args.args[1] == "Owned article\n\nReadable content"
            assert provider.call_args.args[1] == normalize_content(article.title, article.readable_content, prefs.ai_content_limit)
            record = await db.scalar(select(ArticleAiChat).where(ArticleAiChat.user_id == user.id, ArticleAiChat.article_id == article.id))
            assert record.total_input_tokens == 11 and len(record.messages) == 2
            response = await post()
            assert provider.call_args.args[1] is None
            assert BeautifulSoup(response.text, "html.parser").select_one("#rf-assistant-chat")
            assert response.headers["cache-control"] == "no-store" and "HX-Target" in response.headers["vary"]
            for bad in ["", "bad", "18102", "999999999", "9" * 5000, "١٢"]:
                provider.reset_mock()
                response = await post(include_article="on", article_id=bad)
                assert 'data-chat-error' in response.text and "PRIVATE" not in response.text
                provider.assert_not_called()
            response = await post(message=" ")
            assert response.status_code == 400 and 'data-chat-error' in response.text
            provider.assert_not_called()
            history = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"Previous turn {i}"} for i in range(10)]
            # Exercise the real error boundary: provider details must never reach
            # any chat representation, its hidden history, or server-side logs.
            token = "sk-SYNTHETIC_PRIVATE_CREDENTIAL"
            endpoint = "https://fixture-user:SYNTHETIC_PASSWORD@private.invalid/v1?token=SYNTHETIC_URL_TOKEN"
            failures = [
                (RuntimeError(f"Upstream request rejected: token={token}"), "could not be completed"),
                (RuntimeError(f"Upstream request rejected: {endpoint}"), "could not be completed"),
                (BlockedAddressError(f"disallowed address: {endpoint}"), "AI_ALLOWED_PRIVATE_HOSTS"),
                (ResponseTooLarge(f"size limit exceeded at {endpoint}"), "OpenAI-compatible API"),
                (TimeoutError(endpoint), "Timed out"),
                (httpx.ConnectError(endpoint), "Could not reach the endpoint"),
                (RuntimeError(f"invalid api key: {token}"), "Invalid API key"),
                (RuntimeError(f"not_found: {endpoint}"), "Model not found"),
                (RuntimeError(f"overloaded: {token}"), "overloaded"),
                (RuntimeError(f"rate_limit: {endpoint}"), "Rate limit reached"),
                (RuntimeError(f"forbidden: {token}"), "Access denied"),
                (ValueError(), "could not be completed"),
            ]
            server_error = RuntimeError(token)
            server_error.status_code = 502
            failures.append((server_error, "server error"))
            for cause in [BlockedAddressError(endpoint), ResponseTooLarge(token)]:
                wrapped = httpx.ConnectError("Connection error.")
                wrapped.__cause__ = cause
                failures.append((wrapped, "AI_ALLOWED_PRIVATE_HOSTS" if isinstance(cause, BlockedAddressError) else "OpenAI-compatible API"))
            for failure, safe_hint in failures:
                for representation in ["assistant", "assistant-article", "general", "article"]:
                    is_assistant = representation.startswith("assistant")
                    is_article = representation == "article"
                    url = f"/htmx/articles/{article.id}/ai-chat" if is_article else "/htmx/ai-chat"
                    request_headers = headers if is_assistant else {}
                    fields = {"message": "Retry question", "history": json.dumps(history)}
                    if representation == "assistant-article":
                        fields.update(include_article="on", article_id=str(article.id))
                    record.messages = list(history)
                    await db.flush()
                    old_tokens = (record.total_input_tokens, record.total_output_tokens)
                    caplog.clear()
                    provider.side_effect = failure
                    response = await client.post(url, headers=request_headers, data=fields)
                    assert response.status_code == 200
                    dom = BeautifulSoup(response.text, "html.parser")
                    error = dom.select_one("[data-chat-error]")
                    assert error is not None
                    for secret in [token, endpoint, "fixture-user", "SYNTHETIC_PASSWORD", "private.invalid", "SYNTHETIC_URL_TOKEN"]:
                        assert secret not in response.text
                        assert secret not in caplog.text
                    assert safe_hint in error.get_text()
                    logged = [entry for entry in caplog.records if entry.name == ai.__name__]
                    assert [entry.getMessage() for entry in logged] == [f"AI chat failed: {type(failure).__name__}"]
                    assert logged[0].exc_info is None
                    restored = history if is_assistant or is_article else history[1:]
                    if not is_article:
                        assert json.loads(dom.select_one('[name="history"]')["value"]) == restored
                    for turn in restored:
                        assert turn["content"] in dom.get_text()
                    assert "Retry question" not in dom.get_text()
                    await db.refresh(record)
                    assert record.messages == history
                    assert (record.total_input_tokens, record.total_output_tokens) == old_tokens
                    submitted = history + [{"role": "user", "content": "Retry question"}]
                    assert provider.call_args.args[0] == (submitted if is_article else submitted[-10:])
                    provider.side_effect = None
                    fields["history"] = json.dumps(restored)
                    retry = await client.post(url, headers=request_headers, data=fields)
                    assert retry.status_code == 200 and "data-chat-error" not in retry.text
                    retried = (restored + [{"role": "user", "content": "Retry question"}, {"role": "assistant", "content": "Answer"}])[-10:]
                    if is_article:
                        await db.refresh(record)
                        assert record.messages == retried
                    else:
                        retry_dom = BeautifulSoup(retry.text, "html.parser")
                        assert json.loads(retry_dom.select_one('[name="history"]')["value"]) == retried
            provider.side_effect = None
            legacy = await client.post("/htmx/ai-chat", data={"message": "Legacy"})
            assert 'id="general-chat-area"' in legacy.text and 'id="rf-assistant-chat"' not in legacy.text
            assert legacy.headers["cache-control"] == "no-store" and "HX-Target" in legacy.headers["vary"]
            legacy = await client.post(f"/htmx/articles/{article.id}/ai-chat", data={"message": "Legacy"})
            assert f'id="chat-area-{article.id}"' in legacy.text


async def test_assistant_chat_setup_states():
    async with chat_fixture() as (client, db, user, prefs, article, admin):
        assert hasattr(ai, "assistant_chat_context"), "T4 needs the shared readiness adapter"
        provider = AsyncMock(side_effect=AssertionError("setup must not call a provider"))
        with patch("app.services.ai_service.chat_with_article", provider):
            ready = await ai.assistant_chat_context(user, db, article.id)
            assert ready["chat_available"] and ready["article"].id == article.id
            for field, value, text in [("ai_quality_model", None, "main model"), ("ai_quality_provider", "anthropic", "API key"), ("ai_custom_base_url", None, "endpoint"), ("ai_chat_enabled", False, "chat")]:
                old = getattr(prefs, field)
                setattr(prefs, field, value)
                await db.flush()
                context = await ai.assistant_chat_context(user, db)
                dom = page(**context)
                assert not context["chat_available"] and text.lower() in dom.get_text().lower()
                # The notice says it once, then its one link.
                notice = dom.select_one("#assistant-chat .alert")
                assert " ".join(notice.get_text().split()) == f'{context["chat_setup"]["text"]} Open AI provider settings'
                assert dom.select_one("#general-chat-submit").has_attr("disabled")
                response = await client.post("/htmx/ai-chat", headers={"HX-Target": "rf-assistant-chat"}, data={"message": "blocked"})
                assert "data-chat-error" in response.text
                setattr(prefs, field, old)
            admin.ai_enabled = False
            await db.flush()
            switched_off = page(**await ai.assistant_chat_context(user, db))
            assert "administrator" in switched_off.get_text()
            # Nothing in the reader's own settings turns it back on.
            assert not switched_off.select('#assistant-chat a[href="/settings/ai"]')
            admin.ai_enabled = True
            await db.flush()
            inaccessible = await ai.assistant_chat_context(user, db, 18102)
            assert inaccessible["article"] is None
            assert "PRIVATE" not in str(page(**inaccessible))
            await db.delete(prefs)
            await db.flush()
            absent = await ai.assistant_chat_context(user, db)
            assert not absent["chat_available"] and "main model" in page(**absent).get_text().lower()
            assert "localhost:9999" not in str(page(**absent))
            provider.assert_not_called()


async def test_chat_setup_link_is_structured():
    # The link is data next to the sentence, not a phrase cut out of it.
    async with chat_fixture() as (client, db, user, prefs, article, admin):
        for field, value, text in [
            ("ai_quality_model", None, "Choose a main model."),
            ("ai_quality_provider", "anthropic", "Add an API key for your main model."),
            ("ai_custom_base_url", None, "Set the custom model endpoint."),
            ("ai_chat_enabled", False, "Enable chat in the AI provider settings."),
        ]:
            old = getattr(prefs, field)
            setattr(prefs, field, value)
            await db.flush()
            context = await ai.assistant_chat_context(user, db)
            assert context["chat_setup"] == {"text": text, "link_label": "Open AI provider settings", "href": "/settings/ai"}
            dom = page(**context)
            notices = dom.select("#assistant-chat .alert")
            assert len(notices) == 1
            links = notices[0].select('a[href="/settings/ai"]')
            assert [a.get_text(strip=True) for a in links] == ["Open AI provider settings"]
            assert text in notices[0].get_text() and "Settings → AI" not in notices[0].get_text()
            setattr(prefs, field, old)


async def test_assistant_unavailable_article_keeps_general_chat():
    async with chat_fixture() as (client, db, user, prefs, article, admin):
        foreign = await ai.assistant_chat_context(user, db, 18102)
        missing = await ai.assistant_chat_context(user, db, 999999999)
        # Someone else's article and a deleted one are indistinguishable.
        assert str(page(**foreign)) == str(page(**missing))
        dom = page(**foreign)
        assert "PRIVATE" not in str(dom) and "18102" not in str(dom)
        assert "start a general conversation" in dom.select_one("#assistant-chat .alert").get_text()
        assert not dom.select_one('#assistant-chat a[href="/settings/ai"]')
        assert not dom.select_one("#assistant-chat fieldset").has_attr("disabled")
        assert not dom.select_one("#general-chat-submit").has_attr("disabled")
        assert [o["value"] for o in dom.select("#assistant-chat-scope option")] == ["general"]
        assert dom.select_one("#general-chat-article-id")["value"] == ""
        assert not dom.select_one("#general-chat-include-article").has_attr("checked")

        served = await client.get("/assistant?article_id=18102")
        section = BeautifulSoup(served.text, "html.parser").select_one("#assistant-chat")
        assert served.status_code == 200 and "PRIVATE" not in served.text
        assert not section.select_one("fieldset").has_attr("disabled")

        @asynccontextmanager
        async def transport(*args):
            yield object(), "custom", "fixture"
        provider = AsyncMock(return_value=("General answer", 3, 2))
        with patch("app.services.ai_service.ai_client", transport), patch("app.services.ai_service.chat_with_article", provider):
            response = await client.post("/htmx/ai-chat", headers={"HX-Target": "rf-assistant-chat"},
                                         data={"message": "Question", "history": "[]"})
        assert "General answer" in response.text and "data-chat-error" not in response.text
        assert provider.call_args.args[1] is None

        # A setup blocker still wins over the article hint, with its settings link.
        prefs.ai_chat_enabled = False
        await db.flush()
        blocked = page(**await ai.assistant_chat_context(user, db, 18102))
        assert blocked.select_one("#assistant-chat fieldset").has_attr("disabled")
        assert blocked.select_one('#assistant-chat a[href="/settings/ai"]')
        assert "Enable chat" in blocked.get_text()

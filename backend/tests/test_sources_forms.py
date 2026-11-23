"""Sources form contracts; wave-one bases fall back only while T1 is absent."""
import json
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from bs4 import BeautifulSoup
from jinja2 import ChoiceLoader, DictLoader, FileSystemLoader
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.auth.dependencies import get_current_user, require_ai_enabled
from app.config import settings
from app.database import get_db
from app.main import app
from app.models.feed import Feed, Folder, UserFeed
from app.models.user import User
from app.rate_limit import limiter
from app.services.opml import MAX_UPLOAD_BYTES
from app.templating import templates
from app.utils.crypto import encrypt

SHEET = {"HX-Request": "true", "HX-Target": "rf-source-sheet-body"}
PAGE = '<html><title>Fixture</title><body><a href="/story">Story</a></body></html>'


@pytest.fixture(scope="session", autouse=True)
def source_bases():
    monkeypatch = pytest.MonkeyPatch()
    # Wave 1 shares interfaces, not file ownership. The real loader always wins;
    # assembled verification must also run T1's response tests on real templates.
    loader = ChoiceLoader([templates.env.loader, DictLoader({
        "sources/base.html": '{% extends "base.html" %}{% block content %}{% block sources_content %}{% endblock %}{% endblock %}',
        "sources/sheet_content.html": '{% block sources_content %}{% endblock %}',
    })])
    monkeypatch.setattr(templates.env, "loader", loader)
    templates.env.cache.clear()
    yield
    templates.env.cache.clear()
    monkeypatch.undo()


@pytest.fixture(autouse=True)
def no_rate_limit(monkeypatch):
    monkeypatch.setattr(limiter, "enabled", False)


@pytest_asyncio.fixture
async def forms():
    engine = create_async_engine(settings.database_url)
    async with engine.connect() as conn:
        tx = await conn.begin()
        async with AsyncSession(bind=conn, expire_on_commit=False,
                                join_transaction_mode="create_savepoint") as db:
            user = User(email=f"forms-{uuid4().hex}@test.invalid", password_hash="x", display_name="Forms")
            db.add(user)
            await db.flush()
            folder = Folder(user_id=user.id, name="Kept folder")
            db.add(folder)
            await db.commit()

            async def database():
                yield db

            app.dependency_overrides[get_db] = database
            app.dependency_overrides[get_current_user] = lambda: user
            try:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                            base_url="http://localhost") as client:
                    await client.get("/settings/opml")
                    client.headers["x-csrftoken"] = client.cookies["csrftoken"]
                    yield client, db, user, folder
            finally:
                app.dependency_overrides.clear()
        await tx.rollback()
    await engine.dispose()


def soup(response):
    assert response.status_code == 200, response.text[:300]
    return BeautifulSoup(response.text, "html.parser")


def representation(response, sheet):
    dom = soup(response)
    assert bool(dom.html) is not sheet
    assert response.headers["cache-control"] == "no-store"
    # main.py currently overwrites Vary with Cookie; wave 2 owns its fix.
    # Test the assigned route headers directly below, without patching middleware.
    return dom


@pytest.mark.parametrize("kind", ["rss", "scrape"])
@pytest.mark.parametrize("submitted_state", ["missing", "empty", "entered", "typed", "blank"])
def test_sources_edit_template_preserves_submitted_values(kind, submitted_state):
    from starlette.requests import Request

    feed = Feed(id=101, feed_url="https://example.com/saved", title="Original",
                feed_type=kind, is_private=True, subscriber_count=1,
                fetch_auth_pass_encrypted="stored-secret", fetch_interval_min=60,
                status="active", block_count=0,
                type_config={"article_links_selector": "a.saved"})
    uf = UserFeed(id=202, feed_id=101, user_id=1, folder_id=7, custom_title="Saved title")
    uf.feed = feed
    saved = {"custom_title": "Saved title", "folder_id": "7", "fetch_interval_min": "60",
             "feed_url": "https://example.com/saved", "article_links_selector": "a.saved"}
    entered = {"custom_title": 'Entered title <&"', "folder_id": "8", "fetch_interval_min": "90",
               "feed_url": "ftp://example.com/invalid", "article_links_selector": "["}
    request = Request({"type": "http", "method": "POST", "path": "/settings/feeds/202/edit",
                       "headers": [(b"hx-target", b"rf-source-sheet-body")]})
    context = {
        "request": request, "uf": uf,
        "folders": [Folder(id=7, name="Saved folder"), Folder(id=8, name="Entered folder")],
        "can_edit_url": True, "can_edit_interval": True, "can_edit_auth": True,
        "is_sole_subscriber": True, "auto_interval_min": 60,
        "url_error": "Invalid URL", "selector_error": "Invalid selector",
    }
    expected = saved
    if submitted_state != "missing":
        submitted = {}
        if submitted_state in {"entered", "typed"}:
            submitted = dict(entered)
            expected = entered
            if submitted_state == "typed":
                submitted.update(folder_id=8, fetch_interval_min=90)
        elif submitted_state == "blank":
            submitted = dict.fromkeys(saved, "")
            expected = submitted
        context["submitted"] = submitted

    # Render the actual form block and its real imports. No fallback base/sheet
    # templates: those belong to T1 and are absent in this isolated worktree.
    env = templates.env.overlay(loader=FileSystemLoader("app/templates"))
    template = env.get_template("settings/feed_edit.html")
    body = "".join(template.blocks["sources_content"](template.new_context(context)))
    form = BeautifulSoup(body, "html.parser").select_one("form.rf-sources-form")
    for name in ["custom_title", "feed_url"]:
        assert form.select_one(f'[name="{name}"]')["value"] == expected[name]
    for name in ["folder_id", "fetch_interval_min"]:
        select = form.select_one(f'[name="{name}"]')
        selected = select.select("option[selected]")
        assert len(selected) <= 1
        # With no explicit selection, browsers use the first (empty) option.
        assert (selected[0] if selected else select.option)["value"] == expected[name]
    if kind == "scrape":
        assert form.select_one('[name="article_links_selector"]')["value"] == expected["article_links_selector"]
    else:
        password = form.select_one('input[type="password"][name="fetch_auth_pass"]')
        assert password is not None and not password.get("value")
    assert "stored-secret" not in body


@pytest.mark.parametrize("saved,submitted,expected", [
    (True, None, True), (False, None, False), (None, None, True),
    (True, {}, True), (False, {}, False),
    (True, False, False), (False, True, True), (None, False, False),
])
def test_sources_edit_template_preserves_checkbox_choices(saved, submitted, expected):
    """Explicit False must override saved/default True; missing keys keep saved choices."""
    from starlette.requests import Request

    feed = Feed(id=101, feed_url="https://example.com/feed", title="Original",
                feed_type="rss", subscriber_count=1, status="active", block_count=0)
    uf = UserFeed(id=202, feed_id=101, user_id=1, extract_readable=bool(saved),
                  ai_summary_enabled=saved, translate=bool(saved))
    uf.feed = feed
    request = Request({"type": "http", "method": "GET", "path": "/settings/feeds/202/edit", "headers": []})
    context = {"request": request, "uf": uf, "folders": [], "auto_interval_min": 60,
               "ai_summary_global_enabled": True,
               "translation": {"blocker": None, "language": "French", "backfill_limit": 50}}
    names = ["extract_readable", "ai_summary_enabled", "translate"]
    if submitted is not None:
        context["submitted"] = dict.fromkeys(names, submitted) if isinstance(submitted, bool) else submitted
    env = templates.env.overlay(loader=FileSystemLoader("app/templates"))
    template = env.get_template("settings/feed_edit.html")
    body = "".join(template.blocks["sources_content"](template.new_context(context)))
    form = BeautifulSoup(body, "html.parser")
    for name in names:
        want = expected
        if saved is None and submitted is None and name != "ai_summary_enabled":
            want = False
        assert form.select_one(f'input[type="checkbox"][name="{name}"]').has_attr("checked") is want


async def test_sources_edit_forms_preserve_capabilities(forms):
    client, db, user, folder = forms
    from starlette.requests import Request
    # Render real edit markup with the existing permission values; T1 owns its
    # endpoint response plumbing and tests those permissions through the route.
    for kind, private, shared in [("rss", False, False), ("rss", True, False),
                                   ("rss", True, True), ("scrape", True, False),
                                   ("scrape", False, True)]:
        feed = Feed(id=101, feed_url="https://example.com/feed", title="Original",
                    feed_type=kind, is_private=private, subscriber_count=2 if shared else 1,
                    fetch_auth_user="reader", fetch_auth_pass_encrypted="stored-secret",
                    fetch_interval_min=90, status="active", block_count=0,
                    type_config={"article_links_selector": "a"})
        uf = UserFeed(id=202, feed_id=101, user_id=user.id, folder_id=folder.id,
                      custom_title="My title", extract_readable=True, translate=True)
        uf.feed = feed
        for target in ["rf-source-sheet-body", "content"]:
            request = Request({"type": "http", "method": "GET", "path": "/settings/feeds/202/edit",
                               "headers": [(b"hx-target", target.encode()), (b"hx-request", b"true")]})
            body = templates.TemplateResponse(request, "settings/feed_edit.html", {
                "uf": uf, "folders": [folder], "can_edit_url": not shared,
                "can_edit_interval": not shared, "can_edit_auth": not shared,
                "is_sole_subscriber": not shared, "ai_selector_available": True,
                "ai_summary_global_enabled": True, "auto_interval_min": 60,
                "translation": {"language": "French", "backfill_limit": 50},
            }).body.decode()
            dom = BeautifulSoup(body, "html.parser")
            assert bool(dom.html) == (target != "rf-source-sheet-body")
            form = dom.select_one("form.rf-sources-form")
            assert form and len(dom.select('form[action$="/edit"]')) == 1
            assert form["hx-target"] == ("#rf-source-sheet-body" if target == "rf-source-sheet-body" else "body")
            assert form["hx-swap"] == "innerHTML" and form.has_attr("data-rf-online-only")
            assert form.select_one('[name="custom_title"]')["value"] == "My title"
            assert form.select_one('[name="folder_id"] option[selected]')["value"] == str(folder.id)
            for field in ["extract_readable", "translate", "ai_summary_enabled"]:
                assert form.select_one(f'[name="{field}"]')
            assert "latest 50 unread" in form.get_text(" ", strip=True)
            assert bool(form.select_one('[name="feed_url"]')) is not shared
            password = form.select_one('[name="fetch_auth_pass"]')
            assert bool(password) == (kind == "rss" and not shared)
            if password:
                assert not password.get("value")
            assert "stored-secret" not in body
            assert len(dom.select("#selector-input")) == int(kind == "scrape" and not shared)
            for helper in form.select("button[hx-post]"):
                assert helper["hx-include"] == "closest form"
                assert helper["hx-swap"] == "innerHTML"
                assert helper.has_attr("data-rf-online-only")
            if kind == "scrape" and not shared:
                assert form.select_one('[name="feed_id"]')["value"] == "101"
                assert not form.select_one('[name="url"]')


async def test_sources_opml_sheet_roundtrip_and_limits(forms):
    client, db, user, _ = forms
    from starlette.requests import Request
    from app.routers.web.settings.opml import _opml_page
    request = Request({"type": "http", "method": "GET", "path": "/settings/opml", "headers": []})
    assert _opml_page(request, {}).headers["vary"] == "HX-Target"
    for headers in [SHEET, {"HX-Request": "true", "HX-Target": "body"}]:
        dom = representation(await client.get("/settings/opml", headers=headers), headers == SHEET)
        form = dom.select_one("#opml-import-form")
        assert form["hx-post"] == "/settings/opml/import"
        assert form["hx-encoding"] == "multipart/form-data"
        assert form["hx-push-url"] == "false"
        assert form["hx-swap"] == "innerHTML"
        assert dom.select_one('form[action$="/export"]')["hx-boost"] == "false"
    feed = Feed(feed_url="https://example.com/existing", title="Existing", subscriber_count=1)
    db.add(feed)
    await db.flush()
    db.add(UserFeed(user_id=user.id, feed_id=feed.id))
    await db.commit()
    xml = b'<opml version="2.0"><body><outline type="rss" xmlUrl="https://example.com/existing"/></body></opml>'
    response = await client.post("/settings/opml/import", headers=SHEET,
                                 data={"import_feeds": "true"}, files={"file": ("feeds.opml", xml)})
    dom = representation(response, True)
    assert "Import complete" in dom.text and "Skipped" in dom.text
    assert dom.select_one("tbody tr").select("td")[2].text.strip() == "1"
    assert json.loads(response.headers["HX-Trigger"])["rf:sourceschanged"] == {"kind": "opml"}
    assert "HX-Reswap" not in response.headers
    for raw, message in [(b"<broken", "Invalid"), (b"x" * (MAX_UPLOAD_BYTES + 1), "too large")]:
        response = await client.post("/settings/opml/import", headers=SHEET,
                                     data={"import_labels": "true"}, files={"file": ("bad.opml", raw)})
        dom = representation(response, True)
        assert message.lower() in dom.text.lower()
        assert "rf:sourceschanged" not in response.headers.get("HX-Trigger", "")
        assert dom.select_one('[name="import_labels"]').has_attr("checked")
        assert not dom.select_one('[name="import_feeds"]').has_attr("checked")
    response = await client.get("/settings/opml/export?include=head&include=feeds")
    assert 'attachment;' in response.headers["content-disposition"]
    assert "application/xml" in response.headers["content-type"]
    assert "https://example.com/existing" in response.text
    assert "xmlUrl" not in (await client.get("/settings/opml/export?include=head")).text


async def test_sources_scrape_setup_errors_and_success(forms, monkeypatch):
    client, db, user, folder = forms
    from starlette.requests import Request
    from app.routers.web.settings.scrape import _scrape_page
    request = Request({"type": "http", "method": "GET", "path": "/settings/feeds/scrape-setup", "headers": []})
    assert _scrape_page(request, {"folders": []}).headers["vary"] == "HX-Target"
    fetch = AsyncMock(return_value=PAGE)
    monkeypatch.setattr("app.routers.web.settings.scrape.fetch_page_html", fetch)
    monkeypatch.setattr("app.fetcher.scrape.fetch_page_html", fetch)
    async def validate(url, **kwargs):
        if "127.0.0.1" in url:
            raise ValueError("URL resolves to a disallowed address")
    monkeypatch.setattr("app.services.feed.async_validate_feed_url", validate)
    def discard(coro, **kwargs):
        coro.close()
    monkeypatch.setattr("app.services.feed.spawn_background", discard)
    for headers in [SHEET, {"HX-Request": "true"}]:
        response = await client.get("/settings/feeds/scrape-setup?url=https://example.com", headers=headers)
        dom = representation(response, headers == SHEET)
        form = dom.select_one("form.rf-sources-form")
        assert form["hx-swap"] == "innerHTML"
        assert len(dom.select("#selector-input")) == 1
    response = await client.get("/settings/feeds/scrape-setup", headers=SHEET)
    assert "URL" in representation(response, True).text
    assert (await client.get("/settings/feeds/scrape-setup")).status_code == 303
    data = {"url": "https://example.com", "selector": "[", "title": "Kept title",
            "folder_id": str(folder.id), "fetch_interval_min": "90"}
    for url, selector, error in [("", "a", "URL"), ("https://example.com", "[", "selector"),
                                  ("http://127.0.0.1", "a", "disallowed")]:
        response = await client.post("/settings/feeds/scrape", headers=SHEET,
                                     data={**data, "url": url, "selector": selector})
        dom = representation(response, True)
        assert error.lower() in dom.text.lower()
        assert dom.select_one('[name="title"]')["value"] == "Kept title"
        assert dom.select_one('[name="selector"]')["value"] == selector
        for name, value in [("folder_id", str(folder.id)), ("fetch_interval_min", "90")]:
            assert dom.select_one(f'[name="{name}"] option[selected]')["value"] == value
        assert "HX-Trigger" not in response.headers
    fetch.side_effect = ValueError("captcha challenge")
    response = await client.post("/settings/feeds/scrape", headers=SHEET, data={**data, "selector": "a"})
    assert "captcha" in representation(response, True).text
    fetch.side_effect = None
    for headers, suffix in [(SHEET, "sheet"), ({}, "page"), ({"HX-Request": "true"}, "boost")]:
        response = await client.post("/settings/feeds/scrape", headers=headers,
                                     data={**data, "url": f"https://example.com/{suffix}", "selector": "a"})
        if headers == SHEET:
            assert response.status_code == 200 and not response.content
            assert response.headers["HX-Reswap"] == "none"
            assert json.loads(response.headers["HX-Trigger"])["rf:sourceschanged"] == {"kind": "scrape"}
        elif headers:
            assert response.status_code == 200
            assert response.headers["HX-Redirect"].startswith("/settings/feeds")
            assert "HX-Trigger" not in response.headers
        else:
            assert response.status_code == 303 and response.headers["location"].startswith("/settings/feeds")
        saved = await db.scalar(select(Feed).where(Feed.feed_url == f"https://example.com/{suffix}"))
        assert saved.title == "Kept title" and saved.fetch_interval_min == 90
        uf = await db.scalar(select(UserFeed).where(UserFeed.feed_id == saved.id))
        assert uf.folder_id == folder.id


async def test_sources_scrape_helpers_keep_targets_and_auth(forms, monkeypatch):
    client, db, user, folder = forms
    feed = Feed(feed_url="https://example.com/private", title="Private", feed_type="scrape",
                is_private=True, fetch_auth_user="reader", fetch_auth_pass_encrypted=encrypt("hidden-password"),
                subscriber_count=1, type_config={"article_links_selector": "a"})
    db.add(feed)
    await db.flush()
    db.add(UserFeed(user_id=user.id, feed_id=feed.id))
    await db.commit()
    fetch = AsyncMock(return_value=PAGE)
    monkeypatch.setattr("app.routers.web.settings.scrape.fetch_page_html", fetch)
    for context in [{"url": "https://example.com/setup"}, {"feed_id": str(feed.id)}]:
        for endpoint in ["scrape-preview", "scrape-show-prompt"]:
            response = await client.post(f"/settings/feeds/{endpoint}", data={**context, "selector": "a"})
            dom = soup(response)
            assert not dom.html and "hidden-password" not in response.text
            if "feed_id" in context:
                assert fetch.call_args.kwargs["auth"] == ("reader", "hidden-password")
        for endpoint in ["scrape-preview", "scrape-show-prompt"]:
            fetch.reset_mock()
            response = await client.post(f"/settings/feeds/{endpoint}", data={"feed_id": "999999", "selector": "a"})
            assert "required" in response.text
            fetch.assert_not_awaited()
    app.dependency_overrides[require_ai_enabled] = lambda: None
    @asynccontextmanager
    async def configured(*args):
        yield object(), "openai", "fixture-model"
    monkeypatch.setattr("app.routers.web.settings.scrape.ai_client", configured)
    generate = AsyncMock(return_value=("a.story", 10, 5))
    monkeypatch.setattr("app.routers.web.settings.scrape.generate_css_selector_from_sample", generate)
    response = await client.post("/settings/feeds/scrape-ai-selector", data={"feed_id": str(feed.id)})
    dom = soup(response)
    assert json.loads(response.headers["HX-Trigger"])["selectorGenerated"]["selector"] == "a.story"
    button = dom.select_one("button[hx-post]")
    assert button["hx-include"] == "closest form" and button["hx-swap"] == "innerHTML"
    assert button["hx-target"] == "#ai-refinement"
    assert dom.select_one("#conversation-history")["hx-swap-oob"] == "true"
    assert "hidden-password" not in response.text
    history = dom.select_one("#conversation-history")["value"]
    response = await client.post("/settings/feeds/scrape-ai-selector", data={
        "feed_id": str(feed.id), "conversation_history": history,
        "html_sample": PAGE, "refinement": "Only story links",
    })
    assert generate.call_args.args[2][-1]["feedback"] == "Only story links"
    assert soup(response).select_one("#scrape-gen-prompt")
    generate.side_effect = ValueError("provider unavailable")
    response = await client.post("/settings/feeds/scrape-ai-selector", data={
        "url": "https://example.com/setup", "html_sample": PAGE,
    })
    assert soup(response).select_one("[role=alert]")
    assert soup(response).select_one('[data-copy-from="scrape-gen-prompt"]')
    assert "HX-Trigger" not in response.headers
    @asynccontextmanager
    async def missing(*args):
        yield None, None, None
    monkeypatch.setattr("app.routers.web.settings.scrape.ai_client", missing)
    generate.reset_mock()
    response = await client.post("/settings/feeds/scrape-ai-selector", data={"feed_id": str(feed.id)})
    assert "not configured" in response.text
    generate.assert_not_awaited()
    response = await client.get("/settings/feeds/scrape-setup?url=https://example.com", headers=SHEET)
    dom = soup(response)
    assert dom.select_one('[name="selector"]')
    assert dom.select_one('button[hx-post$="scrape-show-prompt"]')

"""Moved pages: an old URL answers 308 to its new home; its non-GET methods stay
served from the old path as aliases of the new route until `remove_aliases_in`.

The helper is proven on a throwaway app and the Sources production routes
are exercised against isolated, rolled-back database fixtures.
"""
from contextlib import asynccontextmanager
import re

import httpx
from bs4 import BeautifulSoup
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from app.auth.dependencies import get_current_user
from app.config import settings
from app.database import get_db
from app.main import app as production_app
from app.models.feed import Feed, Folder, UserFeed
from app.models.user import User, UserSettings
from app.rate_limit import limiter
from app.templating import templates
from app.utils.request_context import current_viewer
from tests.test_sources_add import outbound, RSS

import pytest
from fastapi import FastAPI, Form
from fastapi.responses import PlainTextResponse
from fastapi.testclient import TestClient
from starlette.routing import Route

from app.routers.web.moved_pages import MOVED_PAGES, MovedPage, register_moved_pages


def _throwaway_app() -> FastAPI:
    app = FastAPI()

    @app.get("/new", response_class=PlainTextResponse)
    def new_get():
        return "new page"

    @app.post("/new", response_class=PlainTextResponse)
    def new_post(word: str = Form(...)):
        return f"echo:{word}"

    return app


def test_get_redirects_308_no_store_and_target_is_200():
    app = _throwaway_app()
    register_moved_pages(app, [MovedPage("/old", "/new")])
    client = TestClient(app)

    r = client.get("/old?x=1", follow_redirects=False)
    assert r.status_code == 308
    assert r.headers["location"] == "/new?x=1"
    assert r.headers["cache-control"] == "no-store"

    followed = client.get("/old?x=1")
    assert followed.status_code == 200
    assert followed.text == "new page"


def test_post_alias_calls_same_handler():
    app = _throwaway_app()
    register_moved_pages(app, [MovedPage("/old", "/new", methods=("GET", "POST"))])
    client = TestClient(app)

    direct = client.post("/new", data={"word": "hi"})
    aliased = client.post("/old", data={"word": "hi"}, follow_redirects=False)
    assert aliased.status_code == direct.status_code == 200
    assert aliased.text == direct.text == "echo:hi"
    # The form field is still required on the alias: same handler, same validation.
    assert client.post("/old", data={}).status_code == 422


def test_missing_target_raises():
    app = _throwaway_app()
    with pytest.raises(RuntimeError, match="/nowhere"):
        register_moved_pages(app, [MovedPage("/old", "/nowhere")])
    with pytest.raises(RuntimeError, match="PUT"):
        register_moved_pages(app, [MovedPage("/old2", "/new", methods=("GET", "PUT"))])


def test_production_table_targets_exist():
    from app.main import app

    served = {}
    for route in app.router.routes:
        if isinstance(route, Route):
            served.setdefault(route.path, set()).update(route.methods or ())
    for page in MOVED_PAGES:
        assert "GET" in served.get(page.new, set()), page
        for method in page.methods:
            assert method in served.get(page.new, set()), (page, method)
            assert method in served.get(page.old, set()), (page, method)


# Independent expected routes: an accidentally empty production table must fail.
SOURCE_MOVES = [
    ("/settings/feeds", "/sources", ("GET", "POST")),
    ("/settings/feeds/add", "/sources/add", ("GET",)),
    ("/settings/feeds-list", "/sources/feeds-list", ("GET",)),
    ("/settings/feeds/{user_feed_id}/edit", "/sources/feeds/{user_feed_id}/edit", ("GET", "POST")),
    ("/settings/feeds/scrape-setup", "/sources/scrape", ("GET",)),
    ("/settings/folders/{folder_id}/rename-form", "/sources/folders/{folder_id}/rename-form", ("GET",)),
    ("/settings/opml", "/sources/opml", ("GET",)),
    ("/settings/opml/export", "/sources/opml/export", ("GET",)),
]
SOURCE_ACTIONS = [
    ("/settings/feeds", "/sources", "POST", {"url": "https://example.com/new.xml"}),
    ("/settings/feeds/17/edit", "/sources/feeds/17/edit", "POST", {"custom_title": "Renamed"}),
    ("/settings/feeds/test", "/sources/test", "POST", {"url": "https://example.com/new.xml"}),
    ("/settings/feeds/17", "/sources/feeds/17", "DELETE", {}),
    ("/settings/folders", "/sources/folders", "POST", {"name": "New folder"}),
    ("/settings/folders/19", "/sources/folders/19", "DELETE", {}),
    ("/settings/folders/19/rename", "/sources/folders/19/rename", "POST", {"name": "Renamed"}),
    ("/settings/folders/19/move", "/sources/folders/19/move", "POST", {"dir": "down"}),
    ("/settings/folder-order", "/sources/folder-order", "POST", {"mode": "name"}),
    ("/settings/folder-order/reset", "/sources/folder-order/reset", "POST", {}),
    ("/settings/opml/import", "/sources/opml/import", "POST", {"import_feeds": "true"}),
    ("/settings/feeds/scrape-preview", "/sources/scrape-preview", "POST", {"url": "https://example.com/page", "selector": "a"}),
    ("/settings/feeds/scrape-ai-selector", "/sources/scrape-ai-selector", "POST", {}),
    ("/settings/feeds/scrape-show-prompt", "/sources/scrape-show-prompt", "POST", {"url": "https://example.com/page"}),
    ("/settings/feeds/scrape", "/sources/scrape", "POST", {"url": "https://example.com/page", "selector": "a", "title": "Scraped"}),
]




@asynccontextmanager
async def source_fixture():
    """Each paired request starts with identical owned IDs, then rolls back commits."""
    engine = create_async_engine(settings.database_url)
    async with engine.connect() as conn:
        tx = await conn.begin()
        async with AsyncSession(conn, expire_on_commit=False, join_transaction_mode="create_savepoint") as db:
            user = User(id=17001, email="routing@test.invalid", password_hash="x", display_name="Reader")
            db.add_all([user, User(id=17002, email="other@test.invalid", password_hash="x", display_name="Other"),
                        Feed(id=18, feed_url="https://example.com/feed.xml", title="Existing", subscriber_count=1)])
            await db.flush()
            db.add_all([Folder(id=19, user_id=user.id, name="First", position=0),
                        Folder(id=20, user_id=user.id, name="Second", position=1),
                        Folder(id=21, user_id=17002, name="Other"),
                        UserSettings(user_id=user.id, folder_order="custom", folders_arranged=True)])
            await db.flush()
            db.add_all([UserFeed(id=17, user_id=user.id, feed_id=18, folder_id=19),
                        UserFeed(id=22, user_id=17002, feed_id=18, folder_id=21)])
            await db.commit()
            async def database():
                yield db
            async def viewer():
                current_viewer.set((user.id, user.display_name))
                return user
            production_app.dependency_overrides[get_db] = database
            production_app.dependency_overrides[get_current_user] = viewer
            old_limit = limiter.enabled
            limiter.enabled = False
            try:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=production_app), base_url="http://localhost") as client:
                    await client.get("/login")
                    client.headers["x-csrftoken"] = client.cookies["csrftoken"]
                    yield client, db
            finally:
                limiter.enabled = old_limit
                production_app.dependency_overrides.clear()
        await tx.rollback()
    await engine.dispose()


def source_transport(request):
    if request.url.path.endswith(".xml"):
        return httpx.Response(200, text=RSS, headers={"content-type": "application/rss+xml"})
    return httpx.Response(200, text='<html><title>Page</title><a href="/story">Story</a></html>')


async def test_sources_moved_get_matrix():
    """Catches absent moves, literal route braces, lost query bytes and partial registration."""
    assert {(p.old, p.new, p.methods) for p in MOVED_PAGES} >= set(SOURCE_MOVES)
    async with source_fixture() as (client, _):
        with outbound(source_transport):
            for old, new, _ in SOURCE_MOVES:
                old = old.format(user_feed_id=17, folder_id=19)
                new = new.format(user_feed_id=17, folder_id=19)
                query = "?x=a%2Bb&x=2&url=https%3A%2F%2Fexample.com%2Fpage"
                response = await client.get(old + query)
                assert response.status_code == 308, old
                assert response.headers["cache-control"] == "no-store"
                assert response.headers["location"] == new + query
                target = await client.get(response.headers["location"])
                assert target.status_code == 200, new
                if new.endswith("/export"):
                    assert "application/xml" in target.headers["content-type"]
    synthetic = _throwaway_app()
    @synthetic.get("/new/{new_id}")
    def parameterized(new_id: str):
        return new_id
    before = list(synthetic.routes)
    with pytest.raises(RuntimeError, match="parameter"):
        register_moved_pages(synthetic, [MovedPage("/valid", "/new"), MovedPage("/old/{old_id}", "/new/{new_id}")])
    assert synthetic.routes == before
    @synthetic.get("/converted/{item_id:int}")
    def converted(item_id: int):
        return item_id
    register_moved_pages(synthetic, [MovedPage("/legacy/{item_id:int}", "/converted/{item_id:int}")])
    assert TestClient(synthetic).get("/legacy/17?x=a%2Bb", follow_redirects=False).headers["location"] == "/converted/17?x=a%2Bb"
    with pytest.raises(RuntimeError, match="still served"):
        register_moved_pages(synthetic, [MovedPage("/new", "/new")])


async def test_sources_non_get_alias_matrix():
    """A stale form runs the same validated handler and has the same persisted effect."""
    def route(path, method):
        for candidate in production_app.routes:
            if isinstance(candidate, Route) and method in candidate.methods and candidate.path_regex.fullmatch(path):
                return candidate
        pytest.fail(f"Missing {method} {path}")
    for old, new, method, data in SOURCE_ACTIONS:
        a, b = route(old, method), route(new, method)
        assert a.endpoint is b.endpoint
        assert a.dependencies == b.dependencies
        for invalid in [False, True]:
            results = []
            for path in [old, new]:
                async with source_fixture() as (client, db):
                    if invalid:
                        path = path.replace("/17", "/22").replace("/19", "/21")
                    payload = {} if invalid else data
                    options = {"data": payload, "headers": {"HX-Request": "true", "HX-Target": "rf-source-sheet-body"}}
                    if path.endswith("/opml/import"):
                        xml = b"<broken" if invalid else b'<opml version="2.0"><body><outline type="rss" xmlUrl="https://example.com/feed.xml"/></body></opml>'
                        options["files"] = {"file": ("feeds.opml", xml)}
                    with outbound(source_transport):
                        response = await client.request(method, path, **options)
                    assert response.status_code != 308
                    assert response.status_code < 500
                    # IDs allocated by sequences differ across rolled-back runs; compare domain state.
                    state = (
                        (await db.execute(select(Folder.user_id, Folder.name, Folder.position).order_by(Folder.user_id, Folder.name))).all(),
                        (await db.execute(select(UserFeed.user_id, UserFeed.custom_title, UserFeed.extract_readable).order_by(UserFeed.user_id, UserFeed.custom_title))).all(),
                        (await db.execute(select(UserSettings.folder_order, UserSettings.folders_arranged))).all(),
                    )
                    body = re.sub(r'(?:nonce|\bid)="[^"]*"', '', response.text)
                    body = re.sub(r'((?:folder-(?:menu-|header-)?|folders/)\d+)',
                                  lambda match: re.sub(r'\d+$', 'ID', match[0]), body)
                    body = re.sub(r'(?<=value=")\d+', 'ID', body)
                    results.append((response.status_code, body, response.headers.get("HX-Trigger"), response.headers.get("HX-Redirect"), state))
            assert results[0] == results[1], (method, old, invalid)


@pytest.mark.parametrize("path", ["/sources/add", "/sources/opml"])
async def test_sources_standalone_return_link_and_sheet_insertion(path):
    """Standalone forms retain list navigation; sheets do not duplicate its shell."""
    async with source_fixture() as (client, _):
        response = await client.get("/sources")
        assert response.status_code == 200
        page = BeautifulSoup(response.text, "html.parser")

        def assert_single_sources_shell(dom):
            assert len(dom.select("#sources-heading")) == 1
            heading = dom.select_one("h1#sources-heading")
            assert heading is not None and heading["tabindex"] == "-1"
            assert len(dom.select("header.rf-sources-toolbar")) == 1
            assert len(dom.select('nav[aria-label="Sources navigation"]')) == 1
            for href in ["/sources/add", "/sources/opml"]:
                assert len(dom.select(f'a[data-rf-source-sheet][href="{href}"]')) == 1

        assert_single_sources_shell(page)
        response = await client.get(path)
        assert response.status_code == 200
        standalone = BeautifulSoup(response.text, "html.parser")
        assert standalone.html is not None
        assert_single_sources_shell(standalone)
        link = standalone.select_one('a[href="/sources"]')
        assert link is not None and link.get_text(" ", strip=True) == "Sources"
        assert not link.has_attr("data-rf-source-sheet")

        response = await client.get(path, headers={
            "HX-Request": "true", "HX-Target": "rf-source-sheet-body",
        })
        assert response.status_code == 200
        sheet = BeautifulSoup(response.text, "html.parser")
        assert sheet.html is None
        assert not sheet.select('#sources-heading, header.rf-sources-toolbar, nav[aria-label="Sources navigation"]')
        assert sheet.select_one("form") is not None
        body = page.select_one("#rf-source-sheet-body")
        assert body is not None
        body.clear()
        body.append(sheet)
        assert_single_sources_shell(page)


async def test_sources_redirect_targets_and_navigation():
    """Catches stale success/entry URLs and full-page vs sheet representation mistakes."""
    for old, new, data in [
        ("/settings/feeds", "/sources", {"url": "https://example.com/new.xml"}),
        ("/settings/feeds/17/edit", "/sources/feeds/17/edit", {"custom_title": "Renamed"}),
        ("/settings/feeds/scrape", "/sources/scrape", {"url": "https://example.com/page", "selector": "a"}),
    ]:
        for path in [old, new]:
            for headers in [{}, {"HX-Request": "true"}]:
                async with source_fixture() as (client, _):
                    with outbound(source_transport):
                        response = await client.post(path, data=data, headers=headers)
                    target = response.headers.get("HX-Redirect") or response.headers.get("location")
                    assert target and (target == "/sources" or target.startswith("/sources?added=")), (path, response.text)
    async with source_fixture() as (client, db):
        assert (await client.get("/sources/scrape")).headers["location"] == "/sources"
        for path in ["/settings/feeds/add", "/sources/add"]:
            for sheet in [False, True]:
                response = await client.get(path, follow_redirects=True, headers={"HX-Request": "true", "HX-Target": "rf-source-sheet-body" if sheet else "body"})
                assert response.status_code == 200
                assert ("<html" in response.text) is not sheet
        from app.models.feed import UserFeed
        await db.delete(await db.get(UserFeed, 17))
        await db.commit()
        assert (await client.get("/settings")).headers["location"] == "/sources"
    for choice, target in [("import", "/sources/opml"), ("manual", "/sources/add")]:
        async with source_fixture() as (client, _):
            assert (await client.post("/welcome/feeds", data={"choice": choice})).headers["HX-Redirect"] == target
    from starlette.requests import Request
    from tests.test_offline_drift import SIDEBAR_COUNTS
    request = Request({"type": "http", "method": "GET", "path": "/app", "headers": []})
    for template in ["app/partials/sidebar.html", "app/partials/mobile_bars.html", "app/partials/palette.html", "app/partials/user_menu_items.html", "settings/base.html"]:
        dom = BeautifulSoup(templates.env.get_template(template).render(request=request, user=User(display_name="Reader", role="user"), user_feeds=[], folders=[], active="feeds", **SIDEBAR_COUNTS), "html.parser")
        links = dom.select('a[href^="/sources"]')
        assert links, template
        assert not dom.select('a[href^="/settings/feeds"], a[href^="/settings/opml"]'), template
        for link in links:
            assert link.has_attr("data-rf-online-only"), (template, link)
            if link["href"] == "/sources/add":
                assert link.has_attr("data-rf-source-sheet"), template

    # Shared macro callers without attrs retain ordinary links in both layouts.
    nav = templates.env.get_template("partials/side_nav.html").module.side_nav([
        {"label": "Profile", "url": "/settings/profile", "active": True},
    ])
    links = BeautifulSoup(nav, "html.parser").select('a[href="/settings/profile"]')
    assert len(links) == 2
    assert all(link.text == "Profile" and not link.has_attr("data-rf-online-only") for link in links)


async def test_assistant_moved_get_and_section():
    """A bookmark must retain query bytes and select Catch me up, never chat."""
    from tests.test_assistant_chat import chat_fixture
    assert MovedPage('/app/catch-me-up', '/assistant/catch-up') in MOVED_PAGES
    async with chat_fixture() as (client, db, user, prefs, article, admin):
        query = '?x=a%2Bb&x=%2F&section=chat'
        moved = await client.get('/app/catch-me-up' + query)
        assert moved.status_code == 308
        assert moved.headers['cache-control'] == 'no-store'
        assert moved.headers['location'] == '/assistant/catch-up' + query
        for path, section in [
            (moved.headers['location'], 'catch-up'), ('/assistant', 'chat'),
            ('/assistant?section=profile', 'profile'), ('/assistant?section=invalid', 'chat'),
            ('/assistant?article_id=18101', 'chat'),
        ]:
            response = await client.get(path)
            assert response.status_code == 200, response.text
            assert response.headers['cache-control'] == 'no-store'
            page = BeautifulSoup(response.text, 'html.parser')
            assert page.select_one('#assistant-main')['data-section'] == section
            selected = page.select_one('#assistant-' + section)
            assert not selected.has_attr('hidden')
            assert not any(p.has_attr('hidden') for p in selected.parents)
            if 'article_id' in path:
                assert page.select_one('#general-chat-article-id')['value'] == str(article.id)
                assert article.title in page.get_text()
        prefs.ai_quality_provider = prefs.ai_quality_model = None
        await db.flush()
        response = await client.get('/assistant')
        assert response.status_code == 200
        page = BeautifulSoup(response.text, 'html.parser')
        assert page.select_one('fieldset[disabled]')
        assert page.select_one('a[href="/settings/ai"]')
        production_app.dependency_overrides.pop(get_current_user)
        assert (await client.get('/assistant')).status_code in (302, 303, 401)


async def test_assistant_non_get_compatibility():
    """Registration must retain old action identity, access checks and narrow saves."""
    from app.routers.web.app import ai as chat, catchup
    from app.routers.web.settings import ai as profile
    from app.models.user import UserCatchupConfig
    from tests.test_assistant_chat import chat_fixture

    def route(path, method):
        found = [r for r in production_app.routes if getattr(r, 'path', None) == path and method in getattr(r, 'methods', ())]
        assert len(found) == 1, (method, path)
        return found[0]

    actions = [
        ('/htmx/ai-chat', 'POST', chat.htmx_general_ai_chat),
        ('/htmx/ai-chat', 'DELETE', chat.htmx_general_ai_chat_clear),
        ('/htmx/articles/{article_id}/ai-chat', 'POST', chat.htmx_ai_chat),
        ('/htmx/articles/{article_id}/ai-chat', 'DELETE', chat.htmx_ai_chat_clear),
        ('/htmx/catch-me-up/estimate', 'GET', catchup.htmx_catchup_estimate),
        ('/htmx/catch-me-up/generate', 'POST', catchup.htmx_catchup_generate),
        ('/htmx/catch-me-up/jobs/{job_id}', 'GET', catchup.htmx_catchup_job),
        ('/htmx/catchup-configs', 'POST', catchup.htmx_catchup_config_create),
        ('/htmx/catchup-configs/{config_id}', 'PUT', catchup.htmx_catchup_config_update),
        ('/htmx/catchup-configs/{config_id}', 'DELETE', catchup.htmx_catchup_config_delete),
        ('/htmx/catchup-configs/{config_id}/rename', 'PUT', catchup.htmx_catchup_config_rename),
        ('/htmx/catchup-configs/{config_id}/briefing', 'GET', catchup.htmx_briefing_modal_get),
        ('/htmx/catchup-configs/{config_id}/briefing', 'PUT', catchup.htmx_briefing_modal_save),
        ('/htmx/catchup-configs/{config_id}/briefing/test', 'POST', catchup.htmx_briefing_test_send),
    ]
    for path, method, endpoint in actions:
        assert route(path, method).endpoint is endpoint
    for source in [chat.router, catchup.router]:
        for r in source.routes:
            if r.path.startswith('/htmx/'):
                for method in r.methods:
                    actual = route(r.path, method)
                    assert actual.endpoint is r.endpoint
                    assert [d.call for d in actual.dependant.dependencies] == [d.call for d in r.dependant.dependencies]
    assert route('/settings/ai/preferences', 'POST').endpoint is profile.settings_ai_preferences_save
    assert route('/assistant/profile', 'POST').endpoint is profile.assistant_profile_save
    assert route('/settings/ai', 'GET').endpoint is profile.settings_ai
    for old, new in [('/settings/ai/generate-preference', '/assistant/profile/generate'),
                     ('/settings/ai/revert-preference', '/assistant/profile/revert')]:
        a, b = route(old, 'POST'), route(new, 'POST')
        assert a.endpoint is b.endpoint
        assert [d.call for d in a.dependant.dependencies] == [d.call for d in b.dependant.dependencies]
        for previous in [None, 'Previous interests']:
            results = []
            for path in [old, new]:
                async with chat_fixture() as (client, db, user, prefs, article, admin):
                    prefs.ai_quality_provider = prefs.ai_quality_model = None
                    prefs.ai_preference_text = 'Current interests'
                    prefs.ai_preference_prev_text = previous
                    await db.flush()
                    response = await client.post(path, data={'user_id': '18102'})
                    await db.refresh(prefs)
                    assert response.status_code == 200
                    results.append((response.status_code, response.text, response.headers.get('HX-Trigger'),
                                    prefs.ai_preference_text, prefs.ai_preference_prev_text))
            assert results[0] == results[1]
    async with chat_fixture() as (client, db, user, prefs, article, admin):
        prefs.ai_preference_text = 'Retained interests'
        db.add(UserCatchupConfig(id=18102, user_id=18102, name='PRIVATE CONFIG'))
        await db.flush()
        for config_id in [18102, 999999]:
            for method, suffix, data in [('PUT', '', {'name': 'Renamed'}), ('PUT', '/rename', {'name': 'Renamed'}),
                                         ('PUT', '/briefing', {}), ('POST', '/briefing/test', {}),
                                         ('DELETE', '', {})]:
                response = await client.request(method, f'/htmx/catchup-configs/{config_id}{suffix}', data=data)
                assert response.status_code == (200 if method == 'DELETE' else 404), response.text
                assert 'PRIVATE CONFIG' not in response.text
                assert await db.get(UserCatchupConfig, 18102) is not None
        before = prefs.ai_quality_model
        invalid = await client.post('/assistant/profile', data={'ai_preference_text': 'short', 'ai_quality_model': 'injected'})
        assert invalid.status_code == 200 and 'HX-Trigger' not in invalid.headers
        await db.refresh(prefs)
        assert prefs.ai_preference_text == 'Retained interests' and prefs.ai_quality_model == before
        await client.post('/settings/ai/preferences', data={'ai_quality_provider': 'openai', 'ai_quality_model': 'changed'})
        await db.refresh(prefs)
        assert prefs.ai_quality_model == 'changed' and prefs.ai_preference_text == 'Retained interests'
        production_app.dependency_overrides.pop(get_current_user)
        for path in ['/assistant/profile', '/assistant/profile/generate', '/assistant/profile/revert',
                     '/settings/ai/generate-preference', '/settings/ai/revert-preference']:
            assert (await client.post(path)).status_code in (302, 303, 401)


async def test_assistant_navigation_and_real_composition():
    """Real includes and unconditional entry links must survive missing AI setup."""
    from tests.test_assistant_chat import chat_fixture
    from starlette.requests import Request
    from tests.test_offline_drift import SIDEBAR_COUNTS
    async with chat_fixture() as (client, db, user, prefs, article, admin):
        for headers in [{}, {'HX-Request': 'true', 'HX-Boosted': 'true', 'HX-Target': 'body'}]:
            response = await client.get('/assistant?section=profile', headers=headers)
            assert response.status_code == 200
            page = BeautifulSoup(response.text, 'html.parser')
            assert page.html is not None
            for selector in ['#assistant-main', '#assistant-chat', '#assistant-catch-up', '#assistant-profile',
                             '#ai_preference_text', '#catchup-form', '#catchup-configs-list-wrapper',
                             '#rf-briefing-sheet', '#rf-assistant-chat']:
                assert len(page.select(selector)) == 1, selector
            for script in ['app.js', 'ui/assistant.js', 'catchup.js', 'scope-selector.js', 'label-selector.js']:
                assert len(page.select(f'script[src^="/static/js/{script}?"]')) == 1, script
        for article_id in [18102, 999999]:
            response = await client.get(f'/assistant?article_id={article_id}')
            assert response.status_code == 200
            page = BeautifulSoup(response.text, 'html.parser')
            assert page.select_one('#assistant-chat .alert[role="status"]') and page.select_one('fieldset[disabled]')
            assert 'This article is unavailable' in page.get_text()
            assert 'PRIVATE TITLE' not in response.text and 'PRIVATE BODY' not in response.text
            assert not page.select_one('#assistant-chat-scope option[value="article"]')
        settings_page = BeautifulSoup((await client.get('/settings/ai')).text, 'html.parser')
        assert settings_page.select_one('a[href="/assistant?section=profile#assistant-profile"]')
        request = Request({'type': 'http', 'method': 'GET', 'path': '/app', 'headers': []})
        for available in [False, True]:
            for template in ['sidebar', 'mobile_bars', 'palette']:
                page = BeautifulSoup(templates.env.get_template(f'app/partials/{template}.html').render(
                    request=request, user=user, user_feeds=[], folders=[], chat_available=available,
                    catchup_available=available, **SIDEBAR_COUNTS), 'html.parser')
                links = page.select('a[href="/assistant"][data-rf-online-only]')
                assert len(links) == (2 if template == 'sidebar' else 1), template
                assert not page.select('a[href="/app/catch-me-up"]')
                if template == 'mobile_bars':
                    assert links[0]['id'] == 'mobile-bottom-chat-btn'
                if template == 'sidebar' and available:
                    assert page.select_one('#sidebar-chat-btn')

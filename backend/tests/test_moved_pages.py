"""Moved pages: an old URL answers 308 to its new home on GET. The non-GET aliases
were removed in s8: a stale tab posting to an old path is told the page is out of
date, and nothing runs.

The helper is proven on a throwaway app and the Sources production routes
are exercised against isolated, rolled-back database fixtures.
"""
from contextlib import asynccontextmanager
import json

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


def test_post_to_old_path_is_not_served():
    """The helper registers GET only: a POST to the old path never reaches the handler."""
    app = _throwaway_app()
    register_moved_pages(app, [MovedPage("/old", "/new")])
    client = TestClient(app)

    assert client.post("/new", data={"word": "hi"}).text == "echo:hi"
    stale = client.post("/old", data={"word": "hi"}, follow_redirects=False)
    assert stale.status_code == 405
    assert "echo" not in stale.text
    assert client.get("/old", follow_redirects=False).status_code == 308


def test_missing_target_raises():
    app = _throwaway_app()
    with pytest.raises(RuntimeError, match="/nowhere"):
        register_moved_pages(app, [MovedPage("/old", "/nowhere")])


def test_production_table_targets_exist():
    from app.main import app

    served = {}
    for route in app.router.routes:
        if isinstance(route, Route):
            served.setdefault(route.path, set()).update(route.methods or ())
    moved = {route.path: route.methods for route in app.router.routes
             if isinstance(route, Route) and (route.name or "").startswith("moved:")}
    assert not [route.name for route in app.router.routes if (getattr(route, "name", "") or "").startswith("moved-alias")]
    for page in MOVED_PAGES:
        assert "GET" in served.get(page.new, set()), page
        assert moved[page.old] == {"GET"}, page


STALE_PAGE = "This page is out of date. Reload it and try again."


def assert_stale_toast(response, status=None):
    assert response.status_code in ((status,) if status else (404, 405)), response.status_code
    assert json.loads(response.headers["HX-Trigger"]) == {"showToast": {"msg": STALE_PAGE, "type": "error"}}


# Independent expected routes: an accidentally empty production table must fail.
SOURCE_MOVES = [
    ("/settings/feeds", "/sources"),
    ("/settings/feeds/add", "/sources/add"),
    ("/settings/feeds-list", "/sources/feeds-list"),
    ("/settings/feeds/{user_feed_id}/edit", "/sources/feeds/{user_feed_id}/edit"),
    ("/settings/feeds/scrape-setup", "/sources/scrape"),
    ("/settings/folders/{folder_id}/rename-form", "/sources/folders/{folder_id}/rename-form"),
    ("/settings/opml", "/sources/opml"),
    ("/settings/opml/export", "/sources/opml/export"),
]
# The non-GET paths that were aliases until s8, with the canonical path that stays.
SOURCE_ACTIONS = [
    ("/settings/feeds", "/sources", "POST", {"url": "https://example.com/new.xml"}),
    ("/settings/feeds/{user_feed_id}/edit", "/sources/feeds/{user_feed_id}/edit", "POST", {"custom_title": "Renamed"}),
    ("/settings/feeds/test", "/sources/test", "POST", {"url": "https://example.com/new.xml"}),
    ("/settings/feeds/{user_feed_id}", "/sources/feeds/{user_feed_id}", "DELETE", {}),
    ("/settings/folders", "/sources/folders", "POST", {"name": "New folder"}),
    ("/settings/folders/{folder_id}", "/sources/folders/{folder_id}", "DELETE", {}),
    ("/settings/folders/{folder_id}/rename", "/sources/folders/{folder_id}/rename", "POST", {"name": "Renamed"}),
    ("/settings/folders/{folder_id}/move", "/sources/folders/{folder_id}/move", "POST", {"dir": "down"}),
    ("/settings/folder-order", "/sources/folder-order", "POST", {"mode": "name"}),
    ("/settings/folder-order/reset", "/sources/folder-order/reset", "POST", {}),
    ("/settings/opml/import", "/sources/opml/import", "POST", {"import_feeds": "true"}),
    ("/settings/feeds/scrape-preview", "/sources/scrape-preview", "POST", {"url": "https://example.com/page", "selector": "a"}),
    ("/settings/feeds/scrape-ai-selector", "/sources/scrape-ai-selector", "POST", {}),
    ("/settings/feeds/scrape-show-prompt", "/sources/scrape-show-prompt", "POST", {"url": "https://example.com/page"}),
    ("/settings/feeds/scrape", "/sources/scrape", "POST", {"url": "https://example.com/page", "selector": "a", "title": "Scraped"}),
    ("/settings/reading", "/settings/reading/save", "POST", {"articles_per_page": "40"}),
    ("/settings/preferences", "/settings/reading/save", "POST", {"articles_per_page": "40"}),
    ("/settings/ai/generate-preference", "/assistant/profile/generate", "POST", {}),
    ("/settings/ai/revert-preference", "/assistant/profile/revert", "POST", {}),
]




@asynccontextmanager
async def source_fixture():
    """A reader with two folders and a subscription, and another reader's, rolled back
    afterwards. Folder and UserFeed ids come from the sequences (a fixed id collides
    with rows other tests leave behind) and are in ``db.info["ids"]``: ``user_feed_id``
    and ``folder_id`` are the reader's, ``foreign_*`` the other reader's."""
    engine = create_async_engine(settings.database_url)
    async with engine.connect() as conn:
        tx = await conn.begin()
        async with AsyncSession(conn, expire_on_commit=False, join_transaction_mode="create_savepoint") as db:
            user = User(id=17001, email="routing@test.invalid", password_hash="x", display_name="Reader")
            feed = Feed(feed_url="https://example.com/feed.xml", title="Existing", subscriber_count=1)
            db.add_all([user, User(id=17002, email="other@test.invalid", password_hash="x", display_name="Other"),
                        feed])
            await db.flush()
            first = Folder(user_id=user.id, name="First", position=0)
            foreign_folder = Folder(user_id=17002, name="Other")
            db.add_all([first, Folder(user_id=user.id, name="Second", position=1), foreign_folder,
                        UserSettings(user_id=user.id, folder_order="custom", folders_arranged=True)])
            await db.flush()
            mine = UserFeed(user_id=user.id, feed_id=feed.id, folder_id=first.id)
            foreign = UserFeed(user_id=17002, feed_id=feed.id, folder_id=foreign_folder.id)
            db.add_all([mine, foreign])
            await db.commit()
            db.info["ids"] = {"user_feed_id": mine.id, "folder_id": first.id,
                              "foreign_user_feed_id": foreign.id, "foreign_folder_id": foreign_folder.id}
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
    assert {(p.old, p.new) for p in MOVED_PAGES} >= set(SOURCE_MOVES)
    async with source_fixture() as (client, db):
        with outbound(source_transport):
            for old, new in SOURCE_MOVES:
                old = old.format(**db.info["ids"])
                new = new.format(**db.info["ids"])
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


async def _sources_state(db):
    return (
        (await db.execute(select(Folder.user_id, Folder.name, Folder.position).order_by(Folder.user_id, Folder.name))).all(),
        (await db.execute(select(UserFeed.user_id, UserFeed.custom_title, UserFeed.extract_readable).order_by(UserFeed.user_id, UserFeed.custom_title))).all(),
        (await db.execute(select(UserSettings.user_id, UserSettings.folder_order, UserSettings.folders_arranged,
                                 UserSettings.articles_per_page, UserSettings.ai_preference_text)
                          .order_by(UserSettings.user_id))).all(),
    )


async def test_non_get_aliases_gone_and_gets_redirect():
    """Every former alias answers the stale failure and changes nothing, while its
    canonical path is still served; every moved GET still redirects."""
    def served(path, method):
        return any(isinstance(r, Route) and method in (r.methods or ()) and r.path_regex.fullmatch(path)
                   for r in production_app.routes)
    async with source_fixture() as (client, db):
        ids = db.info["ids"]
        before = await _sources_state(db)
        for old, new, method, data in SOURCE_ACTIONS:
            old, new = old.format(**ids), new.format(**ids)
            assert served(new, method), (method, new)
            assert not served(old, method), (method, old)
            options = {"data": data, "headers": {"HX-Request": "true", "HX-Target": "rf-source-sheet-body"}}
            if old.endswith("/opml/import"):
                options["files"] = {"file": ("feeds.opml", b'<opml version="2.0"><body><outline type="rss" xmlUrl="https://example.com/feed.xml"/></body></opml>')}
            with outbound(source_transport):
                response = await client.request(method, old, **options)
            assert_stale_toast(response)
            assert await _sources_state(db) == before, (method, old)

        # url= is what the scrape page needs to answer 200 instead of going back to Sources.
        query = "?x=a%2Bb&x=2&url=https%3A%2F%2Fexample.com%2Fpage"
        with outbound(source_transport):
            for page in MOVED_PAGES:
                old, new = page.old.format(**ids), page.new.format(**ids)
                response = await client.get(old + query)
                assert response.status_code == 308, old
                assert response.headers["cache-control"] == "no-store"
                assert response.headers["location"] == new + query
                assert (await client.get(response.headers["location"])).status_code == 200, new


async def test_stale_post_to_removed_alias_toasts_out_of_date():
    """A tab from before the deploy: htmx gets the stale toast, a plain post the error
    page saying the same, the API keeps JSON, and nothing is created."""
    async with source_fixture() as (client, db):
        before = await _sources_state(db)
        htmx = {"HX-Request": "true"}
        for path, status, data in [("/settings/folders", 404, {"name": "Stale folder"}),
                                   ("/settings/feeds", 405, {"url": "https://example.com/new.xml"})]:
            with outbound(source_transport):
                assert_stale_toast(await client.post(path, data=data, headers=htmx), status)
                page = await client.post(path, data=data)
            assert page.status_code == status
            text = BeautifulSoup(page.text, "html.parser").get_text(" ", strip=True)
            assert STALE_PAGE in text and "That did not go through." in text
            assert "Go back and correct it" not in text
            assert "HX-Trigger" not in page.headers
        assert await _sources_state(db) == before
        assert (await db.scalar(select(Folder.id).where(Folder.name == "Stale folder"))) is None
        api = await client.post("/api/v1/no-such")
        assert api.status_code == 404
        assert api.json() == {"detail": "Not Found"}


async def test_route_own_404_keeps_its_answer():
    """A route that ran and raised its own 404 (a missing saved search) is not stale."""
    async with source_fixture() as (client, _):
        response = await client.post("/htmx/saved-searches/999999/delete", headers={"HX-Request": "true"})
        assert response.status_code == 404
        assert "HX-Trigger" not in response.headers
        assert "Page not found." in response.text
        assert STALE_PAGE not in response.text


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
    for path, data in [
        ("/sources", {"url": "https://example.com/new.xml"}),
        ("/sources/feeds/{user_feed_id}/edit", {"custom_title": "Renamed"}),
        ("/sources/scrape", {"url": "https://example.com/page", "selector": "a"}),
    ]:
        for headers in [{}, {"HX-Request": "true"}]:
            async with source_fixture() as (client, db):
                with outbound(source_transport):
                    response = await client.post(path.format(**db.info["ids"]), data=data, headers=headers)
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
        await db.delete(await db.get(UserFeed, db.info["ids"]["user_feed_id"]))
        await db.commit()
        assert (await client.get("/settings")).headers["location"] == "/settings/reading"
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


# Independent of the production table, as SOURCE_MOVES is.
SETTINGS_MOVES = [
    ("/settings/preferences", "/settings/reading"),
    ("/settings/preferences/hidden", "/settings/relevance/hidden"),
    ("/settings/filters", "/settings/relevance"),
]


async def test_settings_moved_pages_redirect_and_old_posts_gone():
    """An old Settings bookmark lands on the new page; a stale Preferences tab is told
    it is out of date and saves nothing; posting a new filter is served where it
    always was."""
    async with source_fixture() as (client, _):
        for old, new in SETTINGS_MOVES:
            response = await client.get(old + "?x=1")
            assert response.status_code == 308, old
            assert response.headers["location"] == new + "?x=1"
            assert response.headers["cache-control"] == "no-store"
            assert (await client.get(response.headers["location"])).status_code == 200, new
    old_form = {
        "timezone": "UTC", "format_profile": "iso", "unread_filter": "show_all",
        "default_sort_order": "oldest", "articles_per_page": "40",
        "list_density_web": "compact", "list_density_mobile": "summary",
        "label_display": "dots", "story_dedup": "collapse_suppress",
        "mark_read_on_scroll": "on", "reading_font_size": "lg", "reading_font_family": "serif",
        "bucket_small_max": "700", "bucket_medium_max": "1200",
    }
    names = [*old_form, "mark_read_auto_advance", "open_original_when_empty"]
    for path in ["/settings/preferences", "/settings/reading"]:
        async with source_fixture() as (client, db):
            row = await db.scalar(select(UserSettings).where(UserSettings.user_id == 17001))
            before = {name: str(getattr(row, name)) for name in names}
            assert_stale_toast(await client.post(path, data=old_form, headers={"HX-Request": "true"}), 405)
            await db.refresh(row)
            assert {name: str(getattr(row, name)) for name in names} == before, path
    async with source_fixture() as (client, _):
        form = {"name": "Stale tab", "is_active": "true", "match_operator": "AND", "position": "0",
                "cond_field": "title", "cond_operator": "contains", "cond_value": "x",
                "cond_position": "0", "cond_source": "", "action_type": "star", "action_value": ""}
        response = await client.post("/settings/filters", data=form)
        assert response.status_code == 303, response.text
        assert response.headers["location"] == "/settings/relevance"


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
        # Section name -> the container the page shows for it; the ids do not follow
        # the query values ("catch-up" is "assistant-catch-up"), so name them.
        section_ids = {'chat': 'assistant-chat', 'catch-up': 'assistant-catch-up',
                       'profile': 'assistant-profile'}
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
            selected = page.select_one('#' + section_ids[section])
            assert selected is not None, section
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
    old_profile_paths = ['/settings/ai/generate-preference', '/settings/ai/revert-preference']
    for old, new in zip(old_profile_paths, ['/assistant/profile/generate', '/assistant/profile/revert']):
        assert not [r for r in production_app.routes if getattr(r, 'path', None) == old]
        assert route(new, 'POST').endpoint in (profile.settings_ai_generate_preference,
                                               profile.settings_ai_revert_preference)
        async with chat_fixture() as (client, db, user, prefs, article, admin):
            prefs.ai_preference_text = 'Current interests'
            prefs.ai_preference_prev_text = 'Previous interests'
            await db.flush()
            assert_stale_toast(await client.post(old, data={'user_id': '18102'}, headers={'HX-Request': 'true'}), 404)
            await db.refresh(prefs)
            assert (prefs.ai_preference_text, prefs.ai_preference_prev_text) == ('Current interests', 'Previous interests')
            response = await client.post(new, data={'user_id': '18102'})
            assert response.status_code == 200
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
        # A stale AI settings tab still carrying the profile is refused whole.
        stale = await client.post('/settings/ai/preferences', headers={'HX-Request': 'true'}, data={
            'ai_quality_provider': 'openai', 'ai_quality_model': 'changed', 'ai_preference_text': 'Stale tab interests'})
        assert_stale_toast(stale, 409)
        await db.refresh(prefs)
        assert prefs.ai_quality_model == before and prefs.ai_preference_text == 'Retained interests'
        await client.post('/settings/ai/preferences', data={'ai_quality_provider': 'openai', 'ai_quality_model': 'changed'})
        await db.refresh(prefs)
        assert prefs.ai_quality_model == 'changed' and prefs.ai_preference_text == 'Retained interests'
        production_app.dependency_overrides.pop(get_current_user)
        for path in ['/assistant/profile', '/assistant/profile/generate', '/assistant/profile/revert']:
            assert (await client.post(path)).status_code in (302, 303, 401)
        # A removed path answers before any sign-in check: there is nothing there to protect.
        for path in old_profile_paths:
            assert_stale_toast(await client.post(path, headers={'HX-Request': 'true'}), 404)


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
            assert page.select_one('#assistant-chat .alert[role="status"]')
            # The alert offers a general conversation, so that one stays usable.
            assert not page.select_one('#assistant-chat fieldset[disabled]')
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

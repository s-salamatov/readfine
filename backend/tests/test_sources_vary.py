"""End-to-end representation headers and assembled Sources document regressions."""
from bs4 import BeautifulSoup
from fastapi.responses import HTMLResponse
from app.main import app
from tests.test_moved_pages import source_fixture


async def test_sources_vary_preserves_representation_and_cookie():
    async with source_fixture() as (client, _):
        # The old path works before routing migration and follows the 308 afterwards.
        sheet = await client.get("/settings/feeds/add", follow_redirects=True,
                                 headers={"HX-Target": "rf-source-sheet-body"})
        assert sheet.status_code == 200
        tokens = [value.strip().lower() for value in sheet.headers["vary"].split(",")]
        assert tokens.count("hx-target") == tokens.count("cookie") == 1
        async def existing_vary():
            return HTMLResponse("existing tokens", headers={"Vary": "Accept-Encoding, cookie, HX-Target, Cookie"})
        app.add_api_route("/__test_sources_vary", existing_vary, methods=["GET"])
        route = app.routes[-1]
        try:
            merged = await client.get("/__test_sources_vary")
            assert merged.headers["vary"] == "Accept-Encoding, cookie, HX-Target"
        finally:
            app.router.routes.remove(route)
        ordinary = await client.get("/login")
        assert ordinary.status_code == 200
        assert ordinary.headers["vary"].lower().split(",").count("cookie") == 1


async def test_sources_assembled_page_has_one_heading_and_toolbar():
    async with source_fixture() as (client, _):
        response = await client.get("/settings/feeds", follow_redirects=True)
        assert response.status_code == 200
        dom = BeautifulSoup(response.text, "html.parser")
        ids = [element["id"] for element in dom.select("[id]")]
        assert len(ids) == len(set(ids)), [id_ for id_ in ids if ids.count(id_) > 1]
        heading = dom.select_one("#sources-heading")
        assert heading.name == "h1" and heading["tabindex"] == "-1"
        main = dom.select_one("main")
        assert len(main.select('a[href$="/add"]')) == 1
        assert len(main.select('a[href$="/opml"]')) == 1
        assert len(dom.select("#feeds-count")) == 1

"""Moved pages: an old URL answers 308 to its new home; its non-GET methods stay
served from the old path as aliases of the new route until `remove_aliases_in`.

The production table is empty in s2, so the helper is proven on a throwaway app
with a synthetic entry.
"""
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

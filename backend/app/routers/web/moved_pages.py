"""Pages that moved to a new URL during the UI redesign.

GET on the old path answers 308 to the new one (query string kept, never cached,
so a later move or removal is not pinned in browsers). Only GET is redirected: the
non-GET aliases that kept stale tabs working were removed in s8. A form or script
that still posts to an old path finds no route for it, and ``auth_redirect_handler``
(``main.py``) answers "This page is out of date. Reload it and try again."

Sources entries were added in s5; s6-s7 add their page moves. `register_moved_pages` runs after
every router is included, and a target that no route serves fails startup.
"""
from dataclasses import dataclass

from fastapi import FastAPI
from starlette.requests import Request
from starlette.responses import RedirectResponse
from starlette.routing import Route, compile_path, replace_params


@dataclass(frozen=True)
class MovedPage:
    old: str
    new: str


MOVED_PAGES: list[MovedPage] = [
    MovedPage("/app/catch-me-up", "/assistant/catch-up"),
    MovedPage("/settings/feeds", "/sources"),
    MovedPage("/settings/feeds/add", "/sources/add"),
    MovedPage("/settings/feeds-list", "/sources/feeds-list"),
    MovedPage("/settings/feeds/{user_feed_id}/edit", "/sources/feeds/{user_feed_id}/edit"),
    MovedPage("/settings/feeds/scrape-setup", "/sources/scrape"),
    MovedPage("/settings/folders/{folder_id}/rename-form", "/sources/folders/{folder_id}/rename-form"),
    MovedPage("/settings/opml", "/sources/opml"),
    MovedPage("/settings/opml/export", "/sources/opml/export"),
    MovedPage("/settings/preferences", "/settings/reading"),
    MovedPage("/settings/preferences/hidden", "/settings/relevance/hidden"),
    # The list page only: POST /settings/filters and the filter actions kept their URLs.
    MovedPage("/settings/filters", "/settings/relevance"),
]


def _route_for(app: FastAPI, path: str, method: str) -> Route | None:
    for route in app.router.routes:
        if isinstance(route, Route) and route.path == path and method in (route.methods or ()):
            return route
    return None


def _redirect_endpoint(page: MovedPage):
    _, path_format, converters = compile_path(page.new)

    async def moved_page_redirect(request: Request) -> RedirectResponse:
        target, _ = replace_params(path_format, converters, dict(request.path_params))
        if request.url.query:
            target += "?" + request.url.query
        return RedirectResponse(target, status_code=308, headers={"Cache-Control": "no-store"})

    return moved_page_redirect


def register_moved_pages(app: FastAPI, pages: list[MovedPage] = MOVED_PAGES) -> None:
    # Check every entry before adding anything, so a bad entry leaves the app untouched.
    for page in pages:
        old_params = compile_path(page.old)[2]
        new_params = compile_path(page.new)[2]
        if old_params.keys() != new_params.keys():
            raise RuntimeError(f"moved page {page.old} -> {page.new}: mismatched route parameter names")
        if _route_for(app, page.new, "GET") is None:
            raise RuntimeError(f"moved page {page.old} -> {page.new}: no GET route serves {page.new}")
        if _route_for(app, page.old, "GET") is not None:
            raise RuntimeError(f"moved page {page.old} -> {page.new}: GET {page.old} is still served")

    for page in pages:
        app.add_api_route(
            page.old,
            _redirect_endpoint(page),
            methods=["GET"],
            include_in_schema=False,
            name=f"moved:{page.old}",
        )

"""Pages that moved to a new URL during the UI redesign.

GET on the old path answers 308 to the new one (query string kept, never cached,
so a later move or removal is not pinned in browsers). Non-GET methods listed in
`methods` are served from the old path by the very route that serves the new
path, so a form or script still posting to the old URL keeps working until the
aliases are removed in `remove_aliases_in`.

The table is empty in s2; s5-s7 add entries. `register_moved_pages` runs after
every router is included, and a target that no route serves fails startup.
"""
from dataclasses import dataclass

from fastapi import FastAPI
from fastapi.routing import APIRoute
from starlette.requests import Request
from starlette.responses import RedirectResponse
from starlette.routing import Route


@dataclass(frozen=True)
class MovedPage:
    old: str
    new: str
    methods: tuple[str, ...] = ("GET",)
    remove_aliases_in: str = "s8"


MOVED_PAGES: list[MovedPage] = []


def _route_for(app: FastAPI, path: str, method: str) -> Route | None:
    for route in app.router.routes:
        if isinstance(route, Route) and route.path == path and method in (route.methods or ()):
            return route
    return None


def _redirect_endpoint(page: MovedPage):
    async def moved_page_redirect(request: Request) -> RedirectResponse:
        target = page.new
        if request.url.query:
            target += "?" + request.url.query
        return RedirectResponse(target, status_code=308, headers={"Cache-Control": "no-store"})

    return moved_page_redirect


def register_moved_pages(app: FastAPI, pages: list[MovedPage] = MOVED_PAGES) -> None:
    # Resolve every target before adding anything, so a bad entry leaves the app untouched.
    plan: list[tuple[MovedPage, list[tuple[str, Route]]]] = []
    for page in pages:
        methods = [m.upper() for m in page.methods]
        if "GET" not in methods:
            methods.insert(0, "GET")
        targets = []
        for method in methods:
            route = _route_for(app, page.new, method)
            if route is None:
                raise RuntimeError(f"moved page {page.old} -> {page.new}: no {method} route serves {page.new}")
            if _route_for(app, page.old, method) is not None:
                raise RuntimeError(f"moved page {page.old} -> {page.new}: {method} {page.old} is still served")
            targets.append((method, route))
        plan.append((page, targets))

    for page, targets in plan:
        for method, route in targets:
            if method == "GET":
                app.add_api_route(
                    page.old,
                    _redirect_endpoint(page),
                    methods=["GET"],
                    include_in_schema=False,
                    name=f"moved:{page.old}",
                )
            elif isinstance(route, APIRoute):
                app.add_api_route(
                    page.old,
                    route.endpoint,
                    methods=[method],
                    response_model=route.response_model,
                    status_code=route.status_code,
                    dependencies=route.dependencies,
                    response_class=route.response_class,
                    include_in_schema=False,
                    name=f"moved-alias:{method}:{page.old}",
                )
            else:
                app.router.add_route(
                    page.old,
                    route.endpoint,
                    methods=[method],
                    include_in_schema=False,
                    name=f"moved-alias:{method}:{page.old}",
                )

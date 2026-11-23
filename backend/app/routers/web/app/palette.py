"""Command palette results: what the reader's ⌘K palette finds on the server.

``GET /htmx/palette?q=`` answers the open palette's typing (static/js/ui/palette.js,
debounced) with up to three groups of matches, each item rendered by the
``command_items`` macro with ``data-force`` so Basecoat's command.js shows it whatever
the typed filter is (the server has already matched it):

- Articles: a full-text search, as the search modal runs it; an item opens the page
  on the article (``/app?open_article_id=``).
- Saved searches: name contains the query, case-insensitive.
- Feeds and folders: subscription title (the custom one when set) or folder name
  contains the query, case-insensitive; folders first, eight together at most.

Saved searches, feeds and folders carry ``data-rf-nav`` with the very ``hx-get`` URL
of their sidebar row, so the client can click that row (and fall back to loading the
list directly). A query shorter than two characters answers an empty body.
"""
from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.database import get_db
from app.models.user import User
from app.services.article import list_articles
from app.services.feed import list_user_feeds
from app.services.folder_service import get_folder_order
from app.services.saved_search_service import list_saved_searches
from app.templating import templates

router = APIRouter(tags=["web-app"])

MIN_QUERY = 2
ARTICLE_LIMIT = 8
SAVED_SEARCH_LIMIT = 5
FEED_FOLDER_LIMIT = 8

NAV_BASE = "/htmx/articles"


def _nav(label: str, url: str) -> dict:
    return {"label": label, "attrs": {"data-force": True, "data-rf-nav": url}}


async def _feeds_and_folders(user: User, db: AsyncSession, needle: str) -> list[dict]:
    user_feeds = await list_user_feeds(user, db, folder_order=await get_folder_order(db, user.id))
    folders: list[dict] = []
    seen_folders: set[int] = set()
    feeds: list[dict] = []
    for uf in user_feeds:
        folder = uf.folder
        if folder is not None and folder.id not in seen_folders:
            seen_folders.add(folder.id)
            if needle in folder.name.lower():
                folders.append(_nav(folder.name, f"{NAV_BASE}?folder_id={folder.id}"))
        title = uf.custom_title or uf.feed.title or ""
        if needle in title.lower():
            feeds.append(_nav(title, f"{NAV_BASE}?feed_id={uf.feed_id}"))
    return (folders + feeds)[:FEED_FOLDER_LIMIT]


@router.get("/htmx/palette", response_class=HTMLResponse)
async def htmx_palette(
    request: Request,
    q: str = "",
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    q = q.strip()
    if len(q) < MIN_QUERY:
        return HTMLResponse("")
    needle = q.lower()

    articles = await list_articles(user, db, q=q, search=True, limit=ARTICLE_LIMIT)
    article_items = [
        {"label": a.title, "href": f"/app?open_article_id={a.id}", "attrs": {"data-force": True}}
        for a in articles
    ]
    search_items = [
        _nav(s.name, f"{NAV_BASE}?saved_search_id={s.id}")
        for s in await list_saved_searches(db, user.id)
        if needle in s.name.lower()
    ][:SAVED_SEARCH_LIMIT]
    feed_items = await _feeds_and_folders(user, db, needle)

    groups = [
        {"type": "group", "label": label, "items": items}
        for label, items in (
            ("Articles", article_items),
            ("Saved searches", search_items),
            ("Feeds and folders", feed_items),
        )
        if items
    ]
    return templates.TemplateResponse(request, "app/partials/palette_results.html", {"groups": groups})

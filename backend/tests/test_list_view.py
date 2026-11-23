"""The article list as redesigned in s4 (s4-T2): the list header with the view title,
the View menu and mark-all; the folder chips; the rows' hooks; the skeleton; and the
small endpoint that saves one View-menu choice (POST /htmx/list-view).

Runs against the real (test) database in a transaction that is always rolled back;
the app's get_db and get_current_user are pointed at that session. Names carry a
unique token so a test only ever matches its own rows.
"""
import json
import uuid
from datetime import datetime, timezone

import httpx
import pytest
import pytest_asyncio
from bs4 import BeautifulSoup
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.config import settings as app_settings
from app.models.article import Article, ArticleTranslation
from app.models.feed import Feed, Folder, UserFeed
from app.models.label import ArticleLabel, Label
from app.models.user import User, UserSettings
from app.services import saved_search_service

pytestmark = pytest.mark.integration

NOW = datetime.now(timezone.utc)
MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148"
DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"


@pytest_asyncio.fixture
async def pg():
    engine = create_async_engine(app_settings.database_url)
    try:
        conn = await engine.connect()
    except Exception as exc:
        await engine.dispose()
        from tests.conftest import db_unreachable
        db_unreachable(exc)
    trans = await conn.begin()
    session = AsyncSession(bind=conn, expire_on_commit=False,
                           join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        from app.main import app
        app.dependency_overrides.clear()
        await session.close()
        await trans.rollback()
        await conn.close()
        await engine.dispose()


def _client(session, user):
    from app.auth.dependencies import get_current_user
    from app.database import get_db
    from app.main import app

    async def _db():
        yield session

    async def _me():
        return user

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _me
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost")


async def _user(s, **settings):
    u = uuid.uuid4().hex
    user = User(email=f"{u}@ex.invalid", password_hash="x", display_name=f"u-{u[:6]}")
    s.add(user)
    await s.flush()
    s.add(UserSettings(user_id=user.id, onboarded_at=NOW, **settings))
    await s.flush()
    return user


async def _folder(s, user, name, position=0):
    folder = Folder(user_id=user.id, name=name, position=position)
    s.add(folder)
    await s.flush()
    return folder


async def _feed(s, user, title, folder=None, translate=False):
    u = uuid.uuid4().hex
    feed = Feed(feed_url=f"https://ex.invalid/{u}.xml", title=title, subscriber_count=1)
    s.add(feed)
    await s.flush()
    s.add(UserFeed(user_id=user.id, feed_id=feed.id, folder_id=folder.id if folder else None,
                   translate=translate))
    await s.flush()
    return feed


async def _article(s, feed, title, summary=None):
    u = uuid.uuid4().hex
    a = Article(feed_id=feed.id, guid=u, guid_hash=u, title=title, content="<p>body</p>",
                summary=summary, readable_status="pending", published_at=NOW, fetched_at=NOW)
    s.add(a)
    await s.flush()
    return a


def _soup(html):
    return BeautifulSoup(html, "html.parser")


async def _settings_row(s, user):
    row = await s.get(UserSettings, user.id)
    await s.refresh(row)
    return {c.name: getattr(row, c.name) for c in UserSettings.__table__.columns}


# ── header ────────────────────────────────────────────────────────────────────

VIEWS = ["all", "feed", "folder", "label", "starred", "saved_search", "search", "foreign_feed"]


@pytest.mark.parametrize("view", VIEWS)
async def test_list_header_shows_title_view_menu_and_mark_all(pg, view):
    """list: header shows the view title, View menu and mark-all for each sidebar view;
    a search has no mark-all and no Sort group; a foreign feed id titles as All articles."""
    tok = uuid.uuid4().hex[:8]
    me = await _user(pg)
    other = await _user(pg)
    folder = await _folder(pg, me, f"Folder {tok}")
    feed = await _feed(pg, me, f"Feed {tok}", folder=folder)
    foreign = await _feed(pg, other, f"Foreign {tok}")
    art = await _article(pg, feed, f"Story {tok}")
    label = Label(user_id=me.id, name=f"Label {tok}", color="#336699")
    pg.add(label)
    await pg.flush()
    pg.add(ArticleLabel(user_id=me.id, article_id=art.id, label_id=label.id))
    await pg.flush()
    saved = await saved_search_service.create_saved_search(
        pg, me.id, name=f"Saved {tok}", params={"q": tok})

    url, title = {
        "all": ("/htmx/articles", "All articles"),
        "feed": (f"/htmx/articles?feed_id={feed.id}", f"Feed {tok}"),
        "folder": (f"/htmx/articles?folder_id={folder.id}", f"Folder {tok}"),
        "label": (f"/htmx/articles?label_id={label.id}", f"Label {tok}"),
        "starred": ("/htmx/articles?starred_only=true", "Starred"),
        "saved_search": (f"/htmx/articles?saved_search_id={saved.id}", f"Saved {tok}"),
        "search": (f"/htmx/articles?q={tok}", None),
        "foreign_feed": (f"/htmx/articles?feed_id={foreign.id}", "All articles"),
    }[view]
    async with _client(pg, me) as c:
        r = await c.get(url)
    assert r.status_code == 200
    soup = _soup(r.text)
    headers = soup.select("[data-list-header]")
    assert len(headers) == 1, "exactly one sticky list header"
    header = headers[0]
    if title is not None:
        h1 = header.select_one("h1[data-list-title]")
        assert h1 is not None and h1.get_text(strip=True) == title
    menu = header.select_one("#list-view-menu")
    assert menu is not None, "View menu in the header"
    items = menu.select('[role="menuitemradio"][data-rf-view]')
    fields = {i["data-rf-view"].split(":")[0] for i in items}
    for item in items:
        assert item.has_attr("data-rf-online-only")
        assert item["hx-post"] == "/htmx/list-view" and item["hx-swap"] == "none"
        vals = json.loads(item["hx-vals"])
        assert f'{vals["field"]}:{vals["value"]}' == item["data-rf-view"]
        assert item["aria-checked"] in ("true", "false")
    mark_all = header.select('[data-action="mark-all-read"]')
    if view == "search":
        assert fields == {"density", "unread", "stories"}
        assert mark_all == []
    else:
        assert fields == {"density", "sort", "unread", "stories"}
        assert len(mark_all) == 1 and mark_all[0]["aria-label"] == "Mark all as read"
    # One checked choice per group.
    for field in fields:
        checked = [i for i in items if i["data-rf-view"].startswith(field + ":")
                   and i["aria-checked"] == "true"]
        assert len(checked) == 1, field


# ── chips ─────────────────────────────────────────────────────────────────────

async def test_folder_chips_follow_sidebar_order_and_mark_the_active_one(pg):
    """list: folder chips list the reader's folders in sidebar order and mark the active
    one; another user's folder is absent; a feed view has no chips."""
    tok = uuid.uuid4().hex[:8]
    me = await _user(pg, folder_order="custom")
    other = await _user(pg)
    # Custom order puts Zeta first, so name order would be visibly wrong.
    zeta = await _folder(pg, me, f"Zeta {tok}", position=1)
    alpha = await _folder(pg, me, f"Alpha {tok}", position=2)
    stranger = await _folder(pg, other, f"Stranger {tok}", position=1)
    feed = await _feed(pg, me, f"Feed {tok}", folder=zeta)
    await _feed(pg, me, f"Feed2 {tok}", folder=alpha)
    await _feed(pg, other, f"Feed3 {tok}", folder=stranger)
    await _article(pg, feed, f"Story {tok}")

    async with _client(pg, me) as c:
        in_folder = await c.get(f"/htmx/articles?folder_id={alpha.id}")
        in_all = await c.get("/htmx/articles")
        in_feed = await c.get(f"/htmx/articles?feed_id={feed.id}")

    def chips(html):
        bar = _soup(html).select_one("[data-rf-chips]")
        if bar is None:
            return None
        assert bar["role"] == "toolbar" and bar["aria-label"] == "Folders"
        return [(b.get_text(strip=True), b["data-rf-nav"], b["aria-pressed"], b["type"])
                for b in bar.select("button")]

    assert chips(in_folder.text) == [
        ("All", "/htmx/articles", "false", "button"),
        (f"Zeta {tok}", f"/htmx/articles?folder_id={zeta.id}", "false", "button"),
        (f"Alpha {tok}", f"/htmx/articles?folder_id={alpha.id}", "true", "button"),
    ]
    assert [c[2] for c in chips(in_all.text)] == ["true", "false", "false"]
    assert f"Stranger {tok}" not in in_all.text
    assert chips(in_feed.text) is None


# ── /htmx/list-view ───────────────────────────────────────────────────────────

SAVES = [
    # (field, value, user agent, column it lands in)
    ("density", "summary", MOBILE_UA, "list_density_mobile"),
    ("density", "compact", DESKTOP_UA, "list_density_web"),
    ("sort", "oldest", DESKTOP_UA, "default_sort_order"),
    ("unread", "show_all", DESKTOP_UA, "unread_filter"),
    ("stories", "off", DESKTOP_UA, "story_dedup"),
    ("stories", "collapse_suppress", MOBILE_UA, "story_dedup"),
]
REFUSALS = [
    {"field": "bogus", "value": "x"},
    {"field": "density", "value": "huge"},
    {"field": "sort", "value": "relevance"},
    {"field": "unread", "value": ""},
    {"field": "stories"},
    {"field": "label_display", "value": "dots"},
]


async def test_list_view_saves_one_field_and_refuses_unknown_values(pg):
    """list-view: saves one field and refuses unknown values; every other settings
    column is unchanged either way."""
    for field, value, ua, column in SAVES:
        me = await _user(pg)
        before = await _settings_row(pg, me)
        async with _client(pg, me) as c:
            r = await c.post("/htmx/list-view", data={"field": field, "value": value},
                             headers={"user-agent": ua, "HX-Request": "true"})
        assert r.status_code == 200, (field, value, r.text)
        assert r.text == ""
        assert json.loads(r.headers["hx-trigger"]) == {
            "rf:viewchanged": {"field": field, "value": value}}
        after = await _settings_row(pg, me)
        assert after[column] == value, (field, column)
        changed = {k for k in before if before[k] != after[k]}
        assert changed <= {column, "updated_at"}, (field, changed)

    for data in REFUSALS:
        me = await _user(pg)
        before = await _settings_row(pg, me)
        async with _client(pg, me) as c:
            r = await c.post("/htmx/list-view", data=data, headers={"HX-Request": "true"})
        assert r.status_code == 400, data
        assert "hx-trigger" not in r.headers
        assert await _settings_row(pg, me) == before, data


# ── rows ──────────────────────────────────────────────────────────────────────

async def test_rows_keep_their_hooks_and_the_translated_title_in_every_density(pg):
    """list: rows keep their hooks and the translated title in every density."""
    tok = uuid.uuid4().hex[:8]
    me = await _user(pg, ai_translation_language="de")
    feed = await _feed(pg, me, f"quill {tok}", translate=True)
    art = await _article(pg, feed, f"Original {tok}", summary=f"Snippet text {tok}")
    pg.add(ArticleTranslation(user_id=me.id, article_id=art.id, language="de",
                              title=f"Übersetzt {tok}"))
    await pg.flush()

    for density in ("compact", "comfortable", "summary"):
        row_settings = await pg.get(UserSettings, me.id)
        row_settings.list_density_web = density
        await pg.flush()
        async with _client(pg, me) as c:
            r = await c.get(f"/htmx/articles?feed_id={feed.id}",
                            headers={"user-agent": DESKTOP_UA})
        assert r.status_code == 200
        row = _soup(r.text).select_one(f"#article-row-{art.id}")
        assert row is not None, density
        assert "article-row" in row["class"]
        for attr, want in {
            "data-article-id": str(art.id), "data-rf-article": str(art.id),
            "data-density": density, "data-is-read": "false",
            "data-title-original": f"Original {tok}",
            "data-title-translated": f"Übersetzt {tok}",
            "hx-get": f"/htmx/articles/{art.id}", "hx-trigger": "click",
        }.items():
            assert row.get(attr) == want, (density, attr)
        assert row.has_attr("data-url")
        assert row.has_attr("data-rf-read-classes") and row.has_attr("data-rf-unread-classes")
        title = row.select_one("[data-article-title]")
        assert title.get_text(strip=True) == f"Übersetzt {tok}", density
        assert title.find(True) is None, "the title holds text only"
        assert row.select_one("[data-translation-mark]") is not None, density
        star = row.select_one('[data-star-btn][data-rf-slot="star-button"]')
        assert star is not None and star.find("svg") is None, density
        assert star.find("span").get_text(strip=True) in ("☆", "★")
        assert row.select_one(f"#article-labels-{art.id}[data-rf-slot=labels]") is not None
        assert row.select_one("[data-archived-indicator][data-rf-slot=archive-button]") is not None
        assert row.select_one("[data-rf-time]") is not None
        # No <p> before the title: app.js finds the title as the row's first p or title.
        first = row.select_one("p, [data-article-title]")
        assert first is title, density
        icon = row.select_one(".rf-feed-icon")
        assert icon is not None and icon.get_text(strip=True) == "Q", density
        assert icon["aria-hidden"] == "true"
        snippet = row.select_one("[data-article-snippet]")
        if density == "summary":
            assert snippet is not None and "hidden" in snippet["class"]
        else:
            assert snippet is None


# ── skeleton ──────────────────────────────────────────────────────────────────

async def test_skeleton_is_hidden_from_screen_readers(pg):
    """list: the skeleton is hidden from screen readers: /app renders
    template#rf-list-skeleton and the initial skeleton, both aria-hidden."""
    me = await _user(pg)
    async with _client(pg, me) as c:
        r = await c.get("/app")
    assert r.status_code == 200, r.status_code
    soup = _soup(r.text)
    lst = soup.select_one("#article-list")
    assert "Loading…" not in lst.get_text()
    initial = lst.select_one("[data-rf-skeleton]")
    assert initial is not None and initial["aria-hidden"] == "true"
    assert len(initial.select(".skeleton")) >= 8 * 2
    tpl = soup.select_one("template#rf-list-skeleton")
    assert tpl is not None, "skeleton template"
    assert tpl.find_parent(id="article-list") is None, "outside the swapped list"
    inner = tpl.select_one("[data-rf-skeleton]")
    assert inner is not None and inner["aria-hidden"] == "true"
    assert len(inner.select(".skeleton")) == len(initial.select(".skeleton"))

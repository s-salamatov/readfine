"""Command palette results: GET /htmx/palette?q= (s3-T7).

The route answers an open palette's typing with up to three groups of server
matches (articles, saved searches, feeds and folders), rendered through the
command_items macro with data-force so Basecoat's command.js never filters them out.

Runs against the real (dev) database in a transaction that is always rolled back;
the app's get_db and get_current_user are pointed at that session. Each test puts a
unique nonsense token in the names it creates so matches only hit its own rows.
"""
import re
import uuid
from datetime import datetime, timezone

import httpx
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.config import settings as app_settings
from app.models.article import Article
from app.models.feed import Feed, Folder, UserFeed
from app.models.user import User
from app.services import saved_search_service

pytestmark = pytest.mark.integration

NOW = datetime.now(timezone.utc)


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


async def _user(s):
    u = uuid.uuid4().hex
    user = User(email=f"{u}@ex.invalid", password_hash="x", display_name=f"u-{u[:6]}")
    s.add(user)
    await s.flush()
    return user


async def _feed(s, user, title, folder=None, custom_title=None):
    """A subscription. A spare Feed goes in first so Feed.id and UserFeed.id differ:
    the sidebar's feed rows use the Feed id."""
    u = uuid.uuid4().hex
    spare = Feed(feed_url=f"https://ex.invalid/spare-{u}.xml", title="spare", subscriber_count=0)
    feed = Feed(feed_url=f"https://ex.invalid/{u}.xml", title=title, subscriber_count=1)
    s.add_all([spare, feed])
    await s.flush()
    uf = UserFeed(user_id=user.id, feed_id=feed.id, folder_id=folder.id if folder else None,
                  custom_title=custom_title)
    s.add(uf)
    await s.flush()
    return feed, uf


async def _folder(s, user, name):
    folder = Folder(user_id=user.id, name=name)
    s.add(folder)
    await s.flush()
    return folder


async def _article(s, feed, title):
    u = uuid.uuid4().hex
    a = Article(feed_id=feed.id, guid=u, guid_hash=u, title=title, content="<p>body</p>",
                readable_status="pending", published_at=NOW, fetched_at=NOW)
    s.add(a)
    await s.flush()
    return a


async def _search(s, user, name):
    return await saved_search_service.create_saved_search(s, user.id, name=name, params={"q": "x"})


def _groups(body):
    """Heading text of each role=group section, in order."""
    return re.findall(r'<span role="heading" id="[^"]+">([^<]*)</span>', body)


def _items(body):
    return re.findall(r'<(?:a|div) id="[^"]+" role="menuitem"[^>]*>', body)


async def _get(session, user, q):
    async with _client(session, user) as c:
        return await c.get("/htmx/palette", params={"q": q}, headers={"HX-Request": "true"})


@pytest.mark.asyncio
async def test_palette_groups_and_limits(pg):
    """palette: groups and limits"""
    user = await _user(pg)
    tok = "zpal" + uuid.uuid4().hex[:10]
    folder = await _folder(pg, user, f"{tok} folder")
    feeds = []
    for i in range(9):
        feed, uf = await _feed(pg, user, f"{tok} feed {i}", folder=folder if i == 0 else None)
        feeds.append((feed, uf))
    for i in range(10):
        await _article(pg, feeds[0][0], f"{tok} article {i}")
    for i in range(7):
        await _search(pg, user, f"{tok.upper()} search {i}")

    r = await _get(pg, user, tok)
    assert r.status_code == 200
    body = r.text
    assert _groups(body) == ["Articles", "Saved searches", "Feeds and folders"]
    sections = re.split(r'<div role="group"', body)[1:]
    assert len(sections) == 3
    assert len(_items(sections[0])) == 8
    assert len(_items(sections[1])) == 5, "saved searches match case-insensitively, at most 5"
    assert len(_items(sections[2])) == 8, "feeds and folders together, at most 8"

    # The URLs are the sidebar's own: articles open the page, the rest the list.
    assert re.search(r'href="/app\?open_article_id=\d+"', sections[0])
    assert 'data-rf-nav="/htmx/articles?saved_search_id=' in sections[1]
    # The folder appears once although it holds a feed row, then feeds by Feed id.
    assert sections[2].count(f'data-rf-nav="/htmx/articles?folder_id={folder.id}"') == 1
    feed, uf = feeds[0]
    assert feed.id != uf.id
    assert f'data-rf-nav="/htmx/articles?feed_id={feed.id}"' in sections[2]

    # Only feeds match: one group, the other two are left out.
    r = await _get(pg, user, f"{tok} feed 3")
    assert _groups(r.text) == ["Feeds and folders"]

    # A custom title is what the reader sees, so it is what matches.
    _, _ = await _feed(pg, user, "plain title", custom_title=f"{tok}renamed")
    r = await _get(pg, user, f"{tok}renamed")
    assert _groups(r.text) == ["Feeds and folders"]
    assert f"{tok}renamed" in r.text

    # Nothing matches: a clear empty state, no group.
    r = await _get(pg, user, "zzznomatch" + uuid.uuid4().hex[:8])
    assert r.status_code == 200
    assert _groups(r.text) == []
    assert 'data-rf-palette-state="empty"' in r.text


@pytest.mark.asyncio
async def test_palette_short_query_is_empty(pg):
    """palette: short query is empty"""
    user = await _user(pg)
    await _feed(pg, user, "a feed")
    for q in ["", " ", "a", "  a  "]:
        r = await _get(pg, user, q)
        assert r.status_code == 200
        assert r.text == "", q
    async with _client(pg, user) as c:
        r = await c.get("/htmx/palette", headers={"HX-Request": "true"})
    assert r.status_code == 200 and r.text == ""


@pytest.mark.asyncio
async def test_palette_other_users_feeds_and_searches_do_not_appear(pg):
    """palette: another user's feeds and searches do not appear"""
    me = await _user(pg)
    other = await _user(pg)
    tok = "zpal" + uuid.uuid4().hex[:10]
    folder = await _folder(pg, other, f"{tok} theirs")
    feed, _ = await _feed(pg, other, f"{tok} their feed", folder=folder)
    await _article(pg, feed, f"{tok} their article")
    await _search(pg, other, f"{tok} their search")

    r = await _get(pg, me, tok)
    assert r.status_code == 200
    assert _groups(r.text) == []
    assert tok not in r.text

    # The owner does see all three.
    r = await _get(pg, other, tok)
    assert _groups(r.text) == ["Articles", "Saved searches", "Feeds and folders"]


@pytest.mark.asyncio
async def test_palette_titles_are_escaped_and_items_carry_data_force(pg):
    """palette: titles are escaped and items carry data-force"""
    user = await _user(pg)
    tok = "zpal" + uuid.uuid4().hex[:10]
    evil = f'{tok} <img src=x onerror="alert(1)"> & "q"'
    feed, _ = await _feed(pg, user, evil)
    await _article(pg, feed, evil)
    await _search(pg, user, f"{tok} <b>bold</b>")

    r = await _get(pg, user, tok)
    body = r.text
    assert "<img" not in body and "<b>" not in body
    assert "&lt;img src=x onerror=" in body
    assert "&lt;b&gt;bold&lt;/b&gt;" in body
    items = _items(body)
    assert len(items) == 3
    for tag in items:
        assert " data-force" in tag, tag
        assert "onerror" not in tag
    # Distinct from the palette's own static "rf-palette-item-*" ids.
    assert "rf-palette-item-" not in body

"""Relevance & filters page (s7-T3): the merged filters list with delayed delete,
the Stories block with its hidden-stories list, filter redirects and the
"Filter from this source" prefill (real Postgres, real commits).

The routes commit (settings rows are created on first visit), so the
rolled-back-transaction pattern cannot hold them: every test writes rows with
unique names and removes its users and feeds at the end.
"""
import uuid
from datetime import datetime, timezone

import httpx
import pytest
import pytest_asyncio
from bs4 import BeautifulSoup
from fastapi import Depends
from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.config import settings as app_settings
from app.models.article import Article, UserArticleState
from app.models.feed import Feed, UserFeed
from app.models.filter import Filter, FilterAction, FilterCondition
from app.models.user import User, UserSettings

pytestmark = pytest.mark.integration


@pytest_asyncio.fixture
async def env():
    engine = create_async_engine(app_settings.database_url)
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception as exc:
        await engine.dispose()
        from tests.conftest import db_unreachable
        db_unreachable(exc)
    made = {"users": [], "feeds": []}
    try:
        yield engine, made
    finally:
        from app.main import app
        app.dependency_overrides.clear()
        async with AsyncSession(engine) as s:
            if made["users"]:
                await s.execute(delete(Filter).where(Filter.user_id.in_(made["users"])))
                await s.execute(delete(User).where(User.id.in_(made["users"])))
            if made["feeds"]:
                await s.execute(delete(Feed).where(Feed.id.in_(made["feeds"])))
            await s.commit()
        await engine.dispose()


async def _user(s, made, story_dedup=None):
    u = uuid.uuid4().hex
    user = User(email=f"{u}@ex.invalid", password_hash="x", display_name=f"u-{u[:6]}")
    s.add(user)
    await s.flush()
    made["users"].append(user.id)
    if story_dedup:
        s.add(UserSettings(user_id=user.id, story_dedup=story_dedup))
        await s.flush()
    return user


async def _feed(s, made, *subscribers, title=None):
    """A feed with a spare one in front, so Feed.id and UserFeed.id differ."""
    u = uuid.uuid4().hex
    spare = Feed(feed_url=f"https://ex.invalid/spare-{u}.xml", title="spare", subscriber_count=0)
    feed = Feed(feed_url=f"https://ex.invalid/{u}.xml", title=title or f"Feed {u[:8]}",
                subscriber_count=len(subscribers))
    s.add_all([spare, feed])
    await s.flush()
    made["feeds"] += [spare.id, feed.id]
    for user in subscribers:
        s.add(UserFeed(user_id=user.id, feed_id=feed.id))
    await s.flush()
    return feed


def _client(engine, user_id):
    from app.auth.dependencies import get_current_user
    from app.database import get_db
    from app.main import app

    async def _db():
        async with AsyncSession(engine, expire_on_commit=False) as s:
            yield s

    async def _me(db: AsyncSession = Depends(get_db)):
        return await db.get(User, user_id)

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _me
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost")


async def test_relevance_page_has_filters_and_stories(env):
    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made, story_dedup="collapse_suppress")
        f1 = Filter(user_id=user.id, name=f"alpha-{uuid.uuid4().hex[:6]}", is_active=True)
        f1.actions = [FilterAction(action_type="star", action_value=None)]
        s.add(f1)
        await s.commit()

    async with _client(engine, user.id) as c:
        r = await c.get("/settings/relevance")
    assert r.status_code == 200
    soup = BeautifulSoup(r.text, "html.parser")
    lst = soup.select_one("#filters #filters-list")
    assert lst is not None and f1.name in lst.get_text()
    assert soup.select_one('#filters a[href="/settings/filters/new"]') is not None
    radios = soup.select("#stories input[name=story_dedup][data-rf-autosave]")
    assert sorted(i["value"] for i in radios) == ["collapse", "collapse_suppress", "off"]
    assert [i["value"] for i in radios if i.has_attr("checked")] == ["collapse_suppress"]
    # The counter opens onto the list in suppress mode, even at zero.
    assert soup.select_one('#stories details[hx-get="/settings/relevance/hidden"]') is not None
    # The relevance form keeps its own fields and does not post story_dedup.
    form = soup.select_one('form[action="/settings/relevance"]')
    assert form is not None and form.select_one("[name=story_dedup]") is None


async def test_filters_list_uses_delayed_delete(env):
    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        names = [f"<b>one</b>-{uuid.uuid4().hex[:6]}", f"two-{uuid.uuid4().hex[:6]}"]
        flts = [Filter(user_id=user.id, name=n, is_active=True) for n in names]
        s.add_all(flts)
        await s.commit()

    async with _client(engine, user.id) as c:
        r = await c.get("/settings/relevance")
    assert r.status_code == 200
    soup = BeautifulSoup(r.text, "html.parser")
    lst = soup.select_one("#filters-list")
    for f in flts:
        key = f"filter:{f.id}"
        rows = lst.select(f'[data-rf-delete-key="{key}"]')
        assert len(rows) == 1
        triggers = lst.select(f'[data-rf-delete="{key}"]')
        assert len(triggers) == 1
        assert triggers[0]["data-rf-delete-label"] == f.name
        assert rows[0].select_one(f'[data-rf-delete="{key}"]') is triggers[0]
    assert lst.select(".swap-confirm") == []
    assert lst.select("[hx-delete]") == []
    assert "<b>one</b>" not in r.text  # the name is escaped, in text and attribute
    # RFPending keeps the list's empty text true after a delete: it is always rendered.
    assert lst.has_attr("data-rf-pending-list")
    empty = lst.select("[data-rf-pending-empty]")
    assert len(empty) == 1 and empty[0].has_attr("hidden")


async def test_filters_explained_once_and_separator_marked(env):
    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        await s.commit()

    async with _client(engine, user.id) as c:
        r = await c.get("/settings/relevance")
    assert r.status_code == 200
    soup = BeautifulSoup(r.text, "html.parser")
    card = soup.select_one("#filters")
    # With no filters, what a filter does is said once (the card), not again below it.
    assert card.get_text().count("when the conditions match") == 1
    assert "conditions\n      match" not in r.text and "when your conditions" not in r.text
    empty = card.select("#filters-list [data-rf-pending-empty]")
    assert len(empty) == 1 and not empty[0].has_attr("hidden")
    assert "No filters yet" in empty[0].get_text()
    assert empty[0].select_one('a[href="/settings/filters/new"]') is not None

    async with AsyncSession(engine, expire_on_commit=False) as s:
        regular = Filter(user_id=user.id, name=f"reg-{uuid.uuid4().hex[:6]}", is_active=True)
        late = Filter(user_id=user.id, name=f"late-{uuid.uuid4().hex[:6]}", is_active=True)
        late.conditions = [FilterCondition(field="ai_score", operator="gte", value="70", position=0)]
        s.add_all([regular, late])
        await s.commit()
    async with _client(engine, user.id) as c:
        r = await c.get("/settings/relevance")
    soup = BeautifulSoup(r.text, "html.parser")
    seps = soup.select("#filters-list [data-rf-pending-sep]")
    assert len(seps) == 1 and "Run after regular filters" in seps[0].get_text()
    # Toggled through the hidden attribute only (WR2-F2): no display class on it.
    assert not seps[0].get("class")


async def test_filter_create_and_update_redirect_to_relevance(env):
    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        await s.commit()
    name = f"redir-{uuid.uuid4().hex[:6]}"
    form = {"name": name, "is_active": "true", "match_operator": "AND", "position": "0",
            "cond_field": "title", "cond_operator": "contains", "cond_value": "x",
            "cond_position": "0", "cond_source": "", "action_type": "star", "action_value": ""}
    async with _client(engine, user.id) as c:
        r = await c.post("/settings/filters", data=form)
        assert r.status_code == 303
        assert r.headers["location"] == "/settings/relevance"
        async with AsyncSession(engine) as s:
            fid = await s.scalar(select(Filter.id).where(Filter.user_id == user.id, Filter.name == name))
        assert fid
        r = await c.post(f"/settings/filters/{fid}/edit", data={**form, "name": name + "-2"})
        assert r.status_code == 303
        assert r.headers["location"] == "/settings/relevance"
        # The editor goes back to the merged page, not the old list.
        r = await c.get(f"/settings/filters/{fid}/edit")
    # Within the page body: the settings nav is s7-T1's.
    main = BeautifulSoup(r.text, "html.parser").select_one("main")
    assert main.select_one('a[href="/settings/relevance#filters"]') is not None
    assert main.select_one('a[href="/settings/filters"]') is None


async def test_filter_new_prefill_from_feed(env):
    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        other = await _user(s, made)
        own = await _feed(s, made, user, title=f"Own {uuid.uuid4().hex[:6]}")
        foreign = await _feed(s, made, other, title=f"Foreign {uuid.uuid4().hex[:6]}")
        unsubscribed = await _feed(s, made, title=f"Gone {uuid.uuid4().hex[:6]}")
        await s.commit()

    def checked_scope(soup):
        return [i["value"] for i in soup.select("input[name=scope_include]") if i.has_attr("checked")]

    async with _client(engine, user.id) as c:
        r = await c.get(f"/settings/filters/new?feed={own.id}")
        assert r.status_code == 200
        soup = BeautifulSoup(r.text, "html.parser")
        assert checked_scope(soup) == [f"feed:{own.id}"]
        assert soup.select_one("input[name=name]")["value"] == own.title

        for bad in (str(foreign.id), "abc", "99999999999", str(unsubscribed.id), "", f" {own.id}", "9" * 5000):
            r = await c.get("/settings/filters/new", params={"feed": bad})
            assert r.status_code == 200, bad
            soup = BeautifulSoup(r.text, "html.parser")
            assert checked_scope(soup) == [], bad
            assert soup.select_one("input[name=name]").get("value", "") == "", bad
            assert foreign.title not in r.text
            assert unsubscribed.title not in r.text


async def test_hidden_stories_moved_to_relevance(env):
    engine, made = env
    now = datetime.now(timezone.utc)
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made, story_dedup="collapse_suppress")
        second = await _user(s, made, story_dedup="collapse_suppress")
        feed = await _feed(s, made, user, second)
        title = f"Kept out {uuid.uuid4().hex[:8]}"
        g = uuid.uuid4().hex
        art = Article(feed_id=feed.id, guid=g, guid_hash=g, title=title,
                      published_at=now, fetched_at=now)
        s.add(art)
        await s.flush()
        s.add(UserArticleState(user_id=user.id, article_id=art.id, is_read=True,
                               read_at=now, suppressed_at=now, hidden_at=now))
        await s.commit()

    async with _client(engine, user.id) as c:
        r = await c.get("/settings/relevance/hidden")
    assert r.status_code == 200
    assert title in r.text and f"open_article_id={art.id}" in r.text

    async with _client(engine, second.id) as c:
        r = await c.get("/settings/relevance/hidden")
    assert r.status_code == 200 and title not in r.text

    async with AsyncSession(engine) as s:
        row = await s.scalar(select(UserSettings).where(UserSettings.user_id == user.id))
        row.story_dedup = "collapse"
        await s.commit()
    async with _client(engine, user.id) as c:
        r = await c.get("/settings/relevance/hidden")
    assert r.status_code == 200 and title not in r.text

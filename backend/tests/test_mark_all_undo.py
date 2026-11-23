"""Mark all read answers with its stamp and count, and one mark-all can be undone by
that stamp (POST /htmx/articles/mark-read/undo). Real Postgres, real commits.

The routes commit on their own session, so the rolled-back-transaction pattern of
the other DB tests cannot hold them: every test writes rows with unique names and
removes them at the end (as tests/test_settings_deletes.py does).
"""
import json
import re
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
import pytest_asyncio
from fastapi import Depends
from sqlalchemy import delete, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.config import settings as app_settings
from app.models.article import SUPPRESSED_BY_BULK, Article, UserArticleState
from app.models.feed import Feed, Folder, UserFeed
from app.models.label import ArticleLabel, Label
from app.models.user import User
from app.services import saved_search_service as saved_svc

pytestmark = pytest.mark.integration

UNDO = "/htmx/articles/mark-read/undo"
STAMP_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}\+00:00$")


def _now():
    return datetime.now(timezone.utc)


@pytest_asyncio.fixture
async def env():
    """A test engine plus a record of what the test created, removed afterwards."""
    engine = create_async_engine(app_settings.database_url)
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception as exc:
        await engine.dispose()
        from tests.conftest import db_unreachable
        db_unreachable(exc)
    made = {"users": [], "feeds": [], "articles": []}
    try:
        yield engine, made
    finally:
        from app.main import app
        app.dependency_overrides.clear()
        async with AsyncSession(engine) as s:
            # articles.feed_id is SET NULL on a feed delete, so articles go first.
            if made["articles"]:
                await s.execute(delete(Article).where(Article.id.in_(made["articles"])))
            if made["users"]:
                await s.execute(delete(User).where(User.id.in_(made["users"])))
            if made["feeds"]:
                await s.execute(delete(Feed).where(Feed.id.in_(made["feeds"])))
            await s.commit()
        await engine.dispose()


async def _user(s, made):
    u = uuid.uuid4().hex
    user = User(email=f"mau_{u}@ex.invalid", password_hash="x", display_name=f"u-{u[:6]}")
    s.add(user)
    await s.flush()
    made["users"].append(user.id)
    return user


async def _feed(s, made, *subscribers, folder_id=None):
    u = uuid.uuid4().hex
    feed = Feed(feed_url=f"https://ex.invalid/{u}.xml", title=f"f-{u[:6]}", subscriber_count=1)
    s.add(feed)
    await s.flush()
    made["feeds"].append(feed.id)
    for user in subscribers:
        s.add(UserFeed(user_id=user.id, feed_id=feed.id, folder_id=folder_id))
    await s.flush()
    return feed


async def _art(s, made, feed, *, minutes_ago=60):
    g = uuid.uuid4().hex
    when = _now() - timedelta(minutes=minutes_ago)
    a = Article(feed_id=feed.id, guid=g, guid_hash=g, title=f"t-{g[:6]}", content="<p>x</p>",
                readable_status="success", published_at=when, fetched_at=when)
    s.add(a)
    await s.flush()
    made["articles"].append(a.id)
    return a


def _client(engine, user_id):
    """An app client whose user is loaded through the request's own session."""
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


async def _states(engine, user, articles):
    """{article id: (is_read, read_at, suppressed_by)} for *user*, None without a row."""
    async with AsyncSession(engine) as s:
        rows = (await s.execute(select(UserArticleState).where(
            UserArticleState.user_id == user.id,
            UserArticleState.article_id.in_([a.id for a in articles]),
        ))).scalars().all()
        found = {r.article_id: (r.is_read, r.read_at, r.suppressed_by) for r in rows}
    return {a.id: found.get(a.id) for a in articles}


def _is_read(states, article):
    return bool(states[article.id] and states[article.id][0])


def _marked(resp):
    trigger = json.loads(resp.headers["HX-Trigger"])
    assert trigger["sidebarRefresh"] is True
    return trigger["rf:markedall"]


async def test_undo_restores_only_the_callers_bulk_rows_of_that_stamp(env):
    """undo: restores only the caller's bulk rows of that stamp."""
    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        a_user = await _user(s, made)
        b_user = await _user(s, made)
        feed = await _feed(s, made, a_user, b_user)
        bulk1, bulk2, later_read, hand_read = [await _art(s, made, feed) for _ in range(4)]
        hand_at = _now() - timedelta(minutes=30)
        s.add(UserArticleState(user_id=a_user.id, article_id=hand_read.id,
                               is_read=True, read_at=hand_at))
        for art in (bulk1, bulk2):
            s.add(UserArticleState(user_id=b_user.id, article_id=art.id, is_read=False))
        await s.commit()

    async with _client(engine, a_user.id) as c:
        r = await c.post(f"/htmx/feeds/{feed.id}/mark-read",
                         data={"before": _now().isoformat()})
    assert r.status_code == 200
    marked = _marked(r)
    assert marked["count"] == 3
    stamp = datetime.fromisoformat(marked["stamp"])

    async with AsyncSession(engine) as s:
        # B's rows look exactly like a bulk mark of the same instant.
        await s.execute(update(UserArticleState).where(
            UserArticleState.user_id == b_user.id,
        ).values(is_read=True, read_at=stamp, suppressed_at=stamp,
                 suppressed_by=SUPPRESSED_BY_BULK))
        # A reads one properly afterwards: the dwell handler takes the stamp off.
        await s.execute(update(UserArticleState).where(
            UserArticleState.user_id == a_user.id,
            UserArticleState.article_id == later_read.id,
        ).values(read_at=stamp + timedelta(seconds=5), suppressed_at=None, suppressed_by=None))
        await s.commit()

    async with _client(engine, a_user.id) as c:
        r = await c.post(UNDO, data={"stamp": marked["stamp"]})
    assert r.status_code == 200
    assert json.loads(r.headers["HX-Trigger"])["showToast"]["msg"] == "Restored 2"

    arts = [bulk1, bulk2, later_read, hand_read]
    a_states = await _states(engine, a_user, arts)
    assert a_states[bulk1.id] == (False, None, None)
    assert a_states[bulk2.id] == (False, None, None)
    assert _is_read(a_states, later_read)
    assert a_states[hand_read.id] == (True, hand_at, None)
    b_states = await _states(engine, b_user, [bulk1, bulk2])
    assert b_states[bulk1.id] == (True, stamp, SUPPRESSED_BY_BULK)
    assert b_states[bulk2.id] == (True, stamp, SUPPRESSED_BY_BULK)


SCOPES = ["all", "starred", "label", "feed", "folder", "saved"]


@pytest.mark.parametrize("scope", SCOPES)
async def test_mark_all_every_route_returns_stamp_and_count_and_keeps_sidebar_refresh(env, scope):
    """mark-all: every route returns stamp and count and keeps sidebarRefresh."""
    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        folder = Folder(user_id=user.id, name=f"fo-{uuid.uuid4().hex[:6]}")
        s.add(folder)
        await s.flush()
        in_folder = await _feed(s, made, user, folder_id=folder.id)
        loose = await _feed(s, made, user)
        unsubscribed = await _feed(s, made)
        label = Label(user_id=user.id, name=f"l-{uuid.uuid4().hex[:6]}")
        s.add(label)
        await s.flush()
        # In every scope: two unread, one already read, one fetched after `before`.
        hits = [await _art(s, made, in_folder) for _ in range(2)]
        already = await _art(s, made, in_folder)
        too_new = await _art(s, made, in_folder, minutes_ago=-10)
        # Outside every scope but "all" (a subscribed feed, not starred, no label).
        other = await _art(s, made, loose)
        # Outside every scope.
        foreign = await _art(s, made, unsubscribed)
        for art in (*hits, already, too_new):
            s.add(UserArticleState(user_id=user.id, article_id=art.id,
                                   is_read=art is already, is_starred=True))
            s.add(ArticleLabel(user_id=user.id, article_id=art.id, label_id=label.id))
        saved = await saved_svc.create_saved_search(
            s, user.id, name=f"s-{uuid.uuid4().hex[:6]}",
            params={"scope_include": [f"feed:{in_folder.id}"]},
        )
        await s.commit()

    before = _now().isoformat()
    url, data, expected = {
        "all": ("/htmx/articles/mark-read", {}, 3),
        "starred": ("/htmx/articles/mark-read", {"starred_only": "1"}, 2),
        "label": ("/htmx/articles/mark-read", {"label_id": str(label.id)}, 2),
        "feed": (f"/htmx/feeds/{in_folder.id}/mark-read", {}, 2),
        "folder": (f"/htmx/folders/{folder.id}/mark-read", {}, 2),
        "saved": (f"/htmx/saved-searches/{saved.id}/mark-read", {}, 2),
    }[scope]
    async with _client(engine, user.id) as c:
        r = await c.post(url, data={"before": before, **data})
    assert r.status_code == 200
    marked = _marked(r)
    assert STAMP_RE.match(marked["stamp"]), marked["stamp"]
    assert marked["count"] == expected

    stamp = datetime.fromisoformat(marked["stamp"])
    arts = [*hits, already, too_new, other, foreign]
    states = await _states(engine, user, arts)
    changed = [a for a in arts if states[a.id] and states[a.id][1] == stamp
               and states[a.id][2] == SUPPRESSED_BY_BULK]
    assert len(changed) == marked["count"]
    assert not _is_read(states, too_new) and states[foreign.id] is None

    if scope == "saved":
        assert r.text == ""
    else:
        assert r.text.startswith('<span class="mark-read-badge'), r.text


async def test_undo_the_stamp_round_trips_as_text_and_a_repeat_changes_nothing(env):
    """undo: the stamp round-trips as text and a repeat changes nothing."""
    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        feed = await _feed(s, made, user)
        arts = [await _art(s, made, feed) for _ in range(2)]
        await s.commit()

    async with _client(engine, user.id) as c:
        r = await c.post(f"/htmx/feeds/{feed.id}/mark-read", data={"before": _now().isoformat()})
        # The exact text of the header, not a value rebuilt from a parsed date.
        raw = re.search(r'"stamp":\s*"([^"]+)"', r.headers["HX-Trigger"]).group(1)
        first = await c.post(UNDO, data={"stamp": raw})
        after_first = await _states(engine, user, arts)
        second = await c.post(UNDO, data={"stamp": raw})
        after_second = await _states(engine, user, arts)

    assert _marked(r)["count"] == 2
    assert first.status_code == 200 and first.text == ""
    assert json.loads(first.headers["HX-Trigger"]) == {
        "sidebarRefresh": True, "showToast": {"msg": "Restored 2", "type": "ok"}}
    assert all(v[0] is False for v in after_first.values())
    assert second.status_code == 200 and second.text == ""
    assert json.loads(second.headers["HX-Trigger"])["showToast"]["msg"] == "Nothing to restore"
    assert after_second == after_first


@pytest.mark.parametrize("case", ["stale", "future", "naive", "garbled", "missing"])
async def test_undo_stale_future_naive_and_garbled_stamps_are_refused(env, case):
    """undo: stale, future, naive and garbled stamps are refused."""
    engine, made = env
    now = _now()
    at = {"stale": now - timedelta(minutes=11), "future": now + timedelta(minutes=2)}.get(case, now)
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        feed = await _feed(s, made, user)
        art = await _art(s, made, feed)
        s.add(UserArticleState(user_id=user.id, article_id=art.id, is_read=True, read_at=at,
                               suppressed_at=at, suppressed_by=SUPPRESSED_BY_BULK))
        await s.commit()

    stamp = at.isoformat(timespec="microseconds")
    data = {
        "naive": {"stamp": at.replace(tzinfo=None).isoformat(timespec="microseconds")},
        "garbled": {"stamp": "x"},
        "missing": {},
    }.get(case, {"stamp": stamp})
    async with _client(engine, user.id) as c:
        r = await c.post(UNDO, data=data)

    expected = {"stale": 410, "future": 410, "naive": 400, "garbled": 400, "missing": 422}[case]
    assert r.status_code == expected
    if case == "stale":
        assert json.loads(r.headers["HX-Trigger"]) == {
            "showToast": {"msg": "Too late to undo", "type": "info"}}
    if expected in (400, 410):
        assert r.text == ""
    assert (await _states(engine, user, [art]))[art.id] == (True, at, SUPPRESSED_BY_BULK)

"""Batch delete route POST /settings/deletes (real Postgres, real commits).

The delete services commit per item and the route rolls back a failed item, so the
rolled-back-transaction pattern of the other DB tests cannot hold these: every test
writes real rows with unique names and removes them at the end.
"""
import asyncio
import json
import uuid
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import httpx
import pytest
import pytest_asyncio
from fastapi import Depends
from sqlalchemy import delete, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.config import settings as app_settings
from app.models.feed import Feed, UserFeed
from app.models.filter import Filter, FilterAction
from app.models.label import Label
from app.models.user import User

pytestmark = pytest.mark.integration

URL = "/settings/deletes"


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
    made = {"users": [], "feeds": []}
    try:
        yield engine, made
    finally:
        from app.main import app
        app.dependency_overrides.clear()
        async with AsyncSession(engine) as s:
            if made["users"]:
                await s.execute(delete(User).where(User.id.in_(made["users"])))
            if made["feeds"]:
                await s.execute(delete(Feed).where(Feed.id.in_(made["feeds"])))
            await s.commit()
        await engine.dispose()


async def _user(s, made):
    u = uuid.uuid4().hex
    user = User(email=f"{u}@ex.invalid", password_hash="x", display_name=f"u-{u[:6]}")
    s.add(user)
    await s.flush()
    made["users"].append(user.id)
    return user


async def _feed(s, made, user):
    """A subscription. A spare Feed goes in first so Feed.id and UserFeed.id differ:
    the route takes the UserFeed id, scope tokens carry the Feed id."""
    u = uuid.uuid4().hex
    spare = Feed(feed_url=f"https://ex.invalid/spare-{u}.xml", title="spare", subscriber_count=0)
    feed = Feed(feed_url=f"https://ex.invalid/{u}.xml", title="t", subscriber_count=1)
    s.add_all([spare, feed])
    await s.flush()
    made["feeds"] += [spare.id, feed.id]
    uf = UserFeed(user_id=user.id, feed_id=feed.id)
    s.add(uf)
    await s.flush()
    return feed, uf


async def _label(s, user, name="lab"):
    lab = Label(user_id=user.id, name=f"{name}-{uuid.uuid4().hex[:6]}")
    s.add(lab)
    await s.flush()
    return lab


async def _filter(s, user, name="f", include=None, actions=()):
    f = Filter(user_id=user.id, name=name, is_active=True,
               scope_include=json.dumps(include) if include else None)
    f.actions = [FilterAction(action_type=t, action_value=v) for t, v in actions]
    s.add(f)
    await s.flush()
    return f


def _client(engine, user_id):
    """An app client whose user is loaded through the request's own session, as
    get_current_user does in production (a rollback expires it there too)."""
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


async def _exists(engine, model, id_):
    async with AsyncSession(engine) as s:
        return await s.get(model, id_) is not None


async def test_mixed_batch_deletes_each_item_and_reports_done(env, monkeypatch):
    """deletes: mixed batch deletes each item and reports done (and runs inside batch_lock)."""
    from app.routers.web.settings import deletes

    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        feed, uf = await _feed(s, made, user)
        lab = await _label(s, user)
        flt = await _filter(s, user, actions=[("star", None)])
        await s.commit()

    real_lock, real_unsub, real_label, real_filter = (
        deletes.batch_lock, deletes.unsubscribe, deletes.delete_label, deletes.delete_filter)
    seen, held, calls = [], [False], []

    @asynccontextmanager
    async def spy(eng, uid):
        seen.append(uid)
        async with real_lock(eng, uid):
            held[0] = True
            try:
                yield
            finally:
                held[0] = False

    def under_lock(name, real):
        async def wrapped(*a):
            calls.append((name, held[0]))
            return await real(*a)
        return wrapped

    monkeypatch.setattr(deletes, "batch_lock", spy)
    monkeypatch.setattr(deletes, "unsubscribe", under_lock("feed", real_unsub))
    monkeypatch.setattr(deletes, "delete_label", under_lock("label", real_label))
    monkeypatch.setattr(deletes, "delete_filter", under_lock("filter", real_filter))
    items = [{"kind": "feed", "id": uf.id}, {"kind": "label", "id": lab.id},
             {"kind": "filter", "id": flt.id}]
    async with _client(engine, user.id) as c:
        r = await c.post(URL, json=items)

    assert r.status_code == 200
    body = r.json()
    assert body == {"results": [{**i, "status": "done"} for i in items], "notices": []}
    assert "hx-trigger" not in r.headers
    assert seen == [user.id]
    assert calls == [("feed", True), ("label", True), ("filter", True)]
    assert not await _exists(engine, UserFeed, uf.id)
    assert not await _exists(engine, Label, lab.id)
    assert not await _exists(engine, Filter, flt.id)


async def test_foreign_and_missing_ids_are_done_and_change_nothing(env):
    """deletes: foreign and missing ids are done and change nothing."""
    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        me = await _user(s, made)
        other = await _user(s, made)
        _, uf = await _feed(s, made, other)
        lab = await _label(s, other)
        flt = await _filter(s, other)
        await s.commit()

    items = [{"kind": "feed", "id": uf.id}, {"kind": "label", "id": lab.id},
             {"kind": "filter", "id": flt.id}, {"kind": "filter", "id": 2_000_000_000}]
    async with _client(engine, me.id) as c:
        r = await c.post(URL, json=items)

    assert r.status_code == 200
    assert [x["status"] for x in r.json()["results"]] == ["done"] * 4
    assert await _exists(engine, UserFeed, uf.id)
    assert await _exists(engine, Label, lab.id)
    assert await _exists(engine, Filter, flt.id)


async def test_failing_item_does_not_undo_the_others(env, monkeypatch):
    """deletes: a failing item does not undo the others; items after it still run."""
    from app.routers.web.settings import deletes

    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        bad = await _filter(s, user, name="bad")
        good = await _filter(s, user, name="good")
        lab = await _label(s, user)
        _, uf = await _feed(s, made, user)
        await s.commit()

    real = deletes.delete_filter

    async def flaky(user_id, filter_id, db):
        if filter_id == bad.id:
            await db.execute(text("SELECT 1"))  # leave the session mid-transaction
            raise RuntimeError("boom")
        return await real(user_id, filter_id, db)

    monkeypatch.setattr(deletes, "delete_filter", flaky)
    items = [{"kind": "filter", "id": good.id}, {"kind": "filter", "id": bad.id},
             {"kind": "label", "id": lab.id}, {"kind": "feed", "id": uf.id}]
    async with _client(engine, user.id) as c:
        r = await c.post(URL, json=items)

    assert r.status_code == 200
    assert [x["status"] for x in r.json()["results"]] == ["done", "failed", "done", "done"]
    assert not await _exists(engine, Filter, good.id)
    assert await _exists(engine, Filter, bad.id)
    assert not await _exists(engine, Label, lab.id)
    assert not await _exists(engine, UserFeed, uf.id)


async def test_unsubscribing_both_feeds_of_a_filter_scope(env):
    """deletes: unsubscribing both feeds of a filter scope leaves the filter
    deactivated and not pointing at a deleted feed."""
    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        fa, ua = await _feed(s, made, user)
        fb, ub = await _feed(s, made, user)
        assert fa.id != ua.id
        flt = await _filter(s, user, name="two-feeds",
                            include=[f"feed:{fa.id}", f"feed:{fb.id}"])
        await s.commit()

    async with _client(engine, user.id) as c:
        r = await c.post(URL, json=[{"kind": "feed", "id": ua.id}, {"kind": "feed", "id": ub.id}])

    assert r.status_code == 200
    assert [x["status"] for x in r.json()["results"]] == ["done", "done"]
    async with AsyncSession(engine) as s:
        f = await s.get(Filter, flt.id)
        assert f.is_active is False
        assert f.scope_include is None
    notices = r.json()["notices"]
    assert len(notices) == 1 and notices[0]["type"] == "warning"
    assert "two-feeds" in notices[0]["msg"]


async def test_notices_come_back_as_a_list_under_show_toast(env):
    """deletes: notices come back as a list under showToast."""
    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        feed, uf = await _feed(s, made, user)
        await _filter(s, user, name="Только-фид", include=[f"feed:{feed.id}"])
        lab = await _label(s, user)
        await _filter(s, user, name="only-label", actions=[("label", str(lab.id))])
        await s.commit()

    async with _client(engine, user.id) as c:
        r = await c.post(URL, json=[{"kind": "feed", "id": uf.id}, {"kind": "label", "id": lab.id}])

    assert r.status_code == 200
    notices = r.json()["notices"]
    assert len(notices) == 2
    assert all(set(n) == {"msg", "type"} and n["type"] == "warning" for n in notices)
    assert "Только-фид" in notices[0]["msg"]
    assert notices[1]["msg"] == (
        "Turned off 1 filter whose only action was this label: only-label.")
    trigger = r.headers["hx-trigger"]
    trigger.encode("ascii")  # header stays ASCII for non-Latin names
    assert json.loads(trigger) == {"showToast": notices}


async def test_unauthenticated_gets_401_json(env):
    """deletes: unauthenticated gets 401 JSON (no redirect); a session cookie without
    x-csrftoken is refused with 403."""
    from app.database import get_db
    from app.main import app

    async def _db():
        yield AsyncMock()

    app.dependency_overrides[get_db] = _db
    body = [{"kind": "filter", "id": 1}]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://localhost") as c:
        plain = await c.post(URL, json=body)
        htmx = await c.post(URL, json=body, headers={"HX-Request": "true"})
        c.cookies.set("session", "x")
        csrf = await c.post(URL, json=body)

    for r in (plain, htmx):
        assert r.status_code == 401
        assert "location" not in r.headers and "hx-redirect" not in r.headers
        assert r.headers["content-type"].startswith("application/json")
        assert r.json() == {"detail": "Not authenticated"}
    assert csrf.status_code == 403


async def test_malformed_body_is_422(env):
    """deletes: malformed body is 422."""
    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        await s.commit()

    bad_bodies = [
        [],
        [{"kind": "filter", "id": i} for i in range(1, 52)],
        [{"kind": "folder", "id": 1}],
        [{"kind": "filter", "id": 0}],
        [{"kind": "filter", "id": -3}],
        [{"kind": "filter", "id": "7"}],
        [{"kind": "filter", "id": True}],
        [{"kind": "filter", "id": 2**31}],
        [{"kind": "filter"}],
        {"kind": "filter", "id": 1},
    ]
    async with _client(engine, user.id) as c:
        codes = [(await c.post(URL, json=b)).status_code for b in bad_bodies]
        not_json = await c.post(URL, content=b"nope", headers={"content-type": "application/json"})
        fifty = await c.post(URL, json=[{"kind": "filter", "id": i} for i in range(1, 51)])

    assert codes == [422] * len(bad_bodies)
    assert not_json.status_code == 422
    assert fifty.status_code == 200


async def test_concurrent_batches_are_serialised(env):
    """deletes: concurrent batches are serialised, another user is not blocked, and
    the lock is released afterwards."""
    from app.routers.web.settings.deletes import DELETE_BATCH_LOCK_NS, batch_lock

    engine, _ = env
    uid, other_uid = 2_000_000_001, 2_000_000_002
    events = []

    async def hold(name, user_id):
        async with batch_lock(engine, user_id):
            events.append(("enter", name, asyncio.get_running_loop().time()))
            await asyncio.sleep(0.2)
            events.append(("exit", name, asyncio.get_running_loop().time()))

    await asyncio.gather(hold("a", uid), hold("b", uid), hold("c", other_uid))

    spans = {}
    for kind, name, t in events:
        spans.setdefault(name, {})[kind] = t
    a, b, c = spans["a"], spans["b"], spans["c"]
    assert a["exit"] <= b["enter"] or b["exit"] <= a["enter"]
    first = min(a["enter"], b["enter"])
    # The other user's holder ran alongside the first, not after both.
    assert c["enter"] < first + 0.15

    async with engine.connect() as conn:
        got = (await conn.execute(text("SELECT pg_try_advisory_lock(:ns, :uid)"),
                                  {"ns": DELETE_BATCH_LOCK_NS, "uid": uid})).scalar()
        assert got is True
        await conn.execute(text("SELECT pg_advisory_unlock(:ns, :uid)"),
                           {"ns": DELETE_BATCH_LOCK_NS, "uid": uid})

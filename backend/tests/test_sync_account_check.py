"""Every /sync/v1 request names the device database's reader (X-Readfine-User).

A tab of reader A still open after B signed in elsewhere in the same browser carries B's
session cookie. Without the check, A's queued ops would be applied to B's account and
B's articles written into A's device database (design 5.7: the stored and the signed-in
user are compared on every start and every sync). Missing or different header → 409
``{"error": "account_mismatch"}`` before any handler runs; no session stays 401.
"""
import httpx
import pytest
from sqlalchemy import select

from app.models.article import UserArticleState
from app.models.sync import SyncAppliedOp
from tests.test_sync_manifest import _article, _feed, _user, pg  # noqa: F401
from tests.test_sync_ops import _app, _now, _op

pytestmark = pytest.mark.integration


async def _calls(c, art_id):
    body = {"client_time": _now().isoformat(), "ops": [_op("star", art_id)]}
    return {
        "ops": await c.post("/sync/v1/ops", json=body),
        "manifest": await c.get("/sync/v1/manifest"),
        "articles": await c.post("/sync/v1/articles", json={"ids": [art_id]}),
        "lists": await c.get("/sync/v1/lists"),
        "snapshots": await c.get("/sync/v1/snapshots", params={"ids": str(art_id)}),
    }


@pytest.mark.parametrize("header", [None, "", "999999999", "abc"])
async def test_mismatched_or_missing_reader_is_refused_and_applies_nothing(pg, header):
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user))
    app = await _app(pg, user)
    headers = {} if header is None else {"X-Readfine-User": header}
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost",
                                     headers=headers) as c:
            got = await _calls(c, art.id)
    finally:
        app.dependency_overrides.clear()
    for name, resp in got.items():
        assert resp.status_code == 409, name
        assert resp.json() == {"error": "account_mismatch"}, name
        assert resp.headers["cache-control"] == "no-store", name
    # The star op was never applied, nor recorded as applied.
    state = await pg.scalar(select(UserArticleState).where(
        UserArticleState.user_id == user.id, UserArticleState.article_id == art.id))
    assert state is None or not state.is_starred
    assert await pg.scalar(select(SyncAppliedOp).where(SyncAppliedOp.user_id == user.id)) is None


async def test_matching_reader_is_served(pg):
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user))
    app = await _app(pg, user)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost",
                                     headers={"X-Readfine-User": str(user.id)}) as c:
            got = await _calls(c, art.id)
    finally:
        app.dependency_overrides.clear()
    for name, resp in got.items():
        assert resp.status_code == 200, name
    assert got["ops"].json()["results"][0]["status"] == "applied"


def test_no_session_is_still_401_first(unauth_client):
    for path in ("/sync/v1/manifest", "/sync/v1/lists"):
        resp = unauth_client.get(path, headers={"X-Readfine-User": "1"})
        assert resp.status_code == 401
        resp = unauth_client.get(path)
        assert resp.status_code == 401

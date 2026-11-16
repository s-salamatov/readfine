"""Offline action replay (POST /sync/v1/ops), against the real database (rolled back)."""
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.models.article import Article, ArticleAiJob, UserArticleState
from app.models.label import ArticleLabel, Label
from app.models.saved_search import SavedSearch
from app.models.settings import AppSettings
from app.models.sync import SyncAppliedOp
from app.models.user import UserSettings
from app.schemas.sync import SyncOpsRequest
from app.services.sync.ops import apply_ops
from tests.test_sync_manifest import _article, _feed, _state, _user, pg  # noqa: F401

pytestmark = pytest.mark.integration

LONG_TEXT = "word " * 400


def _now():
    return datetime.now(timezone.utc)


def _op(type_, article_id=None, at=None, **value):
    return {"op_id": str(uuid.uuid4()), "type": type_, "article_id": article_id,
            "value": value, "at": (at or _now()).isoformat()}


async def _run(pg, user, ops, client_time=None):
    req = SyncOpsRequest(client_time=client_time or _now(), ops=ops)
    return await apply_ops(user, req, pg)


async def _state_of(pg, user, art):
    return await pg.scalar(select(UserArticleState).where(
        UserArticleState.user_id == user.id, UserArticleState.article_id == art.id,
    ).execution_options(populate_existing=True))


async def test_read_op_applied_and_returns_state(pg):
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user))
    out = await _run(pg, user, [_op("read", art.id)])
    assert "server_time" in out
    (res,) = out["results"]
    assert res["status"] == "applied" and res["reason"] is None
    # A read, unkept article is outside the offline scope; the result still carries it.
    assert res["article"]["id"] == art.id and res["article"]["is_read"] is True
    assert (await _state_of(pg, user, art)).is_read is True


async def test_replayed_op_returns_stored_result_without_reapplying(pg):
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user))
    op = _op("dwell", art.id, seconds=20)
    first = await _run(pg, user, [op])
    second = await _run(pg, user, [op])
    assert first["results"] == second["results"]
    assert (await _state_of(pg, user, art)).dwell_seconds == 20
    stored = await pg.scalar(select(SyncAppliedOp).where(SyncAppliedOp.user_id == user.id))
    assert stored.result["status"] == "applied"


async def test_ops_applied_in_order(pg):
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user))
    t0 = _now() - timedelta(minutes=30)
    out = await _run(pg, user, [
        _op("star", art.id, at=t0),
        _op("unstar", art.id, at=t0 + timedelta(seconds=5)),
        _op("label_add", art.id, at=t0, label_id=(lab := await _label(pg, user)).id),
        _op("label_remove", art.id, at=t0 + timedelta(seconds=5), label_id=lab.id),
    ])
    assert [r["status"] for r in out["results"]] == ["applied"] * 4
    assert (await _state_of(pg, user, art)).is_starred is False
    assert out["results"][-1]["article"]["label_ids"] == []


async def _label(pg, user):
    lab = Label(user_id=user.id, name=f"l{uuid.uuid4().hex[:6]}")
    pg.add(lab)
    await pg.flush()
    return lab


async def test_toggle_skipped_when_server_changed_later(pg):
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user))
    await _state(pg, user, art, is_starred=True)
    # The server-side star happened after the device's unstar.
    await pg.execute(update(UserArticleState).where(
        UserArticleState.user_id == user.id, UserArticleState.article_id == art.id,
    ).values(star_changed_at=_now()))
    out = await _run(pg, user, [_op("unstar", art.id, at=_now() - timedelta(hours=1))])
    (res,) = out["results"]
    assert res["status"] == "skipped" and res["reason"] == "conflict"
    assert res["article"]["is_starred"] is True
    assert (await _state_of(pg, user, art)).is_starred is True


async def test_label_remove_skipped_when_assigned_later(pg):
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user))
    lab = await _label(pg, user)
    pg.add(ArticleLabel(user_id=user.id, article_id=art.id, label_id=lab.id, assigned_at=_now()))
    await pg.flush()
    out = await _run(pg, user, [_op("label_remove", art.id, at=_now() - timedelta(hours=1), label_id=lab.id)])
    assert out["results"][0]["status"] == "skipped" and out["results"][0]["reason"] == "conflict"


async def test_clock_skew_corrected(pg):
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user))
    await _state(pg, user, art, is_starred=True)
    await pg.execute(update(UserArticleState).where(
        UserArticleState.user_id == user.id, UserArticleState.article_id == art.id,
    ).values(star_changed_at=_now() - timedelta(minutes=10)))
    # The device clock is 2 h behind: its "5 minutes ago" is 2 h 5 min ago in server time.
    client_now = _now() - timedelta(hours=2)
    out = await _run(pg, user, [_op("unstar", art.id, at=client_now - timedelta(minutes=5))],
                     client_time=client_now)
    assert out["results"][0]["status"] == "applied"
    assert (await _state_of(pg, user, art)).is_starred is False


async def test_mark_scope_read_respects_max_article_id(pg):
    user = await _user(pg)
    feed = await _feed(pg, user)
    old = await _article(pg, feed, age_hours=3)
    newer = await _article(pg, feed, age_hours=2)  # arrived after the device's last sync
    out = await _run(pg, user, [_op("mark_scope_read", feed_id=feed.id, max_article_id=old.id)])
    assert out["results"][0]["status"] == "applied"
    assert (await _state_of(pg, user, old)).is_read is True
    s = await _state_of(pg, user, newer)
    assert s is None or s.is_read is False


async def test_mark_scope_read_saved_search(pg):
    user = await _user(pg)
    feed = await _feed(pg, user)
    a, b = await _article(pg, feed, age_hours=3), await _article(pg, feed, age_hours=2)
    search = SavedSearch(user_id=user.id, name="s", params={})
    pg.add(search)
    await pg.flush()
    out = await _run(pg, user, [_op("mark_scope_read", saved_search_id=search.id, max_article_id=a.id)])
    assert out["results"][0]["status"] == "applied"
    assert (await _state_of(pg, user, a)).is_read is True
    s = await _state_of(pg, user, b)
    assert s is None or s.is_read is False


async def test_mark_scope_read_unknown_saved_search_fails(pg):
    user, other = await _user(pg), await _user(pg)
    search = SavedSearch(user_id=other.id, name="s", params={})
    pg.add(search)
    await pg.flush()
    out = await _run(pg, user, [_op("mark_scope_read", saved_search_id=search.id, max_article_id=1)])
    assert out["results"][0] == {**out["results"][0], "status": "failed", "reason": "not_found"}


async def test_save_url_op_creates_saved_article(pg):
    user = await _user(pg)

    def _swallow(coro, **_kw):
        coro.close()
        return MagicMock()

    with patch("app.utils.url_validator.async_validate_feed_url", AsyncMock()), \
         patch("app.services.saved_article_service.spawn_background", MagicMock(side_effect=_swallow)):
        out = await _run(pg, user, [_op("save_url", url="https://example.com/offline-1", title="Read later")])
    (res,) = out["results"]
    assert res["status"] == "applied"
    assert res["article"]["url"] == "https://example.com/offline-1"
    assert res["article"]["saved_at"] is not None


async def test_save_url_op_bad_url_fails(pg):
    user = await _user(pg)
    out = await _run(pg, user, [_op("save_url", url="ftp://nope")])
    assert out["results"][0]["status"] == "failed" and out["results"][0]["reason"] == "invalid_url"


async def _enable_ai(pg, user):
    await pg.execute(pg_insert(AppSettings).values(id=1, ai_enabled=True)
                     .on_conflict_do_update(index_elements=["id"], set_={"ai_enabled": True}))
    pg.add(UserSettings(user_id=user.id, ai_quality_provider="anthropic", ai_quality_model="m"))
    await pg.flush()


async def test_ai_summary_op_enqueues_job(pg):
    user = await _user(pg)
    await _enable_ai(pg, user)
    art = await _article(pg, await _feed(pg, user), content=LONG_TEXT)
    out = await _run(pg, user, [_op("ai_summary", art.id)])
    assert out["results"][0]["status"] == "applied"
    job = await pg.scalar(select(ArticleAiJob).where(
        ArticleAiJob.article_id == art.id, ArticleAiJob.user_id == user.id,
        ArticleAiJob.operation == "summary"))
    assert job is not None and job.status == "pending"


async def test_ai_context_op_enqueues_job_and_resets_finished_one(pg):
    user = await _user(pg)
    await _enable_ai(pg, user)
    art = await _article(pg, await _feed(pg, user), content=LONG_TEXT)
    pg.add(ArticleAiJob(article_id=art.id, user_id=user.id, operation="context", status="success"))
    await pg.flush()
    out = await _run(pg, user, [_op("ai_context", art.id)])
    assert out["results"][0]["status"] == "applied"
    job = await pg.scalar(select(ArticleAiJob).where(
        ArticleAiJob.article_id == art.id, ArticleAiJob.user_id == user.id,
        ArticleAiJob.operation == "context").execution_options(populate_existing=True))
    assert job.status == "pending"


async def test_ai_op_skipped_when_ai_unavailable(pg):
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user), content=LONG_TEXT)
    await pg.execute(pg_insert(AppSettings).values(id=1, ai_enabled=False)
                     .on_conflict_do_update(index_elements=["id"], set_={"ai_enabled": False}))
    out = await _run(pg, user, [_op("ai_summary", art.id), _op("ai_context", art.id)])
    assert [(r["status"], r["reason"]) for r in out["results"]] == [("skipped", "ai_unavailable")] * 2


async def test_extract_readable_op_queues_extraction(pg):
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user), url="https://example.com/x")
    out = await _run(pg, user, [_op("extract_readable", art.id)])
    assert out["results"][0]["status"] == "applied"
    a = await pg.get(Article, art.id, populate_existing=True)
    assert a.readable_status == "pending" and a.readable_next_retry_at is not None


async def test_share_unsave_dwell_link_opened_ops(pg):
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user))
    await _state(pg, user, art, saved_at=_now() - timedelta(days=1), is_read=True)
    await pg.execute(update(UserArticleState).where(
        UserArticleState.user_id == user.id, UserArticleState.article_id == art.id,
    ).values(saved_changed_at=_now() - timedelta(days=1)))
    out = await _run(pg, user, [
        _op("share", art.id), _op("share", art.id),  # second is a no-op: already shared
        _op("dwell", art.id, seconds=40), _op("link_opened", art.id),
        _op("unsave", art.id, at=_now() - timedelta(minutes=1)),
    ])
    assert [r["status"] for r in out["results"]] == ["applied"] * 5
    s = await _state_of(pg, user, art)
    assert s.share_token and out["results"][1]["article"]["share_token"] == s.share_token
    assert s.dwell_seconds == 40 and s.link_opened is True and s.saved_at is None


async def test_op_on_deleted_article_fails_not_found(pg):
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user))
    await pg.execute(delete(Article).where(Article.id == art.id))
    out = await _run(pg, user, [_op("read", art.id), _op("unsave", art.id), _op("link_opened", art.id)])
    assert [(r["status"], r["reason"], r["article"]) for r in out["results"]] == [("failed", "not_found", None)] * 3


async def test_other_users_article_fails_not_found(pg):
    user, other = await _user(pg), await _user(pg)
    theirs = await _article(pg, await _feed(pg, other))
    lab = await _label(pg, user)
    out = await _run(pg, user, [
        _op("star", theirs.id), _op("label_add", theirs.id, label_id=lab.id),
        _op("share", theirs.id), _op("dwell", theirs.id, seconds=30), _op("ai_summary", theirs.id),
    ])
    assert all(r["status"] == "failed" and r["reason"] == "not_found" for r in out["results"])
    assert await pg.scalar(select(UserArticleState).where(UserArticleState.user_id == user.id)) is None


async def test_one_failing_op_does_not_roll_back_others(pg):
    user = await _user(pg)
    feed = await _feed(pg, user)
    a, b = await _article(pg, feed), await _article(pg, feed)
    boom = AsyncMock(side_effect=RuntimeError("boom"))
    with patch("app.services.sync.ops.add_dwell", boom):
        out = await _run(pg, user, [_op("read", a.id), _op("dwell", a.id, seconds=30), _op("star", b.id)])
    assert [r["status"] for r in out["results"]] == ["applied", "failed", "applied"]
    assert out["results"][1]["reason"] == "error" and out["results"][1]["retryable"] is True
    assert out["results"][0]["retryable"] is False
    assert (await _state_of(pg, user, a)).is_read is True
    assert (await _state_of(pg, user, b)).is_starred is True
    # Nothing was committed for the failed op, so nothing is stored: a retry applies it.
    stored = await pg.scalar(select(SyncAppliedOp).where(
        SyncAppliedOp.user_id == user.id,
        SyncAppliedOp.op_id == uuid.UUID(out["results"][1]["op_id"])))
    assert stored is None
    dwell_op = _op("dwell", a.id, seconds=30)
    dwell_op["op_id"] = out["results"][1]["op_id"]
    again = await _run(pg, user, [dwell_op])
    assert again["results"][0]["status"] == "applied"
    assert (await _state_of(pg, user, a)).dwell_seconds == 30


async def test_star_op_enqueues_summary_when_user_default_on(pg):
    user = await _user(pg)
    await _enable_ai(pg, user)
    await pg.execute(update(UserSettings).where(UserSettings.user_id == user.id)
                     .values(ai_summary_enabled_default=True))
    art = await _article(pg, await _feed(pg, user), content=LONG_TEXT)
    await _run(pg, user, [_op("star", art.id)])
    assert await pg.scalar(select(ArticleAiJob.status).where(
        ArticleAiJob.article_id == art.id, ArticleAiJob.operation == "summary")) == "pending"


async def _app(pg, user):
    from app.auth.dependencies import get_current_user
    from app.database import get_db
    from app.main import app

    async def _db():
        yield pg

    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = _db
    return app


async def test_ops_endpoint_shape_and_limit(pg):
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user))
    app = await _app(pg, user)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as c:
            ok = await c.post("/sync/v1/ops", json={"client_time": _now().isoformat(),
                                                    "ops": [_op("archive", art.id)]})
            too_many = await c.post("/sync/v1/ops", json={
                "client_time": _now().isoformat(), "ops": [_op("read", 1) for _ in range(501)]})
            bad_type = await c.post("/sync/v1/ops", json={
                "client_time": _now().isoformat(), "ops": [_op("explode", 1)]})
            naive = await c.post("/sync/v1/ops", json={
                "client_time": _now().isoformat(),
                "ops": [{**_op("read", art.id), "at": "2026-11-16T10:00:00"}]})
    finally:
        app.dependency_overrides.clear()
    assert ok.status_code == 200 and ok.headers["cache-control"] == "no-store"
    body = ok.json()
    assert set(body) == {"server_time", "results"}
    assert set(body["results"][0]) == {"op_id", "status", "reason", "article", "retryable"}
    assert body["results"][0]["article"]["is_archived"] is True
    assert too_many.status_code == 422 and bad_type.status_code == 422
    assert naive.status_code == 422


async def test_share_route_still_works_after_refactor(pg):
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user))
    app = await _app(pg, user)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as c:
            on = await c.post(f"/htmx/articles/{art.id}/share")
            token = (await _state_of(pg, user, art)).share_token
            off = await c.post(f"/htmx/articles/{art.id}/share")
            missing = await c.post("/htmx/articles/99999999/share")
            dwell = await c.post(f"/htmx/articles/{art.id}/dwell", data={"seconds": "40"})
            dwell_missing = await c.post("/htmx/articles/99999999/dwell", data={"seconds": "40"})
            opened = await c.post(f"/htmx/articles/{art.id}/link-opened")
    finally:
        app.dependency_overrides.clear()
    assert on.status_code == 200 and token and f"share/{token}" in on.text
    assert off.status_code == 200
    assert missing.status_code == 404
    assert dwell.status_code == 204 and dwell_missing.status_code == 404
    assert opened.status_code == 204
    s = await _state_of(pg, user, art)
    assert s.share_token is None and s.dwell_seconds == 40 and s.link_opened is True


async def test_prune_applied_ops_older_than_30_days(pg):
    from app.services.sync.ops import prune_applied_ops
    user = await _user(pg)
    old, fresh = uuid.uuid4(), uuid.uuid4()
    pg.add_all([
        SyncAppliedOp(user_id=user.id, op_id=old, applied_at=_now() - timedelta(days=31), result={}),
        SyncAppliedOp(user_id=user.id, op_id=fresh, applied_at=_now() - timedelta(days=29), result={}),
    ])
    await pg.flush()
    await prune_applied_ops(pg)
    left = (await pg.execute(select(SyncAppliedOp.op_id).where(SyncAppliedOp.user_id == user.id))).scalars().all()
    assert left == [fresh]


async def test_queued_context_job_is_processed_like_the_button(pg):
    """The background pass turns a queued context request into the stored context."""
    from contextlib import asynccontextmanager

    from app.services.ai_summary_service import process_pending_contexts

    user = await _user(pg)
    await _enable_ai(pg, user)
    art = await _article(pg, await _feed(pg, user), content=LONG_TEXT)
    await _run(pg, user, [_op("ai_context", art.id)])

    @asynccontextmanager
    async def _client(*_a, **_kw):
        yield object(), "anthropic", "m"

    ctx = AsyncMock(return_value=("Background **here**", 11, 7))
    with patch("app.services.ai_service.ai_client", _client), \
         patch("app.services.ai_service.get_article_context", ctx):
        assert await process_pending_contexts(pg) >= 1
    job = await pg.scalar(select(ArticleAiJob).where(
        ArticleAiJob.article_id == art.id, ArticleAiJob.operation == "context",
    ).execution_options(populate_existing=True))
    assert (job.status, job.input_tokens, job.output_tokens, job.model) == ("success", 11, 7, "m")
    assert (await _state_of(pg, user, art)).ai_context == "Background **here**"


async def test_queued_context_job_failure_backs_off(pg):
    from contextlib import asynccontextmanager

    from app.services.ai_summary_service import process_pending_contexts

    user = await _user(pg)
    await _enable_ai(pg, user)
    art = await _article(pg, await _feed(pg, user), content=LONG_TEXT)
    await _run(pg, user, [_op("ai_context", art.id)])

    @asynccontextmanager
    async def _client(*_a, **_kw):
        yield object(), "anthropic", "m"

    with patch("app.services.ai_service.ai_client", _client), \
         patch("app.services.ai_service.get_article_context", AsyncMock(side_effect=RuntimeError("down"))):
        await process_pending_contexts(pg)
    job = await pg.scalar(select(ArticleAiJob).where(
        ArticleAiJob.article_id == art.id, ArticleAiJob.operation == "context",
    ).execution_options(populate_existing=True))
    assert job.retry_count == 1 and job.next_retry_at is not None and job.error_message
    settings = await pg.scalar(select(UserSettings).where(UserSettings.user_id == user.id)
                               .execution_options(populate_existing=True))
    assert settings.last_ai_error.startswith("Context error")


async def test_unread_after_scope_read_in_same_session_applies(pg):
    """The bulk read is dated back to the op, so a later unread is not a conflict."""
    user = await _user(pg)
    feed = await _feed(pg, user)
    art = await _article(pg, feed, age_hours=3)
    t0 = _now() - timedelta(minutes=20)
    out = await _run(pg, user, [
        _op("mark_scope_read", at=t0, feed_id=feed.id, max_article_id=art.id),
        _op("unread", art.id, at=t0 + timedelta(seconds=5)),
    ])
    assert [r["status"] for r in out["results"]] == ["applied", "applied"]
    assert (await _state_of(pg, user, art)).is_read is False


async def test_failure_after_service_commit_counts_as_applied(pg):
    """The op's own commit happened, then something failed: its effect stands."""
    from app.services.article import add_dwell as real_add_dwell

    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user))

    async def _commit_then_fail(*a, **kw):
        await real_add_dwell(*a, **kw)
        raise RuntimeError("after commit")

    op = _op("dwell", art.id, seconds=30)
    with patch("app.services.sync.ops.add_dwell", _commit_then_fail):
        out = await _run(pg, user, [op])
    (res,) = out["results"]
    assert res["status"] == "applied" and res["retryable"] is False
    assert res["article"]["id"] == art.id
    assert (await _run(pg, user, [op]))["results"] == out["results"]
    assert (await _state_of(pg, user, art)).dwell_seconds == 30


async def test_stale_in_progress_claim_resolves_to_applied(pg):
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user))
    await _state(pg, user, art, is_read=True)
    op = _op("read", art.id)
    pg.add(SyncAppliedOp(user_id=user.id, op_id=uuid.UUID(op["op_id"]),
                         result={"op_id": op["op_id"], "status": "skipped",
                                 "reason": "in_progress", "article": None}))
    await pg.flush()
    (res,) = (await _run(pg, user, [op]))["results"]
    assert res["status"] == "applied" and res["article"]["is_read"] is True
    stored = await pg.scalar(select(SyncAppliedOp.result).where(
        SyncAppliedOp.user_id == user.id, SyncAppliedOp.op_id == uuid.UUID(op["op_id"]))
        .execution_options(populate_existing=True))
    assert stored["status"] == "applied"


async def test_mark_scope_read_leaves_later_server_unread_alone(pg):
    user = await _user(pg)
    feed = await _feed(pg, user)
    kept_unread, plain = await _article(pg, feed, age_hours=3), await _article(pg, feed, age_hours=3)
    await _state(pg, user, kept_unread, is_read=False)
    later = _now() - timedelta(minutes=1)
    await pg.execute(update(UserArticleState).where(
        UserArticleState.user_id == user.id, UserArticleState.article_id == kept_unread.id,
    ).values(read_changed_at=later))
    t3 = _now() - timedelta(minutes=10)  # the device's mark-all, before the server change
    out = await _run(pg, user, [_op("mark_scope_read", at=t3, feed_id=feed.id,
                                    max_article_id=max(kept_unread.id, plain.id))])
    assert out["results"][0]["status"] == "applied"
    s = await _state_of(pg, user, kept_unread)
    assert s.is_read is False and s.read_changed_at == later
    assert (await _state_of(pg, user, plain)).is_read is True


async def test_mark_saved_search_read_leaves_later_server_unread_alone(pg):
    user = await _user(pg)
    feed = await _feed(pg, user)
    art = await _article(pg, feed, age_hours=3)
    await _state(pg, user, art, is_read=False)
    later = _now() - timedelta(minutes=1)
    await pg.execute(update(UserArticleState).where(
        UserArticleState.user_id == user.id, UserArticleState.article_id == art.id,
    ).values(read_changed_at=later))
    search = SavedSearch(user_id=user.id, name="s", params={})
    pg.add(search)
    await pg.flush()
    await _run(pg, user, [_op("mark_scope_read", at=_now() - timedelta(minutes=10),
                              saved_search_id=search.id, max_article_id=art.id)])
    s = await _state_of(pg, user, art)
    assert s.is_read is False and s.read_changed_at == later


async def test_costly_ops_over_batch_budget_are_retryable_and_not_stored(pg):
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user), content=LONG_TEXT)
    await pg.execute(pg_insert(AppSettings).values(id=1, ai_enabled=False)
                     .on_conflict_do_update(index_elements=["id"], set_={"ai_enabled": False}))
    ops = [_op("ai_summary" if i % 2 else "ai_context", art.id) for i in range(21)]
    ops.append(_op("read", art.id))
    out = await _run(pg, user, ops)
    statuses = [(r["status"], r["reason"], r["retryable"]) for r in out["results"]]
    assert statuses[:20] == [("skipped", "ai_unavailable", False)] * 20
    assert statuses[20] == ("skipped", "rate_limited", True)
    assert statuses[21] == ("applied", None, False)
    assert await pg.scalar(select(SyncAppliedOp).where(
        SyncAppliedOp.op_id == uuid.UUID(ops[20]["op_id"]))) is None
    # Next sync: the same op_id goes through.
    assert (await _run(pg, user, [ops[20]]))["results"][0]["reason"] == "ai_unavailable"


async def test_save_url_and_extract_budgets(pg):
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user))  # no url: extract is skipped/no_url
    ops = [_op("save_url", url="ftp://nope") for _ in range(21)]
    ops += [_op("extract_readable", art.id) for _ in range(51)]
    res = (await _run(pg, user, ops))["results"]
    assert [r["reason"] for r in res[:21]] == ["invalid_url"] * 20 + ["rate_limited"]
    assert [r["reason"] for r in res[21:]] == ["no_url"] * 50 + ["rate_limited"]


async def test_ai_summary_gated_does_not_revive_failed_job(pg):
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user), content=LONG_TEXT)
    pg.add(UserSettings(user_id=user.id, ai_quality_provider="anthropic", ai_quality_model="m"))
    pg.add(ArticleAiJob(article_id=art.id, user_id=user.id, operation="summary", status="failed"))
    await pg.execute(pg_insert(AppSettings).values(id=1, ai_enabled=False)
                     .on_conflict_do_update(index_elements=["id"], set_={"ai_enabled": False}))
    await pg.flush()
    op = _op("ai_summary", art.id)
    (res,) = (await _run(pg, user, [op]))["results"]
    assert (res["status"], res["reason"]) == ("skipped", "ai_unavailable")
    assert await pg.scalar(select(ArticleAiJob.status).where(
        ArticleAiJob.article_id == art.id, ArticleAiJob.operation == "summary")) == "failed"
    assert await pg.scalar(select(SyncAppliedOp).where(
        SyncAppliedOp.op_id == uuid.UUID(op["op_id"]))) is not None


async def test_extract_readable_resets_retries_of_failed_article(pg):
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user), url="https://example.com/y",
                         readable_status="failed", readable_retries=5)
    await _run(pg, user, [_op("extract_readable", art.id)])
    a = await pg.get(Article, art.id, populate_existing=True)
    assert (a.readable_status, a.readable_retries) == ("pending", 0)


async def test_ops_endpoint_rate_limited_per_user(pg):
    from app.rate_limit import limiter

    user = await _user(pg)
    app = await _app(pg, user)
    limiter._storage.reset()
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as c:
            codes = [(await c.post("/sync/v1/ops", json={"client_time": _now().isoformat(), "ops": []})).status_code
                     for _ in range(31)]
    finally:
        app.dependency_overrides.clear()
        limiter._storage.reset()
    assert codes[:30] == [200] * 30 and codes[30] == 429


def test_rate_limit_key_is_the_session_user():
    from types import SimpleNamespace

    from app.routers.web.sync import _user_or_ip
    assert _user_or_ip(SimpleNamespace(session={"user_id": 7})) == "user:7"


async def _assert_retryable_then_applies(pg, user, art, out, op):
    (res,) = out["results"]
    assert (res["status"], res["reason"], res["retryable"]) == ("failed", "error", True)
    assert await pg.scalar(select(SyncAppliedOp).where(
        SyncAppliedOp.user_id == user.id, SyncAppliedOp.op_id == uuid.UUID(op["op_id"]))) is None
    s = await _state_of(pg, user, art)
    assert s is None or not s.dwell_seconds
    again = await _run(pg, user, [op])
    assert again["results"][0]["status"] == "applied"
    assert (await _state_of(pg, user, art)).dwell_seconds == 30


async def test_failed_commit_is_retryable_not_applied(pg):
    """A COMMIT that fails (dropped connection, serialization) closes the savepoint
    with nothing committed: that must not read as "applied"."""
    from sqlalchemy.exc import OperationalError

    from app.services.article import add_dwell as real_add_dwell

    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user))

    async def _commit_fails(u, aid, seconds, db):
        await db.execute(pg_insert(UserArticleState).values(
            user_id=u.id, article_id=aid, dwell_seconds=seconds))

        async def _bad_commit():
            # What a failed COMMIT leaves behind: the transaction gone, nothing kept.
            await db.get_nested_transaction().rollback()
            raise OperationalError("COMMIT", {}, Exception("connection lost"))
        with patch.object(db, "commit", _bad_commit):
            await db.commit()

    op = _op("dwell", art.id, seconds=30)
    with patch("app.services.sync.ops.add_dwell", _commit_fails):
        out = await _run(pg, user, [op])
    with patch("app.services.sync.ops.add_dwell", real_add_dwell):
        await _assert_retryable_then_applies(pg, user, art, out, op)


async def test_failed_flush_is_retryable_not_applied(pg):
    from app.services.article import add_dwell as real_add_dwell

    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user))

    async def _flush_fails(u, aid, seconds, db):
        db.add(UserArticleState(user_id=u.id, article_id=2_000_000_000))  # no such article
        await db.flush()

    op = _op("dwell", art.id, seconds=30)
    with patch("app.services.sync.ops.add_dwell", _flush_fails):
        out = await _run(pg, user, [op])
    with patch("app.services.sync.ops.add_dwell", real_add_dwell):
        await _assert_retryable_then_applies(pg, user, art, out, op)

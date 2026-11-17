"""Offline action replay: apply what the device did while offline, once, in order.

Every op goes through the same service function the online button uses, so side
effects (story closing, star → readable/summary, label scoring, share tokens) match.

Rules (design 5.4):
  * Idempotent: ``sync_applied_ops`` keeps each (user, op_id) with its result for 30
    days; a replayed op gets the stored result and is not applied again.
  * Order: ops apply in list order.
  * Clock skew: every device time is shifted by ``server_now - client_time``.
  * Conflicts: a read/star/archive/saved toggle is skipped with ``reason="conflict"``
    when the server changed that field after the op's (shifted) time; a
    ``label_remove`` likewise when the label was assigned after it.
  * Isolation: each op runs in its own SAVEPOINT. The services commit as they go
    (which also ends the savepoint), so a failing op loses only its own uncommitted
    writes, never earlier ops.

After an op applies, the field's change time is stamped back to the op's own time
(``LEAST(current, op time)``): the trigger stamps the server's clock, and without the
restamp a later op from the same offline session (star, then unstar) would look
older than the change its predecessor just made and be skipped as a conflict. A read
or unread that closes or reopens the article's story restamps the siblings it touched
the same way.
"""
import logging
import uuid
from datetime import datetime, timedelta, timezone

from limits import parse as parse_rate
from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import InvalidRequestError, ResourceClosedError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings as app_settings
from app.models.article import SUPPRESSED_BY_BULK, Article, ArticleAiJob, UserArticleState
from app.models.label import ArticleLabel
from app.models.saved_search import SavedSearch
from app.models.sync import SyncAppliedOp
from app.models.user import User, UserSettings
from app.schemas.article import ArticleStateUpdate
from app.schemas.sync import SyncOp, SyncOpsRequest
from app.services.article import (
    add_dwell,
    filter_accessible_article_ids,
    mark_link_opened,
    mark_scope_read,
    toggle_share,
    update_article_state,
)
from app.rate_limit import limiter
from app.services.sync.payload import article_records

logger = logging.getLogger(__name__)

APPLIED_OPS_TTL = timedelta(days=30)


class _Done(Exception):
    """Raised inside the savepoint to roll it back and answer with ``result``."""

    def __init__(self, result: dict):
        self.result = result


# op type -> (ArticleStateUpdate field, value, change-time column)
_TOGGLES = {
    "read": ("is_read", True, "read_changed_at"),
    "unread": ("is_read", False, "read_changed_at"),
    "star": ("is_starred", True, "star_changed_at"),
    "unstar": ("is_starred", False, "star_changed_at"),
    "archive": ("is_archived", True, "archive_changed_at"),
    "unarchive": ("is_archived", False, "archive_changed_at"),
}
_SCOPE_KEYS = ("feed_id", "folder_id", "label_id", "saved_search_id", "all")
_NO_ARTICLE_OPS = {"mark_scope_read", "save_url"}

# Written with the claim and replaced by the real result in the same op. The claim
# only becomes visible to another transaction once something committed it, and before
# the final store that can only be the op's own service commit, i.e. its main effect.
# A stored claim therefore means "applied" (see ``_resolve_stored``).
_IN_PROGRESS = "in_progress"

# Ops that cost an outbound fetch or an AI call get the same per-user limit as the
# button that does it online, counted per minute across batches (a replay must not be
# a way around the online limits). In memory, in the app's limiter storage: one
# uvicorn worker by design. Ops past it are answered ``skipped/rate_limited`` with
# ``retryable`` and not stored, so the device sends them again (same op_id) later.
_OP_RATES = {
    "save_url": app_settings.rate_limit_save_url,
    "extract_readable": app_settings.rate_limit_extract_readable,
    "ai_summary": app_settings.rate_limit_ai_summary,
    "ai_context": app_settings.rate_limit_ai_context,
}


def _within_rate(user_id: int, op_type: str) -> bool:
    """Counts the op against the user's per-minute budget for its type. False: over."""
    rate = _OP_RATES.get(op_type)
    if rate is None or not limiter.enabled:
        return True
    return limiter._limiter.hit(parse_rate(rate), "sync-op", op_type, str(user_id))


def _result(op_id, status: str, reason: str | None = None, article: dict | None = None,
            *, retryable: bool = False) -> dict:
    return {"op_id": str(op_id), "status": status, "reason": reason, "article": article,
            "retryable": retryable}


async def apply_ops(user: User, req: SyncOpsRequest, db: AsyncSession) -> dict:
    """Apply the batch in order; one result per op, in the same order."""
    server_now = datetime.now(timezone.utc)
    skew = server_now - req.client_time
    results = [await _apply_one(user, op, skew, server_now, db) for op in req.ops]
    return {"server_time": server_now.isoformat(), "results": results}


async def _stored(db: AsyncSession, user_id: int, op_id: uuid.UUID) -> dict | None:
    return await db.scalar(select(SyncAppliedOp.result).where(
        SyncAppliedOp.user_id == user_id, SyncAppliedOp.op_id == op_id))


async def _store(db: AsyncSession, user_id: int, op_id: uuid.UUID, result: dict) -> None:
    await db.execute(
        pg_insert(SyncAppliedOp).values(user_id=user_id, op_id=op_id, result=result)
        .on_conflict_do_update(index_elements=["user_id", "op_id"], set_={"result": result})
    )


async def _applied_after_commit(user: User, op: SyncOp, db: AsyncSession) -> dict:
    """The op's main effect is committed but its result was never stored (a crash, or
    a failure after the service's commit): it counts as applied, with fresh state."""
    result = _result(op.op_id, "applied", None, await _record(user, op.article_id, db))
    await _store(db, user.id, op.op_id, result)
    await db.commit()
    return result


async def _resolve_stored(user: User, op: SyncOp, db: AsyncSession) -> dict | None:
    stored = await _stored(db, user.id, op.op_id)
    if stored is not None and stored.get("reason") == _IN_PROGRESS:
        return await _applied_after_commit(user, op, db)
    return stored


async def _apply_one(user: User, op: SyncOp, skew: timedelta, server_now: datetime,
                     db: AsyncSession) -> dict:
    user_id = user.id
    stored = await _resolve_stored(user, op, db)
    if stored is not None:
        return stored
    if not _within_rate(user_id, op.type):
        return _result(op.op_id, "skipped", "rate_limited", retryable=True)
    at = min(op.at + skew, server_now)
    # Not ``async with``: the services commit, which ends the savepoint early, and the
    # context manager then refuses the statements that follow. Rolled back by hand,
    # and only while it is still open.
    savepoint = await db.begin_nested()
    try:
        claimed = await db.execute(
            pg_insert(SyncAppliedOp)
            .values(user_id=user_id, op_id=op.op_id,
                    result=_result(op.op_id, "skipped", _IN_PROGRESS))
            .on_conflict_do_nothing()
        )
        if claimed.rowcount == 0:  # a concurrent request got there first
            stored = await _stored(db, user_id, op.op_id)
            if stored is not None:
                raise _Done(stored)
            # The row vanished in between (pruned): apply; the final store recreates it.
        result = await _dispatch(user, op, at, skew, server_now, db)
        await _store(db, user_id, op.op_id, result)
        if savepoint.is_active:
            await savepoint.commit()
        await db.commit()
        return result
    except _Done as done:
        if savepoint.is_active:
            await savepoint.rollback()
        if done.result.get("reason") == _IN_PROGRESS:
            return await _applied_after_commit(user, op, db)
        return done.result
    except Exception:
        logger.exception("sync op %s (%s) failed", op.op_id, op.type)
        # Also when no longer active: a failed flush leaves the savepoint deactivated
        # but open, and the session refuses work until it is rolled back. On one
        # already closed (by a commit) this is a no-op.
        try:
            await savepoint.rollback()
        except (ResourceClosedError, InvalidRequestError):
            logger.debug("savepoint already closed after failed op", exc_info=True)
        except Exception:
            logger.warning("savepoint rollback after failed op %s failed", op.op_id, exc_info=True)
    # What happened is read from durable state, not from the transaction objects: a
    # savepoint is also closed by a failed flush or a failed COMMIT, with nothing
    # committed. The claim row was written inside the op's savepoint, so it exists
    # only if the op's own commit went through.
    try:
        stored = await _stored(db, user_id, op.op_id)
    except Exception:
        await db.rollback()  # the session needs it after a failed flush or COMMIT
        # A rollback expires every object in the session, the request's user too, and
        # the next ``user.id`` would lazy-load outside the async context. Reload it so
        # the rest of the batch can go on.
        if user in db:
            await db.refresh(user)
        stored = await _stored(db, user_id, op.op_id)
    if stored is None:
        # Nothing of the op was committed: forget it entirely, so the device retries
        # it with the same op_id instead of getting a final "failed".
        return _result(op.op_id, "failed", "error", retryable=True)
    if stored.get("reason") != _IN_PROGRESS:
        return stored
    # A service committed the op's main effect before the failure: it stands.
    return await _applied_after_commit(user, op, db)


async def _record(user: User, article_id: int | None, db: AsyncSession) -> dict | None:
    if article_id is None:
        return None
    recs = await article_records(user, [article_id], db, scoped=False)
    return recs[0] if recs else None


async def _dispatch(user: User, op: SyncOp, at: datetime, skew: timedelta,
                    server_now: datetime, db: AsyncSession) -> dict:
    aid = op.article_id
    v = op.value

    async def done(status="applied", reason=None, article_id=aid):
        return _result(op.op_id, status, reason, await _record(user, article_id, db))

    def failed(reason):
        return _result(op.op_id, "failed", reason)

    if op.type not in _NO_ARTICLE_OPS:
        if aid is None:
            return failed("invalid")
        if not await filter_accessible_article_ids(user.id, [aid], db):
            return failed("not_found")

    if op.type in _TOGGLES:
        field, value, col = _TOGGLES[op.type]
        changed = await db.scalar(select(getattr(UserArticleState, col)).where(
            UserArticleState.user_id == user.id, UserArticleState.article_id == aid))
        if changed is not None and changed > at:
            return await done("skipped", "conflict")
        close_story = not bool(v.get("story_unfolded"))
        # The trigger stamps now(), the transaction's start: every sibling the service
        # closes or reopens below (same transaction) carries exactly this value.
        txn_now = await db.scalar(select(func.now())) if field == "is_read" else None
        art = await update_article_state(
            user, aid, ArticleStateUpdate(**{field: value}), db, close_story=close_story,
        )
        if art is None:
            return failed("not_found")
        await _restamp_state(db, user.id, aid, col, at)
        if close_story and txn_now is not None:
            await _restamp_story_siblings(db, user.id, aid, txn_now, at)
        if op.type == "star":
            await _summary_on_star(user.id, aid, db)
        return await done()

    if op.type in ("label_add", "label_remove"):
        label_id = v.get("label_id")
        if not isinstance(label_id, int):
            return failed("invalid")
        from app.services.label_service import assign_label, remove_label
        if op.type == "label_add":
            if not await assign_label(user, aid, label_id, db):
                return failed("not_found")
            await db.execute(update(ArticleLabel).where(
                ArticleLabel.user_id == user.id, ArticleLabel.article_id == aid,
                ArticleLabel.label_id == label_id,
            ).values(assigned_at=func.least(ArticleLabel.assigned_at, at)))
            return await done()
        assigned = await db.scalar(select(ArticleLabel.assigned_at).where(
            ArticleLabel.user_id == user.id, ArticleLabel.article_id == aid,
            ArticleLabel.label_id == label_id))
        if assigned is not None and assigned > at:
            return await done("skipped", "conflict")
        await remove_label(user, aid, label_id, db)  # already gone: nothing to do
        return await done()

    if op.type == "mark_scope_read":
        return await _mark_scope_read(user, op, at, skew, server_now, db)

    if op.type == "save_url":
        url = v.get("url")
        if not isinstance(url, str) or not url.strip():
            return failed("invalid")
        title = v.get("title") if isinstance(v.get("title"), str) else None
        from app.services.saved_article_service import save_article_by_url
        try:
            article, _ = await save_article_by_url(url.strip(), user, db, fallback_title=title)
        except ValueError:
            return failed("invalid_url")
        return await done(article_id=article.id)

    if op.type == "unsave":
        changed = await db.scalar(select(UserArticleState.saved_changed_at).where(
            UserArticleState.user_id == user.id, UserArticleState.article_id == aid))
        if changed is not None and changed > at:
            return await done("skipped", "conflict")
        from app.services.saved_article_service import unsave_article
        await unsave_article(aid, user.id, db)
        await _restamp_state(db, user.id, aid, "saved_changed_at", at)
        return await done()

    if op.type == "share":
        want = bool(v.get("on", True))
        token = await db.scalar(select(UserArticleState.share_token).where(
            UserArticleState.user_id == user.id, UserArticleState.article_id == aid))
        if bool(token) != want:
            await toggle_share(user, aid, db)
        return await done()

    if op.type == "dwell":
        seconds = v.get("seconds")
        if not isinstance(seconds, int):
            return failed("invalid")
        await add_dwell(user, aid, seconds, db)
        return await done()

    if op.type == "link_opened":
        await mark_link_opened(user, aid, db)
        return await done()

    article = await db.get(Article, aid)
    if op.type == "ai_summary":
        if not await _request_summary(article, user.id, db):
            return await done("skipped", "ai_unavailable")
        await db.commit()
        return await done()

    if op.type == "ai_context":
        from app.services.ai_service import enqueue_context_job
        if not await enqueue_context_job(article, user.id, db):
            return await done("skipped", "ai_unavailable")
        await db.commit()
        return await done()

    if op.type == "extract_readable":
        if not article.url:
            return await done("skipped", "no_url")
        if article.readable_status != "success":
            # A fresh attempt, as when the reader opens an article: the retry
            # bookkeeping of earlier failures starts over.
            article.readable_status = "pending"
            article.readable_retries = 0
            article.readable_next_retry_at = datetime.now(timezone.utc)
            await db.commit()
        return await done()

    raise AssertionError(f"unhandled op type {op.type}")  # Literal guards this


async def _restamp_state(db: AsyncSession, user_id: int, article_id: int, col: str,
                         at: datetime) -> None:
    """Date the field's change back to the op's own time (see the module docstring)."""
    column = getattr(UserArticleState, col)
    await db.execute(update(UserArticleState).where(
        UserArticleState.user_id == user_id, UserArticleState.article_id == article_id,
    ).values({col: func.least(func.coalesce(column, at), at)}))


async def _restamp_story_siblings(db: AsyncSession, user_id: int, article_id: int,
                                  txn_now: datetime, at: datetime) -> None:
    """Date back the story members this op just closed or reopened, as for the article
    itself: otherwise a later offline ``unread`` of a sibling (same session) would look
    older than the server's close and be skipped as a conflict. Rows stamped by any
    other transaction carry another time and are left alone."""
    story = select(Article.story_id).where(
        Article.id == article_id, Article.story_id.is_not(None)).scalar_subquery()
    members = select(Article.id).where(Article.story_id == story, Article.id != article_id)
    await db.execute(update(UserArticleState).where(
        UserArticleState.user_id == user_id,
        UserArticleState.article_id.in_(members),
        UserArticleState.read_changed_at == txn_now,
    ).values(read_changed_at=func.least(UserArticleState.read_changed_at, at)))


async def _summary_on_star(user_id: int, article_id: int, db: AsyncSession) -> None:
    """What the star button does after starring: queue a summary when the user has
    summaries on by default. The background pipeline picks it up."""
    settings = await db.scalar(select(UserSettings).where(UserSettings.user_id == user_id))
    if not (settings and settings.ai_summary_enabled_default):
        return
    article = await db.get(Article, article_id)
    if article is None:
        return
    from app.services.ai_summary_service import enqueue_summary_job
    if await enqueue_summary_job(article, user_id, db):
        await db.commit()


async def _request_summary(article: Article, user_id: int, db: AsyncSession) -> bool:
    """The summary button, queued: the same gates with the on-demand length floor, and
    a failed or skipped earlier job is reset to pending (as ``run_summary_on_demand``
    does). False, with nothing changed, when the gates say no."""
    from app.services.ai_jobs import ON_DEMAND_MIN_CHARS
    from app.services.ai_summary_service import enqueue_summary_job, summary_eligible
    if not await summary_eligible(article, user_id, db, min_chars=ON_DEMAND_MIN_CHARS):
        return False
    if await enqueue_summary_job(article, user_id, db, min_chars=ON_DEMAND_MIN_CHARS):
        return True
    job = await db.scalar(select(ArticleAiJob).where(
        ArticleAiJob.article_id == article.id, ArticleAiJob.user_id == user_id,
        ArticleAiJob.operation == "summary"))
    if job is not None and job.status in ("failed", "skipped"):
        job.status = "pending"
        job.retry_count = 0
        job.next_retry_at = None
    return True


async def _mark_scope_read(user: User, op: SyncOp, at: datetime, skew: timedelta,
                           server_now: datetime, db: AsyncSession) -> dict:
    v = op.value
    keys = [k for k in _SCOPE_KEYS if v.get(k) not in (None, False)]
    max_id = v.get("max_article_id")
    if len(keys) != 1 or not isinstance(max_id, int) or isinstance(max_id, bool):
        return _result(op.op_id, "failed", "invalid")
    key = keys[0]
    if key != "all" and (not isinstance(v[key], int) or isinstance(v[key], bool)):
        return _result(op.op_id, "failed", "invalid")
    before = at
    if v.get("before") is not None:
        try:
            before = min(datetime.fromisoformat(v["before"]) + skew, server_now)
        except (TypeError, ValueError):
            return _result(op.op_id, "failed", "invalid")
        if before.tzinfo is None:
            return _result(op.op_id, "failed", "invalid")

    started = datetime.now(timezone.utc)
    if key == "saved_search_id":
        search = await db.scalar(select(SavedSearch).where(
            SavedSearch.id == v[key], SavedSearch.user_id == user.id))
        if search is None:
            return _result(op.op_id, "failed", "not_found")
        from app.services.saved_search_service import mark_saved_search_read
        await mark_saved_search_read(db, user, search, before=before, max_article_id=max_id,
                                     changed_before=at)
        await db.commit()
    else:
        kw = {} if key == "all" else {key: v[key]}
        await mark_scope_read(user, db, before, max_article_id=max_id, changed_before=at, **kw)
    # Date the reads this op just made back to the op's time, as for single toggles.
    # Rows changed on the server after the op were left alone above, so are not here.
    await db.execute(update(UserArticleState).where(
        UserArticleState.user_id == user.id,
        UserArticleState.suppressed_by == SUPPRESSED_BY_BULK,
        UserArticleState.read_at >= started,
    ).values(read_changed_at=func.least(UserArticleState.read_changed_at, at)))
    return _result(op.op_id, "applied")


async def prune_applied_ops(db: AsyncSession) -> int:
    """Forget op ids older than the replay window. Returns rows removed."""
    cutoff = datetime.now(timezone.utc) - APPLIED_OPS_TTL
    res = await db.execute(delete(SyncAppliedOp).where(SyncAppliedOp.applied_at < cutoff))
    await db.commit()
    return res.rowcount

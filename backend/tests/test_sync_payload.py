"""Sync article batches and lists, against the real database (rolled back)."""
import httpx
import pytest
from starlette_csrf import CSRFMiddleware

from app.config import settings as app_settings

from app.models.article import UserArticleState
from app.models.label import Label
from app.models.saved_search import SavedSearch
from app.models.user import UserSettings
from app.services.label_service import assign_label
from app.services.sync.payload import article_records, user_lists
from tests.test_sync_manifest import _article, _feed, _state, _user, pg  # noqa: F401

pytestmark = pytest.mark.integration

RECORD_KEYS = {
    "id", "feed_id", "title", "url", "author", "published_at", "fetched_at", "story_id",
    "image_url", "estimated_read_min", "word_count", "is_read", "is_starred", "is_archived",
    "saved_at", "hidden_at", "share_token", "ai_score", "lexical_score", "ai_summary",
    "ai_summary_truncated", "ai_context", "ai_summary_html", "ai_context_html",
    "label_ids", "version", "content_version",
}


async def _client(pg, user):
    from app.auth.dependencies import get_current_user
    from app.database import get_db
    from app.main import app

    async def _db():
        yield pg

    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = _db
    return app


async def test_article_records_skip_out_of_scope_ids(pg):
    user, other = await _user(pg), await _user(pg)
    mine = await _article(pg, await _feed(pg, user))
    theirs = await _article(pg, await _feed(pg, other))
    hidden = await _article(pg, await _feed(pg, user))
    from datetime import datetime, timezone
    await _state(pg, user, hidden, hidden_at=datetime.now(timezone.utc))

    recs = await article_records(user, [mine.id, theirs.id, hidden.id, 99999999], pg)
    assert [r["id"] for r in recs] == [mine.id]
    assert set(recs[0]) == RECORD_KEYS
    assert recs[0]["is_read"] is False and recs[0]["label_ids"] == []
    assert len(recs[0]["version"]) == 12


async def test_article_records_label_ids_sorted(pg):
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user))
    labels = []
    for n in ("b", "a", "c"):
        lab = Label(user_id=user.id, name=n)
        pg.add(lab)
        labels.append(lab)
    await pg.flush()
    for lab in reversed(labels):
        assert await assign_label(user, art.id, lab.id, pg)
    recs = await article_records(user, [art.id], pg)
    assert recs[0]["label_ids"] == sorted(l.id for l in labels)


async def test_articles_endpoint_rejects_over_200_ids(pg):
    user = await _user(pg)
    app = await _client(pg, user)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost", headers={"X-Readfine-User": str(user.id)}) as c:
            c.cookies.set("csrftoken", "x")
            ok = await c.post("/sync/v1/articles", json={"ids": list(range(200))})
            bad = await c.post("/sync/v1/articles", json={"ids": list(range(201))})
    finally:
        app.dependency_overrides.clear()
    # No session cookie is sent here, so the CSRF check does not apply to either call.
    assert ok.status_code == 200 and ok.json() == {"articles": []}
    assert bad.status_code == 422


async def test_articles_endpoint_requires_csrf(pg):
    user = await _user(pg)
    app = await _client(pg, user)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost", headers={"X-Readfine-User": str(user.id)}) as c:
            c.cookies.set("session", "anything")  # sensitive cookie present: CSRF is enforced
            no_header = await c.post("/sync/v1/articles", json={"ids": []})
            token = CSRFMiddleware(app=None, secret=app_settings.secret_key)._generate_csrf_token()
            c.cookies.set("csrftoken", token)
            with_header = await c.post("/sync/v1/articles", json={"ids": []}, headers={"x-csrftoken": token})
    finally:
        app.dependency_overrides.clear()
    assert no_header.status_code == 403
    assert with_header.status_code == 200


async def test_saved_search_member_ids_within_scope(pg):
    user = await _user(pg)
    feed = await _feed(pg, user)
    in_scope = await _article(pg, feed)
    pg.add(SavedSearch(user_id=user.id, name="all", params={}))
    await pg.flush()
    # An article reachable only through an unsubscribed feed is not in scope.
    stranger = await _user(pg)
    await _article(pg, await _feed(pg, stranger))
    lists = await user_lists(user, pg)
    (ss,) = lists["saved_searches"]
    assert ss["name"] == "all" and ss["member_ids"] == [in_scope.id]


async def test_prefs_subset_exact_keys(pg):
    user = await _user(pg)
    pg.add(UserSettings(user_id=user.id))
    await pg.flush()
    lists = await user_lists(user, pg)
    assert set(lists["prefs"]) == {
        "list_density_web", "list_density_mobile", "label_display", "ai_score_show_in_list",
        "timezone", "default_sort_order", "articles_per_page", "mark_read_on_scroll",
        "story_dedup", "reading_font_size", "reading_font_family", "format_profile",
        "unread_filter",
    }
    assert set(lists) == {"folders", "feeds", "labels", "saved_searches", "prefs", "versions"}
    assert set(lists["versions"]) == {"folders", "feeds", "labels", "saved_searches", "prefs", "templates"}


async def test_article_records_carry_rendered_ai_html(pg):
    """The device shows stored AI output offline, drawn as the detail panel draws it."""
    from app.utils.markdown import md_render_ai
    user = await _user(pg)
    art = await _article(pg, await _feed(pg, user))
    await _state(pg, user, art, is_starred=True, ai_summary="**Bold** point", ai_context="- one\n- two")
    (rec,) = await article_records(user, [art.id], pg)
    assert rec["ai_summary_html"] == md_render_ai("**Bold** point")
    assert "<strong>Bold</strong>" in rec["ai_summary_html"]
    assert "<li>" in rec["ai_context_html"]
    (bare,) = await article_records(user, [(await _article(pg, await _feed(pg, user))).id], pg)
    assert bare["ai_summary_html"] is None and bare["ai_context_html"] is None

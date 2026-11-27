"""Sources consume the shipped delayed-delete contract and real scope cleanup."""
import json
from datetime import datetime, timezone
from html.parser import HTMLParser

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from app.models.article import Article
from app.models.feed import Feed, Folder, UserFeed
from app.models.filter import Filter
from app.models.saved_search import SavedSearch
from app.models.user import UserCatchupConfig
from app.routers.web.settings.common import _get_feeds_context
from app.services.article import list_articles
from app.templating import templates
from tests.test_settings_deletes import URL, _client, _feed, _filter, _user, env

pytestmark = pytest.mark.integration


class Tags(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.tags = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))


async def test_sources_delete_uses_subscription_key(env):
    """Wrong ID, immediate delete, or unescaped title breaks the menu contract."""
    engine, made = env
    hostile = '\"><img src=x onerror="alert(1)"> & source'
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        feed, uf = await _feed(s, made, user)
        # Explicitly separate the ID domains; independent sequences can coincide.
        uf.id = max(feed.id, await s.scalar(select(func.max(UserFeed.id)))) + 1
        await s.flush()
        assert uf.id != feed.id
        folder = Folder(user_id=user.id, name="Folder")
        s.add(folder)
        await s.flush()
        uf.folder_id = folder.id
        uf.custom_title = hostile
        await s.commit()
        context = await _get_feeds_context(user, s)
        html = templates.env.get_template("settings/partials/feeds_list.html").render(
            request=Request({"type": "http", "method": "GET", "path": "/sources", "headers": []}),
            **context,
        )

    tags = Tags(html).tags
    rows = [attrs for tag, attrs in tags if tag == "tr" and attrs.get("id") == f"source-row-{uf.id}"]
    assert len(rows) == 1 and rows[0]["data-rf-delete-key"] == f"feed:{uf.id}"
    actions = [attrs for tag, attrs in tags if tag == "button" and attrs.get("data-rf-delete") == f"feed:{uf.id}"]
    assert len(actions) == 1, "feed Remove must use the delayed subscription key"
    action = actions[0]
    assert action["data-rf-delete-label"] == hostile
    assert "data-rf-online-only" in action
    assert action["type"] == "button" and action["role"] == "menuitem"
    assert not {"hx-delete", "hx-target", "hx-swap", "data-confirm-text", "data-confirm-class"} & action.keys()
    assert "swap-confirm" not in action.get("class", "").split()
    assert not any(attrs.get("hx-delete", "").startswith(("/settings/feeds/", "/sources/feeds/")) for _, attrs in tags)
    assert not any(tag == "img" or "onerror" in attrs for tag, attrs in tags)
    folder_actions = [attrs for _, attrs in tags if attrs.get("hx-delete") == f"/sources/folders/{folder.id}"]
    assert len(folder_actions) == 1
    assert folder_actions[0]["data-confirm-text"] == "Confirm delete"
    assert "swap-confirm" in folder_actions[0]["class"].split()


async def test_sources_delete_cleanup_notices(env):
    """Unsubscribe must persist cleanup without widening searches or other users' scopes."""
    engine, made = env
    now = datetime.now(timezone.utc)
    async with AsyncSession(engine, expire_on_commit=False) as s:
        me, other = await _user(s, made), await _user(s, made)
        feed, uf = await _feed(s, made, me)
        other_uf = UserFeed(user_id=other.id, feed_id=feed.id)
        feed.subscriber_count = 2
        s.add(other_uf)
        token = f"feed:{feed.id}"
        filters, briefings, searches = [], [], []
        for user in (me, other):
            filters.append(await _filter(s, user, name="Only source", include=[token]))
            briefings.append(UserCatchupConfig(
                user_id=user.id, name="Daily", scope_include=json.dumps([token]),
                briefing_enabled=True, briefing_next_send_at=now,
            ))
            searches.append(SavedSearch(user_id=user.id, name="Source search", params={"scope_include": [token]}))
        s.add_all(briefings + searches)
        s.add(Article(feed_id=feed.id, guid="source-cleanup", guid_hash="source-cleanup",
                      title="Source article", content="<p>body</p>", readable_status="success",
                      published_at=now, fetched_at=now))
        await s.commit()
        before = await list_articles(user=me, db=s, scope_include=json.dumps([token]), search=True, limit=10)
        assert len(before) == 1

    async with _client(engine, me.id) as client:
        response = await client.post(URL, json=[{"kind": "feed", "id": uf.id}])
    assert response.status_code == 200
    assert response.json()["results"] == [{"kind": "feed", "id": uf.id, "status": "done"}]
    notices = response.json()["notices"]
    assert len(notices) == 1 and notices[0]["type"] == "warning"
    assert notices[0]["msg"] == (
        "Deactivated 1 filter scoped only to what you just removed: Only source. "
        "Disabled the briefing on 1 digest scoped only to what you just removed: Daily. "
        "1 saved search scoped only to what you just removed will show nothing until you change it: Source search."
    )
    assert json.loads(response.headers["hx-trigger"]) == {"showToast": notices}
    async with AsyncSession(engine) as s:
        assert await s.get(UserFeed, uf.id) is None
        mine = await s.get(Filter, filters[0].id)
        assert mine.is_active is False and mine.scope_include is None
        briefing = await s.get(UserCatchupConfig, briefings[0].id)
        assert briefing.briefing_enabled is False and briefing.scope_include is None
        assert briefing.briefing_next_send_at is None
        search = await s.get(SavedSearch, searches[0].id)
        # Keep the dead reference: removing it would silently broaden the search.
        assert search.params == {"scope_include": [token]}
        assert await list_articles(user=me, db=s, scope_include=json.dumps(search.params["scope_include"]), search=True, limit=10) == []
        assert await s.get(UserFeed, other_uf.id) is not None
        assert (await s.get(Feed, feed.id)).subscriber_count == 1
        foreign_filter = await s.get(Filter, filters[1].id)
        assert foreign_filter.is_active is True and json.loads(foreign_filter.scope_include) == [token]
        foreign_briefing = await s.get(UserCatchupConfig, briefings[1].id)
        assert foreign_briefing.briefing_enabled is True
        assert json.loads(foreign_briefing.scope_include) == [token]
        assert foreign_briefing.briefing_next_send_at == now
        assert (await s.get(SavedSearch, searches[1].id)).params == {"scope_include": [token]}
        assert len(await list_articles(user=other, db=s, scope_include=json.dumps([token]), search=True, limit=10)) == 1

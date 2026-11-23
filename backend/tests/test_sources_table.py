"""Sources table contracts; real counts/folder services in a rolled-back DB.

Wave 1 substitutes only the s5-T1-owned layout when it is not assembled yet.
"""
import re
import uuid
from datetime import datetime, timezone
from urllib.parse import urlencode

import pytest
import pytest_asyncio
from jinja2 import ChoiceLoader, DictLoader, TemplateNotFound
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from starlette.requests import Request

from app.config import settings
from app.models.article import Article, UserArticleState
from app.models.feed import Feed, Folder, UserFeed
from app.models.user import User, UserSettings
from app.routers.web.settings.common import _get_feeds_context
from app.routers.web.settings import folders as routes
from app.services.counts_service import sidebar_counts, story_dedup_of
from app.templating import templates

pytestmark = pytest.mark.integration


@pytest_asyncio.fixture
async def db():
    engine = create_async_engine(settings.database_url)
    async with engine.connect() as conn:
        tx = await conn.begin()
        async with AsyncSession(conn, expire_on_commit=False, join_transaction_mode="create_savepoint") as session:
            yield session
        await tx.rollback()
    await engine.dispose()


async def user(db):
    u = User(email=f"sources-{uuid.uuid4().hex}@example.invalid", password_hash="x", display_name="Sources tester")
    db.add(u)
    await db.flush()
    return u


async def subscription(db, u, folder=None, **kwargs):
    f = Feed(feed_url=f"https://example.invalid/{uuid.uuid4().hex}", title="Source", **kwargs)
    db.add(f)
    await db.flush()
    uf = UserFeed(user_id=u.id, feed_id=f.id, folder_id=folder.id if folder else None)
    db.add(uf)
    await db.flush()
    return f, uf


def request(data=None, *, htmx=True):
    body = urlencode(data or {}).encode()
    async def receive():
        return {"type": "http.request", "body": body}
    return Request({"type": "http", "method": "POST", "path": "/settings/folders",
                    "headers": [(b"content-type", b"application/x-www-form-urlencoded")]
                    + ([(b"hx-request", b"true")] if htmx else [])}, receive)


def render(ctx, *, full=False, htmx=False):
    env = templates.env.overlay()
    try:
        env.get_template("sources/base.html")
    except TemplateNotFound:
        env.loader = ChoiceLoader([env.loader, DictLoader({
            "sources/base.html": '{% block sources_content %}{% endblock %}{% block scripts %}{% endblock %}'
        })])
    return env.get_template("settings/feeds.html" if full else "settings/partials/feeds_list.html").render(
        request=request(htmx=htmx), **ctx)


def row(html, id_):
    return re.search(rf'<tr\b[^>]*id="source-row-{id_}".*?</tr>', html, re.S).group()


async def test_sources_counts_and_grouping(db):
    a, b = await user(db), await user(db)
    folders = [Folder(user_id=a.id, name=n, position=i) for i, n in enumerate(["Zulu", "Empty", "Alpha"], 1)]
    db.add_all(folders + [UserSettings(user_id=a.id, folder_order="custom", folders_arranged=True)])
    await db.flush()
    f, uf = await subscription(db, a, folders[0])
    _, second = await subscription(db, a, folders[2])
    _, unfiled = await subscription(db, a)
    db.add(UserFeed(user_id=b.id, feed_id=f.id))
    articles = [Article(feed_id=f.id, guid=str(i), guid_hash=str(i), title="Article") for i in range(3)]
    db.add_all(articles)
    await db.flush()
    db.add_all([UserArticleState(user_id=a.id, article_id=articles[0].id, is_read=True),
                UserArticleState(user_id=b.id, article_id=articles[1].id, is_read=True),
                UserArticleState(user_id=b.id, article_id=articles[2].id, is_read=True)])
    await db.flush()
    ctx = await _get_feeds_context(a, db)
    expected = await sidebar_counts(db, a.id, feed_ids=[f.id], label_ids=[], story_dedup=await story_dedup_of(db, a.id))
    assert ctx["feed_unread_counts"][f.id] == expected.feed_unread_counts[f.id] == 2
    assert (await _get_feeds_context(b, db))["feed_unread_counts"][f.id] == 1
    assert ctx["article_counts"][f.id] == 3
    html = render(ctx)
    assert html.index(f'id="source-row-{uf.id}"') < html.index(f'id="source-row-{second.id}"') < html.index(f'id="source-row-{unfiled.id}"')
    assert 'data-rf-source-unread>0</td>' in row(html, unfiled.id)
    assert f'id="folder-header-{folders[1].id}"' in html


async def test_sources_table_contract(db):
    u = await user(db)
    db.add(Feed(feed_url="https://example.invalid/spare", title="Spare"))
    await db.flush()
    statuses = [("active", 0, "Healthy"), ("active", templates.env.globals["block_badge_threshold"] - 1, "Healthy"),
                ("active", templates.env.globals["block_badge_threshold"], "Throttled"),
                ("error", 0, "Failing"), ("disabled", 99, "Disabled"), ("paused", 99, "Paused")]
    ids = []
    for status, blocks, label in statuses:
        f, uf = await subscription(db, u, status=status, block_count=blocks, fetch_error_count=2,
                                   last_error="<script>error</script>", fetch_interval_min=60)
        uf.custom_title = '<img src=x onerror=alert(1)>' + ' Long' * 40
        if status == "active":
            f.last_fetched_at = f.last_published_at = datetime.now(timezone.utc)
        assert uf.id != f.id
        ids.append((uf.id, label))
    await db.flush()
    html = render(await _get_feeds_context(u, db), full=True)
    assert html.count('id="feeds-list"') == 1
    assert 'id="sources-main"' in html and 'rf-sources-table-scroll' in html
    assert '<img src=x' not in html and '&lt;img src=x' in html
    assert '<script>error' not in html
    for id_, label in ids:
        r = row(html, id_)
        assert f'data-rf-delete-key="feed:{id_}"' in r
        assert f'id="source-menu-{id_}"' in r and 'data-rf-source-menu' in r
        assert label in r and 'data-rf-source-unread' in r
        assert f'href="/settings/feeds/{id_}/edit"' in r and 'data-rf-source-sheet' in r
        assert f'hx-delete="/settings/feeds/{id_}"' in r and '>Remove</button>' in r
    for text in ['Unread', 'Articles', 'Interval', 'Last / next fetch', 'Last pub.', 'Never', 'next ', 'Stats', 'switched off', 'refusals']:
        assert text in html
    assert 'id="feed-subscribe-form"' not in html
    boosted = render(await _get_feeds_context(u, db), full=True, htmx=True)
    assert boosted.count('id="feeds-count"') == boosted.count('id="feeds-list"') == 1


async def test_sources_folder_mutations_and_oob(db):
    u, other = await user(db), await user(db)
    foreign = Folder(user_id=other.id, name="Foreign")
    db.add(foreign)
    await db.flush()
    async def check(fn, data=None, **kwargs):
        response = await fn(request=request(data), user=u, db=db, **kwargs)
        assert response.status_code == 200
        html = response.body.decode()
        assert html.count('id="feeds-list"') == 1
        assert 'id="subscribe-folder-select" hx-swap-oob="true"' in html
        assert 'id="feeds-count" hx-swap-oob="true"' in html
        return html
    await check(routes.settings_folder_create, {"name": "First"})
    first = await db.scalar(select(Folder).where(Folder.user_id == u.id))
    await check(routes.settings_folder_create, {"name": "Second"})
    second = await db.scalar(select(Folder).where(Folder.user_id == u.id, Folder.name == "Second"))
    await subscription(db, u, first)
    await subscription(db, u, second)
    for name, status in [("", 400), ("First", 409)]:
        response = await routes.settings_folder_create(request({"name": name}), u, db)
        assert response.status_code == status
    for name, status in [("", 400), ("Second", 409)]:
        response = await routes.settings_folder_rename(first.id, request({"name": name}), u, db)
        assert response.status_code == status and first.name == "First"
    assert 'Renamed' in await check(routes.settings_folder_rename, {"name": "Renamed"}, folder_id=first.id)
    await check(routes.settings_folder_order, {"mode": "custom"})
    await check(routes.settings_folder_move, {"dir": "down"}, folder_id=first.id)
    before = first.position
    bad = await routes.settings_folder_move(first.id, request({"dir": "sideways"}), u, db)
    assert bad.status_code == 400 and first.position == before
    await check(routes.settings_folder_order_reset)
    await check(routes.settings_folder_rename, {"name": "Hacked"}, folder_id=foreign.id)
    await check(routes.settings_folder_move, {"dir": "up"}, folder_id=foreign.id)
    await check(routes.settings_folder_delete, folder_id=foreign.id)
    assert foreign.name == "Foreign" and await db.get(Folder, foreign.id) is foreign
    assert (await routes.settings_folder_rename_form(foreign.id, request(), u, db)).status_code == 404
    await check(routes.settings_folder_delete, folder_id=first.id)
    assert await db.get(Folder, first.id) is None


async def test_sources_no_subscription_empty_state(db):
    u = await user(db)
    folder = Folder(user_id=u.id, name="Empty")
    db.add(folder)
    await db.flush()
    html = render(await _get_feeds_context(u, db), full=True)
    assert html.count('id="feeds-list"') == 1
    assert 'No feeds yet' in html and 'Add source' in html and 'OPML' in html
    assert f'id="folder-header-{folder.id}"' in html
    assert f'/settings/folders/{folder.id}/rename-form' in html
    assert f'hx-delete="/settings/folders/{folder.id}"' in html
    assert 'data-confirm-text="Confirm delete"' in html
    assert 'data-rf-delete-key="feed:' not in html and 'data-rf-source-unread' not in html
    assert 'Starred and archived articles are never deleted' in html

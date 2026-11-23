"""Per-user offline snapshots of the row and detail partials (real database, rolled back)."""
from datetime import datetime, timezone

import httpx
import pytest
from bs4 import BeautifulSoup
from sqlalchemy import delete
from starlette.requests import Request

from app.models.feed import UserFeed
from app.models.label import Label
from app.models.user import UserSettings
from app.services.label_service import assign_label
from app.services.sync import OFFLINE_TEMPLATE_VERSION
from app.services.sync.manifest import prefs_version
from app.services.sync.payload import article_records
from app.services.sync.snapshots import render_snapshots
from tests.test_sync_manifest import _article, _feed, _state, _user, pg  # noqa: F401
from tests.test_sync_payload import _client

pytestmark = pytest.mark.integration

IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"
DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"
PUBLISHED = datetime(2020, 1, 2, 3, 4, tzinfo=timezone.utc)

BODY = (
    '<p>Hi <img src="https://img.example/a.jpg" alt="a"'
    ' srcset="https://img.example/a1.jpg 1x, //cdn.example/a2.jpg 2x"></p>'
    '<picture><source srcset="https://img.example/p.webp 640w"><img src="https://img.example/p.jpg"></picture>'
    '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">'
    '<img src="http://testserver/static/own.png">'
    '<figure data-video-provider="youtube" data-video-id="abcdefghijk">'
    '<a href="https://www.youtube.com/watch?v=abcdefghijk">'
    '<img src="https://img.youtube.com/vi/abcdefghijk/hqdefault.jpg" alt="Video thumbnail"></a>'
    '<figcaption>&#9654; Watch on YouTube</figcaption></figure>'
    '<iframe src="https://www.youtube-nocookie.com/embed/zyxwvutsrqp" width="560"></iframe>'
    '<video poster="https://img.example/poster.jpg" src="https://vid.example/v.mp4"></video>'
)


def _request(ua: str = IPHONE) -> Request:
    return Request({
        "type": "http", "method": "GET", "path": "/sync/v1/snapshots", "query_string": b"",
        "headers": [(b"host", b"testserver"), (b"user-agent", ua.encode())],
        "scheme": "http", "server": ("testserver", 80), "root_path": "",
    })


async def _settings(pg, user, **kw):
    pg.add(UserSettings(user_id=user.id, **kw))
    await pg.flush()


async def _one(pg, user, art, ua=IPHONE) -> dict:
    snaps = await render_snapshots(_request(ua), user, [art.id], pg)
    assert len(snaps) == 1
    return snaps[0]


def _media_attr_values(html: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for tag in soup.find_all(["img", "source", "video"]):
        for attr in ("src", "srcset", "poster"):
            if tag.get(attr):
                out.append(tag[attr])
    return out


async def test_snapshot_shape_and_versions(pg):
    user = await _user(pg)
    user.last_active_at = datetime.now(timezone.utc)
    await _settings(pg, user)
    feed = await _feed(pg, user)
    available = await _article(pg, feed, readable_status="success", readable_content="<p>Full</p>")
    expected = await _article(pg, feed, url="https://ex.invalid/article", readable_status="pending",
                              readable_retries=1, content="<p>Feed version</p>")
    excluded = await _article(pg, feed, url="https://ex.invalid/failed", readable_status="failed",
                              readable_error="Extraction error", content="<p>Feed version</p>")
    await _state(pg, user, expected, is_starred=True)
    ids = [available.id, expected.id, excluded.id]
    snaps = await render_snapshots(_request(), user, ids, pg)
    assert [snap["id"] for snap in snaps] == ids
    records = await article_records(user, ids, pg)
    prefs = await prefs_version(user.id, pg)
    for snap, record, art, flag in zip(snaps, records, (available, expected, excluded), (True, False, None)):
        assert snap["full_text"] is flag
        assert snap["full_text"] is record["full_text"]
        assert set(snap) == {"id", "content_version", "template_version", "prefs_version",
                             "row_html", "detail_html", "media", "full_text"}
        assert snap["content_version"] == art.content_version
        assert snap["template_version"] == OFFLINE_TEMPLATE_VERSION
        assert snap["prefs_version"] == prefs
        assert f'data-rf-article="{art.id}"' in snap["row_html"]
        assert f'data-rf-article="{art.id}"' in snap["detail_html"]
        soup = BeautifulSoup(snap["detail_html"], "html.parser")
        notes = soup.select("[data-rf-full-text-note]")
        if flag is False:
            assert len(notes) == 1 and notes[0].name == "p"
            assert notes[0].get_text(strip=True) == "Full text not downloaded yet — showing the feed version."
            assert notes[0].find_next_sibling() == soup.select_one(".article-body")
        else:
            assert not notes
        assert "Another attempt is scheduled." not in snap["detail_html"]
        assert "Extraction error" not in snap["detail_html"]

    await pg.execute(delete(UserFeed).where(UserFeed.user_id == user.id, UserFeed.feed_id == feed.id))
    kept = await _one(pg, user, expected)
    assert kept["full_text"] is None
    assert "data-rf-full-text-note" not in kept["detail_html"]

    app = await _client(pg, user)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as client:
            live = await client.get(f"/htmx/articles/{expected.id}")
    finally:
        app.dependency_overrides.clear()
    assert live.status_code == 200
    assert "Another attempt is scheduled." in live.text
    assert "data-rf-full-text-note" not in live.text


async def test_snapshot_marks_the_body_for_offline_search(pg):
    user = await _user(pg)
    await _settings(pg, user)
    art = await _article(pg, await _feed(pg, user), content="<p>lighthouse keeper</p>")
    snap = await _one(pg, user, art)
    soup = BeautifulSoup(snap["detail_html"], "html.parser")
    body = soup.select_one("[data-rf-search-text]")
    assert body is not None and body["id"] == f"article-content-{art.id}"
    assert "lighthouse keeper" in body.get_text()


async def test_snapshot_has_no_csrf_or_nonce(pg):
    user = await _user(pg)
    await _settings(pg, user, ai_chat_enabled=True)
    art = await _article(pg, await _feed(pg, user), content=BODY, url="https://pub.example/a")
    snap = await _one(pg, user, art)
    for html in (snap["row_html"], snap["detail_html"]):
        assert "csrftoken" not in html and "nonce" not in html
        assert "hx-headers" not in html and "session" not in html.lower()


async def test_snapshot_images_rewritten_to_m(pg):
    user = await _user(pg)
    await _settings(pg, user)
    art = await _article(pg, await _feed(pg, user), content=BODY)
    snap = await _one(pg, user, art)
    html = snap["detail_html"]
    assert 'src="/m/' in html
    values = _media_attr_values(html)
    assert values
    for v in values:
        assert "img.example" not in v and "cdn.example" not in v
    # The legacy YouTube thumbnail goes to the local video-thumb proxy, not to /m/.
    assert "img.youtube.com" not in html
    assert 'src="/img/video-thumb/youtube/abcdefghijk"' in html
    # The player iframe is replaced by its thumbnail facade.
    assert "<iframe" not in html
    assert 'data-video-id="zyxwvutsrqp"' in html
    assert 'src="/img/video-thumb/youtube/zyxwvutsrqp"' in html
    # A data: URL is left alone.
    assert 'src="data:image/gif' in html
    # The video file is not proxied (images only); its poster is.
    soup = BeautifulSoup(html, "html.parser")
    video = soup.find("video")
    assert video["poster"].startswith("/m/") and video["src"] == "https://vid.example/v.mp4"


async def test_snapshot_lists_all_media(pg):
    user = await _user(pg)
    await _settings(pg, user)
    art = await _article(pg, await _feed(pg, user), content=BODY)
    snap = await _one(pg, user, art)
    media = snap["media"]
    assert len(media) == len(set(media))
    signed = [m for m in media if m.startswith("/m/")]
    # a.jpg, a1.jpg, a2.jpg, p.webp, p.jpg, own.png (own host spelled out), poster.jpg
    assert len(signed) == 7
    assert "/img/video-thumb/youtube/abcdefghijk" in media
    assert "/img/video-thumb/youtube/zyxwvutsrqp" in media
    assert not any(m.startswith("data:") for m in media)
    assert len(media) == 9
    # Every signed URL in the HTML is in the list.
    for v in _media_attr_values(snap["detail_html"]):
        for cand in v.split(","):
            url = cand.strip().split()[0]
            if url.startswith("/"):
                assert url in media


async def test_snapshot_uses_user_density_and_timezone(pg):
    user = await _user(pg)
    await _settings(pg, user, list_density_mobile="summary", list_density_web="compact",
                    timezone="Asia/Tokyo", format_profile="iso", label_display="dots")
    art = await _article(pg, await _feed(pg, user), content="<p>x</p>", summary="Snippet here")
    art.published_at = PUBLISHED
    await pg.flush()
    mobile = await _one(pg, user, art, IPHONE)
    desktop = await _one(pg, user, art, DESKTOP)
    assert 'data-density="summary"' in mobile["row_html"]
    assert 'data-density="compact"' in desktop["row_html"]
    # 03:04 UTC is 12:04 in Tokyo; both the row date and the detail date say so.
    assert "12:04" in mobile["row_html"] and "12:04" in mobile["detail_html"]
    assert f'data-rf-time="{PUBLISHED.isoformat()}"' in mobile["row_html"]
    assert f'data-rf-time="{PUBLISHED.isoformat()}"' in mobile["detail_html"]
    # The viewer contextvars are restored afterwards.
    from app.utils.datetime_format import current_viewer_tz
    assert current_viewer_tz.get() == "UTC"


async def test_snapshot_neutral_state(pg):
    user = await _user(pg)
    await _settings(pg, user, ai_score_show_in_list=True, label_display="dots")
    art = await _article(pg, await _feed(pg, user), content="<p>x</p>")
    await _state(pg, user, art, is_read=True, is_starred=True, is_archived=True,
                 saved_at=datetime.now(timezone.utc), ai_summary="SECRET SUMMARY",
                 ai_context="SECRET CONTEXT", ai_score=0.9, share_token="tok123")
    lab = Label(user_id=user.id, name="LabelName", color="#123456")
    pg.add(lab)
    await pg.flush()
    assert await assign_label(user, art.id, lab.id, pg)

    snap = await _one(pg, user, art)
    row, detail = snap["row_html"], snap["detail_html"]
    for html in (row, detail):
        assert 'data-is-read="true"' not in html
        assert "★" not in html
        assert "SECRET" not in html and "tok123" not in html
        assert "LabelName" not in html and "#123456" not in html
    soup = BeautifulSoup(row, "html.parser")
    root = soup.find(attrs={"data-rf-article": str(art.id)})
    assert "opacity-75" not in root["class"]
    assert root["data-rf-read-classes"] == "opacity-75"
    labels = soup.find(attrs={"data-rf-slot": "labels"})
    assert not labels.find(style=True)  # no coloured label dots
    # Snapshot-only slots are present and empty.
    assert soup.find(attrs={"data-rf-slot": "score-badge"}).get_text(strip=True) == ""
    d = BeautifulSoup(detail, "html.parser")
    for slot in ("ai-summary", "ai-context", "related-count"):
        el = d.find(attrs={"data-rf-slot": slot})
        assert el is not None and el.get_text(strip=True) == "", slot
    assert "AI summary" not in detail
    # Saved controls exist (for the overlay) but are hidden.
    saved = d.find_all(attrs={"data-rf-slot": "saved-icon"})
    assert len(saved) == 2 and all("hidden" in el["class"] for el in saved)
    # Read button in its unread form.
    read_btn = d.find(attrs={"data-rf-slot": "read-button", "id": f"read-btn-{art.id}"})
    assert "Unread" in read_btn.get_text()


async def test_snapshots_skip_out_of_scope(pg):
    user, other = await _user(pg), await _user(pg)
    await _settings(pg, user)
    mine = await _article(pg, await _feed(pg, user))
    theirs = await _article(pg, await _feed(pg, other))
    snaps = await render_snapshots(_request(), user, [theirs.id, mine.id, 99999999], pg)
    assert [s["id"] for s in snaps] == [mine.id]


async def test_snapshots_endpoint_max_50(pg):
    user = await _user(pg)
    await _settings(pg, user)
    art = await _article(pg, await _feed(pg, user), content="<p>x</p>")
    app = await _client(pg, user)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost", headers={"X-Readfine-User": str(user.id)}) as c:
            ok = await c.get("/sync/v1/snapshots", params={"ids": ",".join([str(art.id)] + [str(i) for i in range(1, 50)])})
            bad = await c.get("/sync/v1/snapshots", params={"ids": ",".join(str(i) for i in range(1, 52))})
            junk = await c.get("/sync/v1/snapshots", params={"ids": "1,x"})
            empty = await c.get("/sync/v1/snapshots", params={"ids": ""})
    finally:
        app.dependency_overrides.clear()
    assert ok.status_code == 200
    assert [s["id"] for s in ok.json()["snapshots"]] == [art.id]
    assert bad.status_code == 422
    assert junk.status_code == 422
    assert empty.status_code == 200 and empty.json() == {"snapshots": []}


PROBES = (
    '<img src="/\\evil.example/p.gif">'
    '<img src="\\\\evil.example/q.gif">'
    '<img src="rel/x.jpg">'
    '<img src="javascript:alert(1)">'
    '<img src="  java\tscript:alert(2)">'
    '<img src="/lo\ncal/ok.png">'
    '<img srcset="rel/a.jpg 1x, https://img.example/b.jpg 2x">'
    '<img srcset="rel/c.jpg 1x">'
    '<video poster="ftp://img.example/v.jpg"></video>'
)


async def test_snapshot_image_rewrite_probes(pg):
    """What the browser would resolve elsewhere is signed or dropped, never left as is."""
    import base64
    user = await _user(pg)
    await _settings(pg, user)
    art = await _article(pg, await _feed(pg, user), content=PROBES)
    snap = await _one(pg, user, art)
    soup = BeautifulSoup(snap["detail_html"], "html.parser")
    imgs = soup.select(".article-body img")
    srcs = [i.get("src") for i in imgs]

    def target(m):
        b64 = m.rsplit("/", 1)[1]
        return base64.urlsafe_b64decode(b64 + "=" * (-len(b64) % 4)).decode()

    # "/\evil" and "\\evil" are protocol-relative to a browser: signed as https.
    assert srcs[0].startswith("/m/") and target(srcs[0]) == "https://evil.example/p.gif"
    assert srcs[1].startswith("/m/") and target(srcs[1]) == "https://evil.example/q.gif"
    # No base for a relative path, and no other scheme: the attribute goes.
    assert srcs[2] is None and srcs[3] is None and srcs[4] is None
    # Tab/newline stripped as the browser does, then a same-origin path.
    assert srcs[5] == "/local/ok.png"
    # srcset keeps only the candidates it can serve; none left drops the attribute.
    assert imgs[6]["srcset"].startswith("/m/") and imgs[6]["srcset"].endswith(" 2x")
    assert "," not in imgs[6]["srcset"]
    assert not imgs[7].has_attr("srcset")
    assert not soup.find("video").has_attr("poster")
    html = snap["detail_html"]
    assert "evil.example" not in html and "javascript" not in html and "rel/" not in html
    assert "/local/ok.png" in snap["media"]


async def _ai_switch_on(pg):
    from app.models.settings import AppSettings
    row = await pg.get(AppSettings, 1)
    if row is None:
        row = AppSettings(id=1)
        pg.add(row)
    row.ai_enabled = True
    await pg.flush()


async def _ai_on(pg, user, chat=True):
    await _ai_switch_on(pg)
    await _settings(pg, user, ai_quality_provider="openai", ai_quality_model="m", ai_chat_enabled=chat)


async def test_snapshot_ai_actions_with_ai_on(pg):
    user = await _user(pg)
    await _ai_on(pg, user)
    art = await _article(pg, await _feed(pg, user), content="<p>x</p>")
    await _state(pg, user, art, ai_summary="SECRET SUMMARY", ai_context="SECRET CONTEXT")
    snap = await _one(pg, user, art)
    html = snap["detail_html"]
    d = BeautifulSoup(html, "html.parser")
    assert "SECRET" not in html
    # Queueable actions, in their neutral form.
    action = d.find(attrs={"data-rf-slot": "ai-summary-action"})
    assert action is not None and "Generate summary" in action.get_text()
    ctx_actions = d.find_all(attrs={"data-rf-slot": "ai-context-action"})
    # One: the Context tab's Generate (the "Generate context" menu item left in s4).
    assert len(ctx_actions) == 1 and all("Regenerate" not in a.get_text() for a in ctx_actions)
    # Targets the overlay fills, visible since AI is on.
    wrapper = d.find(attrs={"data-rf-placeholder": "ai"})
    assert "hidden" not in wrapper["class"]
    assert d.find(attrs={"data-rf-slot": "ai-summary"}).find(id=f"ai-summary-{art.id}") is not None
    area = d.find(id=f"ai-context-area-{art.id}")
    assert area["data-rf-slot"] == "ai-context" and area.find(id=f"ai-context-{art.id}") is not None
    # Chat entry points drawn, marked online-only.
    chats = d.find_all(attrs={"data-show-chat-modal": str(art.id)})
    # Three since s4: the toolbar's Ask, the AI panel's Ask and the bottom bar's chat.
    assert len(chats) == 3 and all(c.has_attr("data-rf-online-only") for c in chats)
    assert "csrftoken" not in html and "nonce" not in html


async def test_snapshot_ai_off_hides_ai_section(pg):
    user = await _user(pg)
    await _settings(pg, user)
    art = await _article(pg, await _feed(pg, user), content="<p>x</p>")
    d = BeautifulSoup((await _one(pg, user, art))["detail_html"], "html.parser")
    assert "hidden" in d.find(attrs={"data-rf-placeholder": "ai"})["class"]
    assert d.find(attrs={"data-rf-slot": "ai-summary-action"}) is None
    assert d.find(attrs={"data-show-chat-modal": True}) is None
    assert d.find(attrs={"data-rf-slot": "ai-context"}) is not None


async def test_prefs_version_tracks_format_and_ai(pg):
    user = await _user(pg)
    await _settings(pg, user, format_profile="iso")
    v1 = await prefs_version(user.id, pg)
    from sqlalchemy import select
    s = await pg.scalar(select(UserSettings).where(UserSettings.user_id == user.id))
    s.format_profile = "eu"
    await pg.flush()
    v2 = await prefs_version(user.id, pg)
    assert v2 != v1
    await _ai_switch_on(pg)
    s.ai_quality_provider, s.ai_quality_model = "openai", "m"
    await pg.flush()
    v3 = await prefs_version(user.id, pg)
    assert v3 != v2
    s.ai_chat_enabled = not s.ai_chat_enabled
    await pg.flush()
    v4 = await prefs_version(user.id, pg)
    assert v4 != v3
    # The device's lists apply the unread setting, so the device must learn of a change.
    s.unread_filter = "show_all"
    await pg.flush()
    assert await prefs_version(user.id, pg) != v4


async def test_sync_responses_are_no_store(pg):
    user = await _user(pg)
    await _settings(pg, user)
    app = await _client(pg, user)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost", headers={"X-Readfine-User": str(user.id)}) as c:
            responses = [
                await c.get("/sync/v1/manifest"),
                await c.get("/sync/v1/lists"),
                await c.post("/sync/v1/articles", json={"ids": []}),
                await c.get("/sync/v1/snapshots", params={"ids": ""}),
            ]
    finally:
        app.dependency_overrides.clear()
    for r in responses:
        assert r.status_code == 200, r.request.url
        assert r.headers["cache-control"] == "no-store", r.request.url


async def test_in_offline_scope_matches_the_full_scope(pg):
    from app.services.sync.scope import in_offline_scope, offline_scope_ids

    user, other = await _user(pg), await _user(pg)
    feed = await _feed(pg, user)
    unread = [await _article(pg, feed, age_hours=h) for h in (1, 2, 3, 4)]
    starred_old = await _article(pg, feed, age_hours=100)
    await _state(pg, user, starred_old, is_read=True, is_starred=True)
    read = await _article(pg, feed)
    await _state(pg, user, read, is_read=True)
    theirs = await _article(pg, await _feed(pg, other))
    ask = [a.id for a in (*unread, starred_old, read, theirs)] + [99999999]
    # unread_limit 2: only the two newest unread are in scope, kept ones on top.
    full = set(await offline_scope_ids(user, pg, unread_limit=2))
    got = await in_offline_scope(user, ask, pg, unread_limit=2)
    assert got == sorted(full & set(ask))
    assert got == sorted([unread[0].id, unread[1].id, starred_old.id])
    assert await in_offline_scope(user, [], pg) == []


async def test_snapshot_rewrite_runs_off_the_event_loop(pg, monkeypatch):
    import asyncio

    from app.services.sync import snapshots as snap_mod

    user = await _user(pg)
    await _settings(pg, user)
    feed = await _feed(pg, user)
    arts = [await _article(pg, feed, content=BODY) for _ in range(3)]
    calls = []
    real = asyncio.to_thread

    async def spy(fn, *a, **kw):
        calls.append(fn.__name__)
        return await real(fn, *a, **kw)

    monkeypatch.setattr(snap_mod.asyncio, "to_thread", spy)
    snaps = await render_snapshots(_request(), user, [a.id for a in arts], pg)
    assert [s["id"] for s in snaps] == sorted(a.id for a in arts)
    # One thread hop for every body of the batch, one for the media scan.
    assert calls == ["_offline_bodies", "_media_of"]
    assert all("/m/" in s["detail_html"] for s in snaps)


async def test_media_scan_matches_picture_and_skips_video_sources():
    from app.services.sync.snapshots import media_urls

    html = ('<img src="/m/a"><picture><source srcset="/m/b 1x, /m/c 2x"><img src="/m/d"></picture>'
            '<video poster="/m/e"><source src="/v.mp4"></video><img src="https://x/y">'
            '<img src="//x/z"><img srcset="/m/a 1x">')
    assert media_urls(html, '<img src="/m/f">') == ["/m/a", "/m/b", "/m/c", "/m/d", "/m/e", "/m/f"]


async def test_sync_fetch_endpoints_rate_limited_per_user(pg):
    from app.rate_limit import limiter

    user = await _user(pg)
    await _settings(pg, user)
    app = await _client(pg, user)
    limiter._storage.reset()
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost", headers={"X-Readfine-User": str(user.id)}) as c:
            snaps = [(await c.get("/sync/v1/snapshots", params={"ids": ""})).status_code for _ in range(121)]
            arts = [(await c.post("/sync/v1/articles", json={"ids": []})).status_code for _ in range(121)]
    finally:
        app.dependency_overrides.clear()
        limiter._storage.reset()
    assert snaps[:120] == [200] * 120 and snaps[120] == 429
    assert arts[:120] == [200] * 120 and arts[120] == 429

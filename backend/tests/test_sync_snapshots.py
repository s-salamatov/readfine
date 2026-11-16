"""Per-user offline snapshots of the row and detail partials (real database, rolled back)."""
from datetime import datetime, timezone

import httpx
import pytest
from bs4 import BeautifulSoup
from starlette.requests import Request

from app.models.label import Label
from app.models.user import UserSettings
from app.services.label_service import assign_label
from app.services.sync import OFFLINE_TEMPLATE_VERSION
from app.services.sync.manifest import prefs_version
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
    await _settings(pg, user)
    art = await _article(pg, await _feed(pg, user), content="<p>x</p>")
    snap = await _one(pg, user, art)
    assert set(snap) == {"id", "content_version", "template_version", "prefs_version",
                         "row_html", "detail_html", "media"}
    assert snap["id"] == art.id
    assert snap["content_version"] == art.content_version
    assert snap["template_version"] == OFFLINE_TEMPLATE_VERSION
    assert snap["prefs_version"] == await prefs_version(user.id, pg)
    assert f'data-rf-article="{art.id}"' in snap["row_html"]
    assert f'data-rf-article="{art.id}"' in snap["detail_html"]


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
    # a.jpg, a1.jpg, a2.jpg, p.webp, p.jpg, poster.jpg
    assert len(signed) == 6
    assert "/img/video-thumb/youtube/abcdefghijk" in media
    assert "/img/video-thumb/youtube/zyxwvutsrqp" in media
    assert not any(m.startswith("data:") for m in media)
    # Our own host spelled out comes back as a plain path, listed, not signed.
    assert "/static/own.png" in media
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
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as c:
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

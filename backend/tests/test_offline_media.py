"""Signed offline media proxy."""
import os
import time
from unittest.mock import MagicMock, patch

import httpx
import pytest

from app.config import settings
from app.services.sync import media
from app.utils.url_validator import BytesResponse, ResponseTooLarge

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32
URL = "https://img.example.com/a.png"


@pytest.fixture(autouse=True)
def _cache(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "offline_media_cache_dir", str(tmp_path / "om"))


def _path(url=URL, uid=1):
    return media.sign_media_url(url, uid)


def _parts(path):
    _, _, sig, exp, b64 = path.split("/")
    return sig, int(exp), b64


def test_sign_verify_roundtrip():
    sig, exp, b64 = _parts(_path())
    assert len(sig) == 32
    assert media.verify(sig, exp, b64, 1) == URL


def test_verify_rejects_other_user():
    sig, exp, b64 = _parts(_path())
    with pytest.raises(PermissionError):
        media.verify(sig, exp, b64, 2)


def test_verify_rejects_expired():
    sig, exp, b64 = _parts(media.sign_media_url(URL, 1, ttl_days=-1))
    assert exp < time.time()
    with pytest.raises(PermissionError):
        media.verify(sig, exp, b64, 1)


def test_verify_rejects_garbage_b64():
    with pytest.raises(PermissionError):
        media.verify("x" * 32, int(time.time()) + 100, "!!!not-b64!!!", 1)


def test_route_403_on_tampered_url(client):
    sig, exp, _ = _parts(_path())
    other = media._b64e(b"https://evil.example.com/a.png")
    assert client.get(f"/m/{sig}/{exp}/{other}").status_code == 403


def test_route_403_on_bad_b64_not_500(client):
    sig, exp, _ = _parts(_path())
    assert client.get(f"/m/{sig}/{exp}/a").status_code == 403
    assert client.get(f"/m/{sig}/{exp}/%FF%FE").status_code == 403


def test_route_success_headers(client):
    with patch("app.services.sync.media.fetch_url_bytes",
               return_value=BytesResponse(PNG, "image/png", URL)):
        r = client.get(_path())
    assert r.status_code == 200
    assert r.content == PNG
    assert r.headers["content-type"] == "image/png"
    # Never kept by the browser HTTP cache: it would outlive logout (CWE-525).
    assert r.headers["cache-control"] == "no-store"
    assert "etag" not in r.headers
    with patch("app.services.sync.media.fetch_url_bytes",
               return_value=BytesResponse(PNG, "image/png", URL)):
        r2 = client.get(_path(), headers={"If-None-Match": '"om-x"'})
    assert r2.status_code == 200


def test_route_refuses_private_target(client):
    path = _path("http://127.0.0.1/x.png")
    with patch("app.utils.url_validator._get_once_retrying_protocol_error",
               side_effect=AssertionError("request made")):
        assert client.get(path).status_code == 404


def test_route_413_over_cap(client, monkeypatch):
    monkeypatch.setattr(settings, "offline_media_max_bytes", 16)
    with patch("app.services.sync.media.fetch_url_bytes",
               side_effect=ResponseTooLarge("big")):
        assert client.get(_path()).status_code == 413
    # helper that ignores the cap: still refused after the fact
    with patch("app.services.sync.media.fetch_url_bytes",
               return_value=BytesResponse(PNG, "image/png", URL)):
        assert client.get(_path("https://img.example.com/b.png")).status_code == 413


def test_fetch_called_with_cap(client, monkeypatch):
    monkeypatch.setattr(settings, "offline_media_max_bytes", 1234)
    m = MagicMock(return_value=BytesResponse(PNG, "image/png", URL))
    with patch("app.services.sync.media.fetch_url_bytes", m):
        client.get(_path())
    assert m.call_args.kwargs["max_bytes"] == 1234


def test_route_415_non_image(client):
    with patch("app.services.sync.media.fetch_url_bytes",
               return_value=BytesResponse(b"<html>hi</html>", "text/html", URL)):
        assert client.get(_path()).status_code == 415


def test_route_404_on_fetch_failure(client):
    with patch("app.services.sync.media.fetch_url_bytes", side_effect=httpx.ConnectError("x")):
        assert client.get(_path()).status_code == 404


def test_second_request_served_from_cache(client):
    m = MagicMock(return_value=BytesResponse(PNG, "image/png", URL))
    with patch("app.services.sync.media.fetch_url_bytes", m):
        assert client.get(_path()).status_code == 200
        assert client.get(_path()).status_code == 200
    assert m.call_count == 1


def test_cache_path_is_sha256_only():
    p = media._cache_path("https://x/../../etc/passwd")
    assert p.parent == media._cache_dir()
    assert len(p.name) == 64 and p.name.isalnum()


def test_sweep_drops_idle(monkeypatch):
    media._write_cached(media._cache_path(URL), PNG)
    path = media._cache_path(URL)
    old = time.time() - 40 * 86400
    import os
    os.utime(path, (old, old))
    assert media.sweep_offline_media() == 1
    assert not path.exists()


def test_route_requires_session(unauth_client):
    r = unauth_client.get(_path(), follow_redirects=False)
    assert r.status_code == 401


def test_sweep_drops_stale_tmp_files_only():
    import os
    media._write_cached(media._cache_path(URL), PNG)
    d = media._cache_dir()
    stale, fresh = d / "abc.1.tmp", d / "abc.2.tmp"
    stale.write_bytes(b"x")
    fresh.write_bytes(b"x")
    old = time.time() - 2 * 3600
    os.utime(stale, (old, old))
    assert media.sweep_offline_media() == 0  # counts images only
    assert not stale.exists() and fresh.exists()
    assert media._cache_path(URL).exists()


def test_concurrent_writes_of_one_image_use_their_own_temp_files():
    import threading
    path = media._cache_path(URL)
    names = []
    real = media.tempfile.NamedTemporaryFile

    def spy(*a, **kw):
        f = real(*a, **kw)
        names.append(f.name)
        return f

    with patch.object(media.tempfile, "NamedTemporaryFile", side_effect=spy):
        threads = [threading.Thread(target=media._write_cached, args=(path, PNG)) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    assert len(set(names)) == 8
    assert path.read_bytes() == PNG
    assert [p.name for p in media._cache_dir().iterdir()] == [path.name]


def test_concurrent_cold_requests_fetch_once():
    import threading
    gate = threading.Event()
    calls = []

    def slow_fetch(url, **kw):
        calls.append(url)
        gate.wait(2)
        return BytesResponse(PNG, "image/png", url)

    out = []
    with patch("app.services.sync.media.fetch_url_bytes", side_effect=slow_fetch):
        threads = [threading.Thread(target=lambda: out.append(media.get_media(URL))) for _ in range(5)]
        for t in threads:
            t.start()
        time.sleep(0.1)
        gate.set()
        for t in threads:
            t.join()
    assert len(calls) == 1
    assert out == [(PNG, "image/png")] * 5
    assert media._inflight == {}


def test_size_cap_is_checked_at_most_every_50_writes_or_minute(monkeypatch):
    checks = []
    monkeypatch.setattr(media, "_enforce_size_cap", lambda: checks.append(1))
    monkeypatch.setattr(media, "_cap_state", {"writes": 0, "at": time.monotonic()})
    for i in range(120):
        media._write_cached(media._cache_path(f"https://img.example.com/{i}.png"), PNG)
    assert len(checks) == 2
    # A minute after the last check, the next write checks again.
    media._cap_state["at"] -= 61
    media._write_cached(media._cache_path("https://img.example.com/x.png"), PNG)
    assert len(checks) == 3


def test_fetch_cap_never_raises_the_global_one(monkeypatch):
    from app.utils import url_validator

    monkeypatch.setattr(settings, "max_fetch_bytes", 100)
    caps = []

    class _Resp:
        has_redirect_location = False

        def close(self):
            pass

    class _Client:
        def build_request(self, *a, **kw):
            return None

        def send(self, *a, **kw):
            return _Resp()

    monkeypatch.setattr(url_validator, "_read_capped", lambda r, u, cap, d: caps.append(cap) or b"")
    monkeypatch.setattr(url_validator, "_with_body", lambda r, b: r)
    monkeypatch.setattr(url_validator, "log_outbound", lambda *a, **kw: None)
    for asked in (None, 50, 10_000):
        url_validator._get_once_retrying_protocol_error(
            _Client(), "https://x/", "https://x/", {}, {}, max_bytes=asked)
    assert caps == [100, 50, 100]

"""Signed offline media proxy."""
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

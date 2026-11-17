"""Signed same-origin image proxy for offline copies.

The offline client stores article images on the device, so every image has to come
from our own origin (no third-party fetch from the reader's browser) and be fetchable
by script. Article HTML is rewritten to ``/m/{sig}/{exp}/{b64url}`` links built by
:func:`sign_media_url`; the route verifies the signature, then :func:`get_media`
fetches and disk-caches the image.

The signature is what keeps this from being an open proxy: only URLs the server
itself put into an article for that user (HMAC over ``user_id|exp|url``) are ever
fetched, and the fetch goes through ``fetch_url_bytes``, which refuses non-global
addresses (SSRF). The cache file name derives from sha256(url) only.
"""
import base64
import binascii
import hashlib
import hmac
import logging
import os
import tempfile
import threading
import time
from pathlib import Path

from app.config import settings
from app.services.video_thumb_service import _image_type  # shared magic-byte sniffing
from app.utils.url_validator import ResponseTooLarge, fetch_url_bytes

logger = logging.getLogger(__name__)

_SIG_LEN = 32
_FETCH_TIMEOUT = 15


class MediaTooLarge(Exception):
    """The image is over ``offline_media_max_bytes``."""


class MediaNotImage(Exception):
    """The fetched body is not a recognised image."""


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64d(text: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (binascii.Error, ValueError) as exc:
        raise PermissionError("bad media token") from exc


def _sig(user_id: int, exp: int, url: str) -> str:
    msg = f"{user_id}|{exp}|{url}".encode()
    digest = hmac.new(settings.secret_key.encode(), msg, hashlib.sha256).digest()
    return _b64e(digest)[:_SIG_LEN]


def sign_media_url(url: str, user_id: int, *, ttl_days: int = 30) -> str:
    """The proxy path for *url*, valid for *user_id* for *ttl_days*."""
    exp = int(time.time()) + ttl_days * 86400
    return f"/m/{_sig(user_id, exp, url)}/{exp}/{_b64e(url.encode())}"


def verify(sig: str, exp: int, b64url: str, user_id: int) -> str:
    """The URL behind a media path, or PermissionError if it is not valid for this user."""
    try:
        url = _b64d(b64url).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PermissionError("bad media token") from exc
    if not hmac.compare_digest(sig.encode(), _sig(user_id, exp, url).encode()):
        raise PermissionError("bad media signature")
    if exp < time.time():
        raise PermissionError("media link expired")
    return url


def _cache_dir() -> Path:
    return Path(settings.offline_media_cache_dir)


def _cache_path(url: str) -> Path:
    return _cache_dir() / hashlib.sha256(url.encode()).hexdigest()


def _unlink_quietly(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        pass


def _read_cached(path: Path) -> tuple[bytes, str] | None:
    try:
        data = path.read_bytes()
    except OSError:
        return None
    mime = _image_type(data)
    if mime is None:
        _unlink_quietly(path)
        return None
    now = time.time()
    try:
        os.utime(path, (now, now))  # access time drives the LRU cap and idle sweep
    except OSError:
        pass
    return data, mime


def _cache_entries(*, temp: bool = False) -> list[tuple[Path, os.stat_result]]:
    """Cached images (or, with ``temp``, the ``.tmp`` files of writes in progress)."""
    entries = []
    try:
        for entry in _cache_dir().iterdir():
            if entry.name.endswith(".tmp") != temp:
                continue
            try:
                entries.append((entry, entry.stat()))
            except OSError:
                continue
    except OSError:
        return []
    return entries


# The size cap lists the whole directory: checked at most once per _CAP_EVERY_WRITES
# writes or _CAP_EVERY_SECONDS, not after every image.
_CAP_EVERY_WRITES = 50
_CAP_EVERY_SECONDS = 60
_cap_state = {"writes": 0, "at": 0.0}
_cap_lock = threading.Lock()


def _maybe_enforce_size_cap() -> None:
    with _cap_lock:
        _cap_state["writes"] += 1
        now = time.monotonic()
        if _cap_state["writes"] < _CAP_EVERY_WRITES and now - _cap_state["at"] < _CAP_EVERY_SECONDS:
            return
        _cap_state["writes"] = 0
        _cap_state["at"] = now
    _enforce_size_cap()


def _enforce_size_cap() -> None:
    """Drop least-recently-used images until the cache fits its ceiling."""
    max_bytes = settings.offline_media_cache_max_mb * 1024 * 1024
    entries = _cache_entries()
    total = sum(st.st_size for _, st in entries)
    if total <= max_bytes:
        return
    for path, st in sorted(entries, key=lambda e: e[1].st_atime):
        _unlink_quietly(path)
        total -= st.st_size
        if total <= max_bytes:
            break


def _write_cached(path: Path, data: bytes) -> None:
    tmp_name = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # A name of its own per write: the pool's threads may write the same image.
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + ".",
                                         suffix=".tmp", delete=False) as tmp:
            tmp_name = tmp.name
            tmp.write(data)
        os.replace(tmp_name, path)
    except OSError as exc:
        logger.warning("could not write offline media cache %s: %s", path, exc)
        if tmp_name:
            _unlink_quietly(Path(tmp_name))
        return
    _maybe_enforce_size_cap()


# Concurrent cold requests for the same image share one fetch (per URL).
_inflight: dict[str, threading.Lock] = {}
_inflight_guard = threading.Lock()


def _url_lock(url: str) -> threading.Lock:
    with _inflight_guard:
        lock = _inflight.get(url)
        if lock is None:
            lock = _inflight[url] = threading.Lock()
        return lock


def _drop_url_lock(url: str, lock: threading.Lock) -> None:
    with _inflight_guard:
        if _inflight.get(url) is lock:
            del _inflight[url]


def get_media(url: str) -> tuple[bytes, str] | None:
    """The image at *url* and its MIME type, from disk cache or a fresh SSRF-safe fetch.

    None when the fetch fails (unreachable, refused address, HTTP error). Raises
    :class:`MediaTooLarge` / :class:`MediaNotImage` so the route can answer 413 / 415.
    Requests for the same uncached image wait for the first one's fetch and then read
    its cache file, rather than fetching it again.
    """
    path = _cache_path(url)
    cached = _read_cached(path)
    if cached is not None:
        return cached
    lock = _url_lock(url)
    with lock:
        try:
            cached = _read_cached(path)  # another thread fetched it meanwhile
            if cached is not None:
                return cached
            return _fetch_and_store(url, path)
        finally:
            _drop_url_lock(url, lock)


def _fetch_and_store(url: str, path: Path) -> tuple[bytes, str] | None:
    cap = settings.offline_media_max_bytes
    try:
        body = fetch_url_bytes(url, timeout=_FETCH_TIMEOUT, max_bytes=cap).content
    except ResponseTooLarge as exc:
        raise MediaTooLarge() from exc
    except Exception as exc:  # noqa: BLE001 — any failure is a plain miss
        logger.debug("offline media fetch %s failed: %s", url, exc)
        return None
    if len(body) > cap:
        raise MediaTooLarge()
    mime = _image_type(body)
    if mime is None:
        raise MediaNotImage()
    _write_cached(path, body)
    return body, mime


_TMP_MAX_AGE = 3600


def sweep_offline_media() -> int:
    """Drop images not requested within the idle window, and ``.tmp`` files a write
    left behind (a crash between write and rename) older than an hour. Returns how
    many images went."""
    removed = 0
    idle_days = settings.offline_media_idle_days
    if idle_days > 0:
        cutoff = time.time() - idle_days * 86400
        for path, st in _cache_entries():
            if st.st_atime < cutoff:
                _unlink_quietly(path)
                removed += 1
    tmp_cutoff = time.time() - _TMP_MAX_AGE
    for path, st in _cache_entries(temp=True):
        if st.st_mtime < tmp_cutoff:
            _unlink_quietly(path)
    if removed:
        logger.info("swept %d idle offline image(s) from cache", removed)
    return removed

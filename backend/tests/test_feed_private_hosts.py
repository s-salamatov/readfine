"""FEED_ALLOWED_PRIVATE_HOSTS: named hostnames may resolve to private addresses
for feed fetching only (an internal RSSHub container), and nowhere else."""
import asyncio
from contextlib import contextmanager
from unittest.mock import patch

import httpx
import pytest

from app.utils import url_validator
from app.utils.url_validator import (
    _pin_connection,
    _resolve_and_pin,
    fetch_url_conditional,
    fetch_url_page,
    validate_ai_endpoint_url,
    validate_feed_url,
)
from tests.conftest import allowed_private_ai_hosts
from tests.conftest import mock_httpx_client as _mock_httpx_client

_ADDRS = {
    "rsshub": "172.18.0.5",
    "other": "172.18.0.6",
    "example.com": "93.184.216.34",
}


def _getaddrinfo(host, *args, **kwargs):
    host = host.lower().rstrip(".")
    return [(2, 1, 6, "", (_ADDRS.get(host, host), 0))]


@pytest.fixture(autouse=True)
def _dns():
    with patch("socket.getaddrinfo", side_effect=_getaddrinfo):
        yield


@contextmanager
def feed_hosts(value: str):
    from app.config import settings

    previous = settings.feed_allowed_private_hosts
    settings.feed_allowed_private_hosts = value
    settings.__dict__.pop("allowed_private_feed_hosts", None)
    try:
        yield
    finally:
        settings.feed_allowed_private_hosts = previous
        settings.__dict__.pop("allowed_private_feed_hosts", None)


class TestSetting:
    def test_parsing(self):
        from app.config import settings

        with feed_hosts(" RSSHub, ,other.lan "):
            assert settings.allowed_private_feed_hosts == frozenset({"rsshub", "other.lan"})

    def test_empty_by_default(self):
        from app.config import settings

        assert settings.allowed_private_feed_hosts == frozenset()

    @pytest.mark.parametrize("bad", ["rsshub:1200", "http://rsshub", "rss/hub", "rss hub"])
    def test_malformed_entry_rejected(self, bad):
        from app.config import settings

        with feed_hosts(bad):
            with pytest.raises(ValueError):
                settings.allowed_private_feed_hosts


def test_private_feed_host_refused_by_default():
    with pytest.raises(ValueError):
        validate_feed_url("http://rsshub:1200/x")


def test_listed_private_feed_host_allowed():
    with feed_hosts("rsshub"):
        validate_feed_url("http://rsshub:1200/x")
        connect_url, overlay, _ext = _pin_connection("http://rsshub:1200/x")
        assert connect_url == "http://172.18.0.5:1200/x"
        assert overlay == {"Host": "rsshub:1200"}


def test_listed_host_matched_case_insensitively_and_trailing_dot():
    with feed_hosts("rsshub"):
        validate_feed_url("http://RSSHub.:1200/x")


def test_unlisted_private_host_still_refused():
    with feed_hosts("rsshub"):
        with pytest.raises(ValueError):
            validate_feed_url("http://other:1200/")


def test_listed_host_scheme_still_checked():
    with feed_hosts("rsshub"):
        with pytest.raises(ValueError):
            validate_feed_url("ftp://rsshub/x")


def test_redirect_to_unlisted_private_host_refused():
    def handler(request):
        if request.url.host == "172.18.0.5":
            return httpx.Response(302, headers={"Location": "http://10.0.0.1/secret"})
        return httpx.Response(200, text="<rss/>")

    with feed_hosts("rsshub"), _mock_httpx_client(handler):
        with pytest.raises(ValueError, match="Redirect blocked"):
            fetch_url_conditional("http://rsshub:1200/x")


def test_listed_host_fetch_is_pinned_and_works():
    seen = []

    def handler(request):
        seen.append((request.url.host, request.headers["host"]))
        return httpx.Response(200, text="<rss/>")

    with feed_hosts("rsshub"), _mock_httpx_client(handler):
        result = fetch_url_conditional("http://rsshub:1200/x")
    assert result.text == "<rss/>"
    assert seen == [("172.18.0.5", "rsshub:1200")]


def test_ai_allow_list_does_not_cover_feeds():
    with allowed_private_ai_hosts("rsshub:1200"):
        with pytest.raises(ValueError):
            validate_feed_url("http://rsshub:1200/x")


def test_feed_allow_list_does_not_cover_ai_endpoint():
    with feed_hosts("rsshub"):
        with pytest.raises(ValueError):
            validate_ai_endpoint_url("http://rsshub:1200/v1")


def test_feed_allow_list_does_not_cover_ai_transport():
    """PinnedAsyncTransport pins through _pin_connection; it must opt out."""
    transport = url_validator.PinnedAsyncTransport()
    request = httpx.Request("GET", "http://rsshub:1200/v1/models")
    with feed_hosts("rsshub"):
        with pytest.raises(ValueError):
            asyncio.run(transport._send(request))


def test_non_feed_fetchers_do_not_honour_it_by_default():
    """Readable extraction, media and page fetches call these with defaults."""
    with feed_hosts("rsshub"), _mock_httpx_client(lambda r: httpx.Response(200, text="x")):
        with pytest.raises(ValueError):
            fetch_url_page("http://rsshub:1200/article")
        with pytest.raises(ValueError):
            url_validator.fetch_url_bytes("http://rsshub:1200/img.png")
        with pytest.raises(ValueError):
            url_validator.fetch_url_with_ssrf_check("http://rsshub:1200/p")


def test_fetch_url_page_honours_it_when_asked():
    with feed_hosts("rsshub"), _mock_httpx_client(lambda r: httpx.Response(200, text="x")):
        page = fetch_url_page("http://rsshub:1200/x", feed_hosts=True)
    assert page.text == "x"


def test_validation_can_opt_out_for_non_feed_urls():
    """Saved articles are validated with validate_feed_url but are not feeds."""
    with feed_hosts("rsshub"):
        with pytest.raises(ValueError):
            validate_feed_url("http://rsshub:1200/x", feed_hosts=False)


def test_resolve_and_pin_default_refuses_private():
    with pytest.raises(ValueError):
        _resolve_and_pin("rsshub")
    assert _resolve_and_pin("rsshub", allow_private=True) == "172.18.0.5"

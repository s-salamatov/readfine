"""PWA plumbing: the manifest must stay reachable, public and honest about itself.

Not a route test for its own sake — a manifest that 404s or arrives with the wrong
content type fails silently. The browser simply never offers to install the app, and
nothing in the UI says why.
"""
import json
import struct
from collections import Counter
from html.parser import HTMLParser


def test_manifest_is_served_unauthenticated(unauth_client):
    """Fetched outside normal navigation, so it must not sit behind the session."""
    resp = unauth_client.get("/manifest.webmanifest")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/manifest+json")


def test_manifest_start_url_is_inside_scope(unauth_client):
    """start_url outside scope makes the app uninstallable, with no visible error."""
    m = json.loads(unauth_client.get("/manifest.webmanifest").content)
    assert m["start_url"].startswith(m["scope"])
    assert m["display"] == "standalone"
    assert m["background_color"] == "#141414"
    assert m["theme_color"] == "#141414"


def test_service_worker_is_served_from_the_root(unauth_client):
    """A worker's scope cannot reach above its own directory, so /static/js/sw.js would
    control nothing. The URL is also the worker's identity: keep it stable and uncached."""
    resp = unauth_client.get("/sw.js")
    assert resp.status_code == 200
    assert "javascript" in resp.headers["content-type"]
    assert resp.headers.get("cache-control") == "no-cache"


def test_service_worker_with_the_offline_flag_is_the_same_file(unauth_client):
    """Offline mode registers "/sw.js?offline=1" (the worker reads its own URL to know
    it may answer requests). Same file, same headers, same root scope."""
    plain = unauth_client.get("/sw.js")
    flagged = unauth_client.get("/sw.js?offline=1")
    assert flagged.status_code == 200
    assert flagged.content == plain.content
    assert flagged.headers.get("cache-control") == "no-cache"
    assert "javascript" in flagged.headers["content-type"]


def test_service_worker_has_a_fetch_handler_and_caches_nothing(unauth_client):
    """Chrome fires beforeinstallprompt only with a fetch handler present, so the
    Install button depends on this line existing. Caching would outlive logout."""
    body = unauth_client.get("/sw.js").text
    assert "addEventListener('fetch'" in body
    # The Cache Storage API, not the word "cache" — the file explains itself in prose.
    assert "caches." not in body


def test_manifest_icons_exist(unauth_client):
    """Every icon must resolve; a 404 here silently drops installability."""
    m = json.loads(unauth_client.get("/manifest.webmanifest").content)
    purposes = {icon["purpose"] for icon in m["icons"]}
    assert {"any", "maskable"} <= purposes
    for icon in m["icons"]:
        assert unauth_client.get(icon["src"]).status_code == 200, icon["src"]


def test_apple_startup_images_match_the_device_matrix(unauth_client):
    class StartupImageParser(HTMLParser):
        def __init__(self):
            super().__init__()
            self.in_head = False
            self.links = []

        def handle_starttag(self, tag, attrs):
            if tag == "head":
                self.in_head = True
            if self.in_head and tag == "link":
                attrs = dict(attrs)
                if attrs.get("rel") == "apple-touch-startup-image":
                    self.links.append((attrs.get("media"), attrs.get("href")))

        def handle_endtag(self, tag):
            if tag == "head":
                self.in_head = False

    devices = (
        (440, 956, 3), (402, 874, 3), (430, 932, 3), (393, 852, 3),
        (428, 926, 3), (390, 844, 3), (375, 812, 3), (414, 896, 3),
        (414, 896, 2), (375, 667, 2), (1032, 1376, 2), (1024, 1366, 2),
        (834, 1210, 2), (834, 1194, 2), (820, 1180, 2), (810, 1080, 2),
        (744, 1133, 2),
    )
    expected = {}
    for width, height, dpr in devices:
        portrait = (width * dpr, height * dpr)
        for orientation, size in (("portrait", portrait), ("landscape", portrait[::-1])):
            for scheme in ("light", "dark"):
                href = f"/static/splash/{width}x{height}-{dpr}x-{orientation}-{scheme}.png"
                media = (
                    f"(device-width: {width}px) and (device-height: {height}px) and "
                    f"(-webkit-device-pixel-ratio: {dpr}) and (orientation: {orientation}) "
                    f"and (prefers-color-scheme: {scheme})"
                )
                expected[media, href] = size

    response = unauth_client.get("/login")
    assert response.status_code == 200
    parser = StartupImageParser()
    parser.feed(response.text)
    assert len(parser.links) == 68
    assert Counter(parser.links) == Counter(expected.keys())

    total_bytes = 0
    for (_, href), size in expected.items():
        response = unauth_client.get(href)
        assert response.status_code == 200, href
        png = response.content
        assert png[:16] == b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR", href
        assert struct.unpack_from(">II", png, 16) == size, href
        assert png[25] == 3, href  # PNG indexed color
        total_bytes += len(png)
    assert total_bytes < 4_000_000

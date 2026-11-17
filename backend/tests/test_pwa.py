"""PWA plumbing: the manifest must stay reachable, public and honest about itself.

Not a route test for its own sake — a manifest that 404s or arrives with the wrong
content type fails silently. The browser simply never offers to install the app, and
nothing in the UI says why.
"""
import json


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

"""Security-header middleware: authenticated HTML must be uncacheable (CWE-525),
static assets must stay cacheable."""


def test_html_response_is_no_store(unauth_client):
    """HTML pages carry Cache-Control: no-store + Vary: Cookie so a shared browser
    can't show a previous user's rendered page (bfcache / back-forward)."""
    resp = unauth_client.get("/login")
    assert resp.headers["content-type"].startswith("text/html")
    assert resp.headers.get("cache-control") == "no-store"
    assert resp.headers.get("vary") == "Cookie"


def test_static_asset_stays_cacheable(unauth_client):
    """Static assets are not text/html and must not get no-store."""
    resp = unauth_client.get("/static/js/ai-settings.js")
    assert resp.status_code == 200
    assert not resp.headers["content-type"].startswith("text/html")
    assert resp.headers.get("cache-control") != "no-store"


def test_versioned_static_asset_is_immutable(unauth_client):
    """A static_url() asset (content hash in ?v=) is cached for a year as immutable,
    so an app launch does not revalidate every script over the network; the bare
    URL keeps the default revalidating behaviour."""
    from app.utils.static import static_url

    url = static_url("js/ai-settings.js")
    assert "?v=" in url
    resp = unauth_client.get(url)
    assert resp.status_code == 200
    assert resp.headers.get("cache-control") == "public, max-age=31536000, immutable"
    bare = unauth_client.get("/static/js/ai-settings.js")
    assert "immutable" not in (bare.headers.get("cache-control") or "")
    missing = unauth_client.get("/static/js/does-not-exist.js?v=deadbeef")
    assert missing.status_code == 404
    assert "immutable" not in (missing.headers.get("cache-control") or "")


def test_json_response_not_no_store(unauth_client):
    """Non-HTML (JSON) responses are untouched by the HTML no-store rule."""
    resp = unauth_client.get("/healthz")
    assert not resp.headers["content-type"].startswith("text/html")
    assert resp.headers.get("cache-control") != "no-store"

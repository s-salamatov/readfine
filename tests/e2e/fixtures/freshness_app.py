"""Run the real e2e app with two loopback fixture URLs allowed."""

import argparse
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

FRESHNESS_FEED_PATH = "/feeds/freshness.xml"
FRESHNESS_ARTICLE_PATH = "/articles/freshness.html"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()

    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "backend"))
    import uvicorn
    from sqlalchemy.engine import make_url

    from app.config import settings
    from app.utils import url_validator

    if make_url(settings.database_url).database != "readfine_e2e":
        sys.exit("refusing: DATABASE_URL is not the readfine_e2e database")

    origin = os.environ["E2E_FIXTURE_ORIGIN"]
    port = urlsplit(origin).port
    if port is None or origin != f"http://127.0.0.1:{port}":
        sys.exit("refusing: E2E_FIXTURE_ORIGIN must be an HTTP loopback origin")
    feed_url = origin + FRESHNESS_FEED_PATH
    article_url = origin + FRESHNESS_ARTICLE_PATH
    validate = url_validator.validate_feed_url
    pin = url_validator._pin_connection

    def validate_fixture(url: str, *, feed_hosts: bool = False) -> None:
        if url == feed_url and feed_hosts:
            return
        validate(url, feed_hosts=feed_hosts)

    def pin_fixture(url: str, *, feed_hosts: bool = False) -> tuple[str, dict, dict]:
        # The fixture URLs already use a literal IP. The real fetcher still
        # checks each redirect, response status, timeout and body size.
        if (url == feed_url and feed_hosts) or (url == article_url and not feed_hosts):
            return url, {}, {}
        return pin(url, feed_hosts=feed_hosts)

    url_validator.validate_feed_url = validate_fixture
    url_validator._pin_connection = pin_fixture
    uvicorn.run("app.main:app", host="127.0.0.1", port=args.port, workers=1)


if __name__ == "__main__":
    main()

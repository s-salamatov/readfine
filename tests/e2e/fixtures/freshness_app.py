"""Run the real e2e app with two loopback fixture URLs allowed."""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

FRESHNESS_FEED_PATH = "/feeds/freshness.xml"
FRESHNESS_ARTICLE_PATH = "/articles/freshness.html"


class InstantLaunchFixture:
    """Observe worker-owned requests at the HTTP server, including on WebKit."""

    def __init__(self, app, directory: Path):
        self.app = app
        self.control = directory / "instant-launch.json"
        self.seen = directory / "instant-launch.seen"
        self.release = directory / "instant-launch.release"

    def mark(self, status: int | None) -> None:
        pending = self.seen.with_suffix(".seen.tmp")
        pending.write_text(json.dumps({"status": status}), encoding="utf-8")
        pending.replace(self.seen)

    async def wait_for_release(self) -> bool:
        loop = asyncio.get_running_loop()
        # Leave headroom before the worker's 8 s offline fallback.
        deadline = loop.time() + 6
        while not self.release.exists():
            remaining = deadline - loop.time()
            if remaining <= 0:
                return False
            await asyncio.sleep(min(0.025, remaining))
        return True

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "GET" or scope["path"] not in ("/sync/changes", "/app"):
            return await self.app(scope, receive, send)
        try:
            control = json.loads(self.control.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return await self.app(scope, receive, send)

        from starlette.responses import HTMLResponse, JSONResponse

        mode = control["mode"]
        if (mode == "fail" and scope["path"] == "/app" and scope["query_string"] == b"rf_launch=server"
                and self.seen.exists()):
            response = HTMLResponse(
                '<!doctype html><title>Launch fixture unavailable</title><main>Fixture server rejected launch</main>',
                status_code=503,
            )
            return await response(scope, receive, send)

        headers = dict(scope["headers"])
        if (scope["path"] != "/sync/changes" or self.seen.exists()
                or headers.get(b"x-readfine-user") != str(control["readerId"]).encode()):
            return await self.app(scope, receive, send)

        self.mark(None)

        async def observe(message):
            await send(message)
            if message["type"] == "http.response.start":
                self.mark(message["status"])

        if mode == "hold":
            messages = []

            async def buffer(message):
                messages.append(message)

            await self.app(scope, receive, buffer)
            if not await self.wait_for_release():
                response = JSONResponse({"error": "launch_fixture_release_timeout"}, status_code=504)
                return await response(scope, receive, observe)

            # Keep even the headers behind the barrier and prepare the real
            # answer in advance so release does not reopen an app-processing window.
            self.mark(messages[0]["status"])
            for message in messages:
                await send(message)
            return
        if mode == "fail":
            response = JSONResponse({"error": "launch_fixture_unavailable"}, status_code=503)
            return await response(scope, receive, observe)
        return await self.app(scope, receive, observe)


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
    from app.main import app

    uvicorn.run(InstantLaunchFixture(app, Path(os.environ["E2E_FIXTURE_DIR"])),
                host="127.0.0.1", port=args.port, workers=1)


if __name__ == "__main__":
    main()

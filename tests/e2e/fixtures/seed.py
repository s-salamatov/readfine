"""Seed (and inspect) the e2e database for the offline browser suite.

Run from ``backend/`` with the e2e environment (see ``tests/e2e/env.mjs``):

    uv run python ../tests/e2e/fixtures/seed.py seed --out <file.json>
    uv run python ../tests/e2e/fixtures/seed.py ai-jobs <article_id>
    uv run python ../tests/e2e/fixtures/seed.py freshness-publish <reader_id>
    uv run python ../tests/e2e/fixtures/seed.py freshness-status <feed_id>
    uv run python ../tests/e2e/fixtures/seed.py revoke-session <reader_id>

``seed`` deletes everything an earlier run created (users ``*@e2e.example``, their
feeds and articles, articles saved by URL from ``*.invalid``) and creates:

- alice: 2 folders, 3 feeds (2 in "News", 1 in "Tech"), 10 articles with images,
  labels "Work" and "Later", a saved search "Kestrel", an API token, AI switched on
  (a quality model with no key, so a queued summary is accepted and never runs);
- bob: one feed with one article of his own (the account-switch checks);
- carol: one feed and one article (the account-deletion check).

The baseline rows go straight into the database. The article images are
written into the offline media disk cache (``OFFLINE_MEDIA_CACHE_DIR``, keyed by
sha256 of the URL), which the signed media proxy reads before it would fetch, so the
proxy needs no exception to its SSRF guard either. The same bytes go to the fixture
directory the static server on 127.0.0.1:4252 serves, for the online page.

The seed writes ``--out`` with ids, emails, passwords and API tokens. The freshness
commands publish a live fixture for the seeded reader and inspect its ingest status.
"""
import argparse
import asyncio
import hashlib
import json
import os
import struct
import sys
import zlib
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[3] / "backend"
sys.path.insert(0, str(BACKEND))

from sqlalchemy import delete, or_, select, text, update  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402

from app.auth.security import hash_password, hash_token  # noqa: E402
from app.config import settings  # noqa: E402
from app.models.article import Article, ArticleAiJob, UserArticleState  # noqa: E402
from app.models.auth import ApiToken  # noqa: E402
from app.models.feed import Feed, Folder, UserFeed  # noqa: E402
from app.models.label import Label  # noqa: E402
from app.models.settings import AppSettings  # noqa: E402
from app.models.user import User, UserSettings  # noqa: E402
from app.services.label_service import assign_label  # noqa: E402
from app.services.saved_search_service import create_saved_search  # noqa: E402
from freshness_app import FRESHNESS_ARTICLE_PATH, FRESHNESS_FEED_PATH  # noqa: E402

FIXTURE_ORIGIN = os.environ.get("E2E_FIXTURE_ORIGIN", "http://127.0.0.1:4252")
DOMAIN = "e2e.example"
PASSWORD = "e2e-password-0123456789"
NOW = datetime.now(timezone.utc)


def png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    """A solid-colour PNG: real image bytes for the proxy's magic-byte sniffing."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    row = b"\x00" + bytes(rgb) * width
    raw = zlib.compress(row * height)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")


def write_image(name: str, rgb: tuple[int, int, int]) -> str:
    url = f"{FIXTURE_ORIGIN}/img/{name}.png"
    data = png(40, 30, rgb)
    cache = Path(settings.offline_media_cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    (cache / hashlib.sha256(url.encode()).hexdigest()).write_bytes(data)
    fixtures = Path(os.environ["E2E_FIXTURE_DIR"]) / "img"
    fixtures.mkdir(parents=True, exist_ok=True)
    (fixtures / f"{name}.png").write_bytes(data)
    return url


async def reset(db: AsyncSession) -> None:
    users = select(User.id).where(User.email.like(f"%@{DOMAIN}"))
    feeds = select(Feed.id).where(Feed.feed_url.like(f"{FIXTURE_ORIGIN}/%"))
    await db.execute(delete(Article).where(or_(
        Article.feed_id.in_(feeds), Article.guid.like("e2e-%"),
        Article.url.like("%.invalid%"),
    )))
    # Saved-by-URL rows a replay created hang off the state rows of our users only.
    await db.execute(delete(Article).where(
        Article.feed_id.is_(None),
        Article.id.in_(select(UserArticleState.article_id).where(UserArticleState.user_id.in_(users))),
    ))
    await db.execute(delete(Feed).where(Feed.id.in_(feeds)))
    await db.execute(delete(User).where(User.email.like(f"%@{DOMAIN}")))
    await db.commit()


async def make_user(db: AsyncSession, name: str, *, ai: bool = False) -> User:
    user = User(email=f"{name}@{DOMAIN}", password_hash=hash_password(PASSWORD),
                display_name=name.capitalize(), email_verified=True)
    db.add(user)
    await db.flush()
    db.add(UserSettings(
        user_id=user.id, onboarded_at=NOW, timezone="UTC",
        mark_read_on_scroll=False, ai_quality_provider="anthropic" if ai else None,
        ai_quality_model="e2e-model" if ai else None,
    ))
    await db.flush()
    return user


async def make_feed(db: AsyncSession, user: User, slug: str, title: str,
                    folder: Folder | None, *, extract_readable: bool = False) -> Feed:
    feed = Feed(feed_url=f"{FIXTURE_ORIGIN}/feeds/{slug}.xml", title=title,
                site_url=f"{FIXTURE_ORIGIN}/", subscriber_count=1, status="active",
                last_fetched_at=NOW, fetch_interval_min=1440)
    db.add(feed)
    await db.flush()
    db.add(UserFeed(user_id=user.id, feed_id=feed.id, folder_id=folder.id if folder else None,
                    extract_readable=extract_readable))
    await db.flush()
    return feed


async def make_article(db: AsyncSession, feed: Feed, slug: str, title: str, age_h: int,
                       image: str | None = None, body: str = "") -> Article:
    img = f'<p><img src="{image}" alt="{title} image" data-e2e-img="{slug}"></p>' if image else ""
    filler = ("<p>This paragraph is long enough to count as real article text for the "
              "reading pane, the snippet, the local index and an on-demand AI summary.</p>")
    content = f"<p>{title}. {body}</p>" + filler * 6 + img
    when = NOW - timedelta(hours=age_h)
    article = Article(
        feed_id=feed.id, guid=f"e2e-{slug}", guid_hash=hashlib.sha256(slug.encode()).hexdigest(),
        url=f"https://{slug}.e2e.invalid/post", title=title, content=content,
        content_source="feed", readable_status="skipped", published_at=when, fetched_at=when,
        image_url=image, word_count=40, estimated_read_min=1,
    )
    db.add(article)
    await db.flush()
    return article


async def state(db: AsyncSession, user: User, article: Article, **kw) -> None:
    db.add(UserArticleState(user_id=user.id, article_id=article.id, **kw))
    await db.flush()


async def seed(out: Path) -> None:
    engine = create_async_engine(settings.database_url)
    async with AsyncSession(engine, expire_on_commit=False) as db:
        await reset(db)
        await db.execute(update(AppSettings).where(AppSettings.id == 1).values(ai_enabled=True))

        alice = await make_user(db, "alice", ai=True)
        news = Folder(user_id=alice.id, name="News", position=0)
        tech = Folder(user_id=alice.id, name="Tech", position=1)
        db.add_all([news, tech])
        await db.flush()
        f_world = await make_feed(db, alice, "world", "World Wire", news)
        f_local = await make_feed(db, alice, "local", "Local Ledger", news)
        f_gadget = await make_feed(db, alice, "gadget", "Gadget Gazette", tech)

        colours = [(200, 40, 40), (40, 160, 40), (40, 40, 200), (200, 160, 0), (120, 0, 160)]
        imgs = [write_image(f"pic{i}", c) for i, c in enumerate(colours)]
        a = {}
        a["w1"] = await make_article(db, f_world, "w1", "Kestrel sighted over the harbour", 1, imgs[0], "Birdwatchers gathered.")
        a["w2"] = await make_article(db, f_world, "w2", "Harbour ferry timetable changes", 2, imgs[1])
        a["w3"] = await make_article(db, f_world, "w3", "Storm warning for the coast", 3)
        a["l1"] = await make_article(db, f_local, "l1", "Library extends opening hours", 4, imgs[2])
        a["l2"] = await make_article(db, f_local, "l2", "Kestrel nest found in the clock tower", 5, None, "The clock tower hosts a nest.")
        a["l3"] = await make_article(db, f_local, "l3", "Market square repaving begins", 6)
        a["g1"] = await make_article(db, f_gadget, "g1", "Pocket telescope review", 7, imgs[3], "A zephyrine lens coating.")
        a["g2"] = await make_article(db, f_gadget, "g2", "Battery breakthrough claimed", 8)
        a["g3"] = await make_article(db, f_gadget, "g3", "Old phone, new tricks", 30, imgs[4])
        a["g4"] = await make_article(db, f_gadget, "g4", "Archived teardown of a router", 40)

        await state(db, alice, a["g3"], is_read=True, is_starred=True, user_starred=True,
                    ever_starred=True, starred_at=NOW - timedelta(hours=29))
        await state(db, alice, a["g4"], is_read=True, is_archived=True)
        await state(db, alice, a["l3"], saved_at=NOW - timedelta(hours=5))

        work = Label(user_id=alice.id, name="Work", color="#2563eb", position=0)
        later = Label(user_id=alice.id, name="Later", color="#16a34a", position=1)
        db.add_all([work, later])
        await db.flush()
        assert await assign_label(alice, a["w2"].id, work.id, db)
        assert await assign_label(alice, a["g1"].id, work.id, db)

        search = await create_saved_search(db, alice.id, name="Kestrel", params={"q": "kestrel"})

        token = "rf-e2e-alice-" + hashlib.sha256(os.urandom(16)).hexdigest()[:24]
        db.add(ApiToken(user_id=alice.id, name="e2e", token_hash=hash_token(token),
                        token_prefix=token[:10]))

        bob = await make_user(db, "bob")
        f_bob = await make_feed(db, bob, "bob", "Bob's Bulletin", None)
        b1 = await make_article(db, f_bob, "b1", "Bob's own article", 2)
        bob_token = "rf-e2e-bob-" + hashlib.sha256(os.urandom(16)).hexdigest()[:24]
        db.add(ApiToken(user_id=bob.id, name="e2e", token_hash=hash_token(bob_token),
                        token_prefix=bob_token[:10]))

        carol = await make_user(db, "carol")
        f_carol = await make_feed(db, carol, "carol", "Carol's Chronicle", None)
        c1 = await make_article(db, f_carol, "c1", "Carol's only article", 2)
        await db.commit()

        data = {
            "password": PASSWORD,
            "alice": {"id": alice.id, "email": alice.email, "token": token},
            "bob": {"id": bob.id, "email": bob.email, "token": bob_token, "article": b1.id},
            "carol": {"id": carol.id, "email": carol.email, "article": c1.id},
            "folders": {"news": news.id, "tech": tech.id},
            "feeds": {"world": f_world.id, "local": f_local.id, "gadget": f_gadget.id},
            "labels": {"work": work.id, "later": later.id},
            "savedSearch": search.id,
            "articles": {k: {"id": v.id, "title": v.title, "image": v.image_url} for k, v in a.items()},
        }
    await engine.dispose()
    out.write_text(json.dumps(data, indent=2))


async def ai_jobs(article_id: int) -> None:
    engine = create_async_engine(settings.database_url)
    async with AsyncSession(engine) as db:
        rows = (await db.execute(select(ArticleAiJob.operation, ArticleAiJob.status, ArticleAiJob.user_id)
                                 .where(ArticleAiJob.article_id == article_id))).all()
    await engine.dispose()
    print(json.dumps([{"operation": r[0], "status": r[1], "user_id": r[2]} for r in rows]))


async def applied_ops(email: str) -> None:
    engine = create_async_engine(settings.database_url)
    async with AsyncSession(engine) as db:
        rows = (await db.execute(text(
            "select o.result from sync_applied_ops o join users u on u.id = o.user_id "
            "where u.email = :e order by o.applied_at"), {"e": email})).all()
    await engine.dispose()
    print(json.dumps([r[0] for r in rows]))


async def user_exists(email: str) -> None:
    engine = create_async_engine(settings.database_url)
    async with AsyncSession(engine) as db:
        n = await db.scalar(text("select count(*) from users where email = :e"), {"e": email})
    await engine.dispose()
    print(json.dumps({"exists": bool(n)}))


async def revoke_session(reader_id: int) -> None:
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as db:
            revoked = await db.scalar(
                update(User)
                .where(User.id == reader_id, User.email == f"alice@{DOMAIN}")
                .values(session_token_version=User.session_token_version + 1)
                .returning(User.id)
            )
            if revoked is None:
                sys.exit("refusing: reader is not the seeded e2e Alice")
            await db.commit()
    finally:
        await engine.dispose()
    print(json.dumps({"revoked": True}))


async def freshness_publish(reader_id: int) -> None:
    title = "Observatory night survey"
    article_url = FIXTURE_ORIGIN + FRESHNESS_ARTICLE_PATH
    fixtures = Path(os.environ["E2E_FIXTURE_DIR"])
    article = fixtures / FRESHNESS_ARTICLE_PATH.lstrip("/")
    article.parent.mkdir(parents=True, exist_ok=True)
    article.write_text(
        f"""<!doctype html><html lang="en"><head><title>{title}</title></head><body>
        <article><h1>{title}</h1>
        <p>The observatory recorded a violet halo above the southern ridge.
        The night team photographed the horizon in three directions and recorded
        their observations before dawn, when the clouds started moving inland.</p>
        <p>Researchers compared the images with observations from the previous month.
        They found that the dim outer ring had persisted for almost an hour and was
        visible from two stations on opposite sides of the valley.</p>
        </article></body></html>""",
        encoding="utf-8",
    )
    rss = fixtures / FRESHNESS_FEED_PATH.lstrip("/")
    rss.parent.mkdir(parents=True, exist_ok=True)
    rss.write_text(
        f"""<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0"><channel><title>Freshness Observatory</title>
        <link>{FIXTURE_ORIGIN}/</link><description>Observatory reports</description>
        <item><guid isPermaLink="false">e2e-freshness</guid><title>{title}</title>
        <link>{article_url}</link><description>A new survey is available.</description>
        <pubDate>{format_datetime(NOW, usegmt=True)}</pubDate></item>
        </channel></rss>""",
        encoding="utf-8",
    )
    engine = create_async_engine(settings.database_url)
    async with AsyncSession(engine, expire_on_commit=False) as db:
        reader = await db.get(User, reader_id)
        if not reader or reader.email != f"alice@{DOMAIN}":
            sys.exit("refusing: reader is not the seeded e2e Alice")
        feed = await make_feed(db, reader, "freshness", "Freshness Observatory", None,
                               extract_readable=True)
        await db.commit()
    await engine.dispose()
    print(json.dumps({"feed_id": feed.id}))


async def freshness_status(feed_id: int) -> None:
    engine = create_async_engine(settings.database_url)
    async with AsyncSession(engine) as db:
        row = (await db.execute(select(Article.id, Article.readable_status).where(
            Article.feed_id == feed_id, Article.url == FIXTURE_ORIGIN + FRESHNESS_ARTICLE_PATH,
        ))).one_or_none()
    await engine.dispose()
    article_id, readable_status = row if row else (None, None)
    print(json.dumps({"article_id": article_id, "readable_status": readable_status}))


def main() -> None:
    if make_url(settings.database_url).database != "readfine_e2e":
        sys.exit("refusing: DATABASE_URL is not the readfine_e2e database")
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("seed")
    s.add_argument("--out", type=Path, required=True)
    j = sub.add_parser("ai-jobs")
    j.add_argument("article_id", type=int)
    o = sub.add_parser("applied-ops")
    o.add_argument("email")
    u = sub.add_parser("user-exists")
    u.add_argument("email")
    publish = sub.add_parser("freshness-publish")
    publish.add_argument("reader_id", type=int)
    status = sub.add_parser("freshness-status")
    status.add_argument("feed_id", type=int)
    revoke = sub.add_parser("revoke-session")
    revoke.add_argument("reader_id", type=int)
    args = p.parse_args()
    if args.cmd == "seed":
        asyncio.run(seed(args.out))
    elif args.cmd == "applied-ops":
        asyncio.run(applied_ops(args.email))
    elif args.cmd == "ai-jobs":
        asyncio.run(ai_jobs(args.article_id))
    elif args.cmd == "user-exists":
        asyncio.run(user_exists(args.email))
    elif args.cmd == "freshness-publish":
        asyncio.run(freshness_publish(args.reader_id))
    elif args.cmd == "revoke-session":
        asyncio.run(revoke_session(args.reader_id))
    else:
        asyncio.run(freshness_status(args.feed_id))


if __name__ == "__main__":
    main()

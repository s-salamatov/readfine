"""Sources add/discovery and the feed handler sheet seam (real DB + HTTP transport)."""
import json
import os
import socket
import uuid
from contextlib import contextmanager
from unittest.mock import patch

import httpx
import pytest
import pytest_asyncio
from fastapi import Depends
from jinja2 import ChoiceLoader, DictLoader
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.auth.dependencies import get_current_user
from app.config import settings
from app.database import get_db
from app.main import app
from app.models.feed import Feed, Folder, UserFeed
from app.models.user import User
from app.templating import templates
from app.utils.request_context import current_viewer
from tests.conftest import mock_httpx_client

SHEET = {"HX-Request": "true", "HX-Target": "rf-source-sheet-body"}
RSS = '<rss version="2.0"><channel><title>&lt;Bad &amp; title&gt;</title><link>https://example.com</link><description>Test</description><item><guid>one</guid><title>One</title></item></channel></rss>'


@pytest_asyncio.fixture
async def sources_client(monkeypatch):
    rendered = []
    render = templates.TemplateResponse
    def record_response(*args, **kwargs):
        response = render(*args, **kwargs)
        rendered.append(response)
        return response
    monkeypatch.setattr(templates, 'TemplateResponse', record_response)
    engine = create_async_engine(settings.database_url)
    async with engine.connect() as conn:
        transaction = await conn.begin()
        async with AsyncSession(conn, expire_on_commit=False, join_transaction_mode="create_savepoint") as db:
            user = User(email=f"{uuid.uuid4().hex}@example.com", password_hash="x", display_name="Reader")
            db.add(user)
            await db.flush()
            db.add(Folder(user_id=user.id, name='<Folder & name>'))
            await db.commit()

            async def database():
                yield db

            async def viewer(db=Depends(get_db)):
                me = await db.get(User, user.id)
                current_viewer.set((me.id, me.display_name))
                return me

            app.dependency_overrides[get_db] = database
            app.dependency_overrides[get_current_user] = viewer
            try:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as client:
                    yield client, db, user.id, rendered
            finally:
                app.dependency_overrides.clear()
        await transaction.rollback()
    await engine.dispose()


@contextmanager
def outbound(handler):
    # DNS and HTTP are the only external boundaries. Parsing/detection/cache and
    # SSRF validation still execute; no service/subscribe mocks.
    with patch('app.utils.url_validator.socket.getaddrinfo', return_value=[
        (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443))
    ]), mock_httpx_client(handler):
        yield


async def test_sources_add_form_and_fallback(sources_client):
    """Catches missing route/fields, a fragment selected by HX-Request, and unsafe redisplay."""
    client, db, _, rendered = sources_client
    fields = ['url', 'custom_title', 'folder_id', 'fetch_interval_min', 'is_private',
              'fetch_auth_user', 'fetch_auth_pass', 'import_mode', 'import_limit']
    for headers, full in [({}, True), ({'HX-Request': 'true', 'HX-Boosted': 'true'}, True), (SHEET, False)]:
        response = await client.get('/settings/feeds/add', headers=headers)
        assert response.status_code == 200
        assert ('<html' in response.text) == full
        assert ('<body' in response.text) == full
        assert response.text.count('id="feed-subscribe-form"') == 1
        assert response.text.count('id="rf-source-sheet"') == int(full)
        for field in fields:
            assert f'name="{field}"' in response.text
        assert 'data-rf-source-form="add"' in response.text
        assert '&lt;Folder &amp; name&gt;' in response.text
        assert response.headers['cache-control'] == 'no-store'
        # main.py currently overwrites Vary; wave 2 owns the middleware fix.
        assert 'HX-Target' in rendered[-1].headers['vary']
    response = await client.post('/settings/feeds', data={
        'url': 'ftp://example.com/feed', 'custom_title': '<img src=x onerror=alert(1)>',
        'fetch_auth_pass': 'never-redisplay-me', 'import_mode': 'latest', 'import_limit': '42',
    })
    assert 'id="feed-subscribe-form"' in response.text
    assert '&lt;img src=x onerror=alert(1)&gt;' in response.text
    assert 'never-redisplay-me' not in response.text
    assert 'value="42"' in response.text


async def test_sources_discovery_credentials_and_errors(sources_client):
    """Catches auth precedence/leaks and silent non-RSS/transport responses."""
    client, _, _, _ = sources_client
    seen = []
    def transport(req):
        seen.append((str(req.url.copy_with(host=req.headers['host'])), req.headers.get('authorization')))
        if req.url.path == '/unauthorized':
            return httpx.Response(401)
        if req.url.path == '/captcha':
            return httpx.Response(403, text='<html>captcha challenge</html>')
        if req.url.path == '/site':
            return httpx.Response(200, text='<html><link rel="alternate" type="application/rss+xml" href="/candidate"></html>')
        if req.url.path in ('/feed-ok', '/candidate'):
            return httpx.Response(200, text=RSS, headers={'content-type': 'application/rss+xml'})
        return httpx.Response(200, text='<html>No feeds</html>')
    with outbound(transport):
        for extra, auth in [({}, 'Basic dXJsOnNlY3JldA=='), ({'fetch_auth_user': 'explicit', 'fetch_auth_pass': 'pass'}, 'Basic ZXhwbGljaXQ6cGFzcw==')]:
            seen.clear()
            response = await client.post('/settings/feeds/test', data={'url': 'https://url:secret@example.com/feed-ok', **extra})
            assert seen[0] == ('https://example.com/feed-ok', auth)
            assert 'secret' not in response.text and 'explicit' not in response.text
            assert 'data-feed-title="&lt;Bad &amp; title&gt;"' in response.text
        for path, expected in [('/unauthorized', '401'), ('/captcha', '403'), ('/site', 'data-select-detected-feed'), ('/empty', 'No RSS feed found')]:
            response = await client.post('/settings/feeds/test', data={'url': f'https://url:secret@example.com{path}'})
            assert response.status_code == 200
            assert expected in response.text
            assert 'secret' not in response.text
            if path in ('/site', '/empty'):
                assert 'data-rf-source-sheet' in response.text
                assert 'data-rf-online-only' in response.text
                for attr in ['hx-target="#rf-source-sheet-body"', 'hx-swap="innerHTML"', 'hx-push-url="false"', 'hx-boost="false"']:
                    assert attr in response.text
            if path == '/site':
                assert '&lt;Bad &amp; title&gt;' in response.text
                assert '<Bad & title>' not in response.text

        response = await client.post('/settings/feeds', headers={'HX-Request': 'true', 'HX-Target': 'feed-test-result'}, data={
            'url': 'https://url:secret@example.com/site',
        })
        assert 'secret' not in response.text, 'failed subscribe must not put URL credentials in scrape links'


async def test_sources_sheet_response_contract(sources_client, monkeypatch):
    """Catches false save success, wrong representation, and ownership/mutation regressions."""
    client, db, user_id, rendered = sources_client
    # Wave 1: T3 owns edit markup. This fixture consumes T1's exact shared seam.
    # The assembled-wave verifier sets this to exercise T3's real edit template.
    if os.environ.get('RF_SOURCES_REAL_TEMPLATES') != '1':
        loader = templates.env.loader
        monkeypatch.setattr(templates.env, 'loader', ChoiceLoader([DictLoader({
            'settings/feed_edit.html': '''{% extends "sources/sheet_content.html" if request.headers.get("HX-Target") == "rf-source-sheet-body" else "sources/base.html" %}{% block sources_content %}<form id="edit-fixture">{{ url_error }} {{ url_value }} {{ selector_error }} {{ uf.custom_title }}</form>{% endblock %}'''
        }), loader]))
    templates.env.cache.clear()
    with outbound(lambda req: httpx.Response(200, text=RSS, headers={'content-type': 'application/rss+xml'})):
        for index, headers in enumerate([SHEET, {}, {'HX-Request': 'true'}]):
            response = await client.post('/settings/feeds', headers=headers, data={'url': f'https://example.com/t1-{uuid.uuid4().hex}', 'custom_title': 'Initial'})
            if headers == SHEET:
                assert response.status_code == 200
                assert response.content == b''
                assert response.headers['HX-Reswap'] == 'none'
                event = json.loads(response.headers['HX-Trigger'])
                assert event['rf:sourceschanged'] == {'kind': 'subscribe'}
                assert event['sidebarRefresh'] is True
                assert event['showToast']['type'] == 'ok'
            else:
                assert response.status_code == (200 if headers else 303)
                assert response.headers['HX-Redirect' if headers else 'location'].startswith('/settings/feeds')
        uf = (await db.scalars(select(UserFeed).where(UserFeed.user_id == user_id))).first()
        uf_id, feed_id = uf.id, uf.feed_id
        for headers in [SHEET, {}, {'HX-Request': 'true'}]:
            response = await client.post(f'/settings/feeds/{uf_id}/edit', headers=headers, data={'custom_title': 'Saved'})
            if headers == SHEET:
                assert response.status_code == 200 and not response.content
                assert response.headers['HX-Reswap'] == 'none'
                assert json.loads(response.headers['HX-Trigger'])['rf:sourceschanged'] == {'kind': 'edit'}
            else:
                assert response.status_code == (200 if headers else 303)
        response = await client.post(f'/settings/feeds/{uf_id}/edit', headers=SHEET, data={'feed_url': 'ftp://example.com/invalid', 'custom_title': 'Must not save'})
        assert '<html' not in response.text and '<form' in response.text
        assert 'rf:sourceschanged' not in response.headers.get('HX-Trigger', '')
        assert response.headers['cache-control'] == 'no-store'
        assert 'HX-Target' in rendered[-1].headers['vary']
        assert (await db.get(UserFeed, uf_id)).custom_title == 'Saved'
        other = User(email=f'{uuid.uuid4().hex}@example.com', password_hash='x', display_name='Other')
        db.add(other)
        await db.flush()
        foreign = UserFeed(user_id=other.id, feed_id=feed_id, custom_title='Other title')
        db.add(foreign)
        await db.commit()
        response = await client.post(f'/settings/feeds/{foreign.id}/edit', headers=SHEET, data={'custom_title': 'Stolen'})
        assert response.status_code == 404
        assert 'HX-Trigger' not in response.headers
        await db.refresh(foreign)
        assert foreign.custom_title == 'Other title'
    templates.env.cache.clear()

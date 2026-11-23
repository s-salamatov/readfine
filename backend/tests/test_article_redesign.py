"""The s4 article: sticky toolbar, AI panel tabs, the floating bar's hooks, and the AI
and chat error fragments on the alert macro.

The detail is rendered straight from the partial, as ``test_partials_online_unchanged``
does, so each case states exactly what the template is given. The AI fragments go
through the routes with the mocked database of ``test_ai_summary_context``.
"""
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from bs4 import BeautifulSoup
from starlette.requests import Request

from app.schemas.article import ArticleResponse
from app.templating import templates

AID = 4242
WHEN = datetime(2020, 1, 2, 3, 4, tzinfo=timezone.utc)
BODY = "<p>Body text of the article.</p>"


@pytest.fixture(autouse=True)
def reset_rate_limiter():
    from app.rate_limit import limiter
    limiter.reset()
    yield


def _request() -> Request:
    return Request({
        "type": "http", "method": "GET", "path": "/", "query_string": b"",
        "headers": [(b"host", b"testserver")], "scheme": "http",
        "server": ("testserver", 80), "root_path": "",
    })


def _article(**kw) -> ArticleResponse:
    base = dict(
        id=AID, feed_id=7, feed_title="Feed T", url="https://pub.example/a",
        title="Original title", author="Ann", content=BODY, content_source="feed",
        readable_content=None, readable_status="skipped", published_at=WHEN,
        estimated_read_min=3, word_count=500, image_url=None, is_read=False,
        is_starred=False, is_archived=False, read_at=None,
    )
    base.update(kw)
    return ArticleResponse(**base)


def _detail(article=None, **ctx) -> BeautifulSoup:
    context = dict(mark_read_on_scroll=False, ai_available=True, summary_pending=False,
                   chat_available=True, chat_messages=[], related_count=0, show_score=False)
    context.update(ctx)
    html = templates.env.get_template("app/partials/article_detail.html").render(
        request=_request(), article=article or _article(), **context)
    return BeautifulSoup(html, "html.parser")


def test_detail_toolbar_keeps_the_keyboard_and_offline_hooks():
    d = _detail()
    toolbar = d.find(attrs={"data-article-toolbar": True})
    assert toolbar is not None
    assert "article-detail-menu" in toolbar["class"]
    assert toolbar.find_parent(id="article-detail-root") is not None
    # m / s / e (app.js) and the offline overlay find these three in the toolbar.
    for hook, path, slot in (("data-header-read", "read", "read-button"),
                             ("data-header-star", "star", "star-button"),
                             ("data-header-archive", "archive", "archive-button")):
        btn = toolbar.find(attrs={hook: True})
        assert btn is not None, hook
        assert btn.name == "button"
        assert btn["hx-post"] == f"/htmx/articles/{AID}/{path}"
        assert btn["data-rf-slot"] == slot
        assert btn.find(attrs={"data-label": True}) is not None
        # app.js and overlay.js write the state into the first svg.
        assert btn.find("svg") is not None
    # v opens the original through the title link.
    link = d.select_one(".article-detail-title-row [data-external-link]")
    assert link is not None and link["href"] == "https://pub.example/a"
    assert toolbar.find("a", attrs={"data-external-link": True}) is not None
    # The label picker stays reachable in the phone's full-screen article, which hides
    # the read / star / archive group.
    trigger = toolbar.find(attrs={"data-label-trigger": True})
    assert trigger is not None and trigger.find_parent(class_="article-toolbar-state") is None
    assert d.find(attrs={"data-rf-progress": True}) is not None
    assert toolbar.find(attrs={"data-rf-progress": True}) is not None
    assert toolbar.find(id=f"mobile-detail-back-btn") is not None
    ask = toolbar.find(attrs={"data-show-chat-modal": str(AID)})
    assert ask is not None and ask.has_attr("data-rf-online-only")
    # The "···" menu is a Basecoat dropdown with share, copy and nothing that left it.
    menu = toolbar.find(id=f"article-menu-{AID}")
    assert menu is not None and "dropdown-menu" in menu["class"]
    assert menu.find(attrs={"data-bottom-share": True}) is not None
    assert menu.find(attrs={"data-copy-article": str(AID)}) is not None
    for gone in ("detail-topbar-star", "detail-topbar-archive", "detail-topbar-share",
                 "detail-topbar-next"):
        assert d.find(id=gone) is None, gone
    assert d.find(attrs={"data-menu-toggle": True}) is None
    assert d.find(attrs={"data-show-context-panel": True}) is None
    # The floating bar's hooks.
    bar = d.select_one(f".article-bottom-bar[data-article-id='{AID}']")
    for hook in ("data-bottom-read", "data-bottom-star", "data-bottom-archive",
                 "data-bottom-share", "data-bottom-next"):
        assert bar.find(attrs={hook: True}) is not None, hook
    assert bar.find(attrs={"data-bottom-read": True})["hx-post"] == f"/htmx/articles/{AID}/read"
    assert bar.find(attrs={"data-bottom-read": True})["hx-target"] == f"#read-btn-{AID}"

    # Ask only with chat.
    no_chat = _detail(chat_available=False)
    assert no_chat.find(attrs={"data-show-chat-modal": True}) is None

    # A translated title: the toggle and both titles survive.
    t = _detail(_article(translated_title="Translated title"))
    art = t.find("article")
    assert art["data-title-translated"] == "Translated title"
    assert art["data-title-original"] == "Original title"
    assert t.find(attrs={"data-toggle-translation": str(AID)}) is not None
    assert t.find(attrs={"data-translation-mark": True}) is not None
    assert t.find(attrs={"data-detail-title": True}).get_text(strip=True) == "Translated title"


@pytest.mark.parametrize("case", ["stored", "pending", "none", "off", "context"])
def test_detail_ai_panel_tabs_show_summary_context_and_the_generate_actions(case):
    if case == "stored":
        d = _detail(_article(ai_summary="Stored **summary**"))
    elif case == "pending":
        d = _detail(summary_pending=True)
    elif case == "none":
        d = _detail()
    elif case == "off":
        d = _detail(ai_available=False)
    else:
        d = _detail(_article(ai_context="Stored context"), ai_available=False)

    panel = d.find(id=f"ai-panel-{AID}")
    if case == "off":
        assert panel is None
        assert d.find(id=f"ai-summary-{AID}") is None
        assert d.find(attrs={"data-rf-slot": "ai-summary-action"}) is None
        return
    assert panel is not None and "tabs" in panel["class"]
    tabs = panel.find_all(attrs={"role": "tab"})
    assert [t.get_text(strip=True) for t in tabs] == ["Summary", "Context"]
    assert tabs[0]["aria-selected"] == "true" and tabs[1]["aria-selected"] == "false"
    summary_panel = d.find(id=tabs[0]["aria-controls"])
    context_panel = d.find(id=tabs[1]["aria-controls"])
    assert not summary_panel.has_attr("hidden")
    assert context_panel.has_attr("hidden")
    # Ask is a button beside the tabs, not a tab.
    section = panel.find_parent("section")
    ask = section.find(attrs={"data-show-chat-modal": str(AID)})
    assert ask is not None and ask.get("role") != "tab"
    assert ask.find_parent(attrs={"role": "tablist"}) is None

    summary = summary_panel.find(id=f"ai-summary-{AID}")
    assert summary is not None
    if case == "stored":
        assert "Stored" in summary.get_text() and summary.find("strong") is not None
        assert d.find(attrs={"data-rf-slot": "ai-summary-action"}) is None
    elif case == "pending":
        assert summary["hx-trigger"] == "every 5s"
        assert summary["hx-get"] == f"/htmx/articles/{AID}/ai-summary/poll"
    elif case == "none":
        gen = summary_panel.find(attrs={"data-rf-slot": "ai-summary-action"})
        assert gen is not None and gen.name == "button"
        assert gen["hx-post"] == f"/htmx/articles/{AID}/ai-summary"
        assert gen["hx-target"] == f"#ai-summary-{AID}"
        assert "Generate summary" in gen.get_text()
        # Outside the swap target: a failure answer replaces the target, not the button.
        assert gen.find_parent(id=f"ai-summary-{AID}") is None

    area = context_panel.find(id=f"ai-context-area-{AID}")
    assert area is not None and area["data-rf-slot"] == "ai-context"
    assert area.find(id=f"ai-context-{AID}") is not None
    if case == "context":
        assert "Stored context" in area.get_text()
        # AI off: the stored context shows, the generate form does not.
        assert d.find(id=f"context-panel-{AID}") is None
    else:
        form = context_panel.find(id=f"context-panel-{AID}")
        assert form is not None and not form.has_attr("hidden")
        assert "hidden" not in (form.get("class") or [])
        assert form.find(id=f"context-focus-{AID}") is not None
        actions = d.find_all(attrs={"data-rf-slot": "ai-context-action"})
        assert len(actions) == 1 and actions[0]["hx-post"] == f"/htmx/articles/{AID}/ai-context"


def _make_settings(**kw):
    base = dict(user_id=1, ai_quality_provider="anthropic", ai_quality_model="m",
                ai_content_limit=20000, ai_min_content_chars=1700, ai_summary_prompt=None,
                ai_context_prompt=None, ai_translation_language=None)
    base.update(kw)
    return SimpleNamespace(**base)


def _setup_db(db, scalars, article=None):
    db.scalar = AsyncMock(side_effect=scalars)
    result = MagicMock()
    result.scalar_one_or_none.return_value = article
    db.execute = AsyncMock(return_value=result)


def _long_article():
    return SimpleNamespace(id=10, title="T", content="word " * 500, readable_content=None,
                           feed_id=None)


@pytest.mark.parametrize("case", ["summary", "poll", "context", "disabled"])
def test_ai_failure_and_note_fragments_use_the_alert_macro_and_keep_the_swap_id(
        case, client, mock_db):
    if case == "summary":
        _setup_db(mock_db, [True, _make_settings()], _long_article())
        with patch("app.services.ai_summary_service.run_summary_on_demand",
                   new=AsyncMock(return_value=(None, False, "<b>bad</b>"))):
            resp = client.post("/htmx/articles/10/ai-summary")
        target, variant, text = "ai-summary-10", "destructive", "Summary failed: <b>bad</b>"
    elif case == "poll":
        job = SimpleNamespace(job_params=None, id=1, article_id=10, user_id=1,
                              operation="summary", status="failed",
                              error_message="<b>bad</b>")
        mock_db.scalar = AsyncMock(return_value=job)
        resp = client.get("/htmx/articles/10/ai-summary/poll")
        target, variant, text = "ai-summary-10", "destructive", "Summary failed: <b>bad</b>"
    elif case == "context":
        _setup_db(mock_db, [True, _make_settings()], _long_article())
        with (
            patch("app.services.ai_service.get_ai_client",
                  new=AsyncMock(return_value=(AsyncMock(), "anthropic", "m"))),
            patch("app.services.ai_service.get_article_context",
                  new=AsyncMock(side_effect=Exception("<b>bad</b>"))),
        ):
            resp = client.post("/htmx/articles/10/ai-context")
        target, variant = "ai-context-10", "destructive"
        text = None  # describe_ai_error words it; checked for escaping below
    else:
        _setup_db(mock_db, [False])
        resp = client.post("/htmx/articles/10/ai-summary")
        target, variant, text = "ai-summary-10", "default", "AI is disabled."

    assert resp.status_code == 200
    soup = BeautifulSoup(resp.text, "html.parser")
    el = soup.find(id=target)
    assert el is not None, resp.text
    assert "alert" in el["class"]
    assert "text-red-500" not in resp.text and "text-gray-400" not in resp.text
    if variant == "destructive":
        assert el["data-variant"] == "destructive" and el["role"] == "alert"
    else:
        assert not el.has_attr("data-variant") and el["role"] == "status"
    if text is not None:
        assert el.get_text(strip=True) == text
    # Escaped exactly once: the markup in the error is text, not tags, nor &amp;lt;.
    assert el.find("b") is None
    if case != "disabled":
        assert "&lt;b&gt;" in resp.text and "&amp;lt;" not in resp.text


def test_chat_an_error_renders_the_alert_with_data_chat_error():
    from app.routers.web.app.ai import _render_chat_area
    soup = BeautifulSoup(_render_chat_area(7, [], error="boom <i>x</i>"), "html.parser")
    err = soup.find(attrs={"data-chat-error": True})
    assert err is not None
    assert "alert" in err["class"] and err["data-variant"] == "destructive"
    assert err["role"] == "alert"
    assert err.get_text(strip=True) == "boom <i>x</i>" and err.find("i") is None
    assert soup.select(".text-red-500") == []
    # No error, no alert.
    clean = BeautifulSoup(_render_chat_area(7, []), "html.parser")
    assert clean.find(attrs={"data-chat-error": True}) is None


def _hidden(el) -> bool:
    for node in [el, *el.parents]:
        if getattr(node, "attrs", None) is None:
            continue
        if node.has_attr("hidden") or "hidden" in (node.get("class") or []):
            return True
    return False


def test_detail_without_js_the_title_body_and_original_link_are_not_hidden():
    d = _detail(_article(ai_summary="Stored summary"))
    title = d.select_one(".article-detail-title-row [data-external-link]")
    assert title is not None and not _hidden(title)
    body = d.find(string=lambda s: s and "Body text of the article." in s)
    assert body is not None and not _hidden(body.parent)
    summary = d.find(id=f"ai-summary-{AID}")
    assert summary is not None and not _hidden(summary)
    toolbar = d.find(attrs={"data-article-toolbar": True})
    assert not _hidden(toolbar)
    original = toolbar.find("a", attrs={"data-external-link": True})
    assert original["href"] == "https://pub.example/a" and not _hidden(original)
    for hook in ("data-header-read", "data-header-star", "data-header-archive"):
        btn = toolbar.find(attrs={hook: True})
        assert btn.name == "button" and btn.has_attr("hx-post"), hook

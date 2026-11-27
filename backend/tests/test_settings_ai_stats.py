"""Settings → AI provider and Stats: the restyle keeps the form and loader contracts."""
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from bs4 import BeautifulSoup

from app import templating
from app.routers.web.settings import stats
from tests.test_assistant_profile import STAMP, dom, profile  # noqa: F401
from tests.test_briefing import make_app_settings, make_config, make_user
from tests.test_scrape_ai_selector import ai_client  # noqa: F401
from tests.test_translation import pg  # noqa: F401

# The field names the preferences handler reads, as the page sent them at 12cc961.
PREFERENCE_FIELDS = {
    "ai_custom_base_url", "ai_fast_provider", "ai_fast_model", "ai_quality_provider",
    "ai_quality_model", "ai_scoring_enabled_default", "ai_summary_enabled_default",
    "ai_min_content_chars", "ai_summary_prompt", "ai_context_prompt",
    "ai_translation_language", "ai_translation_slot", "ai_chat_enabled", "ai_content_limit",
}


def names(form):
    return {el["name"] for el in form.select("[name]")}


async def test_ai_provider_page_keeps_form_contract(profile):  # noqa: F811
    p = profile
    p.s.last_ai_error = "Provider said no"
    p.s.last_ai_error_at = STAMP
    await p.db.flush()
    response = await p.web.get("/settings/ai")
    assert response.status_code == 200
    soup = dom(response)
    assert "AI provider" in [h.get_text(strip=True) for h in soup.select("main h1")]

    key_forms = soup.select('form[action="/settings/ai/keys"]')
    assert key_forms
    for form in key_forms:
        assert names(form) == {"provider", "api_key"}
    # The stored key's Remove button empties its own form's field (ai-settings.js).
    assert soup.select_one('button[type="submit"][data-clear-key]').find_parent("form") in key_forms

    form = soup.select_one('form[action="/settings/ai/preferences"]')
    assert names(form) == PREFERENCE_FIELDS
    for selector in (
        "#custom-endpoint-row.hidden", "#auto-summary-dependent #ai_min_content_chars[data-thousands]",
        "#ai_content_limit[data-thousands]", 'select[data-slot="fast"]', 'select[data-slot="quality"]',
        "#verify-fast", "#verify-quality", "#models-link-fast", "#models-link-quality",
        '[hx-post="/settings/ai/verify/fast"][data-loading-target="verify-fast"][data-loading-text]',
        '[data-insert-default="#ai_summary_prompt"]', '[data-insert-default="#ai_context_prompt"]',
        'a[href="/assistant?section=profile#assistant-profile"]',
    ):
        assert soup.select_one(selector), selector
    panel = soup.select_one("#ai-error-panel")
    assert "Provider said no" in panel.get_text()
    assert panel.select_one('[hx-post="/settings/ai/dismiss-error"][hx-target="#ai-error-panel"]')


async def test_stats_page_cards_and_tokens(profile):  # noqa: F811
    p = profile
    p.app.include_router(stats.router)
    response = await p.web.get("/settings/stats")
    assert response.status_code == 200
    soup = dom(response)
    assert "Stats" in [h.get_text(strip=True) for h in soup.select("main h1")]
    assert soup.select("main .card")
    # The cost table and the per-feed table live on AI provider and Sources.
    assert not soup.select_one('main [hx-get]')

    # Checked on the sources: a reader with no data renders none of the tables.
    env = templating.templates.env
    for name in ("settings/stats.html", "settings/partials/ai_cost_table.html",
                 "settings/partials/feeds_stats.html"):
        source = env.loader.get_source(env, name)[0]
        assert "divide-gray-" not in source, name


async def test_setup_messages_name_ai_provider(ai_client):  # noqa: F811
    with patch("app.services.ai_service.get_ai_client",
               new=AsyncMock(return_value=(None, None, None))):
        response = ai_client.post("/sources/scrape-ai-selector", data={
            "url": "https://example.com", "html_sample": "<a href='/a'>A</a>"})
    link = BeautifulSoup(response.text, "html.parser").select_one('a[href="/settings/ai"]')
    assert link and link.get_text() == "Settings → AI provider"

    from app.services.briefing_service import send_briefing

    db = AsyncMock()
    db.add = MagicMock()
    article = SimpleNamespace(id=1, title="A", feed_title="F", published_at=None,
                              fetched_at=STAMP, folder_id=None, score=None, ai_summary=None,
                              readable_content=None, content="text")
    with patch("app.services.briefing_service.fetch_catchup_articles",
               new=AsyncMock(return_value=[article])), \
         patch("app.services.ai_service.get_ai_client",
               new=AsyncMock(return_value=(None, None, None))):
        with pytest.raises(RuntimeError, match="set one up in Settings → AI provider$"):
            await send_briefing(make_config(), make_user(), db, make_app_settings())

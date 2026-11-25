"""Assistant digest presentation; existing services keep their detailed tests."""
import copy
import smtplib
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from bs4 import BeautifulSoup
from starlette.requests import Request

from app.models.user import UserSettings
from app.routers.web.app import catchup
from app.templating import templates
from app.services.briefing_service import MAX_BRIEFINGS_WITH_RECIPIENTS
from tests.conftest import make_scalar_result, make_mock_user
from tests.test_briefing import make_config, make_app_settings


@pytest.mark.asyncio
async def test_assistant_catchup_section_and_scope(mock_db):
    user = make_mock_user()
    settings = UserSettings(user_id=user.id, timezone='Invalid/Zone', ai_fast_provider='openai',
                            ai_quality_provider=None, ai_quality_model=None)
    mock_db.execute.side_effect = [make_scalar_result(settings), make_scalar_result([]),
                                  make_scalar_result(('smtp', None, 'from@example.com'))]
    with patch.object(catchup, 'ai_enabled_globally', AsyncMock(return_value=True)), \
         patch('app.services.feed.list_user_feeds', AsyncMock(return_value=[])), \
         patch.object(catchup, 'list_labels', AsyncMock(return_value=[])):
        ctx = await catchup.catchup_page_context(user, mock_db)
    keys = {'catchup_available', 'ai_scoring_available', 'user_feeds', 'labels', 'saved_configs',
            'default_catchup_prompt', 'custom_prompt_max', 'period_descs', 'smtp_available',
            'main_model_configured'}
    assert keys <= ctx.keys()
    request = Request({'type': 'http', 'state': {'csp_nonce': 'test'}})
    template = templates.env.get_template('assistant/catchup.html')
    html = template.render(catchup_context=ctx, request=request)
    assert 'No saved configurations' in html and 'main model' in html
    assert 'No subscriptions' in html
    cfg = make_config(name='<img src=x onerror=alert(1)>', scope_include='["feed:1","folder:2"]')
    ctx.update(saved_configs=[cfg], scope_value=cfg.scope_include, ai_scoring_available=True,
               labels=[SimpleNamespace(id=3, name='News', color='blue')])
    html = template.render(catchup_context=ctx, request=request)
    soup = BeautifulSoup(html, 'html.parser')
    for id_ in ('assistant-catch-up', 'catchup-form', 'catchup-result', 'catchup-estimate',
                'catchup-configs-list-wrapper', 'rf-briefing-sheet', 'rf-briefing-sheet-body'):
        assert len(soup.select('#' + id_)) == 1
    assert soup.select_one('dialog#rf-briefing-sheet')
    assert soup.select_one('#scope-value')['value'] == cfg.scope_include
    assert {x['value'] for x in soup.select('[name=period]')} == {'today', 'yesterday', '7days'}
    for name in ('scope_include', 'label_filter', 'filter_status', 'include_snippet', 'article_limit', 'custom_prompt'):
        assert soup.select_one(f'[name={name}]')
    assert soup.select_one('#article-limit')['max'] == '500'
    assert soup.select_one('#custom-prompt')['maxlength'] == str(ctx['custom_prompt_max'])
    assert soup.select_one('#save-config-form')['hx-target'] == '#catchup-configs-list-wrapper'
    assert soup.select_one('#catchup-form')['hx-target'] == '#catchup-result'
    assert soup.select_one('[name=include_snippet]').has_attr('checked')
    assert soup.select_one('#score-filter-value')['max'] == '100'
    assert not soup.select('img') and cfg.name in soup.get_text()
    assert 'News' in html
    mock_db.execute.side_effect = None
    mock_db.execute.return_value = make_scalar_result(None)
    with patch.object(catchup, 'ai_enabled_globally', AsyncMock(return_value=False)):
        unavailable = await catchup.catchup_page_context(user, mock_db)
    assert keys <= unavailable.keys()
    assert '/settings/ai' in template.render(catchup_context=unavailable, request=request)


def test_assistant_briefing_save_and_validation(client, mock_db):
    cfg = make_config(briefing_enabled=False)
    app_cfg = make_app_settings(briefing_extra_recipients_enabled=True)
    mock_db.scalar.return_value = app_cfg
    def results():
        mock_db.execute.side_effect = [make_scalar_result(cfg), make_scalar_result(SimpleNamespace(timezone='UTC')),
                                      make_scalar_result([cfg]), make_scalar_result(('smtp', 'from@example.com'))]
    results()
    response = client.put('/htmx/catchup-configs/1/briefing', data={
        'briefing_enabled': 'true', 'briefing_interval': 'weekly', 'briefing_day': '2', 'briefing_time': '09:30'})
    assert response.status_code == 200
    assert response.headers['HX-Trigger'] == 'closeBriefingModal'
    assert 'Weekly Wed 09:30' in response.text and 'catchup-configs-list' in response.text
    assert 'data-rf-catchup-list' in response.text
    assert cfg.briefing_next_send_at is not None
    for invalid in ({'briefing_interval': 'hourly'}, {'briefing_interval': 'weekly', 'briefing_day': '9'},
                    {'briefing_time': '25:10'}, {'briefing_recipients': '<bad>'},
                    {'briefing_enabled': 'true', 'briefing_recipients': 'other@example.com'}):
        before = copy.deepcopy(vars(cfg))
        mock_db.commit.reset_mock()
        mock_db.execute.side_effect = None
        mock_db.execute.return_value = make_scalar_result(cfg)
        with patch('app.services.briefing_service.other_briefings_with_recipients', AsyncMock(return_value=MAX_BRIEFINGS_WITH_RECIPIENTS)):
            response = client.put('/htmx/catchup-configs/1/briefing', data=invalid)
        assert response.headers['HX-Retarget'] == '#briefing-form-error'
        assert 'HX-Trigger' not in response.headers and 'role="alert"' in response.text
        assert vars(cfg) == before
        mock_db.commit.assert_not_called()


def test_assistant_config_not_found_and_test_feedback(client, mock_db):
    from app.rate_limit import limiter
    with patch.object(limiter, 'enabled', False), patch('app.services.briefing_service.send_briefing', AsyncMock()) as send:
        for id_ in (999, 222):  # absent or filtered by the owner predicate
            for method, suffix in (('put', ''), ('put', '/rename'), ('get', '/briefing'),
                                   ('put', '/briefing'), ('post', '/briefing/test')):
                mock_db.execute.side_effect = None
                mock_db.execute.return_value = make_scalar_result(None)
                kwargs = {} if method == 'get' else {'data': {'name': 'x'}}
                response = getattr(client, method)(f'/htmx/catchup-configs/{id_}{suffix}', **kwargs)
                assert response.status_code == 404
                assert 'Configuration not found.' in response.text and 'role="alert"' in response.text
                query = mock_db.execute.call_args.args[0]
                assert 'user_catchup_configs.user_id' in str(query)
        mock_db.commit.assert_not_called()
        send.assert_not_called()
        for mode in ('success', 'ai-off', 'smtp-off', 'smtp-error', 'provider-error'):
            cfg = make_config()
            app_cfg = make_app_settings(ai_enabled=mode != 'ai-off', smtp_host='' if mode == 'smtp-off' else 'smtp')
            mock_db.execute.side_effect = [make_scalar_result(cfg), make_scalar_result(app_cfg),
                                          make_scalar_result(SimpleNamespace(timezone='UTC'))]
            send.reset_mock()
            send.side_effect = (smtplib.SMTPException('<bad>') if mode == 'smtp-error' else
                                RuntimeError('<bad>') if mode == 'provider-error' else None)
            response = client.post('/htmx/catchup-configs/1/briefing/test')
            assert response.status_code == 200 and 'class="alert' in response.text
            assert '<bad>' not in response.text
            assert ('data-briefing-test-ok' in response.text) == (mode == 'success')
            if mode in ('ai-off', 'smtp-off'):
                send.assert_not_called()

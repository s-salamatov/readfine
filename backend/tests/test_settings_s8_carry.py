"""The Settings items carried into s8 (s8-T5): the scroll hint of the stats tables,
the Filters intro on a phone, a prefilled filter name that fits, the filter editor
on tokens and the current Settings names on the welcome screen.
"""
import re
from unittest.mock import AsyncMock

from bs4 import BeautifulSoup
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.feed import Folder, UserFeed
from app.models.filter import Filter, FilterAction, FilterCondition
from app.models.label import Label
from app.models.settings import AppSettings
from app.routers.web.settings import stats
from app.services.stats_service import (
    AiCalibration,
    AiCostStats,
    AiStats,
    FeedStatRow,
    GemArticle,
    LabelRow,
    LabelStats,
    OperationCostRow,
)
from app.templating import templates
from tests.test_assistant_profile import dom, profile  # noqa: F401
from tests.test_settings_relevance import _client, _feed, _user, env  # noqa: F401
from tests.test_translation import pg  # noqa: F401

# A utility of the old palette, with or without a variant prefix: "hover:text-gray-700".
LEGACY_PALETTE = re.compile(r"(?:^|:)[a-z-]+-(?:gray|blue)-\d+")


def _outside_scroller(soup):
    return [t for t in soup.select("table") if t.find_parent(class_="rf-scroll-x") is None]


async def test_stats_tables_scroll_with_hint(profile, monkeypatch):  # noqa: F811
    p = profile
    p.app.include_router(stats.router)
    app_settings = await p.db.get(AppSettings, 1)
    if app_settings is None:
        app_settings = AppSettings(id=1)
        p.db.add(app_settings)
    app_settings.ai_enabled = True
    await p.db.flush()

    gem = GemArticle(article_id=1, title="A long article title", feed_title="Feed", ai_score=0.9)
    monkeypatch.setattr(stats, "get_ai_stats", AsyncMock(return_value=AiStats(
        calibration=AiCalibration(
            avg_score_starred=0.8, avg_score_not_starred=0.3, gap=50, min_score_starred=40),
        gems=[gem], wrong=[gem])))
    monkeypatch.setattr(stats, "get_label_stats", AsyncMock(return_value=LabelStats(
        label_coverage_pct=10.0,
        labels=[LabelRow(label_id=1, name="News", color="x", article_count=3,
                         star_rate=1.0, read_rate=2.0)])))
    monkeypatch.setattr(stats, "get_ai_cost_stats", AsyncMock(return_value=AiCostStats(
        period_days=30, operations=[OperationCostRow(
            operation="scoring", label="Scoring", slot="fast", count=1, input_tokens=10,
            output_tokens=2, est_cost=0.001, trend_pct=None)])))
    monkeypatch.setattr(stats, "get_feed_stats", AsyncMock(return_value=[FeedStatRow(
        user_feed_id=1, feed_title="Feed", total_articles=3, read_pct=1.0, labeled_pct=2.0,
        starred_pct=3.0, avg_dwell=None, avg_ai_score=None, signal=0.5)]))

    # The AI costs and the feed table are partials shown on AI provider and Sources.
    for url, tables in (("/settings/stats", 3), ("/settings/ai/cost-partial", 1),
                        ("/settings/feeds-stats-partial", 1)):
        response = await p.web.get(url)
        assert response.status_code == 200, url
        soup = dom(response)
        assert len(soup.select("table")) == tables, url
        assert not _outside_scroller(soup), url


async def test_filters_intro_stacks_on_phone(env):  # noqa: F811
    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        await s.commit()
    async with _client(engine, user.id) as c:
        r = await c.get("/settings/relevance")
    assert r.status_code == 200
    soup = BeautifulSoup(r.text, "html.parser")
    new_filter = soup.select_one('#filters a[href="/settings/filters/new"]')
    row = new_filter.parent
    classes = row["class"]
    assert "flex" in classes and "flex-col" in classes and "sm:flex-row" in classes
    text = row.find("p", recursive=False)
    assert "Filters run on new articles" in text.get_text()
    assert new_filter not in text.find_all("a")


async def test_prefill_long_feed_title_fits_and_saves(env):  # noqa: F811
    engine, made = env
    words = ("harbour " * 18)[:140]  # a space at every eighth place
    solid = "x" * 140
    exact = "y" * 100 + " tail"  # the boundary right after the last character that fits
    early = "z" * 40 + " " + "w" * 99  # the only space is too far back to cut at
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        feeds = [await _feed(s, made, user, title=t) for t in (words, solid, exact, early)]
        await s.commit()

    async with _client(engine, user.id) as c:
        names, forms = [], []
        for feed in feeds:
            r = await c.get(f"/settings/filters/new?feed={feed.id}")
            assert r.status_code == 200
            form = BeautifulSoup(r.text, "html.parser").select_one('main form[action="/settings/filters"]')
            names.append(form.select_one("input[name=name]")["value"])
            forms.append(form)
        assert all(len(n) <= 100 for n in names), [len(n) for n in names]
        assert names[0] == ("harbour " * 12).strip()
        assert names[1:] == [solid[:100], "y" * 100, early[:100]]

        # Post the first form as the browser would, untouched.
        data: dict[str, list[str]] = {}
        for el in forms[0].select("input[name], textarea[name], select[name]"):
            if el.get("type") in ("checkbox", "radio") and not el.has_attr("checked"):
                continue
            if el.name == "select":
                chosen = el.select_one("option[selected]") or el.select_one("option")
                value = chosen["value"]
            else:
                value = el.get("value", "")
            data.setdefault(el["name"], []).append(value)
        r = await c.post("/settings/filters", data=data,
                         headers={"x-csrftoken": c.cookies.get("csrftoken", "")})
    assert r.status_code == 303, r.text[:2000]
    async with AsyncSession(engine) as s:
        saved = (await s.scalars(select(Filter).where(Filter.user_id == user.id))).all()
    assert [(f.name, f.scope_include) for f in saved] == [(names[0], f'["feed:{feeds[0].id}"]')]


async def test_filter_editor_uses_tokens(env):  # noqa: F811
    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        folder = Folder(user_id=user.id, name="News")
        label = Label(user_id=user.id, name="Later", color="#000000")
        s.add_all([folder, label])
        await s.flush()
        inside = await _feed(s, made, user)
        await _feed(s, made, user)
        uf = await s.scalar(select(UserFeed).where(UserFeed.user_id == user.id,
                                                   UserFeed.feed_id == inside.id))
        uf.folder_id = folder.id
        flt = Filter(user_id=user.id, name="kept", is_active=True,
                     scope_include=f'["feed:{inside.id}"]', scope_except=f'["folder:{folder.id}"]')
        flt.conditions = [FilterCondition(field="title", operator="contains", value="storm", position=0)]
        flt.actions = [FilterAction(action_type="label", action_value=str(label.id))]
        s.add(flt)
        await s.commit()

    async with _client(engine, user.id) as c:
        r = await c.get(f"/settings/filters/{flt.id}/edit")
    assert r.status_code == 200
    soup = BeautifulSoup(r.text, "html.parser")
    main = soup.select_one("main")
    used = {cls for el in main.find_all(class_=True) for cls in el["class"]}
    assert not sorted(cls for cls in used if LEGACY_PALETTE.search(cls))
    # Also what this render does not reach (the error branches, the config block).
    jinja = templates.env
    source = jinja.loader.get_source(jinja, "settings/filter_edit.html")[0]
    assert not re.findall(r"[a-z-]+-(?:gray|blue)-\d+", source)

    for selector in (
        "#filter-type-badge.hidden", "#scope-include-list #scope-all", "#except-toggle", "#except-panel",
        "#scope-include-list input.scope-cb[name=scope_include]", "#except-panel input.scope-cb[name=scope_except]",
        "#score-filter-notice.hidden [data-phase=ai].hidden", "#score-filter-notice [data-phase=relevance]",
        "#score-filter-notice [data-phase=fetch]",
        "#conditions .condition-row select.cond-field-select[name=cond_field]",
        ".condition-row select.cond-source-select.hidden", ".condition-row input[name=cond_source]",
        ".condition-row select[name=cond_operator][data-saved=contains]",
        ".condition-row input[name=cond_position]", ".condition-row input[name=cond_value]",
        ".condition-row button.remove-row", ".condition-row p.cond-hint.hidden", "#add-condition",
        "#regex-hint.hidden", "#actions .action-row select.action-type-select[name=action_type]",
        ".action-row select.label-select[name=action_value]", ".action-row button.remove-row",
        "#add-action", "#test-result", "#filter-edit-cfg",
        "input[name=name][maxlength='100']", "input[name=is_active]", "input[name=stop_on_match]",
        "select[name=match_operator]", "input#filter-position[name=position]",
    ):
        assert soup.select_one(selector), selector


async def test_welcome_names_relevance_and_filters(env):  # noqa: F811
    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        await s.commit()
    async with _client(engine, user.id) as c:
        r = await c.get("/welcome")
    assert r.status_code == 200
    assert "Settings → Relevance &amp; filters" in r.text
    link = BeautifulSoup(r.text, "html.parser").select_one('a[href="/settings/relevance"]')
    assert link is not None and "Relevance & filters" in link.get_text()

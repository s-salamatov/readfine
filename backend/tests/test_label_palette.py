"""The label palette: one Python constant, mirrored as ``--rf-label-<name>`` tokens.

Stored label colours stay ``#RRGGBB`` data (owner decision Q9). The swatches draw
themselves from the tokens and keep submitting the palette's hex, so a label created
from a swatch stores exactly what it stored before the palette moved onto tokens, and
any stored colour, palette or not, keeps rendering as itself.
"""
import re
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from bs4 import BeautifulSoup
from starlette.requests import Request

from app.schemas.article import ArticleListItem
from app.services.label_palette import DEFAULT_LABEL_COLOR, DEFAULT_LABEL_NAME, LABEL_PALETTE
from app.templating import templates

BACKEND = Path(__file__).resolve().parents[1]
TOKENS_CSS = BACKEND.parent / "styles" / "tokens.css"
TEMPLATES = BACKEND / "app" / "templates"
PALETTE_TEMPLATES = ("settings/labels.html", "settings/partials/labels_list.html",
                     "settings/tokens.html")

# The swatch hexes as the templates listed them before s2-T27, in their order. Pinned
# here so the constant and the tokens cannot drift away from stored data together.
LEGACY_HEXES = ("#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e",
                "#14b8a6", "#06b6d4", "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7",
                "#ec4899", "#f43f5e", "#64748b", "#374151")

# The colour pattern of scripts/check-colours.mjs, minus its masks (none apply here).
COLOUR_LITERAL = re.compile(
    r"(?<![&\w])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])"
    r"|\b(?:rgba?|hsla?|oklch|oklab)\(")
RING = {"ring-2", "ring-gray-700", "ring-offset-1"}


def _request(hx: bool = False) -> Request:
    headers = [(b"host", b"testserver")] + ([(b"hx-request", b"true")] if hx else [])
    return Request({
        "type": "http", "method": "GET", "path": "/", "query_string": b"",
        "headers": headers, "scheme": "http", "server": ("testserver", 80), "root_path": "",
    })


def _label(id: int, color: str, name: str = "Tech") -> SimpleNamespace:
    return SimpleNamespace(id=id, name=name, color=color, position=0,
                           created_at=datetime(2024, 1, 1))


def _render(name: str, **ctx) -> BeautifulSoup:
    html = templates.env.get_template(name).render(request=_request(), **ctx)
    return BeautifulSoup(html, "html.parser")


def _swatches(soup) -> list:
    return soup.select(".color-swatch")


def test_tokens_css_and_python_palette_agree():
    tokens = re.findall(r"--rf-label-([a-z]+):\s*(#[0-9a-fA-F]{6})\s*;", TOKENS_CSS.read_text())
    assert tokens == list(LABEL_PALETTE)
    assert tuple(hex_ for _, hex_ in LABEL_PALETTE) == LEGACY_HEXES
    assert dict(LABEL_PALETTE)[DEFAULT_LABEL_NAME] == DEFAULT_LABEL_COLOR == "#6366f1"


def test_swatches_use_tokens_and_submit_hex():
    for name in PALETTE_TEMPLATES:
        source = (TEMPLATES / name).read_text()
        assert not COLOUR_LITERAL.findall(source), f"colour literal in {name}"

    page = _render("settings/labels.html", labels=[_label(1, "#3b82f6")])
    add_form, edit_form = page.select("form")[:2]
    for form, selected in ((add_form, DEFAULT_LABEL_COLOR), (edit_form, "#3b82f6")):
        swatches = _swatches(form)
        assert len(swatches) == len(LABEL_PALETTE)
        for swatch, (name, hex_) in zip(swatches, LABEL_PALETTE):
            assert swatch["style"] == f"background-color: var(--rf-label-{name})"
            assert swatch["data-color"] == hex_
            assert RING.issubset(swatch["class"]) == (hex_ == selected), name
    assert add_form.select_one('input[type="hidden"][name="color"]')["value"] == DEFAULT_LABEL_COLOR
    assert edit_form.select_one('input[type="hidden"][name="color"]')["value"] == "#3b82f6"
    assert edit_form.select_one(".color-custom-input")["value"] == ""

    api = _render("settings/tokens.html", tokens=[], new_token=None)
    assert f'{{"name": "...", "color": "{DEFAULT_LABEL_COLOR}"}}' in api.get_text()


def test_create_with_a_swatch_stores_the_same_hex(client):
    page = _render("settings/labels.html", labels=[])
    swatch_hexes = [s["data-color"] for s in _swatches(page.select_one("form"))]
    assert swatch_hexes == list(LEGACY_HEXES)

    create = AsyncMock()
    with patch("app.routers.web.settings.labels.create_label", new=create), \
         patch("app.routers.web.settings.labels.list_labels", new=AsyncMock(return_value=[])):
        for hex_ in swatch_hexes:
            assert client.post("/settings/labels", data={"name": "L", "color": hex_}).status_code == 200
        # The form's hidden input left untouched: the field default.
        assert client.post("/settings/labels", data={"name": "L"}).status_code == 200
    stored = [call.args[1].color for call in create.await_args_list]
    assert stored == swatch_hexes + [DEFAULT_LABEL_COLOR]


def test_stored_non_palette_colour_still_renders():
    soup = _render("settings/partials/labels_list.html", labels=[_label(7, "#123456")])
    dot = soup.select_one("li span.rounded-full")
    assert dot["style"] == "background-color: #123456"
    assert soup.select_one(".color-custom-input")["value"] == "#123456"
    assert soup.select_one(".color-custom-preview")["style"] == "background-color: #123456"
    assert soup.select_one('input[type="hidden"][name="color"]')["value"] == "#123456"
    assert not any(RING.issubset(s["class"]) for s in _swatches(soup))

    item = ArticleListItem(
        id=1, feed_id=7, feed_title="F", url="https://pub.example/a", title="T", author=None,
        summary="S", snippet="S", published_at=datetime(2020, 1, 2, tzinfo=timezone.utc),
        formatted_date="02.01.2020", estimated_read_min=3, image_url=None, is_read=False,
        is_starred=False, is_archived=False,
        labels=[{"id": 7, "name": "Tech", "color": "#123456"}])
    row = templates.env.get_template("app/partials/article_row.html").render(
        request=_request(), article=item, density="comfortable", label_display="dots")
    assert 'style="background-color: #123456"' in row

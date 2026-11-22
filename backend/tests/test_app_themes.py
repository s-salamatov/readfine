"""The app themes are listed once per runtime: ``app/themes.py`` (templates),
``static/js/init.js`` (``APP_THEMES``, applied before first paint) and the
``[data-rf-theme="…"]`` blocks of ``styles/tokens.css``. No build step can share one
literal across Python, JS and CSS, so this test keeps the three in step (s3-T3, C4)."""
import re
from pathlib import Path

from bs4 import BeautifulSoup

from app.themes import APP_THEMES, DEFAULT_APP_THEME
# _pinned is autouse: the pages render with the same pinned globals as the contract.
from tests.test_dom_contract_pages import _pages, _pinned  # noqa: F401

ROOT = Path(__file__).resolve().parents[2]
INIT_JS = ROOT / "backend" / "app" / "static" / "js" / "init.js"
TOKENS_CSS = ROOT / "styles" / "tokens.css"


def _init_js_ids() -> list[str]:
    m = re.search(r"var APP_THEMES = \[([^\]]*)\];", INIT_JS.read_text())
    assert m, "init.js has no `var APP_THEMES = [...]` literal"
    return re.findall(r"'([a-z-]+)'", m.group(1))


def _tokens_css_ids() -> set[str]:
    css = re.sub(r"/\*[\s\S]*?\*/", "", TOKENS_CSS.read_text())
    return set(re.findall(r'\[data-rf-theme="([a-z-]+)"\]', css))


def test_python_init_js_and_tokens_css_name_the_same_app_themes():
    ids = [i for i, _ in APP_THEMES]
    assert ids[0] == DEFAULT_APP_THEME
    assert len(ids) == len(set(ids))
    assert _init_js_ids() == ids
    assert _tokens_css_ids() == set(ids)


def test_preferences_and_account_menu_render_every_theme():
    ids = [i for i, _ in APP_THEMES]
    prefs = BeautifulSoup(_pages()["preferences"](), "html.parser")
    radios = [el["value"] for el in prefs.select('input[name="app_theme_device"]')]
    assert radios == ids

    sidebar = BeautifulSoup(_pages()["sidebar"](), "html.parser")
    menu = sidebar.select_one("#account-menu")
    assert menu is not None, "the sidebar has no account menu"
    items = menu.select('[role="menuitemradio"][data-rf-app-theme]')
    assert [el["data-rf-app-theme"] for el in items] == ids
    assert [el.get_text(strip=True) for el in items] == [label for _, label in APP_THEMES]
    schemes = menu.select('[role="menuitemradio"][data-rf-scheme]')
    assert [el["data-rf-scheme"] for el in schemes] == ["light", "dark", "system"]
    # Two groups: Basecoat unchecks the other radios of the closest group on a click.
    assert items[0].find_parent(attrs={"role": "group"}) is not schemes[0].find_parent(attrs={"role": "group"})

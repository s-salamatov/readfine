"""The /dev/ui macro gallery (DEBUG only) and the UI script tags in base.html (s2-T18).

The gallery is a development page: it is not registered at all unless settings.debug
is on, and then renders every ui/ macro under a section with the id "ui-<macro>", with
no inline event handler. base.html loads the vendored anime.js and Basecoat scripts
and the ui/ scripts as static, versioned tags (shell cache discovery reads them), never
through a dynamic import.
"""
import re

import pytest
from fastapi.testclient import TestClient
from jinja2.runtime import Macro

from app.config import settings
from app.templating import templates
from tests.conftest import _null_lifespan
from tests.test_csp import _EVAL_PATTERNS, _INLINE_HANDLER

UI_FILES = ("ui/forms.html", "ui/display.html", "ui/readfine.html", "ui/overlay.html", "ui/nav.html")

UI_SCRIPTS = [
    "vendor/anime/anime.umd.min.js",
    "vendor/basecoat/basecoat.min.js",
    "vendor/basecoat/command.min.js",
    "vendor/basecoat/drawer.min.js",
    "vendor/basecoat/dropdown-menu.min.js",
    "vendor/basecoat/popover.min.js",
    "vendor/basecoat/select.min.js",
    "vendor/basecoat/sidebar.min.js",
    "vendor/basecoat/tabs.min.js",
    "vendor/basecoat/toast.min.js",
    "ui/motion.js",
    "ui/dialog.js",
]


def _macro_names():
    for name in UI_FILES:
        module = templates.env.get_template(name).module
        for key, value in vars(module).items():
            if isinstance(value, Macro) and not key.startswith("_"):
                yield key


def _client(monkeypatch, debug):
    monkeypatch.setattr(settings, "debug", debug)
    from app.main import create_app

    app = create_app()
    app.router.lifespan_context = _null_lifespan
    # No `with`: the lifespan (database, scheduler) never runs.
    return TestClient(app, raise_server_exceptions=True)


def test_gallery_404_when_debug_off(monkeypatch):
    client = _client(monkeypatch, debug=False)
    r = client.get("/dev/ui")
    assert r.status_code == 404
    assert "ui-button" not in r.text


def test_gallery_renders_every_macro_when_debug_on(monkeypatch):
    client = _client(monkeypatch, debug=True)
    r = client.get("/dev/ui")
    assert r.status_code == 200, r.text[:500]
    html = r.text
    names = set(_macro_names())
    assert {"menu", "popover", "dialog", "sheet", "toast", "tabs", "command_palette", "sidebar"} <= names
    missing = sorted(n for n in names if f'id="ui-{n}"' not in html)
    assert not missing, f"gallery has no section for: {missing}"
    assert not _INLINE_HANDLER.search(html), _INLINE_HANDLER.search(html).group(0)
    assert not any(p.search(html) for p, _ in _EVAL_PATTERNS)
    # The toaster container Basecoat's toast.js looks for, and the motion demos.
    assert 'id="toaster"' in html and 'class="toaster' in html
    for kind in ("list-enter", "fade-up", "pop"):
        assert f'data-motion="{kind}"' in html
    # Dialogs and sheets open through data-rf-open, and every target exists.
    targets = re.findall(r'data-rf-open="([^"]+)"', html)
    assert targets
    for target in targets:
        assert f'id="{target}"' in html, target
    # The gallery calls RFMotion.enter itself (motion.js runs nothing on first paint),
    # from a nonce'd script.
    nonce = re.search(r'<meta name="csp-nonce" content="([^"]+)"', html).group(1)
    assert re.search(r'<script nonce="' + re.escape(nonce) + r'">[^<]*RFMotion\.enter\(document\)', html)


def test_gallery_replays_each_stage_preset(monkeypatch):
    html = _client(monkeypatch, debug=True).get("/dev/ui").text
    # Up to </main>: the card demo inside the section has a <section> of its own.
    section = re.search(r'<section id="ui-motion".*?</main>', html, re.S).group(0)
    for name in ("press", "press-soft", "fade-up", "fade-up-short", "pop", "list-enter"):
        assert re.search(r'<button[^>]*data-ui-demo-play="' + name + '"', section), name
        assert section.count(f'data-ui-demo-target="{name}"') == 1, name
    assert re.search(r'<button[^>]*data-ui-demo-target="press"', section)
    soft = re.search(r'<div[^>]*data-ui-demo-target="press-soft"[^>]*>', section)
    assert soft and 'data-motion-press="soft"' in soft.group(0)
    scripts = re.findall(r"<script nonce=[^>]*>(.*?)</script>", html, re.S)
    script = next(s for s in scripts if "RFMotion.enter(document)" in s)
    assert "RFMotion.play(" in script
    assert "RFMotion.animate(" not in script and "anime." not in script


def test_list_radio_drops_the_native_look():
    # Review T16-R1: components/radio.css is not imported, so the list-variant radio
    # carries its utilities; without appearance-none the browser draws a native radio
    # in its accent colour instead of the token skin.
    forms = templates.env.get_template("ui/forms.html").module
    html = str(forms.radio_group(name="r", legend="Pick", options=["a", "b"], value="a"))
    radios = re.findall(r'<input type="radio" class="([^"]*)"', html)
    assert len(radios) == 2
    for cls in radios:
        classes = cls.split()
        assert "input" in classes and "appearance-none" in classes, cls
        assert "checked:before:absolute" in classes, cls


def test_base_loads_ui_scripts_statically(client):
    html = client.get("/login").text
    tags = re.findall(r'<script src="/static/js/([^"?]+)\?v=[^"]+" defer></script>', html)
    assert [t for t in tags if t in UI_SCRIPTS] == UI_SCRIPTS, tags
    order = re.findall(r'<script src="/static/js/([^"?]+)', html)
    assert order.index("htmx.min.js") < order.index(UI_SCRIPTS[0])
    assert order.index(UI_SCRIPTS[-1]) < order.index("app.js")
    assert "import(" not in html

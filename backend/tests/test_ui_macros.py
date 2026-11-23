"""The ui/ form, display and Readfine macros (s2-T16).

Every macro renders on its defaults without an inline event handler, a colour literal
or a default hx-swap="none"; the shared attrs() helper refuses handler attributes
outright; and the markup follows Basecoat 1.1.0 (components/*.css, styles/vega.css).
"""
import re

import pytest
from jinja2.runtime import Macro

from app.templating import templates
from tests.test_csp import _EVAL_PATTERNS, _INLINE_HANDLER

UI_FILES = ("ui/forms.html", "ui/display.html", "ui/readfine.html")

# The colour lint's patterns (scripts/check-colours.mjs: HEX and FUNC). Rendered
# output carries no Jinja comments and no href/for masks are needed: a macro that
# draws "#…" on its defaults is a finding either way.
_HEX = re.compile(r"(?<![&\w])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])")
_FUNC = re.compile(r"\b(?:rgba?|hsla?|oklch|oklab)\(")

# Arguments a macro cannot do without (it raises otherwise); everything else has a
# safe default. score_badge draws nothing without a score, so it gets one.
REQUIRED = {
    "icon_button": {"label": "Close"},
    "radio_group": {"legend": "Theme"},
    "score_badge": {"score": 0.82},
}
# Write nothing on their defaults by design: the attribute writer, given no attributes.
EMPTY_ON_DEFAULTS = {"attrs", "render_attrs"}


def _module(name):
    return templates.env.get_template(name).module


def _macros():
    for name in UI_FILES:
        for key, value in vars(_module(name)).items():
            if isinstance(value, Macro) and not key.startswith("_"):
                yield name, key, value


def test_every_macro_renders_without_inline_handlers():
    names = {key for _, key, _ in _macros()}
    expected = {
        "attrs", "render_attrs", "button", "icon_button", "input", "select", "switch", "field", "radio_group",
        "badge", "kbd", "card", "alert", "skeleton", "empty_state",
        "article_row", "feed_icon", "score_badge", "health_dot",
    }
    assert expected <= names, f"missing macros: {sorted(expected - names)}"
    for path, key, macro in _macros():
        html = str(macro(**REQUIRED.get(key, {})))
        if key not in EMPTY_ON_DEFAULTS:
            assert html.strip(), f"{path}:{key} rendered nothing"
        where = f"{path}:{key} -> {html!r}"
        assert not _INLINE_HANDLER.search(html), where
        assert not any(p.search(html) for p, _ in _EVAL_PATTERNS), where
        assert not _HEX.search(html) and not _FUNC.search(html), where
        assert 'hx-swap="none"' not in html, where


@pytest.mark.parametrize(
    "key",
    ["onclick", "onClick", "ONLOAD", "on", "hx-on:click", "hx-on::after-request", "data-hx-on:click",
     'x" onclick="y', "a b"],
)
def test_attrs_refuses_event_handlers(key):
    forms = _module("ui/forms.html")
    with pytest.raises(Exception, match="refuses"):
        str(forms.button(label="Go", attrs={key: "x"}))
    # Ordinary attributes still pass, escaped; true is a bare attribute, false/none drop.
    html = str(forms.button(label="Go", attrs={
        "data-rf-open": 'dlg"><x', "hx-post": "/a", "disabled": True, "hidden": False, "title": None,
    }))
    assert 'data-rf-open="dlg&#34;&gt;&lt;x"' in html
    assert 'hx-post="/a"' in html and " disabled" in html
    assert "hidden" not in html and "title" not in html


def test_icon_button_requires_label():
    forms = _module("ui/forms.html")
    with pytest.raises(Exception, match="requires"):
        str(forms.icon_button())
    with pytest.raises(Exception, match="requires"):
        str(forms.icon_button(label=""))
    html = str(forms.icon_button(label="Close dialog"))
    assert 'aria-label="Close dialog"' in html
    assert 'class="btn"' in html and 'data-size="icon"' in html


def test_button_variants_emit_basecoat_markup():
    forms = _module("ui/forms.html")
    html = str(forms.button(label="Save", variant="outline", size="sm"))
    assert re.search(r'<button type="button" class="btn" data-variant="outline" data-size="sm"', html), html
    assert ">Save</button>" in html
    # Basecoat's defaults are no data-variant / data-size at all (vega.css :not([…])).
    plain = str(forms.button(label="Save"))
    assert "data-variant" not in plain and "data-size" not in plain
    link = str(forms.button(label="Docs", href="/help", variant="link"))
    assert link.startswith('<a href="/help" class="btn" data-variant="link"'), link
    # An unknown variant falls back to Basecoat's default rather than a dead selector.
    assert "data-variant" not in str(forms.button(label="x", variant="bogus"))
    # Extra classes are appended to Basecoat's, not substituted for it.
    assert 'class="btn w-full"' in str(forms.button(label="x", attrs={"class": "w-full"}))


def test_alert_variants_keep_default_bytes_and_add_status_tones():
    """Review T28-4/5/6: warning and success are their own variants, drawn from the
    --rf-warn / --rf-ok roles; default and destructive keep their exact markup."""
    display = _module("ui/display.html")
    # Byte-identical default and destructive output (the login.html golden relies on it).
    assert str(display.alert(text="Hi")) == '<div class="alert"><section>Hi</section></div>'
    assert str(display.alert(title="T", text="Hi", variant="destructive", live=True, attrs={"class": "mb-4"})) == (
        '<div class="alert mb-4" data-variant="destructive" role="alert"><h2>T</h2><section>Hi</section></div>')
    assert str(display.alert(variant="bogus")) == '<div class="alert"></div>'
    tones = {"warning": "--rf-warn", "success": "--rf-ok"}
    for variant, role in tones.items():
        html = str(display.alert(title="T", text="Hi", variant=variant, attrs={"class": "mb-4", "id": "n"}))
        assert re.match(r'<div class="alert [^"]*" data-variant="%s" id="n"><h2>T</h2><section>Hi</section></div>$'
                        % variant, html), html
        cls = re.search(r'class="([^"]*)"', html).group(1).replace("&amp;", "&").replace("&gt;", ">").split()
        assert cls[0] == "alert" and cls[-1] == "mb-4", cls
        # Tinted fill and border from the status role, body text readable on the tint,
        # and the body flows as one paragraph (Basecoat's section is a grid otherwise).
        assert f"bg-({role})/10" in cls and f"border-({role})/50" in cls, cls
        assert "[&>section]:text-foreground" in cls and "[&>section]:block" in cls, cls
        assert not any(t in c for c in cls for t in tones.values() if t != role), cls


def test_radio_group_has_accessible_name_and_focus_style():
    """Review T10-R1: a radio group needs a group name and visible keyboard focus."""
    forms = _module("ui/forms.html")
    options = [("neutral", "Neutral"), ("paper", "Paper"), ("graphite", "Graphite")]
    html = str(forms.radio_group(name="app_theme", legend="App theme", options=options, value="paper"))
    assert re.search(r"<fieldset[^>]*>\s*<legend[^>]*>App theme</legend>", html), html
    assert html.count('type="radio"') == 3 and html.count('name="app_theme"') == 3
    assert re.search(r'value="paper"\s+checked', html)
    seg = str(forms.radio_group(name="t", legend="Theme", options=options, variant="segmented"))
    assert seg.count("sr-only peer") == 3, seg
    # The visible segment shows the focus of the hidden input.
    assert seg.count("peer-focus-visible:ring-2") == 3, seg
    # A visually hidden legend still names the group.
    hidden = str(forms.radio_group(name="t", legend="Theme", options=options, legend_hidden=True))
    assert re.search(r'<legend class="sr-only">Theme</legend>', hidden), hidden


# --- s3-T1: URL schemes, style, sidebar breakpoint, live alert role, command_items ---

_UNSAFE_URLS = ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "vbscript:msgbox(1)"]


@pytest.mark.parametrize("bad", _UNSAFE_URLS)
def test_unsafe_href_and_src_schemes_are_dropped(bad):
    """C8: every attribute that takes a URL drops a scheme outside the allowlist instead
    of raising (hrefs can be user data, such as a feed's site URL)."""
    forms, display = _module("ui/forms.html"), _module("ui/display.html")
    nav, overlay, rf = _module("ui/nav.html"), _module("ui/overlay.html"), _module("ui/readfine.html")
    rendered = {
        "button": forms.button(label="Go", href=bad),
        "icon_button": forms.icon_button(label="Go", href=bad),
        "badge": display.badge(text="b", href=bad),
        "attrs href": forms.button(label="Go", attrs={"href": bad}),
        "attrs src": forms.button(label="Go", attrs={"src": bad}),
        "attrs action": forms.field(attrs={"action": bad}),
        "attrs formaction": forms.button(label="Go", attrs={"formaction": bad}),
        "attrs HREF": forms.button(label="Go", attrs={"HREF": bad}),
        "menu": overlay.menu(id="m", items=[{"label": "x", "href": bad}]),
        "command": nav.command_palette(id="c", items=[{"label": "x", "href": bad}]),
        "sidebar": nav.sidebar(id="s", items=[{"label": "x", "href": bad}]),
        "feed_icon": rf.feed_icon(src=bad, title="Feed"),
        "article_row": rf.article_row(title="T", href=bad),
    }
    for where, html in rendered.items():
        html = str(html)
        assert "script:" not in html.lower() and "data:text" not in html, f"{where}: {html}"
        assert not re.search(r"\b(href|src|action|formaction)=", html, re.I), f"{where}: {html}"
    # Safe values are kept, byte for byte.
    for good in ["/x", "#a", "https://e", "mailto:a@b", "/a:b", "?q=1:2"]:
        assert f'href="{good}"' in str(forms.button(label="Go", href=good)), good
        assert f'href="{good}"' in str(nav.sidebar(id="s", items=[{"label": "x", "href": good}])), good
    src = "data:image/png;base64,AA"
    assert f'src="{src}"' in str(rf.feed_icon(src=src, title="Feed"))
    assert f'src="{src}"' in str(forms.button(label="Go", attrs={"src": src}))
    # data:image is an image source, never a link.
    assert "href=" not in str(forms.button(label="Go", href=src))


def test_attrs_refuses_style():
    forms = _module("ui/forms.html")
    for key in ["style", "STYLE"]:
        with pytest.raises(Exception, match="attrs_refuses_style"):
            str(forms.button(label="Go", attrs={key: "color: red"}))


def test_sidebar_data_breakpoint_override_writes_one_attribute():
    nav = _module("ui/nav.html")
    html = str(nav.sidebar(id="s", attrs={"data-breakpoint": 1024}))
    assert html.count("data-breakpoint=") == 1, html
    assert 'data-breakpoint="1024"' in html
    assert str(nav.sidebar(id="s")).count('data-breakpoint="768"') == 1


def test_live_alert_role_follows_the_variant():
    display = _module("ui/display.html")
    roles = {"destructive": "alert", "warning": "alert", "default": "status", "success": "status", "bogus": "status"}
    for variant, role in roles.items():
        html = str(display.alert(text="Hi", variant=variant, live=True))
        assert f'role="{role}"' in html and html.count("role=") == 1, (variant, html)
        assert "role=" not in str(display.alert(text="Hi", variant=variant))


def test_command_items_renders_data_force_items():
    nav = _module("ui/nav.html")
    html = str(nav.command_items([
        {"label": "Open article", "href": "/app?open_article_id=1", "attrs": {"data-force": True}},
        {"label": "Advanced search…", "attrs": {"data-force": True, "data-action": "open-search"}},
    ], "palette-result"))
    assert re.search(r'<a id="palette-result-1" role="menuitem" href="/app\?open_article_id=1" data-force>', html), html
    assert re.search(r'<div id="palette-result-2" role="menuitem" data-force data-action="open-search">', html), html
    assert "<dialog" not in html

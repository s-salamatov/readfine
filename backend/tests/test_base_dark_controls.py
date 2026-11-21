"""base.html's legacy dark rules against the Basecoat controls, and its light seams (s2-T29).

The <style> block in base.html sits in @layer utilities, above Basecoat's
@layer components, so its old blanket dark rule for input/select/textarea used to win
over every macro control: a checked switch kept a dark track, the radio dot vanished
and macro inputs took the legacy panel fill (T28-2). The rule now leaves the controls
Basecoat styles alone and keeps every other input as it was. These tests read the
selectors straight out of the style block and run them through soupsieve against the
macros' real output and against legacy markup from the pages' goldens.
"""
import re
from pathlib import Path

from bs4 import BeautifulSoup

from app.templating import templates

BACKEND = Path(__file__).resolve().parents[1]
BASE_HTML = BACKEND / "app" / "templates" / "base.html"
GOLDENS = BACKEND / "tests" / "fixtures" / "dom_contract"


def _style_block():
    text = BASE_HTML.read_text()
    start = text.index("<style>") + len("<style>")
    css = text[start:text.index("</style>", start)]
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def _rules(css):
    """(selector list, declarations) for every plain rule; @layer wrappers are descended."""
    out, stack, buf = [], [], ""
    for ch in css:
        if ch == "{":
            stack.append(buf.strip())
            buf = ""
        elif ch == "}":
            if stack:
                head = stack.pop()
                if not head.startswith("@"):
                    out.append((head, buf.strip()))
            buf = ""
        else:
            buf += ch
    return out


def _rule_with(selector_part, declaration_part):
    hits = [
        (sel, decl) for sel, decl in _rules(_style_block())
        if selector_part in sel and declaration_part in decl
    ]
    assert len(hits) == 1, f"expected one rule with {selector_part!r} and {declaration_part!r}, got {hits}"
    return hits[0][0]


def _macro_controls():
    forms = templates.env.get_template("ui/forms.html").module
    nav = templates.env.get_template("ui/nav.html").module
    html = "".join([
        str(forms.input(name="q")),
        str(forms.input(name="mail", type="email")),
        str(forms.select(name="s", options=[("a", "A")])),
        str(forms.switch(name="on", label="On", checked=True)),
        str(forms.switch(name="off")),
        str(forms.radio_group(name="r", legend="R", options=[("a", "A"), ("b", "B")], value="a")),
        '<textarea class="textarea" name="t"></textarea>',
        '<input type="checkbox" class="input" name="c">',
        str(nav.command_palette(id="cmd")),
    ])
    soup = BeautifulSoup(f'<html class="dark"><body>{html}</body></html>', "html.parser")
    controls = soup.select("input, select, textarea")
    # Every control the macros draw (the segmented radio_group is sr-only and is not
    # among these: variant="list" is the default).
    assert len(controls) >= 9
    return soup, controls


def _legacy_controls():
    """Old markup that still relies on the legacy dark fill: the goldens' bare controls."""
    found = []
    for name in ("preferences.html", "main.html", "article_list.html"):
        text = (GOLDENS / name).read_text()
        if "<html" not in text:  # a fragment golden
            text = f"<html><body>{text}</body></html>"
        soup = BeautifulSoup(text, "html.parser")
        soup.html["class"] = (soup.html.get("class") or []) + ["dark"]
        for el in soup.select("input:not([type=hidden]), select, textarea"):
            classes = el.get("class") or []
            if not {"input", "select", "textarea"} & set(classes) and el.get("role") != "switch":
                found.append((soup, el))
    assert found, "no legacy inputs in the goldens to check against"
    return found


def test_legacy_dark_fill_skips_basecoat_controls_and_keeps_legacy_ones():
    selector = _rule_with("html.dark", "background-color: var(--rf-legacy-dark-panel); color: var(--rf-legacy-dark-text-1)")
    soup, controls = _macro_controls()
    styled = [str(el)[:120] for el in soup.select(selector) if el in controls]
    assert styled == [], f"legacy dark fill still reaches Basecoat controls: {styled}"
    missed = [str(el)[:120] for doc, el in _legacy_controls() if el not in doc.select(selector)]
    assert missed == [], f"legacy dark fill no longer reaches old inputs: {missed}"
    # Specificity stays (0,1,2): the exclusion sits in :where(), so html.dark .bg-* and
    # the other utility overrides keep beating it on legacy inputs exactly as before.
    assert ":not(:where(" in selector


def test_legacy_dark_placeholder_skips_basecoat_controls():
    selector = _rule_with("::placeholder", "var(--rf-legacy-dark-placeholder)")
    element_selector = selector.replace("::placeholder", "")
    soup, controls = _macro_controls()
    styled = [str(el)[:120] for el in soup.select(element_selector) if el in controls]
    assert styled == [], f"legacy dark placeholder still reaches Basecoat controls: {styled}"


def test_detail_overlays_use_the_background_token_not_white():
    css = _style_block()
    assert not re.search(r"background(?:-color)?\s*:\s*white\b", css), "background: white left in base.html"
    for selector_part in ("mobile-detail-open #article-detail", "html.deeplink-detail-open #article-detail"):
        hits = [decl for sel, decl in _rules(css) if selector_part in sel and "position: fixed" in decl]
        assert hits and all("background: var(--background)" in decl for decl in hits), (selector_part, hits)


def test_small_light_list_matches_the_mobile_bars():
    """At 390 the bars are var(--background) (theme-color follows it), so the list is too."""
    css = _style_block()
    bars = [decl for sel, decl in _rules(css) if "#mobile-title-bar" in sel and "position: fixed" in decl]
    assert bars and "background: var(--background)" in bars[0]
    hits = [
        sel for sel, decl in _rules(css)
        if "#article-list" in sel and 'data-bucket="small"' in sel and ":not(.dark)" in sel
        and "background-color: var(--background)" in decl
    ]
    assert hits, "no light small-bucket rule puts #article-list on var(--background)"


_AUTOFILL = re.compile(r":-webkit-autofill(?::hover|:focus)?")


def test_legacy_dark_autofill_skips_basecoat_controls_and_keeps_legacy_ones():
    """s2-T36 (T28b-N2): the autofill inset shadow paints --rf-legacy-dark-panel with
    !important; on a Basecoat .input it hid the token fill (navy under Graphite dark).
    It takes the input exclusion of the fill rule above, so old inputs keep the legacy
    autofill look and the macro controls keep their own."""
    selector = _rule_with(":-webkit-autofill", "var(--rf-legacy-dark-panel) inset")
    fill = _rule_with("html.dark", "background-color: var(--rf-legacy-dark-panel); color: var(--rf-legacy-dark-text-1)")
    fill_input = next(part.strip() for part in fill.split(",\n") if part.strip().startswith("html.dark input"))
    parts = [part.strip() for part in selector.split(",\n")]
    assert len(parts) == 3, parts
    soup, controls = _macro_controls()
    legacy = _legacy_controls()
    for part in parts:
        # The same exclusion as the fill rule, in :where() so specificity stays (0,2,2).
        assert part.startswith(fill_input + ":-webkit-autofill"), (part, fill_input)
        element_selector = _AUTOFILL.sub("", part)
        styled = [str(el)[:120] for el in soup.select(element_selector) if el in controls]
        assert styled == [], f"legacy dark autofill still reaches Basecoat controls: {styled}"
        missed = [
            str(el)[:120] for doc, el in legacy
            if el.name == "input" and el not in doc.select(element_selector)
        ]
        assert missed == [], f"legacy dark autofill no longer reaches old inputs: {missed}"

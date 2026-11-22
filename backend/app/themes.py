"""The app themes (design §5.3): the template-side list.

One list per runtime, because no build step shares a literal across Python, JS and
CSS: this one for the templates (the Jinja global ``app_themes``: the Preferences
radios and the account menu), ``APP_THEMES`` in ``static/js/init.js`` (applied before
first paint) and the ``html[data-rf-theme="…"]`` blocks in ``styles/tokens.css``.
``tests/test_app_themes.py`` keeps the three in step. Add a theme in all three.
"""

# (id, label) in display order; the first is the default.
APP_THEMES: tuple[tuple[str, str], ...] = (
    ("neutral", "Neutral"),
    ("paper", "Paper"),
    ("graphite", "Graphite"),
)
DEFAULT_APP_THEME = "neutral"

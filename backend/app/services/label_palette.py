"""The label colour palette: the swatches offered when a label is created or edited.

The canonical hex values live here (owner decision Q9). ``styles/tokens.css`` mirrors
them as ``--rf-label-<name>``, the same in every theme, and
``tests/test_label_palette.py`` keeps the two equal. The swatches draw themselves from
the token and submit the hex below, so a stored label colour stays plain ``#RRGGBB``
data: any value, palette or not, renders as itself.

No imports from ``app``: the router, the services and ``templating`` all import this.
"""
from collections.abc import Iterator

# (name, hex) in the order the swatches appear.
LABEL_PALETTE: tuple[tuple[str, str], ...] = (
    ("red", "#ef4444"),
    ("orange", "#f97316"),
    ("amber", "#f59e0b"),
    ("yellow", "#eab308"),
    ("lime", "#84cc16"),
    ("green", "#22c55e"),
    ("teal", "#14b8a6"),
    ("cyan", "#06b6d4"),
    ("blue", "#3b82f6"),
    ("indigo", "#6366f1"),
    ("violet", "#8b5cf6"),
    ("purple", "#a855f7"),
    ("pink", "#ec4899"),
    ("rose", "#f43f5e"),
    ("slate", "#64748b"),
    ("gray", "#374151"),
)

DEFAULT_LABEL_NAME = "indigo"
DEFAULT_LABEL_COLOR = "#6366f1"


class TemplatePalette:
    """The palette as the templates see it (the ``label_palette`` Jinja global).

    Iterates as ``(name, hex)`` pairs; ``default`` is the default swatch's name,
    ``default_hex`` its hex, ``hexes`` every swatch hex.
    """

    default = DEFAULT_LABEL_NAME
    default_hex = DEFAULT_LABEL_COLOR
    hexes = tuple(hex_ for _, hex_ in LABEL_PALETTE)

    def __iter__(self) -> Iterator[tuple[str, str]]:
        return iter(LABEL_PALETTE)


TEMPLATE_PALETTE = TemplatePalette()

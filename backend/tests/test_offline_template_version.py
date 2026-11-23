"""Snapshot output without a version bump fails here.

Devices cache server-rendered snapshot partials and refetch them only when
``OFFLINE_TEMPLATE_VERSION`` changes. ``OFFLINE_TEMPLATE_HASH`` pins what that
output is built from: the template closure of the two snapshot partials and the
three context helpers. When the tree drifts from the pin, the version must be
bumped together with the hash, and the ledger below gains a row.
"""
import hashlib
import inspect

from jinja2 import ChoiceLoader, DictLoader, meta

from app.routers.web.app import articles
from app.services.sync import OFFLINE_TEMPLATE_HASH, OFFLINE_TEMPLATE_VERSION
from app.templating import templates

SNAPSHOT_ROOTS = ("app/partials/article_row.html", "app/partials/article_detail.html")
CONTEXT_HELPERS = (articles.row_render_context, articles.detail_render_context, articles.list_density)

# (OFFLINE_TEMPLATE_VERSION, OFFLINE_TEMPLATE_HASH) pairs, oldest first. A new
# hash needs a new version: append a row whenever both constants change.
LEDGER = [
    ("3", "dc65c44f502f4948"),
    ("4", "15e07a0d0fad98b0"),
    ("5", "2a128a49fc5f9cc4"),
    ("6", "60ff43c1c5f70e34"),
]
# Every row before the last one, frozen: devices in the field hold those versions, so
# history is never edited. A bump appends to LEDGER and copies its old last row here.
RELEASED = [
    ("3", "dc65c44f502f4948"),
    ("4", "15e07a0d0fad98b0"),
    ("5", "2a128a49fc5f9cc4"),
]


def _source(env, name: str) -> str:
    return env.loader.get_source(env, name)[0]


def snapshot_closure(env) -> dict[str, list[str | None]]:
    """Every template the snapshot roots reach, mapped to its direct references."""
    refs: dict[str, list[str | None]] = {}
    todo = list(SNAPSHOT_ROOTS)
    while todo:
        name = todo.pop()
        if name in refs:
            continue
        found = list(meta.find_referenced_templates(env.parse(_source(env, name))))
        refs[name] = found
        todo.extend(r for r in found if r is not None)
    return refs


def compute_template_hash(env) -> str:
    parts = {name: _source(env, name) for name in snapshot_closure(env)}
    for fn in CONTEXT_HELPERS:
        parts[f"routers/web/app/articles.py:{fn.__name__}"] = inspect.getsource(fn)
    digest = hashlib.sha256()
    for name in sorted(parts):
        digest.update(name.encode() + b"\n" + parts[name].encode() + b"\n")
    return digest.hexdigest()[:16]


def _check_bumped(version: str, current_hash: str) -> None:
    pinned = dict(LEDGER)
    assert current_hash == OFFLINE_TEMPLATE_HASH and pinned.get(version) == current_hash, (
        f"snapshot output changed (hash {current_hash}) while OFFLINE_TEMPLATE_VERSION is "
        f"{version!r} and OFFLINE_TEMPLATE_HASH is {OFFLINE_TEMPLATE_HASH!r}: bump "
        "OFFLINE_TEMPLATE_VERSION, set OFFLINE_TEMPLATE_HASH, add a ledger row and "
        "regenerate goldens with RF_UPDATE_GOLDENS=1"
    )


def test_closure_is_static_and_complete():
    refs = snapshot_closure(templates.env)
    dynamic = [name for name, found in refs.items() if None in found]
    assert not dynamic, f"dynamic template reference in {dynamic}"
    assert "app/partials/error_bar.html" in refs
    assert "app/partials/score_badge.html" in refs


def test_closure_change_without_bump_fails(monkeypatch):
    env = templates.env
    name = "app/partials/error_bar.html"
    changed = _source(env, name) + "\n{# changed #}\n"
    monkeypatch.setattr(env, "loader", ChoiceLoader([DictLoader({name: changed}), env.loader]))

    changed_hash = compute_template_hash(env)
    assert changed_hash != OFFLINE_TEMPLATE_HASH
    assert OFFLINE_TEMPLATE_VERSION == LEDGER[-1][0]
    try:
        _check_bumped(OFFLINE_TEMPLATE_VERSION, changed_hash)
    except AssertionError as exc:
        assert "OFFLINE_TEMPLATE_VERSION" in str(exc) and "OFFLINE_TEMPLATE_HASH" in str(exc)
    else:
        raise AssertionError("a closure change without a version bump passed")


def test_pinned_hash_matches_tree():
    versions = [v for v, _ in LEDGER]
    assert len(versions) == len(set(versions)), (
        "one ledger row per OFFLINE_TEMPLATE_VERSION: a new OFFLINE_TEMPLATE_HASH needs a version bump"
    )
    assert LEDGER[:-1] == RELEASED, "earlier ledger rows are released history: append, never edit"
    assert versions == [str(int(versions[0]) + i) for i in range(len(versions))], (
        "ledger versions count up by one"
    )
    assert LEDGER[-1] == (OFFLINE_TEMPLATE_VERSION, OFFLINE_TEMPLATE_HASH), (
        "the last ledger row must be (OFFLINE_TEMPLATE_VERSION, OFFLINE_TEMPLATE_HASH)"
    )
    _check_bumped(OFFLINE_TEMPLATE_VERSION, compute_template_hash(templates.env))

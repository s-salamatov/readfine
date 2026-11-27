"""Settings → Labels, Account and API tokens pages (real Postgres, real commits)."""
from bs4 import BeautifulSoup
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.security import hash_token
from app.models.auth import ApiToken
from app.services.label_palette import LABEL_PALETTE
from tests.test_settings_deletes import _client, _label, _user, env  # noqa: F401


async def _get(client, url) -> BeautifulSoup:
    r = await client.get(url)
    assert r.status_code == 200
    return BeautifulSoup(r.text, "html.parser")


async def _me(env_):
    engine, made = env_
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        await s.commit()
    return engine, user


async def test_labels_list_uses_delayed_delete(env):
    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        labels = [await _label(s, user, 'say "hi" <b>'), await _label(s, user)]
        await s.commit()

    async with _client(engine, user.id) as c:
        page = await _get(c, "/settings/labels")

    rows = page.select_one("#labels-list")
    for label in labels:
        key = f"label:{label.id}"
        row = rows.select(f'li[data-rf-delete-key="{key}"]')
        assert len(row) == 1
        triggers = row[0].select(f'[data-rf-delete="{key}"]')
        assert len(triggers) == 1
        assert triggers[0]["data-rf-delete-label"] == label.name
    assert not rows.select(".swap-confirm, [hx-delete]")
    # The swatch hooks stay: one full palette in the add form and in each edit form.
    forms = [page.select_one('form[hx-post="/settings/labels"]'),
             *rows.select("form[hx-post]")]
    assert len(forms) == 1 + len(labels)
    for form in forms:
        assert len(form.select(".color-swatch-group .color-swatch[aria-label][aria-pressed]"
                               "[data-color]")) == len(LABEL_PALETTE)
        assert form.select_one(".color-custom-input")
        assert form.select_one(".color-custom-preview")
        assert form.select_one('input[type="hidden"][name="color"]')
    assert forms[0]["data-clear-on-swap"] == "name"
    # One #labels-list (the partial's own, the forms' outerHTML target) and the markers
    # RFPending keeps true after a delete: the count and the always-rendered empty text.
    assert len(page.select("#labels-list")) == 1
    assert rows.has_attr("data-rf-pending-list")
    assert page.select_one("#labels-count")["data-rf-pending-count"] == "labels-list"
    assert page.select_one("#labels-count").get_text() == "(2)"
    empty = rows.select("[data-rf-pending-empty]")
    assert len(empty) == 1 and empty[0].has_attr("hidden")
    assert "No labels yet" in empty[0].get_text()


async def test_labels_empty_text_shown_without_labels(env):
    engine, user = await _me(env)
    async with _client(engine, user.id) as c:
        page = await _get(c, "/settings/labels")
    empty = page.select("#labels-list [data-rf-pending-empty]")
    assert len(empty) == 1 and not empty[0].has_attr("hidden")
    assert page.select_one("#labels-count").get_text() == "(0)"


async def test_new_token_shown_once_and_not_cached(env):
    engine, user = await _me(env)

    async with _client(engine, user.id) as c:
        r = await c.post("/settings/tokens", data={"name": "ci"})
        assert r.status_code == 200
        assert "no-store" in r.headers["cache-control"]
        page = BeautifulSoup(r.text, "html.parser")
        token = page.select_one("#new-token-value").get_text()
        async with AsyncSession(engine) as s:
            stored = await s.scalar(select(ApiToken).where(ApiToken.user_id == user.id))
        assert hash_token(token) == stored.token_hash
        assert page.select_one('.copy-from-btn[data-copy-from="new-token-value"]')
        assert r.text.count(token) == 1

        again = await c.get("/settings/tokens")
        assert token not in again.text

        rejected = await c.post("/settings/tokens", data={"name": "   "})
        assert "Token name cannot be empty." in rejected.text
        assert "no-store" in rejected.headers["cache-control"]


async def test_tokens_list_dividers_and_revoke(env):
    engine, made = env
    async with AsyncSession(engine, expire_on_commit=False) as s:
        user = await _user(s, made)
        tokens = [ApiToken(user_id=user.id, name=f"t{i}", token_prefix="p",
                           token_hash=hash_token(f"{user.id}-{i}")) for i in range(2)]
        s.add_all(tokens)
        await s.commit()

    async with _client(engine, user.id) as c:
        r = await c.get("/settings/tokens")
    page = BeautifulSoup(r.text, "html.parser")

    listing = page.select_one("#tokens-list")
    assert "divide-border" in listing.find("ul")["class"]
    # The API reference table carried the old light-only dividers too.
    for block in (listing, page.find("table")):
        assert "divide-gray-100" not in str(block)
    assert "divide-border" in page.find("tbody")["class"]
    for token in tokens:
        form = listing.select_one(f'form[hx-post="/settings/tokens/{token.id}/revoke"]')
        assert form["hx-target"] == "#tokens-list"
        assert form.select_one('button.swap-confirm[type="submit"]')


async def test_account_forms_keep_actions(env):
    engine, user = await _me(env)

    async with _client(engine, user.id) as c:
        page = await _get(c, "/settings/profile")

    expected = {
        "name": {"display_name"},
        "email": {"email", "current_password"},
        "password": {"current_password", "new_password", "confirm_password"},
        "delete-account": {"current_password", "confirm_text"},
    }
    for action, names in expected.items():
        form = page.select_one(f'form[action="/settings/profile/{action}"]')
        assert form["method"].upper() == "POST"
        assert {el["name"] for el in form.select("input[name]")} == names, action
        assert form.select_one('button[type="submit"]')
    delete = page.select_one("form[data-rf-delete-account]")
    assert delete["action"] == "/settings/profile/delete-account"
    assert [h.get_text() for h in page.select(".card > header > h2")] == [
        "Name", "Email", "Password", "Delete account"]

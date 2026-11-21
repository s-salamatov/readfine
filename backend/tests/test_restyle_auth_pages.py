"""Auth and error pages rebuilt from the ui/ macros (s2-T19, owner decision Q5).

Each page renders through the macros (card, field + input, button, alert, empty_state),
draws no colour from the legacy Tailwind palette any more, and keeps the contract the
backend tests, app.js, offline/boot.js and the e2e helpers rely on: form actions and
methods, data-rf-login, the ids the nonce'd scripts look up, the hidden fields and the
visible English strings.
"""
import re
from pathlib import Path

import pytest
from bs4 import BeautifulSoup
from starlette.requests import Request

from app.templating import templates
from app.utils.form_guard import HONEYPOT_FIELD
from tests.test_csp import _INLINE_HANDLER

TEMPLATES = Path(__file__).resolve().parents[1] / "app" / "templates"

# The colour pattern of scripts/check-colours.mjs (HEX and FUNC), without its masks.
COLOUR_LITERAL = re.compile(
    r"(?<![&\w])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])"
    r"|\b(?:rgba?|hsla?|oklch|oklab)\(")
# Utilities on the fixed Tailwind palette: they ignore the app theme, so the restyled
# pages draw from the tokens (primary, muted-foreground, destructive, card …) instead.
LEGACY_PALETTE = re.compile(
    r"(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|ring|from|to|via|divide|outline|fill|stroke)-"
    r"(?:white|black|(?:gray|slate|zinc|neutral|stone|red|green|amber|yellow|blue|indigo|orange|emerald)-\d{2,3})\b")


def _request(path: str, query: str = "") -> Request:
    req = Request({
        "type": "http", "method": "GET", "path": path, "query_string": query.encode(),
        "headers": [(b"host", b"testserver")], "scheme": "http",
        "server": ("testserver", 80), "root_path": "", "state": {}, "session": {},
    })
    req.state.csp_nonce = "n0nce"
    return req


def _render(name: str, path: str = "/", query: str = "", **ctx) -> tuple[str, BeautifulSoup]:
    html = templates.env.get_template(name).render(request=_request(path, query), **ctx)
    return html, BeautifulSoup(html, "html.parser")


# (template, path, query, context, selectors that must match, visible strings)
AUTH_CASES = {
    "login": (
        "auth/login.html", "/login", "", {"email": "a@b.c", "next": "/settings/profile"},
        ['form[method=post][action="/login"][data-rf-login]', "#email[name=email][type=email][required]",
         "#password[name=password][type=password]", 'input[type=hidden][name=next][value="/settings/profile"]',
         "form[data-rf-login] button[type=submit].btn"],
        ["Readfine", "Email", "Password", "Sign in"],
    ),
    "login-notices": (
        "auth/login.html", "/login", "verified=1&deleted=1&offline_wipe=incomplete",
        {"error": "Invalid email or password", "show_resend": True, "show_reset": True, "email": "a@b.c",
         "registration_open": True},
        ["[data-rf-offline-wipe-warning].alert", ".alert[data-variant=destructive]",
         'a[href="/register/check-email?email=a%40b.c"]', 'a[href="/reset-password"]', 'a[href="/register"]'],
        ["Email verified. You can now sign in.", "Your account has been deleted.",
         "Some offline data could not be removed from this device.", "Invalid email or password",
         "Resend verification email", "Forgot password?", "Don't have an account?", "Register"],
    ),
    "register": (
        "auth/register.html", "/register", "",
        {"error": "This email is already registered.", "email_taken": True, "prefill_email": "n@t.c",
         "prefill_display_name": "New User", "invite_token": "tok", "signup_source": "landing"},
        ['form[method=post][action="/register"][data-rf-login]', "#tz-field[name=timezone]",
         "#fmt-field[name=format_profile]", "input[type=hidden][name=form_ts]",
         f"#{HONEYPOT_FIELD}[name={HONEYPOT_FIELD}][tabindex='-1']",
         "input[type=hidden][name=invite_token]", "input[type=hidden][name=signup_source]",
         "#display_name[name=display_name]", '#email[name=email][value="n@t.c"]', "#password[name=password]",
         "#confirm_password[name=confirm_password]", "button#submit-btn[type=submit].btn",
         'a[href="/login?email=n%40t.c"]', 'a[href="/reset-password?email=n%40t.c"]',
         'a[href="/terms"]', 'a[href="/privacy"]', 'a[href="/help"]'],
        ["Display name", "(optional)", "At least 8 characters", "Confirm password", "Create account",
         "Log in instead", "Already have an account?", "Terms of Service", "Privacy Policy", "See the guide"],
    ),
    "register-locked": (
        "auth/register.html", "/register", "", {"prefill_email": "n@t.c", "email_locked": True},
        ["#email[readonly]", "button#submit-btn"], ["Create account"],
    ),
    "check-email-sent": (
        "auth/check_email.html", "/register/check-email", "sent=1", {"email": "n@t.c"},
        ['form[method=post][action="/resend-verification"]', '#resend_email[name=email][value="n@t.c"]',
         "button#resend-btn[type=submit].btn", "#sent-notice.alert"],
        ["Verification email sent.", "We sent a verification email", "Resend verification email",
         "Resend email", "Already verified?", "Sign in"],
    ),
    "check-email-failed": (
        "auth/check_email.html", "/register/check-email", "failed=1", {"verify_error": True},
        [".alert[data-variant=destructive]", "button#resend-btn"],
        ["This verification link is invalid or has expired.", "could not be sent"],
    ),
    "email-change-ok": (
        "auth/email_change_result.html", "/", "", {"ok": True, "message": "Your email address is updated."},
        ['a.btn[href="/login"]', ".alert"], ["Your email address is updated.", "Continue to Readfine"],
    ),
    "email-change-bad": (
        "auth/email_change_result.html", "/", "", {"ok": False, "message": "That link is no longer valid."},
        [".alert[data-variant=destructive]", 'a.btn[href="/login"]'], ["That link is no longer valid."],
    ),
    "registration-disabled": (
        "auth/registration_disabled.html", "/register", "", {},
        ['a.btn[href="/login"]'], ["Registration is currently disabled on this instance.", "Back to sign in"],
    ),
    "reset-request": (
        "auth/reset_password_request.html", "/reset-password", "", {"email": "a@b.c"},
        ['form[method=POST][action="/reset-password"][hx-boost=true][hx-indicator="#reset-spinner"]',
         '#email[name=email][value="a@b.c"]', "button[type=submit].btn", "#reset-spinner.htmx-indicator"],
        ["Enter your email address and we'll send you a link to reset your password.", "Send reset link",
         "Back to sign in"],
    ),
    "reset-request-sent": (
        "auth/reset_password_request.html", "/reset-password", "", {"sent": True},
        ['a.btn[href="/login"]'], ["If that email address is registered, you'll receive a reset link shortly."],
    ),
    "reset-confirm": (
        "auth/reset_password_confirm.html", "/reset-password/t0k", "", {"token": "t0k"},
        ['form[method=POST][action="/reset-password/t0k"][hx-boost=true]',
         "input[name=new_password][type=password][minlength='8']", "input[name=confirm_password][type=password]",
         "button[type=submit].btn"],
        ["Enter your new password.", "New password", "Confirm password", "Set new password"],
    ),
    "reset-confirm-error": (
        "auth/reset_password_confirm.html", "/reset-password/t0k", "", {"token": "t0k", "error": "Passwords do not match."},
        [".alert[data-variant=destructive]", "form[action='/reset-password/t0k']"], ["Passwords do not match."],
    ),
    "reset-confirm-invalid": (
        "auth/reset_password_confirm.html", "/reset-password/t0k", "", {"invalid": True},
        ['a.btn[href="/reset-password"]'], ["This reset link is invalid or has expired.", "Request a new link"],
    ),
    "reset-confirm-done": (
        "auth/reset_password_confirm.html", "/reset-password/t0k", "", {"done": True},
        ['a.btn[href="/login"]'], ["Your password has been changed.", "Sign in"],
    ),
}

ERROR_CASES = {
    "404": ("errors/404.html", {}, "/app", ["404", "Page not found.", "doesn't exist or has been moved", "Go to app"]),
    "429": ("errors/429.html", {}, "/login", ["429", "Too many requests.", "Please wait a moment", "Back to sign in"]),
    "500": ("errors/500.html", {}, "/app", ["500", "Something went wrong.", "An unexpected error occurred.", "Go to app"]),
    "client": ("errors/client.html", {"status": 400, "message": "Invalid name."}, "/app",
               ["400", "That did not go through.", "Invalid name. Go back and correct it, then try again.",
                "Go to app"]),
}


def _content(soup: BeautifulSoup):
    """The page body without base.html's own scripts and styles."""
    body = soup.body
    for tag in body.find_all(["script", "style"]):
        tag.decompose()
    return body


def _assert_clean(html: str, where: str) -> None:
    assert not _INLINE_HANDLER.search(html), f"inline handler in {where}"
    assert not COLOUR_LITERAL.search(html), f"colour literal in {where}"


@pytest.mark.parametrize("case", list(AUTH_CASES))
def test_auth_pages_use_macros_and_keep_contract(case):
    name, path, query, ctx, selectors, strings = AUTH_CASES[case]
    html, soup = _render(name, path, query, **ctx)
    _assert_clean(html, case)
    assert soup.select(".card"), f"{case}: no card"
    assert soup.select(".btn"), f"{case}: no ui button"
    for form in soup.select("form[action]"):
        # Every visible text control sits in a ui field and is a ui input.
        for control in form.select("input:not([type=hidden])"):
            if control.find_parent(attrs={"aria-hidden": "true"}):
                continue  # the honeypot stays off-screen and unstyled
            assert "input" in control.get("class", []), f"{case}: {control} is not a ui input"
            assert control.find_parent(class_="field"), f"{case}: {control} is outside a ui field"
    for selector in selectors:
        assert soup.select(selector), f"{case}: {selector} missing"
    text = " ".join(_content(soup).get_text(" ").split())
    for string in strings:
        assert string in text, f"{case}: {string!r} missing"


@pytest.mark.parametrize("case", list(ERROR_CASES))
def test_error_pages_use_macros(case):
    name, ctx, back, strings = ERROR_CASES[case]
    html, soup = _render(name, "/missing", **ctx)
    _assert_clean(html, case)
    assert soup.select(".card .empty"), f"{case}: no card with an empty state"
    assert soup.select(f'a.btn[href="{back}"]'), f"{case}: back link is not a ui button"
    text = " ".join(_content(soup).get_text(" ").split())
    for string in strings:
        assert string in text, f"{case}: {string!r} missing"


def test_auth_and_error_sources_draw_from_tokens():
    """Every branch, rendered or not: no colour literal and no fixed-palette utility."""
    found = {}
    for path in sorted([*TEMPLATES.glob("auth/*.html"), *TEMPLATES.glob("errors/*.html")]):
        source = re.sub(r"\{#[\s\S]*?#\}", "", path.read_text())
        hits = LEGACY_PALETTE.findall(source) + COLOUR_LITERAL.findall(source)
        if hits:
            found[path.relative_to(TEMPLATES).as_posix()] = sorted(set(hits))
    assert found == {}

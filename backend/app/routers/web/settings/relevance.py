"""Web routes for Relevance & filters: the basic term list and how scores show,
the filters list and the story grouping with its hidden-stories list.

Basic relevance runs without an API key or an admin who has AI switched on, so
this page is never hidden, unlike the AI item in the settings nav. Its Relevance
card holds the term list the lexical scorer matches, its switch, and the
score-in-list option, which applies to both scorers. The Filters card is the list
that was /settings/filters (the editor and filter actions stay in filters.py).
The Stories card is the story_dedup choice, saved on change through
POST /settings/field, and the "kept out" counter opening onto
/settings/relevance/hidden. The AI interest profile is a different text for a
different reader (the model) and lives on the Assistant page.
"""
from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.config import settings as app_settings_config
from app.database import get_db
from app.fetcher.scheduler import run_lexical_backfill_now
from app.models.user import User
from app.rate_limit import limiter
from app.services.relevance_corpus_service import get_stats
from app.services import relevance_suggest_service as suggest
from app.services.relevance_service import parse_terms, skipped_terms
from app.services.relevance_terms_service import TERMS_MAX_CHARS, backfill_due, save_terms
from app.services.filter_service import list_filters
from app.services.label_service import list_labels
from app.services.story_service import (
    DEDUP_SUPPRESS, SUPPRESSED_DAYS, count_suppressed, list_suppressed,
)
from app.templating import templates

from .common import _get_or_create_settings
from .filters import _user_score_sources

router = APIRouter(prefix="/settings", tags=["settings"])


async def _page_context(user: User, db: AsyncSession) -> dict:
    s = await _get_or_create_settings(user, db)
    return {
        "s": s,
        "active": "relevance",
        "term_count": len(parse_terms(s.relevance_terms)),
        # Nothing is scored until the corpus has been counted once, and an empty
        # score column with no explanation looks like a bug rather than like the
        # first minutes of an install.
        "corpus_ready": await get_stats(db) is not None,
        "terms_max_chars": TERMS_MAX_CHARS,
        # The Filters card (the list that was /settings/filters until s7).
        "filters": await list_filters(user.id, db),
        "labels": await list_labels(user, db),
        "score_sources": await _user_score_sources(user, db),
        # The Stories card: the grouping choice and the counter it produces.
        "suppressed_week": (await count_suppressed(user.id, db)
                            if s.story_dedup == DEDUP_SUPPRESS else 0),
        "suppressed_days": SUPPRESSED_DAYS,
    }


@router.get("/relevance", response_class=HTMLResponse)
async def settings_relevance(
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return templates.TemplateResponse(
        request, "settings/relevance.html", await _page_context(user, db))


@router.post("/relevance", response_class=HTMLResponse)
async def settings_relevance_save(
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    form = await request.form()
    s = await _get_or_create_settings(user, db)

    # Line endings are the browser's, not the reader's: a textarea submits \r\n.
    raw = (form.get("relevance_terms") or "").replace("\r\n", "\n")
    if len(raw) > TERMS_MAX_CHARS:
        ctx = await _page_context(user, db)
        ctx["error"] = (f"The term list is too long ({len(raw)} characters). "
                        f"Maximum is {TERMS_MAX_CHARS:,} characters.".replace(",", " "))
        ctx["terms_submitted"] = raw
        return templates.TemplateResponse(request, "settings/relevance.html", ctx)

    # Stored the way the reader wrote it, separators and all: the scorer reads
    # it apart on every load (parse_terms), and rewriting someone's list under
    # their hands would be the surprising thing to do. What the scorer is going
    # to skip is said instead.
    text = raw.strip() or None

    s.basic_scoring_enabled = form.get("basic_scoring_enabled") == "on"
    s.ai_score_show_in_list = form.get("ai_score_show_in_list") == "on"
    save_terms(s, text)
    await db.commit()

    ctx = await _page_context(user, db)
    ctx["saved"] = True
    ctx["skipped"] = skipped_terms(raw)
    # The rescoring is a scheduler job, pulled forward to now, so it usually lands
    # within seconds; a reader going straight back to the list may still find no
    # scores yet, so it is said when a save made it due.
    ctx["rescoring"] = backfill_due(s)
    if ctx["rescoring"]:
        run_lexical_backfill_now()
    return templates.TemplateResponse(request, "settings/relevance.html", ctx)


@router.get("/relevance/hidden", response_class=HTMLResponse)
async def settings_relevance_hidden(
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The articles behind the "kept out in the last 7 days" counter (Stories card).

    Fetched when the reader opens the counter rather than with the page: most
    readers have the setting off, and for the rest the number answers the question
    until it doesn't. Empty unless story grouping is in suppress mode.

    Read-only by design. There is no button here to bring an article back, because
    the article itself already has one: the title opens it in the reader, where
    un-reading it works the way it does for every other article.
    """
    s = await _get_or_create_settings(user, db)
    hidden = (
        await list_suppressed(user.id, db) if s.story_dedup == DEDUP_SUPPRESS else []
    )
    return templates.TemplateResponse(request, "settings/partials/hidden_stories.html", {
        "hidden": hidden,
        "suppressed_days": SUPPRESSED_DAYS,
    })


# ── suggestions ───────────────────────────────────────────────────────────────
# Loaded after the page (hx-trigger="load"): a month of headlines is tokenized
# for them, and the rest of the page should not wait for that. Clicking one edits
# the list and saves it, the way hiding one saves the dismissal.

@router.get("/relevance/suggestions", response_class=HTMLResponse)
@limiter.limit(app_settings_config.rate_limit_relevance_suggestions)
async def settings_relevance_suggestions(
    request: Request,
    part: str | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The suggestions with the term table, or with `part=terms` the table alone.

    The table alone is what a click on a suggestion reloads: the list changed, so
    its numbers did, but re-rendering the suggestions would close "Why these?"
    under the reader's hands.
    """
    s = await _get_or_create_settings(user, db)
    template = ("settings/_relevance_term_stats.html" if part == "terms"
                else "settings/_relevance_suggestions.html")
    return templates.TemplateResponse(request, template, {
        "sugg": await suggest.suggestions(user.id, s.relevance_terms, db),
        "term_count": len(parse_terms(s.relevance_terms)),
        "window_days": suggest.WINDOW_DAYS,
        "min_engaged": suggest.MIN_ENGAGED,
        "min_lift_matches": suggest.MIN_LIFT_MATCHES,
        "top_score": suggest.TOP_SCORE,
        "min_top_engaged": suggest.MIN_TOP_ENGAGED,
        # The table alone is a reload, and the summary above it has to follow.
        "oob": part == "terms",
    })


def _chip_id(value) -> str | None:
    """The suggestion's element id, echoed back so the response can remove it."""
    value = str(value or "")
    return value if value.startswith("sugg-") and value[5:].isdigit() else None


@router.post("/relevance/suggestions/apply", response_class=HTMLResponse)
async def settings_relevance_suggestion_apply(
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Add or remove the term and save the list, like hiding one saves the dismissal.

    The list saved is the text area as it is now, edits typed into it included:
    a click that changed the list without saving it left the reader with a
    suggestion gone from the page and nothing kept.
    """
    form = await request.form()
    s = await _get_or_create_settings(user, db)
    text = (form.get("relevance_terms") or "").replace("\r\n", "\n")
    term = (form.get("term") or "").strip()
    kind = form.get("kind")
    ctx = {"chip": None, "terms_error": False}
    if term and kind == suggest.ADD:
        text = suggest.add_term(text, term)
        done = f"Added {term} and saved your list. Scores update within a few minutes."
    elif term and kind == suggest.REMOVE:
        text = suggest.remove_term(text, term)
        done = f"Removed {term} and saved your list. Scores update within a few minutes."
    else:
        done = None

    if done and len(text) > TERMS_MAX_CHARS:
        ctx.update(terms_error=True, terms_status=(
            f"Not saved: the list would be {len(text)} characters, and the "
            f"maximum is {TERMS_MAX_CHARS:,}.".replace(",", " ")))
        text = (form.get("relevance_terms") or "").replace("\r\n", "\n")
    elif done:
        save_terms(s, text)
        await db.commit()
        ctx.update(chip=_chip_id(form.get("chip")), terms_status=done)

    ctx.update(terms_text=text, saved_text=s.relevance_terms or "")
    response = templates.TemplateResponse(
        request, "settings/_relevance_suggestion_applied.html", ctx)
    if done and not ctx["terms_error"]:
        response.headers["HX-Trigger"] = "relevance-terms-saved"
    return response


@router.post("/relevance/suggestions/dismiss", response_class=HTMLResponse)
async def settings_relevance_suggestion_dismiss(
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    form = await request.form()
    await suggest.dismiss(user.id, (form.get("term") or "").strip(), form.get("kind"), db)
    return templates.TemplateResponse(request, "settings/_relevance_suggestion_applied.html", {
        "chip": _chip_id(form.get("chip")),
    })

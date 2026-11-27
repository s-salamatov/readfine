"""On-demand AI over a single article (summary, context) and the chat panels
(per-article and general)."""
import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.config import settings as app_settings_config
from app.database import get_db
from app.models.article import Article, ArticleAiChat, ArticleAiJob, UserArticleState
from app.models.user import User, UserSettings
from app.rate_limit import limiter
from app.services.ai_jobs import (
    ON_DEMAND_MIN_CHARS, ai_enabled_globally, normalize_content, normalize_text,
)
from app.services.article import add_article_access_joins, article_access_predicate
from app.templating import templates
from app.ui_fragments import alert_html
from app.services.ai_service import describe_ai_error
from app.utils.url_validator import ResponseTooLarge, find_blocked_address, find_cause

router = APIRouter(tags=["web-app"])
logger = logging.getLogger(__name__)


async def _get_article_access(user: User, article_id: int, db: AsyncSession):
    """Return Article ORM object if user has access, else None."""
    stmt = add_article_access_joins(select(Article), user.id).where(
        Article.id == article_id, article_access_predicate()
    )
    return (await db.execute(stmt)).scalar_one_or_none()


def _ai_macros():
    """Macro module for the AI result blocks — the same source article_detail.html
    renders from, so a generated block matches how a stored one is drawn."""
    return templates.env.get_template("app/partials/ai_blocks.html").module


def _ai_summary_block(article_id: int, summary: str, truncated: bool = False) -> str:
    return str(_ai_macros().ai_summary(article_id, summary, truncated))


def _ai_context_block(article_id: int, context: str) -> str:
    return str(_ai_macros().ai_context(article_id, context))


_CHAT_MAX_MESSAGES = 10  # 5 user + 5 assistant turns
_CHAT_MAX_MESSAGE_CHARS = 2000  # what the user types, in both chats
# The general chat's history comes back from the client. A reply is longer than a
# question, so this is a ceiling against a hand-made request, not a limit on answers.
_CHAT_MAX_HISTORY_ITEM_CHARS = 20000


def _parse_chat_history(raw: str) -> list[dict]:
    """The general chat's history from the form, reduced to what a real one holds:
    user and assistant turns with string content. Anything else (a "system" turn, a
    non-dict, a missing field) is dropped rather than passed to the provider."""
    try:
        items = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return []
    if not isinstance(items, list):
        return []
    return [
        {"role": m["role"], "content": m["content"][:_CHAT_MAX_HISTORY_ITEM_CHARS]}
        for m in items
        if isinstance(m, dict)
        and m.get("role") in ("user", "assistant")
        and isinstance(m.get("content"), str)
    ]


def _chat_macros():
    """Macro module for the chat panel — the same source article_detail.html and
    main.html draw the panel from, so sending a message can't reshape it."""
    return templates.env.get_template("app/partials/chat.html").module


def _render_chat_area(article_id: int, messages: list[dict],
                      include_article: bool = True,
                      error: str = "",
                      article_title: str = "") -> str:
    return str(_chat_macros().chat_area(
        article_id, messages, include_article, error, article_title
    ))


def _render_general_chat_area(messages: list[dict], error: str = "", *,
                              assistant: bool = False, article_id=None,
                              article_title: str = "") -> str:
    if assistant:
        macro = templates.env.get_template("assistant/chat.html").module.assistant_chat_area
        return str(macro(messages, article_id, article_title, error))
    return str(_chat_macros().general_chat_area(messages, error))


async def assistant_chat_context(user: User, db: AsyncSession, article_id=None) -> dict:
    """Presentation readiness, using the same main-slot gate as profile generation.

    An article hint never grants access. This adapter does not load saved chat
    history: each rendered Assistant page starts its own conversation.
    """
    from app.services.ai_profile_service import quality_slot_blocker

    article = None
    article_problem = None
    problem = None
    if article_id is not None:
        raw_id = str(article_id)
        # Keep malformed or out-of-range form IDs away from the bigint query.
        if len(raw_id) <= 19 and raw_id.isascii() and raw_id.isdigit() and 0 < int(raw_id) < 2**63:
            article = await _get_article_access(user, int(raw_id), db)
        if article is None:
            article_problem = "This article is unavailable. Choose a different article or start a general conversation."
    # The reader fixes these in the AI provider settings; the administrator's switch, not.
    fixable = True
    if not await ai_enabled_globally(db):
        problem = "AI is disabled. Contact your administrator."
        fixable = False
    else:
        settings = await db.scalar(select(UserSettings).where(UserSettings.user_id == user.id))
        blocker = await quality_slot_blocker(settings, db) if settings else ("no_quality_model", {})
        if blocker:
            problem = {
                "no_quality_model": "Choose a main model.",
                "no_api_key": "Add an API key for your main model.",
                "no_endpoint": "Set the custom model endpoint.",
            }[blocker[0]]
        elif not settings.ai_chat_enabled:
            problem = "Enable chat in the AI provider settings."
    return {
        "article": article,
        "chat_available": problem is None,
        # The link is its own field: the sentence is shown as written and never parsed.
        "chat_setup": None if problem is None else {
            "text": problem,
            "link_label": "Open AI provider settings" if fixable else None,
            "href": "/settings/ai" if fixable else None,
        },
        # General chat stays usable beside it; a request for that article does not.
        "article_problem": article_problem,
    }


def _ai_failure(target_id: str, text: str) -> str:
    """A failed summary or context, as the destructive alert under the id the swap
    targets. text is plain (alert_html escapes it), so pass the error unescaped."""
    return str(alert_html(text, variant="destructive", live=True, attrs={"id": target_id}))


def _ai_spinner(target_id: str, poll_url: str) -> str:
    return str(_ai_macros().ai_spinner(target_id, poll_url, "Generating summary…"))


async def _require_quality_ai_for_article(
    user: User, article_id: int, db: AsyncSession, *, target_id: str, too_short_label: str
):
    """Shared guard for on-demand AI (summary / context): AI enabled globally, a
    quality model configured, the article accessible, and its content long enough.

    Both buttons gate on ``ON_DEMAND_MIN_CHARS``, not on the user's minimum
    length: that setting is aimed at the automatic pipeline. Context would be the
    worse fit of the two anyway, since it supplies what an article leaves out and
    so earns its keep on exactly the short pieces the setting turns away.

    Returns an error ``HTMLResponse`` (rendered into ``target_id``) on any failed
    check, or ``(article, settings, content_text)`` on success.
    """
    def _note(text: str) -> HTMLResponse:
        return HTMLResponse(alert_html(text, variant="default", live=True, attrs={"id": target_id}))

    if not await ai_enabled_globally(db):
        return _note("AI is disabled.")

    settings = await db.scalar(select(UserSettings).where(UserSettings.user_id == user.id))
    if not settings or not settings.ai_quality_provider or not settings.ai_quality_model:
        return _note("Main AI model not configured.")

    article = await _get_article_access(user, article_id, db)
    if not article:
        return HTMLResponse("", status_code=404)

    # Measured on the full text, truncated only on the way to the model, so this
    # gate agrees with enqueue whatever the content limit is.
    full_text = normalize_text(article.title, article.readable_content or article.content)
    if len(full_text) < ON_DEMAND_MIN_CHARS:
        return _note(
            f"Article is too short for {too_short_label} "
            f"(minimum {ON_DEMAND_MIN_CHARS} characters)."
        )

    return article, settings, full_text[:settings.ai_content_limit]


@router.post("/htmx/articles/{article_id}/ai-summary", response_class=HTMLResponse)
@limiter.limit(app_settings_config.rate_limit_ai_summary)
async def htmx_ai_summary_trigger(
    article_id: int,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """On-demand: run summary synchronously and return result block."""
    guard = await _require_quality_ai_for_article(
        user, article_id, db, target_id=f"ai-summary-{article_id}", too_short_label="a summary"
    )
    if isinstance(guard, HTMLResponse):
        return guard
    article, settings, content_text = guard

    from app.services.ai_summary_service import run_summary_on_demand
    summary, truncated, error = await run_summary_on_demand(article, user.id, db)
    if summary is None:
        return HTMLResponse(_ai_failure(
            f"ai-summary-{article_id}", f"Summary failed: {error or 'Summary unavailable.'}"
        ))
    return HTMLResponse(_ai_summary_block(article_id, summary, truncated))


@router.get("/htmx/articles/{article_id}/ai-summary/poll", response_class=HTMLResponse)
async def htmx_ai_summary_poll(
    article_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Poll summary job status and return final block or keep spinner."""
    job = await db.scalar(
        select(ArticleAiJob).where(
            ArticleAiJob.article_id == article_id,
            ArticleAiJob.user_id == user.id,
            ArticleAiJob.operation == "summary",
        )
    )

    if job is None:
        # No job (never queued, or cancelled by unstarring) — stop polling instead
        # of spinning forever on a summary that is not coming.
        return HTMLResponse(f'<div id="ai-summary-{article_id}"></div>')

    if job.status == "pending":
        from app.services.ai_summary_service import AWAITS_READABLE, awaits_readable
        if job.job_params == AWAITS_READABLE:
            article = await db.get(Article, article_id)
            if article is not None and awaits_readable(article):
                # Not being generated yet. The readable poll brings the spinner back.
                return HTMLResponse(f'<div id="ai-summary-{article_id}"></div>')
        return HTMLResponse(_ai_spinner(f"ai-summary-{article_id}", f"/htmx/articles/{article_id}/ai-summary/poll"))

    if job.status == "failed":
        msg = (job.error_message or "Unknown error")[:120]
        return HTMLResponse(_ai_failure(f"ai-summary-{article_id}", f"Summary failed: {msg}"))

    if job.status == "skipped":
        # Without this the spinner would be replaced by an empty div: the branch
        # below finds no stored summary and says nothing about why. Length is not
        # among the reasons a queued job is skipped, only a model that is no
        # longer there when its turn comes.
        return HTMLResponse(alert_html(
            "Summary was skipped. Check that a main AI model is configured.",
            variant="warning", live=True, attrs={"id": f"ai-summary-{article_id}"},
        ))

    state = await db.scalar(
        select(UserArticleState).where(
            UserArticleState.user_id == user.id,
            UserArticleState.article_id == article_id,
        )
    )
    if state and state.ai_summary:
        return HTMLResponse(
            _ai_summary_block(article_id, state.ai_summary, state.ai_summary_truncated)
        )

    return HTMLResponse(f'<div id="ai-summary-{article_id}"></div>')


@router.post("/htmx/articles/{article_id}/ai-context", response_class=HTMLResponse)
@limiter.limit(app_settings_config.rate_limit_ai_context)
async def htmx_ai_context_trigger(
    article_id: int,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """On-demand: call AI directly and return context block (synchronous, may take several seconds)."""
    guard = await _require_quality_ai_for_article(
        user, article_id, db, target_id=f"ai-context-{article_id}",
        too_short_label="context generation",
    )
    if isinstance(guard, HTMLResponse):
        return guard
    article, settings, content_text = guard

    form = await request.form()
    focus = (form.get("focus") or "").strip() or None

    from app.services.ai_service import ai_client, get_article_context
    from app.services.translation_service import output_language
    language = await output_language(settings, article.feed_id, db)
    async with ai_client(user.id, "quality", db) as (client, provider, model):
        if client is None:
            return HTMLResponse(alert_html(
                "Main AI model not configured.", variant="default", live=True,
                attrs={"id": f"ai-context-{article_id}"},
            ))

        try:
            result, in_tok, out_tok = await get_article_context(
                content_text, client, provider, model,
                base_prompt=settings.ai_context_prompt,
                focus=focus,
                language=language,
            )
        except Exception as exc:
            msg = describe_ai_error(exc)[:200]
            return HTMLResponse(_ai_failure(f"ai-context-{article_id}", f"Context failed: {msg}"))

    now = datetime.now(timezone.utc)
    state = await db.scalar(
        select(UserArticleState).where(
            UserArticleState.user_id == user.id,
            UserArticleState.article_id == article_id,
        )
    )
    if state is None:
        state = UserArticleState(user_id=user.id, article_id=article_id)
        db.add(state)
    state.ai_context = result

    from sqlalchemy.dialects.postgresql import insert as pg_insert
    await db.execute(
        pg_insert(ArticleAiJob).values(
            article_id=article_id,
            user_id=user.id,
            operation="context",
            status="success",
            provider=provider,
            model=model,
            input_tokens=in_tok,
            output_tokens=out_tok,
            processed_at=now,
        ).on_conflict_do_update(
            index_elements=["article_id", "user_id", "operation"],
            set_={
                "status": "success",
                "provider": provider,
                "model": model,
                "input_tokens": in_tok,
                "output_tokens": out_tok,
                "processed_at": now,
            },
        )
    )
    await db.commit()

    return HTMLResponse(_ai_context_block(article_id, result))


def _ai_chat_error_message(exc: Exception) -> str:
    """Keep provider messages, endpoints and credentials out of chat and logs."""
    logger.warning("AI chat failed: %s", type(exc).__name__)
    if find_blocked_address(exc) is not None:
        return (
            "Chat failed: A model on a private address has to be listed in "
            "AI_ALLOWED_PRIVATE_HOSTS in the instance's environment."
        )
    if find_cause(exc, ResponseTooLarge) is not None:
        return (
            "Chat failed: The response exceeded the size limit. "
            "Check that the URL points at an OpenAI-compatible API."
        )

    description = describe_ai_error(exc)
    # Only return controlled texts. The shared formatter also has a raw-message
    # fallback; future additions there must not silently expose details here.
    for safe_message in (
        "Model not found. Check the model name.",
        "Invalid API key.",
        "The AI provider is overloaded. Try again in a moment.",
        "Rate limit reached. Try again later.",
        "Access denied. Check your API key permissions.",
        "Timed out waiting for a reply. A local model can take a while to load "
        "the first time it is used. Try again.",
        "Could not reach the endpoint. Check the URL and that the server is running.",
    ):
        if description == safe_message:
            return f"Chat failed: {safe_message}"
    status = getattr(exc, "status_code", None)
    if type(status) is int and status >= 500 and description == (
        f"The AI provider returned a server error ({status}). Try again later."
    ):
        return "Chat failed: The AI provider returned a server error. Try again later."
    return "Chat failed: The AI request could not be completed. Try again later."


@router.post("/htmx/ai-chat", response_class=HTMLResponse)
@limiter.limit(app_settings_config.rate_limit_ai_chat)
async def htmx_general_ai_chat(
    request: Request,
    message: str = Form(...),
    include_article: str = Form(""),
    history: str = Form("[]"),
    article_id: str = Form(""),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    assistant = request.headers.get("HX-Target") == "rf-assistant-chat"
    article = None

    def render(messages, error="", status_code=200):
        return HTMLResponse(
            _render_general_chat_area(
                messages, error, assistant=assistant,
                article_id=article.id if article else None,
                article_title=article.title if article else "",
            ), status_code=status_code,
            headers={"Cache-Control": "no-store", "Vary": "HX-Target"},
        )

    if assistant:
        context = await assistant_chat_context(
            user, db, article_id if include_article == "on" else None,
        )
        article = context["article"]
        setup = context["chat_setup"]
        blocker = setup["text"] if setup else context["article_problem"]
        if blocker:
            return render(_parse_chat_history(history)[-_CHAT_MAX_MESSAGES:], blocker)

    ai_on = await ai_enabled_globally(db)
    if not ai_on:
        return HTMLResponse(
            f'<div id="general-chat-area" '
            f'class="flex-1 overflow-hidden flex flex-col px-2 sm:px-4 py-3">'
            f'<p class="text-xs text-gray-400 py-2">AI is disabled.</p></div>',
            headers={"Cache-Control": "no-store", "Vary": "HX-Target"}
        )

    settings = await db.scalar(select(UserSettings).where(UserSettings.user_id == user.id))
    if not settings or not settings.ai_quality_provider or not settings.ai_quality_model:
        return HTMLResponse(
            f'<div id="general-chat-area" '
            f'class="flex-1 overflow-hidden flex flex-col px-2 sm:px-4 py-3">'
            f'<p class="text-xs text-gray-400 py-2">Main AI model not configured.</p></div>',
            headers={"Cache-Control": "no-store", "Vary": "HX-Target"}
        )
    if not getattr(settings, 'ai_chat_enabled', False):
        return HTMLResponse("", status_code=403, headers={"Cache-Control": "no-store", "Vary": "HX-Target"})

    msg_text = message.strip()[:_CHAT_MAX_MESSAGE_CHARS]
    if not msg_text:
        if assistant:
            return render(_parse_chat_history(history)[-_CHAT_MAX_MESSAGES:], "Enter a message.", status_code=400)
        return HTMLResponse("", status_code=400, headers={"Cache-Control": "no-store", "Vary": "HX-Target"})

    current_messages = _parse_chat_history(history)
    # A failed page request must restore the complete pre-submit transcript,
    # including the turn displaced by the provider's bounded history window.
    previous_messages = current_messages[-_CHAT_MAX_MESSAGES:]

    current_messages.append({"role": "user", "content": msg_text})
    if len(current_messages) > _CHAT_MAX_MESSAGES:
        current_messages = current_messages[-_CHAT_MAX_MESSAGES:]

    tier = "quality"
    use_article = (include_article == "on")

    article_ctx = None
    art_id: int | None = None
    article = None
    if use_article and article_id.strip().isdigit():
        art_id = int(article_id)
        article = await _get_article_access(user, art_id, db)
        if article:
            article_ctx = normalize_content(
                article.title,
                article.readable_content or article.content,
                settings.ai_content_limit,
            )

    from app.services.ai_service import ai_client, chat_with_article
    async with ai_client(user.id, tier, db) as (client, provider, model):
        if client is None:
            return render(previous_messages if assistant else current_messages[:-1],
                          error="Main AI model not configured.")

        try:
            response_text, in_tok, out_tok = await chat_with_article(current_messages, article_ctx, client, provider, model)
        except Exception as exc:
            return render(previous_messages if assistant else current_messages[:-1],
                          error=_ai_chat_error_message(exc))

    current_messages.append({"role": "assistant", "content": response_text})
    if len(current_messages) > _CHAT_MAX_MESSAGES:
        current_messages = current_messages[-_CHAT_MAX_MESSAGES:]

    if use_article and art_id and article:
        chat_record = await db.scalar(
            select(ArticleAiChat).where(
                ArticleAiChat.user_id == user.id,
                ArticleAiChat.article_id == art_id,
            )
        )
        if chat_record is None:
            chat_record = ArticleAiChat(user_id=user.id, article_id=art_id, messages=[])
            db.add(chat_record)
        saved = list(chat_record.messages or [])
        saved.append({"role": "user", "content": msg_text})
        saved.append({"role": "assistant", "content": response_text})
        if len(saved) > _CHAT_MAX_MESSAGES:
            saved = saved[-_CHAT_MAX_MESSAGES:]
        chat_record.messages = saved
        chat_record.total_input_tokens = (chat_record.total_input_tokens or 0) + in_tok
        chat_record.total_output_tokens = (chat_record.total_output_tokens or 0) + out_tok
        chat_record.updated_at = datetime.now(timezone.utc)
    else:
        from app.models.article import GeneralChatLog
        db.add(GeneralChatLog(user_id=user.id, input_tokens=in_tok, output_tokens=out_tok))
    await db.commit()

    return render(current_messages)


@router.delete("/htmx/ai-chat", response_class=HTMLResponse)
async def htmx_general_ai_chat_clear(
    user: User = Depends(get_current_user),
):
    return HTMLResponse(_render_general_chat_area([]))


@router.post("/htmx/articles/{article_id}/ai-chat", response_class=HTMLResponse)
@limiter.limit(app_settings_config.rate_limit_ai_chat)
async def htmx_ai_chat(
    article_id: int,
    request: Request,
    message: str = Form(...),
    include_article: str = Form(""),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ai_on = await ai_enabled_globally(db)
    if not ai_on:
        return HTMLResponse(
            f'<div id="chat-area-{article_id}" '
            f'class="flex-1 overflow-hidden flex flex-col px-2 sm:px-4 py-3">'
            f'<p class="text-xs text-gray-400 py-2">AI is disabled.</p></div>'
        )

    settings = await db.scalar(select(UserSettings).where(UserSettings.user_id == user.id))
    if not settings or not settings.ai_quality_provider or not settings.ai_quality_model:
        return HTMLResponse(
            f'<div id="chat-area-{article_id}" '
            f'class="flex-1 overflow-hidden flex flex-col px-2 sm:px-4 py-3">'
            f'<p class="text-xs text-gray-400 py-2">Main AI model not configured.</p></div>'
        )
    if not getattr(settings, 'ai_chat_enabled', False):
        return HTMLResponse("", status_code=403)

    msg_text = message.strip()[:_CHAT_MAX_MESSAGE_CHARS]
    if not msg_text:
        return HTMLResponse("", status_code=400)

    article = await _get_article_access(user, article_id, db)
    if not article:
        return HTMLResponse("", status_code=404)

    chat = await db.scalar(
        select(ArticleAiChat).where(
            ArticleAiChat.user_id == user.id,
            ArticleAiChat.article_id == article_id,
        )
    )
    if chat is None:
        chat = ArticleAiChat(user_id=user.id, article_id=article_id, messages=[])
        db.add(chat)

    current_messages: list[dict] = list(chat.messages or [])
    current_messages.append({"role": "user", "content": msg_text})

    tier = "quality"
    use_article = (include_article == "on")

    article_ctx = None
    if use_article:
        article_ctx = normalize_content(article.title, article.readable_content or article.content, settings.ai_content_limit)

    from app.services.ai_service import ai_client, chat_with_article
    title = article.title or ""
    async with ai_client(user.id, tier, db) as (client, provider, model):
        if client is None:
            return HTMLResponse(_render_chat_area(
                article_id, current_messages[:-1], use_article,
                error="Main AI model not configured.",
                article_title=title,
            ))

        try:
            response_text, in_tok, out_tok = await chat_with_article(current_messages, article_ctx, client, provider, model)
        except Exception as exc:
            return HTMLResponse(_render_chat_area(
                article_id, current_messages[:-1], use_article,
                error=_ai_chat_error_message(exc), article_title=title,
            ))

    current_messages.append({"role": "assistant", "content": response_text})
    if len(current_messages) > _CHAT_MAX_MESSAGES:
        current_messages = current_messages[-_CHAT_MAX_MESSAGES:]
    chat.messages = current_messages  # reassign — SQLAlchemy JSONB change tracking
    chat.total_input_tokens = (chat.total_input_tokens or 0) + in_tok
    chat.total_output_tokens = (chat.total_output_tokens or 0) + out_tok
    chat.updated_at = datetime.now(timezone.utc)
    await db.commit()

    return HTMLResponse(_render_chat_area(article_id, current_messages, use_article,
                                          article_title=title))


@router.delete("/htmx/articles/{article_id}/ai-chat", response_class=HTMLResponse)
async def htmx_ai_chat_clear(
    article_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    chat = await db.scalar(
        select(ArticleAiChat).where(
            ArticleAiChat.user_id == user.id,
            ArticleAiChat.article_id == article_id,
        )
    )
    if chat is not None:
        chat.messages = []
        chat.updated_at = datetime.now(timezone.utc)
        await db.commit()
    return HTMLResponse(_render_chat_area(article_id, []))

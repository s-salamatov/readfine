"""Signed same-origin image proxy for offline copies (see app.services.sync.media)."""
import asyncio
import concurrent.futures

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response

from app.auth.dependencies import get_current_user
from app.models.user import User

router = APIRouter(tags=["web-app"])

# Bounded pool for the blocking fetches, like the video-thumb proxy, so a burst of
# cold images cannot exhaust the shared default executor.
_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=8, thread_name_prefix="offline-media")

# Private: the link is bound to one user's session, so no shared cache may keep it.
_CACHE_CONTROL = "private, max-age=31536000, immutable"


@router.get("/m/{sig}/{exp}/{b64url}")
async def offline_media(
    request: Request, sig: str, exp: int, b64url: str,
    user: User = Depends(get_current_user),
):
    from app.services.sync import media

    try:
        url = media.verify(sig, exp, b64url, user.id)
    except PermissionError:
        return Response(status_code=403)

    etag = f'"om-{sig}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": _CACHE_CONTROL})

    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(_POOL, media.get_media, url)
    except media.MediaTooLarge:
        return Response(status_code=413)
    except media.MediaNotImage:
        return Response(status_code=415)
    if result is None:
        return Response(status_code=404)
    data, mime = result
    return Response(content=data, media_type=mime,
                    headers={"Cache-Control": _CACHE_CONTROL, "ETag": etag})

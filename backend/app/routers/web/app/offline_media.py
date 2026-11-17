"""Signed same-origin image proxy for offline copies (see app.services.sync.media)."""
import asyncio
import concurrent.futures

from fastapi import APIRouter, Depends
from fastapi.responses import Response

from app.auth.dependencies import get_current_user
from app.models.user import User

router = APIRouter(tags=["web-app"])

# Bounded pool for the blocking fetches, like the video-thumb proxy, so a burst of
# cold images cannot exhaust the shared default executor.
_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=8, thread_name_prefix="offline-media")

# no-store: the device keeps its offline images in its own per-user Cache Storage
# (wiped on logout); the browser HTTP cache would keep them past logout (CWE-525).
_CACHE_CONTROL = "no-store"


@router.get("/m/{sig}/{exp}/{b64url}")
async def offline_media(
    sig: str, exp: int, b64url: str,
    user: User = Depends(get_current_user),
):
    from app.services.sync import media

    try:
        url = media.verify(sig, exp, b64url, user.id)
    except PermissionError:
        return Response(status_code=403)

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
                    headers={"Cache-Control": _CACHE_CONTROL})

"""Digital Lab + shared analysis routes.

Mount in main.py with:
    from app.routes_digital import router as digital_router
    from app.errors import register_error_handlers
    app.include_router(digital_router)
    register_error_handlers(app)

Physical results become chat-able by calling `store.put(analysis, image_sha256)` after analysis.
"""

from __future__ import annotations

from fastapi import APIRouter, File, UploadFile
from fastapi.concurrency import run_in_threadpool

from .contract import ChatRequest
from .errors import ApiError
from .services.digital_analysis import analyze_digital_image
from .services.grounded_chat import answer_question
from .services.vision_provider import VisionProviderError, get_vision_client
from .store import image_hash, store
from .uploads import MAX_UPLOAD_BYTES, validate_image

router = APIRouter(prefix="/api", tags=["digital"])


def _client():
    try:
        return get_vision_client()
    except VisionProviderError as exc:
        raise ApiError(exc.http_status, exc.code, exc.message) from None


async def _read_limited(upload: UploadFile) -> bytes:
    data = await upload.read(MAX_UPLOAD_BYTES + 1)
    await upload.close()
    return data


@router.post("/digital/analyze")
async def digital_analyze(image: UploadFile = File(...)) -> dict:
    img = validate_image(await _read_limited(image), image.filename)
    sha = image_hash(img.data)
    cached = store.get_by_image("digital", sha)
    if cached is not None:
        return cached.to_api()
    client = _client()
    try:
        analysis = await run_in_threadpool(analyze_digital_image, img.data, img.filename, client, img.mime)
    except VisionProviderError as exc:
        raise ApiError(exc.http_status, exc.code, exc.message) from None
    store.put(analysis, sha)
    return analysis.to_api()


@router.get("/analysis/{analysis_id}")
async def get_analysis(analysis_id: str) -> dict:
    analysis = store.get(analysis_id)
    if analysis is None:
        raise ApiError(404, "analysis_not_found", "Analysis not found (it may have expired after a server restart).")
    return analysis.to_api()


@router.post("/analysis/{analysis_id}/chat")
async def analysis_chat(analysis_id: str, body: ChatRequest) -> dict:
    analysis = store.get(analysis_id)
    if analysis is None:
        raise ApiError(404, "analysis_not_found", "Analysis not found (it may have expired after a server restart).")
    client = _client()
    try:
        resp = await run_in_threadpool(answer_question, analysis, body, client)
    except VisionProviderError as exc:
        raise ApiError(exc.http_status, exc.code, exc.message) from None
    return resp.model_dump()

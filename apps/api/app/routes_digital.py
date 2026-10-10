"""Digital Lab + shared analysis routes.

Mount in main.py with:
    from app.routes_digital import router as digital_router
    from app.errors import register_error_handlers
    app.include_router(digital_router)
    register_error_handlers(app)

Physical results become chat-able by calling `store.put(analysis, image_sha256)` after analysis.
"""

from __future__ import annotations

import asyncio
import os

from fastapi import APIRouter, File, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

from .contract import ChatRequest
from .errors import ApiError
from .samples import load_samples
from .services.digital_analysis import analyze_digital_image
from .services.grounded_chat import answer_question
from .services.vision_provider import VisionProviderError, get_vision_client
from .store import image_hash, store
from .uploads import MAX_UPLOAD_BYTES, ValidatedImage, validate_image

router = APIRouter(prefix="/api", tags=["digital"])

# At most N model calls run at once (free-tier friendly); extra requests wait their turn.
_model_slots = asyncio.Semaphore(max(1, int(os.getenv("VRE_MAX_CONCURRENT_CALLS") or 2)))
# Identical images uploaded while a call is running share that one call.
_inflight: dict[str, asyncio.Task] = {}

SAMPLES = load_samples()
for _s in SAMPLES.values():  # make samples chat-able and let re-uploads of the same image hit the cache
    store.put(_s.analysis, _s.image_sha256, persist=False)


def _client():
    try:
        return get_vision_client()
    except VisionProviderError as exc:
        raise ApiError(exc.http_status, exc.code, exc.message) from None


async def _read_limited(upload: UploadFile) -> bytes:
    data = await upload.read(MAX_UPLOAD_BYTES + 1)
    await upload.close()
    return data


async def _call_model(fn, *args):
    async with _model_slots:
        try:
            return await run_in_threadpool(fn, *args)
        except VisionProviderError as exc:
            raise ApiError(exc.http_status, exc.code, exc.message) from None


async def _analyze_once(sha: str, img: ValidatedImage):
    task = _inflight.get(sha)
    if task is None:
        client = _client()

        async def run():
            analysis = await _call_model(analyze_digital_image, img.data, img.filename, client, img.mime)
            store.put(analysis, sha)
            return analysis

        task = asyncio.ensure_future(run())
        _inflight[sha] = task
        task.add_done_callback(lambda _t: _inflight.pop(sha, None))
    return await asyncio.shield(task)  # a client disconnecting does not cancel the shared call


@router.post("/digital/analyze")
async def digital_analyze(image: UploadFile = File(...)) -> dict:
    img = validate_image(await _read_limited(image), image.filename)
    sha = image_hash(img.data)
    cached = store.get_by_image("digital", sha)
    if cached is None:
        cached = await _analyze_once(sha, img)
    return cached.to_api()


@router.get("/digital/samples")
async def digital_samples() -> list[dict]:
    return [s.summary() for s in SAMPLES.values()]


@router.get("/digital/samples/{sample_id}")
async def digital_sample(sample_id: str) -> dict:
    sample = SAMPLES.get(sample_id)
    if sample is None:
        raise ApiError(404, "sample_not_found", "No digital sample with that id.")
    return sample.to_api()


@router.get("/digital/samples/{sample_id}/image")
async def digital_sample_image(sample_id: str):
    sample = SAMPLES.get(sample_id)
    if sample is None:
        raise ApiError(404, "sample_not_found", "No digital sample with that id.")
    return FileResponse(sample.image_path, media_type=sample.mime)


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
    resp = await _call_model(answer_question, analysis, body, client)
    return resp.model_dump()

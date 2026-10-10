"""Visual Reverse Engineering API: Physical Lab (Samvit) + Digital Lab and chat (Krishna).

Run from apps/api:  uvicorn app.main:app --reload --port 8000
Contract and endpoints: docs/API_CONTRACT.md. All errors: {"error": {"code", "message"}}.
"""
from __future__ import annotations

import hashlib
import json
import os
from collections import OrderedDict
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from starlette.exceptions import HTTPException as StarletteHTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

API_DIR = Path(__file__).resolve().parents[1]


def _load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env(API_DIR / ".env")

from .schemas import SystemAnalysis, WhatIfRequest  # noqa: E402
from .services.component_graph import what_if  # noqa: E402
from .services.physical_analysis import MAX_VIEWS, PIPELINE_VERSION, PROMPT, AnalysisError, analyze_physical_images  # noqa: E402
from .services.vision_client import ProviderError  # noqa: E402
from .contract import SystemAnalysis as ContractAnalysis  # noqa: E402
from .errors import register_error_handlers  # noqa: E402
from .routes_digital import SAMPLES as DIGITAL_SAMPLES  # noqa: E402
from .routes_digital import router as digital_router  # noqa: E402
from .services.vision_provider import make_shared_client, provider_status, set_shared_client  # noqa: E402
from .store import store as shared_store  # noqa: E402

MAX_BYTES = 8 * 1024 * 1024
from .services.assembly import PROMPT as ASSEMBLY_PROMPT  # noqa: E402
# saved results are keyed on every prompt + the pipeline version, so changing either rebuilds them
PROMPT_VERSION = hashlib.sha256((PROMPT + ASSEMBLY_PROMPT).encode()).hexdigest()[:8] + PIPELINE_VERSION
ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp"}
CACHE_DIR = API_DIR / ".cache"
SAMPLES_DIR = API_DIR / "samples"
VIEWER_DIR = API_DIR.parent / "viewer"

app = FastAPI(title="Visual Reverse Engineering API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",")],
    allow_methods=["*"], allow_headers=["*"],
)

@app.middleware("http")
async def _no_stale_viewer(request, call_next):
    """Browsers must revalidate the viewer files, so a code update is never hidden by the cache."""
    resp = await call_next(request)
    if request.url.path in ("/", "/digital") or request.url.path.startswith("/viewer/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


def _make_vision():
    """VISION_PROVIDER: auto (Gemini, then local LM Studio when Gemini is out of quota), gemini, or lmstudio."""
    return make_shared_client()


vision = _make_vision()
set_shared_client(vision)  # Digital Lab and chat use the same client (one quota tracker)
_store: "OrderedDict[str, SystemAnalysis]" = OrderedDict()  # recent analyses for what-if


def _remember(a: SystemAnalysis) -> None:
    _store[a.analysis_id] = a
    _store.move_to_end(a.analysis_id)
    while len(_store) > 50:
        _store.popitem(last=False)
    try:  # also make it available to /api/analysis/{id} and chat (shared store, memory only)
        shared_store.put(ContractAnalysis.model_validate(a.dump()), persist=False)
    except ValueError:
        pass  # chat is optional for physical; never fail the analysis over it


_PROVIDER_CODES = {429: "provider_rate_limited", 503: "provider_unavailable", 504: "provider_timeout"}
_HTTP_CODES = {400: "bad_request", 404: "not_found", 405: "method_not_allowed", 413: "file_too_large",
               415: "unsupported_media_type", 422: "invalid_request"}


def _err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


@app.exception_handler(ProviderError)
async def _provider_error(_, exc: ProviderError):
    return _err(exc.status, _PROVIDER_CODES.get(exc.status, "provider_error"), str(exc))


@app.exception_handler(AnalysisError)
async def _analysis_error(_, exc: AnalysisError):
    return _err(exc.status, getattr(exc, "code", "analysis_failed"), str(exc))


@app.exception_handler(StarletteHTTPException)
async def _http_error(_, exc: StarletteHTTPException):
    msg = exc.detail if isinstance(exc.detail, str) else "Request failed."
    return _err(exc.status_code, _HTTP_CODES.get(exc.status_code, f"http_{exc.status_code}"), msg)


register_error_handlers(app)  # ApiError + request validation -> same {"error": {code, message}} shape
app.include_router(digital_router)  # /api/digital/*, /api/analysis/{id}, /api/analysis/{id}/chat
from .routes_explorer import router as explorer_router  # noqa: E402
app.include_router(explorer_router)  # /api/digital/{whatif,workflow,diff,reconstruct}, /{id}/tree


@app.get("/api/health")
def health():
    return {"status": "ok", "pipeline": PIPELINE_VERSION,
            "labs": ["physical", "digital"],
            "provider": {"name": vision.name, "model": vision.model},
            "providers": [{"name": p.name, "model": p.model} for p in getattr(vision, "providers", [vision])],
            "geminiKeyConfigured": provider_status()["geminiKeyConfigured"],
            "fixtureMode": provider_status()["fixtureMode"],
            "digitalSamples": len(DIGITAL_SAMPLES)}


@app.get("/api/assets")
def assets():
    return {"assets": [], "note": "Physical Lab builds a layered scene from each photo; no fixed 3D assets are required."}


@app.post("/api/physical/analyze")
async def physical_analyze(request: Request):
    """One to four photos of the same object (form field ``images``; ``image`` still works for one)."""
    try:
        form = await request.form()
    except Exception:
        raise HTTPException(400, "Send the photos as multipart form data.")
    uploads = [u for u in form.getlist("images") + form.getlist("image") if hasattr(u, "read")]
    if not uploads:
        raise HTTPException(400, "Upload at least one photo.")
    if len(uploads) > MAX_VIEWS:
        raise HTTPException(400, f"Upload at most {MAX_VIEWS} photos of the same object.")
    files = []
    for u in uploads:
        if (u.content_type or "").split(";")[0] not in ALLOWED_MIME:
            raise HTTPException(415, "Upload JPEG, PNG or WebP images.")
        data = await u.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise HTTPException(413, "Each image must be 8 MB or smaller.")
        if not data:
            raise HTTPException(400, "Empty file.")
        files.append((data, u.filename or f"photo{len(files) + 1}"))

    hint = str(form.get("model_hint") or "").strip()[:100]  # user-confirmed exact model (optional)
    key = hashlib.sha256(b"".join(hashlib.sha256(d).digest() for d, _ in files) + vision.model.encode()
                         + PROMPT_VERSION.encode() + hint.lower().encode()).hexdigest()
    cached = CACHE_DIR / f"{key}.json"
    cached_hit = cached.exists()
    if cached_hit:  # free-tier friendly: same photos never cost a second model call
        analysis = SystemAnalysis.model_validate(json.loads(cached.read_text(encoding="utf-8")))
    else:
        # run the blocking model calls off the event loop so the server stays responsive
        analysis = await run_in_threadpool(analyze_physical_images, files, vision, CACHE_DIR, hint)
        if analysis.scene and analysis.scene.assembly:  # never save a result whose 3D step failed
            CACHE_DIR.mkdir(exist_ok=True)
            cached.write_text(json.dumps(analysis.dump()), encoding="utf-8")
    _remember(analysis)
    from .services import physical_analysis as pa
    timing = ", ".join(f"{k};dur={v * 1000:.0f}" for k, v in pa.LAST_TIMING.items()) if not cached_hit else "cache;dur=0"
    return JSONResponse(analysis.dump(), headers={"Server-Timing": timing})


@app.post("/api/physical/identify")
async def physical_identify(request: Request):
    """Exact-model lookup only (Gemini + Google Search). Form: ``images`` (1-4), optional ``model_hint``."""
    from .services import identify as idm
    from .services import image_ops as ops
    form = await request.form()
    uploads = [u for u in form.getlist("images") if hasattr(u, "read")][:MAX_VIEWS]
    if not uploads:
        raise HTTPException(400, "Upload at least one photo.")
    jpegs = []
    for u in uploads:
        data = await u.read(MAX_BYTES + 1)
        try:
            jpegs.append(ops.encode_jpeg(ops.fit(ops.decode_image(data), 768)))
        except ValueError:
            raise HTTPException(400, "One of the files is not a readable image.")
    hint = str(form.get("model_hint") or "").strip()[:100]
    out = await run_in_threadpool(idm.identify_product, jpegs, vision, CACHE_DIR, hint)
    if out is None:
        raise HTTPException(503, "Web identification unavailable: " + idm.LAST_ERROR["text"][:300])
    return out


@app.get("/api/physical/samples")
def list_samples():
    items = []
    for f in sorted(SAMPLES_DIR.glob("*.json")):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            items.append({"id": f.stem, "title": d.get("title", f.stem)})
        except (OSError, json.JSONDecodeError):
            continue
    return {"samples": items, "note": "Samples are saved results of earlier real analyses (sample mode)."}


@app.get("/api/physical/samples/{sample_id}")
def get_sample(sample_id: str):
    f = SAMPLES_DIR / f"{sample_id}.json"
    if not sample_id.replace("-", "").replace("_", "").isalnum() or not f.exists():
        raise HTTPException(404, "Sample not found.")
    analysis = SystemAnalysis.model_validate(json.loads(f.read_text(encoding="utf-8")))
    _remember(analysis)
    return analysis.dump()


@app.get("/api/physical/teardown")
async def physical_teardown(q: str):
    """Teardown reference photos for an identified product (iFixit public API, CC BY-NC-SA, with credit)."""
    from .services.teardown import find_teardowns
    return await run_in_threadpool(find_teardowns, q, CACHE_DIR)


@app.get("/api/physical/teardown/image")
async def physical_teardown_image(u: str):
    """Small allow-listed proxy so the browser can add an iFixit photo as an extra view (no CORS issues)."""
    from fastapi.responses import Response
    from .services.teardown import fetch_image
    try:
        data, ctype = await run_in_threadpool(fetch_image, u)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception:
        raise HTTPException(502, "Could not download that iFixit photo.")
    return Response(data, media_type=ctype, headers={"Cache-Control": "max-age=86400"})


@app.post("/api/physical/whatif")
def physical_whatif(req: WhatIfRequest):
    analysis = _store.get(req.analysis_id)
    if analysis is not None:
        comps, rels = analysis.components, analysis.relationships
    elif req.components is not None:
        comps, rels = req.components, req.relationships or []
    else:
        raise HTTPException(404, "Analysis not found (server restarted?). Re-run the analysis.")
    try:
        return what_if(comps, rels, req.removed_component_id)
    except KeyError:
        raise HTTPException(404, "Component not found in this analysis.")


if VIEWER_DIR.exists():
    app.mount("/viewer", StaticFiles(directory=VIEWER_DIR), name="viewer")

    @app.get("/")
    def index():
        return FileResponse(VIEWER_DIR / "index.html")

    @app.get("/digital")
    def digital_index():
        return FileResponse(VIEWER_DIR / "digital.html")

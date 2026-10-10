"""FastAPI app for the Physical Lab prototype.

Krishna owns the final API; these routes follow API_CONTRACT.md so they can be
merged into his app (or his app can call ``analyze_physical_image`` directly).
"""
from __future__ import annotations

import hashlib
import json
import os
from collections import OrderedDict
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

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
from .services.physical_analysis import AnalysisError, analyze_physical_image  # noqa: E402
from .services.vision_client import GeminiVisionClient, ProviderError  # noqa: E402

MAX_BYTES = 8 * 1024 * 1024
ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp"}
CACHE_DIR = API_DIR / ".cache"
SAMPLES_DIR = API_DIR / "samples"
VIEWER_DIR = API_DIR.parent / "viewer"

app = FastAPI(title="Visual Reverse Engineering — Physical Lab", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",")],
    allow_methods=["*"], allow_headers=["*"],
)

vision = GeminiVisionClient()
_store: "OrderedDict[str, SystemAnalysis]" = OrderedDict()  # recent analyses for what-if


def _remember(a: SystemAnalysis) -> None:
    _store[a.analysis_id] = a
    _store.move_to_end(a.analysis_id)
    while len(_store) > 50:
        _store.popitem(last=False)


@app.exception_handler(ProviderError)
async def _provider_error(_, exc: ProviderError):
    return JSONResponse({"error": str(exc)}, status_code=exc.status)


@app.exception_handler(AnalysisError)
async def _analysis_error(_, exc: AnalysisError):
    return JSONResponse({"error": str(exc)}, status_code=exc.status)


@app.get("/api/health")
def health():
    return {"status": "ok", "provider": {"name": vision.name, "model": vision.model, "ready": getattr(vision, "ready", True)}}


@app.get("/api/assets")
def assets():
    return {"assets": [], "note": "Physical Lab builds a layered scene from each photo; no fixed 3D assets are required."}


@app.post("/api/physical/analyze")
async def physical_analyze(image: UploadFile = File(...)):
    if image.content_type not in ALLOWED_MIME:
        raise HTTPException(415, "Upload a JPEG, PNG or WebP image.")
    data = await image.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "Image is larger than 8 MB.")
    if not data:
        raise HTTPException(400, "Empty file.")

    key = hashlib.sha256(data + vision.model.encode()).hexdigest()
    cached = CACHE_DIR / f"{key}.json"
    if cached.exists():  # free-tier friendly: same photo never costs a second model call
        analysis = SystemAnalysis.model_validate(json.loads(cached.read_text(encoding="utf-8")))
    else:
        # run the blocking model call off the event loop so the server stays responsive
        from starlette.concurrency import run_in_threadpool
        analysis = await run_in_threadpool(analyze_physical_image, data, image.filename or "upload", vision)
        CACHE_DIR.mkdir(exist_ok=True)
        cached.write_text(json.dumps(analysis.dump()), encoding="utf-8")
    _remember(analysis)
    return analysis.dump()


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


@app.post("/api/physical/whatif")
def physical_whatif(req: WhatIfRequest):
    analysis = _store.get(req.analysis_id)
    if analysis is None:
        raise HTTPException(404, "Analysis not found (server restarted?). Re-run the analysis.")
    try:
        return what_if(analysis.components, analysis.relationships, req.removed_component_id)
    except KeyError:
        raise HTTPException(404, "Component not found in this analysis.")


if VIEWER_DIR.exists():
    app.mount("/viewer", StaticFiles(directory=VIEWER_DIR), name="viewer")

    @app.get("/")
    def index():
        return FileResponse(VIEWER_DIR / "index.html")

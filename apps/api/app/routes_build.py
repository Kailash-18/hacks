"""Digital Lab "Build" routes: screenshot -> working code, and screenshot -> how to build it.

Both take multipart `image` (the screenshot; analysed first if new, served from cache otherwise) or
`analysisId` of a saved sample. Same model-call limits as the rest of the Digital Lab.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from . import routes_digital as rd
from .routes_explorer import _flag, _resolve
from .errors import ApiError
from .services import codegen

router = APIRouter(prefix="/api/digital", tags=["digital-build"])


def _client_or_none():
    try:
        return rd._client()
    except Exception:
        return None  # codegen falls back to the layout draft and says so


@router.post("/code")
async def code(request: Request) -> dict:
    """multipart: image | analysisId; target=html|react; change (request text); baseCode (version to change); force."""
    form = await request.form()
    analysis, img = await _resolve(form, "image", "analysisId")
    try:
        out = await _run_code(form, analysis, img)
    except ApiError:
        raise
    except Exception as exc:  # say what broke instead of a bare 500
        raise ApiError(500, "build_failed", f"Code generation failed: {type(exc).__name__}: {exc}"[:300]) from exc
    return {"analysisId": analysis.analysisId, **out}


async def _run_code(form, analysis, img) -> dict:
    return await rd._call_model(
        codegen.generate_code, analysis, img[0] if img else None, img[1] if img else None, _client_or_none(),
        str(form.get("target") or "html"), str(form.get("change") or ""), str(form.get("baseCode") or ""),
        _flag(form, "force", False))


@router.post("/app")
async def app_build(request: Request) -> dict:
    """multipart: set (id of a saved screen set); force. All screens of the set -> one working HTML app."""
    form = await request.form()
    set_id = str(form.get("set") or "")
    screens = sorted((x for x in rd.SAMPLES.values() if x.sample_set == set_id and not x.compare_with),
                     key=lambda x: (x.order if x.order is not None else 99, x.id))
    if len(screens) < 2:
        raise ApiError(404, "set_not_found", "No saved screen set with that id (it needs at least two screens).")
    data = [(x.analysis, x.image_path.read_bytes(), x.mime) for x in screens[:6]]
    try:
        out = await rd._call_model(codegen.generate_app, data, _client_or_none(), _flag(form, "force", False))
    except ApiError:
        raise
    except Exception as exc:
        raise ApiError(500, "build_failed", f"Whole-site build failed: {type(exc).__name__}: {exc}"[:300]) from exc
    return {"analysisId": data[0][0].analysisId, **out}


@router.post("/refine")
async def refine(request: Request) -> dict:
    """multipart: image | analysisId; render (PNG of how baseCode renders); baseCode; score; regions; force."""
    form = await request.form()
    analysis, img = await _resolve(form, "image", "analysisId")
    up = form.get("render")
    if not img or up is None or not hasattr(up, "read"):
        raise ApiError(400, "missing_input", "Refining needs the screenshot and a render of the current code.")
    render = await up.read()
    dup = form.get("diff")
    diff = await dup.read() if dup is not None and hasattr(dup, "read") else None
    closeups = [await c.read() for c in form.getlist("closeup")[:3] if hasattr(c, "read")]
    if len(render) > 12_000_000:
        raise ApiError(413, "too_large", "The render is too large.")
    out = await rd._call_model(codegen.generate_refine, analysis, img[0], img[1], render, str(form.get("baseCode") or ""),
                               _client_or_none(), str(form.get("score") or ""), str(form.get("regions") or ""), _flag(form, "force", False),
                               diff, str(form.get("colors") or ""), closeups, str(form.get("closeupWhere") or ""),
                               str(form.get("fontMatch") or ""))
    return {"analysisId": analysis.analysisId, **out}


@router.post("/guide")
async def guide(request: Request) -> dict:
    """multipart: image | analysisId; force."""
    form = await request.form()
    analysis, img = await _resolve(form, "image", "analysisId")
    out = await rd._call_model(codegen.generate_guide, analysis, img[0] if img else None, img[1] if img else None,
                               _client_or_none(), _flag(form, "force", False))
    return {"analysisId": analysis.analysisId, **out}


@router.post("/backend")
async def backend(request: Request) -> dict:
    """multipart: image | analysisId; force. Reverse-engineered data model + API (inferred design)."""
    from .services import digital_extras
    form = await request.form()
    analysis, img = await _resolve(form, "image", "analysisId")
    out = await rd._call_model(digital_extras.generate_backend, analysis, img[0] if img else None,
                               img[1] if img else None, _client_or_none(), _flag(form, "force", False))
    return {"analysisId": analysis.analysisId, **out}


@router.post("/a11y")
async def a11y(request: Request) -> dict:
    """multipart: image | analysisId. Accessibility audit measured from pixels + boxes (no model call)."""
    from fastapi.concurrency import run_in_threadpool
    from .services import digital_extras
    form = await request.form()
    analysis, img = await _resolve(form, "image", "analysisId")
    if not img:
        raise ApiError(400, "missing_input", "The accessibility audit needs the screenshot itself.")
    out = await run_in_threadpool(digital_extras.audit_accessibility, analysis, img[0])
    return {"analysisId": analysis.analysisId, **out}

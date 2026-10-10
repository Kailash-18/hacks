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

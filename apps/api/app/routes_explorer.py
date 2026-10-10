"""Digital explorer routes: tree, what-if, workflow, diff, reconstruction, repository mapping.

Built on routes_digital (same model-call limits, cache and in-flight sharing). Mounted in main.py.
Images can be uploaded, or referenced by `analysisId` when they are saved samples.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import routes_digital as rd
from .contract import SystemAnalysis
from .errors import ApiError
from .services import digital_explorer as dx
from .store import image_hash, store
from .uploads import validate_image

router = APIRouter(prefix="/api/digital", tags=["digital-explorer"])
_cache: dict[str, dict] = {}  # workflow/diff results by input ids, so repeat clicks cost no model call


def _get(analysis_id: str) -> SystemAnalysis:
    a = store.get(analysis_id)
    if a is None:
        raise ApiError(404, "analysis_not_found", "Analysis not found (it may have expired after a server restart).")
    return a


def _sample_image(analysis_id: str) -> tuple[bytes, str] | None:
    for s in rd.SAMPLES.values():
        if s.analysis.analysisId == analysis_id:
            return s.image_path.read_bytes(), s.mime
    return None


async def _resolve(form, file_key: str, id_key: str) -> tuple[SystemAnalysis, Optional[tuple[bytes, str]]]:
    """An uploaded screenshot (analysed or served from cache) or an existing analysisId."""
    up = form.get(file_key)
    if up is not None and hasattr(up, "read"):
        data = await up.read(rd.MAX_UPLOAD_BYTES + 1)
        img = validate_image(data, getattr(up, "filename", None))
        sha = image_hash(img.data)
        a = store.get_by_image("digital", sha) or await rd._analyze_once(sha, img)
        return a, (img.data, img.mime)
    aid = str(form.get(id_key) or "").strip()
    if not aid:
        raise ApiError(400, "missing_input", f"Send an image as '{file_key}' or an analysis id as '{id_key}'.")
    return _get(aid), _sample_image(aid)


def _flag(form, key: str, default: bool = True) -> bool:
    v = form.get(key)
    return default if v is None else str(v).lower() not in {"0", "false", "no", "off"}


@router.get("/{analysis_id}/tree")
async def tree(analysis_id: str) -> dict:
    a = _get(analysis_id)
    return {"analysisId": a.analysisId, "tree": dx.build_tree(a), "repeated": dx.find_repeated(a)}


class WhatIfBody(BaseModel):
    analysisId: str = Field(min_length=1)
    componentId: str = Field(min_length=1)


@router.post("/whatif")
async def whatif(body: WhatIfBody) -> dict:
    a = _get(body.analysisId)
    try:
        return dx.digital_impact(a, body.componentId)
    except KeyError:
        raise ApiError(404, "component_not_found", "Component not found in this analysis.") from None


class WorkflowBody(BaseModel):
    analysisIds: list[str] = Field(min_length=2, max_length=8)
    useModel: bool = True


@router.post("/workflow")
async def workflow(body: WorkflowBody) -> dict:
    ids = list(dict.fromkeys(body.analysisIds))
    if len(ids) < 2:
        raise ApiError(400, "need_two_screens", "A workflow needs at least two different screens.")
    analyses = [_get(i) for i in ids]
    if any(a.domain != "digital" or a.analysisId.startswith(("workflow-", "diff-")) for a in analyses):
        raise ApiError(400, "not_a_screen", "Workflows are built from screenshot analyses only.")
    key = "wf:" + "|".join(ids) + f":{body.useModel}"
    if key in _cache and store.get(_cache[key]["analysisId"]):
        return _cache[key]
    client = rd._client() if body.useModel else None
    wf, _notes = await rd._call_model(dx.build_workflow, analyses, client)
    store.put(wf, persist=False)  # chat-able: "how does a user get to Settings?"
    out = wf.to_api()
    out["screens"] = [{"screenId": c["id"], "analysisId": c.get("analysisId"), "title": c["label"],
                       "isEntry": c.get("isEntry", False)} for c in out["components"]]
    _cache[key] = out
    return out


@router.post("/diff")
async def diff(request: Request) -> dict:
    """multipart: before + after (images) or beforeId + afterId; optional useModel=false."""
    form = await request.form()
    before, img_b = await _resolve(form, "before", "beforeId")
    after, img_a = await _resolve(form, "after", "afterId")
    if before.analysisId == after.analysisId:
        raise ApiError(400, "same_image", "Both versions are the same image; upload two different screenshots.")
    use_model = _flag(form, "useModel") and bool(img_b and img_a)
    key = f"diff:{before.analysisId}|{after.analysisId}:{use_model}"
    if key in _cache and store.get(_cache[key]["diff"]["diffId"]):
        return _cache[key]
    client = rd._client() if use_model else None
    images = (img_b, img_a) if img_b and img_a else None
    result, diff_analysis = await rd._call_model(dx.diff_analyses, before, after, client, images)
    store.put(diff_analysis, persist=False)  # chat-able: "what changed in the header?"
    out = {"diff": result, "before": before.to_api(), "after": after.to_api()}
    if not any("unavailable" in l for l in result["limitations"]):  # retry later if the model was out of quota
        _cache[key] = out
    return out


@router.post("/reconstruct")
async def reconstruct(request: Request) -> dict:
    """multipart: image or analysisId -> design tokens, starter prototype (HTML/CSS/React) and docs."""
    form = await request.form()
    analysis, img = await _resolve(form, "image", "analysisId")
    return await run_in_threadpool(dx.reconstruct, analysis, img[0] if img else None)


@router.post("/repo")
async def repo(request: Request) -> dict:
    """multipart: analysisId + (repo = .zip upload | repoUrl = public GitHub URL) -> UI component <-> source file map."""
    from .services import repo_map as rm

    form = await request.form()
    analysis = _get(str(form.get("analysisId") or ""))
    up, url = form.get("repo"), str(form.get("repoUrl") or "").strip()
    try:
        if up is not None and hasattr(up, "read"):
            data = await up.read(rm.MAX_ZIP_BYTES + 1)
            name = (getattr(up, "filename", None) or "repository.zip").rsplit(".", 1)[0][:80]
        elif url:
            data, name = await run_in_threadpool(rm.download_github_zip, url)
        else:
            raise ApiError(400, "missing_input", "Upload the repository as a .zip ('repo') or give a public GitHub URL ('repoUrl').")
        files = await run_in_threadpool(rm.read_zip, data)
        result, repo_analysis = await run_in_threadpool(rm.map_repository, analysis, files, name)
    except rm.RepoError as exc:
        raise ApiError(exc.status, exc.code, exc.message) from None
    store.put(repo_analysis, persist=False)  # chat-able: "which file renders the Sign in button?"
    return result

"""Physical Lab: photo of ANY object -> parts, masks, relationships, layered 2.5D scene.

Pipeline
1. Resize photo, send to the vision model once with a constrained JSON prompt
   (parts + segmentation masks + depth order + hidden-part guesses + relationships).
2. Treat the output as untrusted: validate ids, types, boxes, masks, references.
3. OpenCV: decode/clean masks (GrabCut fallback), resolve overlaps front-to-back,
   cut each part out as an RGBA layer, inpaint the object body behind the parts.
4. Return the shared SystemAnalysis envelope plus an additive ``scene`` block.

3D relief (depth) is estimated in the browser (Depth Anything, transformers.js)
so the backend stays light enough for free hosting.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import time

import numpy as np

from ..schemas import (BBox, Component, Provider, Relationship, Scene, SceneLayer, Source,
                       SystemAnalysis)
from . import image_ops as ops
from .component_graph import ALLOWED_TYPES, validate_relationships
from .vision_client import VisionClient

log = logging.getLogger("uvicorn.error")
MAX_PARTS = 10
MAX_HIDDEN = 6
PART_TYPES = {
    "power_source", "actuator", "controller", "sensor", "structure", "fastener", "connector",
    "mechanism", "interface", "display", "cover", "wheel", "light", "storage", "cable", "unknown",
}

PROMPT = f"""You are a reverse-engineering assistant. Analyze the photo of a physical object and
break it into the parts a person could separate in an exploded-view diagram.

Return ONLY one JSON object, no prose, with this shape:
{{
  "object_name": "short name of the object",
  "summary": "1-2 sentences on what the object is and how it works",
  "object": {{"box_2d": [ymin, xmin, ymax, xmax], "mask": "segmentation mask of the WHOLE object"}},
  "parts": [
    {{"id": "snake_case_id", "label": "Part name", "type": "<part type>",
      "box_2d": [ymin, xmin, ymax, xmax], "mask": "segmentation mask of this part",
      "depth_rank": 0, "evidence": "what in the photo shows this part", "role": "what it does"}}
  ],
  "hidden_parts": [
    {{"id": "snake_case_id", "label": "Part name", "type": "<part type>",
      "reason": "why it is probably inside even though it is not visible"}}
  ],
  "relationships": [
    {{"from": "part_id", "to": "part_id", "type": "<relationship type>", "visible": true,
      "evidence": "short justification"}}
  ]
}}

Rules:
- box_2d uses [ymin, xmin, ymax, xmax] normalized to 0-1000.
- Each mask is a base64-encoded PNG probability map covering exactly its box_2d (the standard
  segmentation output format). Values above 127 belong to the part.
- "parts": at most {MAX_PARTS} VISIBLE, physically distinct parts (covers, panels, wheels, buttons,
  handles, lenses, screws as a group, cables...). Never include the whole object as a part.
  Skip parts smaller than about 2% of the image.
- depth_rank: 0 = closest to the camera; larger = further back. Parts can share a rank.
- "hidden_parts": at most {MAX_HIDDEN} parts that are typically inside this kind of object but are
  NOT visible. Never list a visible part here. Use [] if unsure.
- part type must be one of: {", ".join(sorted(PART_TYPES))}.
- relationship type must be one of: {", ".join(sorted(ALLOWED_TYPES))}.
  Direction: "from" -> "to" means "to" depends on "from" (battery powers motor; frame supports wheel).
  "visible": true only if the connection itself can be seen in the photo.
- Relationships may reference visible or hidden part ids. Only use ids you defined.
- Be honest: do not invent parts you cannot see; put guesses in hidden_parts.
"""

LIMITATIONS = [
    "Parts and relationships are AI-extracted from one photo; verify before relying on them.",
    "The 3D view is a layered 2.5D exploded diagram built from the photo, not a reconstructed CAD model.",
    "Depth relief is estimated per pixel from a single image and can be wrong.",
    "Hidden parts are inferred from typical designs of this kind of object, not observed.",
    "Explode directions are illustrative; they do not show the real assembly order.",
]


class AnalysisError(Exception):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


def _slug(text: str, fallback: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", str(text or "").lower()).strip("_")[:40]
    return s or fallback


def _str(v, limit: int = 300) -> str:
    return str(v).strip()[:limit] if isinstance(v, (str, int, float)) else ""


def parse_model_json(text: str) -> dict:
    """Tolerant parse: strips code fences; accepts a bare list of parts."""
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t)
    try:
        data = json.loads(t)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", t, re.S)
        if not m:
            raise AnalysisError("The vision model returned malformed output. Please retry.", 502)
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError as exc:
            raise AnalysisError("The vision model returned malformed output. Please retry.", 502) from exc
    if isinstance(data, list):
        data = {"parts": data}
    if not isinstance(data, dict):
        raise AnalysisError("The vision model returned an unexpected structure.", 502)
    return data


def _list(v) -> list:
    return v if isinstance(v, list) else []


def build_analysis(raw: dict, img: np.ndarray, filename: str, provider: Provider, image_hash: str) -> SystemAnalysis:
    h, w = img.shape[:2]
    notes: list[str] = []
    used_ids: set[str] = set()

    def unique(base: str) -> str:
        i, cand = 2, base
        while cand in used_ids:
            cand, i = f"{base}_{i}", i + 1
        used_ids.add(cand)
        return cand

    id_map: dict[str, str] = {}  # model id -> our id

    # ---- visible parts -> masks -------------------------------------------
    candidates = []
    for idx, p in enumerate(_list(raw.get("parts"))[: MAX_PARTS * 2]):
        if not isinstance(p, dict):
            continue
        box = ops.box_to_pixels(p.get("box_2d"), w, h)
        if box is None:
            notes.append(f"Skipped a part with an invalid box ({_str(p.get('label'), 40) or idx}).")
            continue
        mask = ops.decode_gemini_mask(p.get("mask"), box, w, h)
        refined_by = "model mask"
        if mask is None or mask.sum() == 0:
            mask = ops.grabcut_mask(img, box)
            refined_by = "GrabCut (model gave no usable mask)"
        mask = ops.clean_mask(mask)
        try:
            rank = int(p.get("depth_rank", 5))
        except (TypeError, ValueError):
            rank = 5
        candidates.append((max(0, min(rank, 50)), idx, p, mask, refined_by))

    candidates.sort(key=lambda c: (c[0], c[1]))
    taken = np.zeros((h, w), np.uint8)
    components: list[Component] = []
    layers: list[SceneLayer] = []
    min_area = 0.002 * h * w
    for rank, idx, p, mask, refined_by in candidates:
        if len(layers) >= MAX_PARTS:
            break
        mask = np.where(taken > 0, 0, mask).astype(np.uint8)  # front-most part owns overlaps
        mask = ops.clean_mask(mask, fill_holes=False)  # keep the holes where front parts sit
        if mask.sum() / 255 < min_area:
            continue
        box = ops.bbox_of(mask)
        if box is None:
            continue
        taken = np.maximum(taken, mask)
        label = _str(p.get("label"), 60) or f"Part {idx + 1}"
        cid = unique(_slug(p.get("id") or label, f"part_{idx + 1}"))
        id_map[_str(p.get("id"), 60) or cid] = cid
        id_map.setdefault(_slug(label, cid), cid)
        ptype = _str(p.get("type"), 30).lower()
        evidence = [e for e in (_str(p.get("evidence")),) if e]
        role = _str(p.get("role"))
        if role:
            evidence.append(f"Likely role (model inference): {role}")
        evidence.append(f"Segmentation: {refined_by}, cleaned with OpenCV")
        x0, y0, x1, y1 = box
        bbox = BBox(x=x0 / w, y=y0 / h, width=(x1 - x0) / w, height=(y1 - y0) / h)
        components.append(Component(
            id=cid, label=label, type=ptype if ptype in PART_TYPES else "unknown",
            status="observed", confidence=None, evidence=evidence, bbox=bbox,
        ))
        layers.append(SceneLayer(componentId=cid, bbox=bbox, cutout=ops.to_data_url(ops.cutout(img, mask, box)),
                                 depthRank=rank))

    if not components:
        raise AnalysisError("No separable parts were found. Try a closer, well-lit photo of one object on a plain background.")

    # ---- hidden (inferred) parts ------------------------------------------
    ghost_ids = []
    for idx, p in enumerate(_list(raw.get("hidden_parts"))[:MAX_HIDDEN]):
        if not isinstance(p, dict):
            continue
        label = _str(p.get("label"), 60)
        if not label:
            continue
        cid = unique(_slug(p.get("id") or label, f"hidden_{idx + 1}"))
        id_map[_str(p.get("id"), 60) or cid] = cid
        id_map.setdefault(_slug(label, cid), cid)
        ptype = _str(p.get("type"), 30).lower()
        reason = _str(p.get("reason"))
        components.append(Component(
            id=cid, label=label, type=ptype if ptype in PART_TYPES else "unknown", status="inferred",
            confidence=None, evidence=[f"Not visible in the photo. {reason}".strip()],
        ))
        ghost_ids.append(cid)

    # ---- relationships -----------------------------------------------------
    rels: list[Relationship] = []
    for r in _list(raw.get("relationships"))[:60]:
        if not isinstance(r, dict):
            continue
        a = id_map.get(_str(r.get("from"), 60)) or id_map.get(_slug(r.get("from"), ""))
        b = id_map.get(_str(r.get("to"), 60)) or id_map.get(_slug(r.get("to"), ""))
        if not a or not b:
            notes.append("Dropped a relationship that referenced an unknown part.")
            continue
        rtype = _str(r.get("type"), 30).lower()
        if rtype not in ALLOWED_TYPES:
            rtype = "connected_to"
        visible = r.get("visible") is True and a not in ghost_ids and b not in ghost_ids
        ev = _str(r.get("evidence"))
        rels.append(Relationship(**{
            "id": f"{a}--{rtype}--{b}", "from": a, "to": b, "type": rtype,
            "status": "observed" if visible else "inferred", "confidence": None,
            "evidence": [ev] if ev else ["Model inference; no direct visual evidence given."],
        }))
    rels, warnings = validate_relationships(components, rels)
    notes.extend(warnings)

    # ---- object plate (body behind the parts, holes inpainted) ------------
    obj = raw.get("object") if isinstance(raw.get("object"), dict) else {}
    obj_box = ops.box_to_pixels(obj.get("box_2d"), w, h)
    obj_mask = ops.decode_gemini_mask(obj.get("mask"), obj_box, w, h) if obj_box else None
    if obj_mask is None or obj_mask.sum() == 0:
        import cv2
        pts = np.column_stack(np.nonzero(taken)[::-1]).astype(np.int32)
        obj_mask = np.zeros((h, w), np.uint8)
        if len(pts):
            cv2.fillConvexPoly(obj_mask, cv2.convexHull(pts), 255)
        notes.append("Object outline estimated from the parts (model gave no object mask).")
    obj_mask = np.maximum(ops.clean_mask(obj_mask), taken)
    plate_box = ops.bbox_of(obj_mask)
    plate = plate_bbox = None
    if plate_box:
        x0, y0, x1, y1 = plate_box
        plate = ops.to_data_url(ops.inpainted_plate(img, obj_mask, taken)[y0:y1, x0:x1])
        plate_bbox = BBox(x=x0 / w, y=y0 / h, width=(x1 - x0) / w, height=(y1 - y0) / h)

    title = _str(raw.get("object_name"), 80) or "Photographed object"
    return SystemAnalysis(
        analysisId=f"physical-{image_hash[:12]}",
        domain="physical",
        title=title,
        source=Source(filename=filename),
        assetId=None,
        components=components,
        relationships=rels,
        summary=_str(raw.get("summary"), 600),
        limitations=LIMITATIONS,
        provider=provider,
        scene=Scene(imageWidth=w, imageHeight=h, plate=plate, plateBbox=plate_bbox, layers=layers,
                    ghostComponentIds=ghost_ids, notes=notes[:20]),
    )


def analyze_physical_image(image_bytes: bytes, filename: str, vision_client: VisionClient) -> SystemAnalysis:
    try:
        img = ops.fit(ops.decode_image(image_bytes))
    except ValueError as exc:
        raise AnalysisError("That file is not a readable image.", 400) from exc
    jpeg = ops.encode_jpeg(ops.fit(img, 768))  # smaller upload = faster model call; coords are normalized
    t0 = time.perf_counter()
    log.info("physical: calling %s (%d KB)...", vision_client.model, len(jpeg) // 1024)
    text = vision_client.generate_json(jpeg, "image/jpeg", PROMPT)
    t1 = time.perf_counter()
    log.info("physical: model replied in %.1f s (%d KB)", t1 - t0, len(text) // 1024)
    raw = parse_model_json(text)
    image_hash = hashlib.sha256(image_bytes).hexdigest()
    result = build_analysis(raw, img, filename, Provider(name=vision_client.name, model=vision_client.model), image_hash)
    log.info("physical: %d parts, %d layers built in %.1f s", len(result.components), len(result.scene.layers), time.perf_counter() - t1)
    return result

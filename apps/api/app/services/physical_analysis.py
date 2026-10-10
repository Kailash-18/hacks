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

from ..schemas import (BBox, Component, Product, Provider, Relationship, Scene, SceneLayer, SceneView, Source,
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

VIEWS = ("top", "bottom", "front", "back", "left", "right", "three-quarter", "inside", "unknown")

PROMPT = f"""You are a reverse-engineering assistant. Analyze the photo of a physical object and
break it into the parts a person could separate in an exploded-view diagram.

Return ONLY one JSON object, no prose, with this shape:
{{
  "object_name": "short name of the object",
  "summary": "1-2 sentences on what the object is and how it works",
  "product": {{"category": "generic category", "brand": "brand or null", "model": "exact model or null",
               "search_query": "best web search query to find photos of this exact product",
               "identified_from": "what you used: logo, printed text, shape..."}},
  "view": "one of: {", ".join(VIEWS)}",
  "object": {{"box_2d": [ymin, xmin, ymax, xmax], "outline": [[y, x], ...]}},
  "parts": [
    {{"id": "snake_case_id", "label": "Part name", "type": "<part type>",
      "box_2d": [ymin, xmin, ymax, xmax], "outline": [[y, x], ...],
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
- "outline" is a polygon tracing the visible edge of the part (or whole object): 8-24 [y, x] points
  in order, on the same 0-1000 grid. Integers only. Keep the JSON compact; no masks, no images.
- "parts": split the object into EVERY visible, separately manufactured piece, like a teardown would:
  each button, wheel, knob, key group, lens, cover, panel, logo plate, foot, port, screw group, cable.
  A mouse seen from above is at least: left button, right button, scroll wheel, palm shell.
  Aim for 4-{MAX_PARTS} parts when they exist. Never include the whole object as a part.
  Skip parts smaller than about 1% of the image.
- depth_rank: 0 = closest to the camera; larger = further back. Parts can share a rank.
- "hidden_parts": at most {MAX_HIDDEN} parts that are typically inside this kind of object but are
  NOT visible in this photo. Never list a visible part here. Use [] if unsure.
- "product": brand/model only if a logo or printed text supports it; otherwise null. Never guess a
  model number you cannot read.
- part type must be one of: {", ".join(sorted(PART_TYPES))}.
- relationship type must be one of: {", ".join(sorted(ALLOWED_TYPES))}.
  Direction: "from" -> "to" means "to" depends on "from" (battery powers motor; frame supports wheel).
  "visible": true only if the connection itself can be seen in the photo.
- Relationships may reference visible or hidden part ids. Only use ids you defined.
- Be honest: do not invent parts you cannot see; put guesses in hidden_parts.
"""

MERGE_PROMPT = """These part lists come from different photos of the SAME object. Decide which labels
name the same physical part. Return ONLY JSON: {"groups": [["label as given", "other label as given"], ...]}
Only group labels that are clearly the same part. Labels not in any group stay separate.
Lists:
"""

LIMITATIONS = [
    "Parts and relationships are AI-extracted from photos; verify before relying on them.",
    "The 3D view is a layered 2.5D exploded diagram built from the photos, not a reconstructed CAD model.",
    "Depth relief is estimated per pixel from single images and can be wrong.",
    "Hidden parts are inferred from typical designs of this kind of object, not observed.",
    "Explode directions are illustrative; they do not show the real assembly order.",
    "Product identification is a model guess from visible logos/text; confirm before relying on it.",
]

MAX_VIEWS = 4


class AnalysisError(Exception):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


def _slug(text, fallback: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", str(text or "").lower()).strip("_")[:40]
    return s or fallback


def _norm_label(label: str) -> str:
    words = [w.rstrip("s") for w in re.findall(r"[a-z0-9]+", label.lower()) if w not in {"the", "a", "of", "part"}]
    return " ".join(words)


def _str(v, limit: int = 300) -> str:
    return str(v).strip()[:limit] if isinstance(v, (str, int, float)) else ""


def _list(v) -> list:
    return v if isinstance(v, list) else []


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


# ---------------------------------------------------------------- per-photo segmentation

def _segment_view(raw: dict, img: np.ndarray, notes: list[str]):
    """Return (visible parts [(p, mask, rank, refined_by)], plate, plate_bbox) for one photo."""
    h, w = img.shape[:2]
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
            outline = ops.polygon_mask(p.get("outline"), w, h)
            if outline is not None:
                mask = ops.grabcut_refine(img, outline, box)
                refined_by = "model outline refined with GrabCut"
            else:
                mask = ops.grabcut_mask(img, box)
                refined_by = "GrabCut from box (model gave no outline)"
        mask = ops.clean_mask(mask)
        try:
            rank = int(p.get("depth_rank", 5))
        except (TypeError, ValueError):
            rank = 5
        candidates.append((max(0, min(rank, 50)), idx, p, mask, refined_by))

    candidates.sort(key=lambda c: (c[0], c[1]))
    taken = np.zeros((h, w), np.uint8)
    parts = []
    min_area = 0.0015 * h * w
    for rank, idx, p, mask, refined_by in candidates:
        if len(parts) >= MAX_PARTS:
            break
        mask = np.where(taken > 0, 0, mask).astype(np.uint8)  # front-most part owns overlaps
        mask = ops.clean_mask(mask, fill_holes=False)  # keep the holes where front parts sit
        if mask.sum() / 255 < min_area or ops.bbox_of(mask) is None:
            continue
        taken = np.maximum(taken, mask)
        parts.append((p, mask, rank, refined_by))

    obj = raw.get("object") if isinstance(raw.get("object"), dict) else {}
    obj_box = ops.box_to_pixels(obj.get("box_2d"), w, h)
    obj_mask = ops.decode_gemini_mask(obj.get("mask"), obj_box, w, h) if obj_box else None
    if (obj_mask is None or obj_mask.sum() == 0) and obj_box:
        rough = ops.polygon_mask(obj.get("outline"), w, h)
        obj_mask = ops.grabcut_refine(img, rough, obj_box) if rough is not None else None
    if obj_mask is None or obj_mask.sum() == 0:
        import cv2
        pts = np.column_stack(np.nonzero(taken)[::-1]).astype(np.int32)
        obj_mask = np.zeros((h, w), np.uint8)
        if len(pts):
            cv2.fillConvexPoly(obj_mask, cv2.convexHull(pts), 255)
        notes.append("Object outline estimated from the parts (model gave no object outline).")
    obj_mask = np.maximum(ops.clean_mask(obj_mask), taken)
    plate = plate_bbox = None
    plate_box = ops.bbox_of(obj_mask)
    if plate_box:
        x0, y0, x1, y1 = plate_box
        plate = ops.to_data_url(ops.inpainted_plate(img, obj_mask, taken)[y0:y1, x0:x1])
        plate_bbox = BBox(x=x0 / w, y=y0 / h, width=(x1 - x0) / w, height=(y1 - y0) / h)
    return parts, plate, plate_bbox, obj_mask


# ---------------------------------------------------------------- multi-photo merge

def build_analysis_multi(views: list[tuple[dict, np.ndarray, str]], provider: Provider, image_hash: str,
                         label_groups: list[list[str]] | None = None) -> SystemAnalysis:
    """views: [(raw model JSON, image, filename)]. Parts with the same name across photos merge."""
    notes: list[str] = []
    used_ids: set[str] = set()
    components: dict[str, Component] = {}
    by_label: dict[str, str] = {}      # normalized label -> component id
    group_of: dict[str, str] = {}      # normalized label -> canonical normalized label
    for g in label_groups or []:
        normed = [_norm_label(x) for x in g if isinstance(x, str) and x.strip()]
        for n in normed[1:]:
            group_of[n] = normed[0]

    def key_for(label: str) -> str:
        n = _norm_label(label)
        return group_of.get(n, n)

    def unique(base: str) -> str:
        i, cand = 2, base
        while cand in used_ids:
            cand, i = f"{base}_{i}", i + 1
        used_ids.add(cand)
        return cand

    scene_views: list[SceneView] = []
    view_id_maps: list[dict[str, str]] = []
    hidden_by_view: list[list[str]] = []
    product = None

    for vi, (raw, img, filename) in enumerate(views):
        h, w = img.shape[:2]
        id_map: dict[str, str] = {}
        vnotes: list[str] = []
        parts, plate, plate_bbox, _ = _segment_view(raw, img, vnotes)
        notes.extend(f"Photo {vi + 1}: {n}" for n in vnotes)
        view_name = _str(raw.get("view"), 20).lower()
        view_name = view_name if view_name in VIEWS else "unknown"
        if product is None and isinstance(raw.get("product"), dict):
            pr = raw["product"]
            product = Product(category=_str(pr.get("category"), 60), brand=_str(pr.get("brand"), 60) or None,
                              model=_str(pr.get("model"), 80) or None,
                              searchQuery=_str(pr.get("search_query"), 120) or _str(raw.get("object_name"), 80),
                              identifiedFrom=_str(pr.get("identified_from"), 120))
            if product.brand and product.brand.lower() in ("null", "none", "unknown"):
                product.brand = None
            if product.model and product.model.lower() in ("null", "none", "unknown"):
                product.model = None

        layers = []
        for p, mask, rank, refined_by in parts:
            label = _str(p.get("label"), 60) or "Part"
            k = key_for(label)
            box = ops.bbox_of(mask)
            x0, y0, x1, y1 = box
            bbox = BBox(x=x0 / w, y=y0 / h, width=(x1 - x0) / w, height=(y1 - y0) / h)
            cid = by_label.get(k)
            if cid and any(l.component_id == cid for l in layers):
                cid = None  # two different parts with the same name in one photo (e.g. two feet)
            if cid is None:
                cid = unique(_slug(p.get("id") or label, f"part_{len(used_ids) + 1}"))
                ptype = _str(p.get("type"), 30).lower()
                ev = [e for e in (_str(p.get("evidence")),) if e]
                role = _str(p.get("role"))
                if role:
                    ev.append(f"Likely role (model inference): {role}")
                ev.append(f"Seen in photo {vi + 1} ({view_name}); segmentation: {refined_by}")
                components[cid] = Component(id=cid, label=label, type=ptype if ptype in PART_TYPES else "unknown",
                                            status="observed", confidence=None, evidence=ev, bbox=bbox)
                by_label.setdefault(k, cid)
            else:
                c = components[cid]
                if c.status != "observed":  # was a hidden guess in an earlier photo, now actually seen
                    c.status, c.bbox = "observed", bbox
                    c.evidence = [f"Seen in photo {vi + 1} ({view_name}); earlier photos only inferred it."] + \
                                 [e for e in [_str(p.get("evidence"))] if e]
                else:
                    c.evidence.append(f"Also seen in photo {vi + 1} ({view_name})")
            id_map[_str(p.get("id"), 60) or cid] = cid
            id_map.setdefault(_slug(label, cid), cid)
            layers.append(SceneLayer(componentId=cid, bbox=bbox, cutout=ops.to_data_url(ops.cutout(img, mask, box)),
                                     depthRank=rank, viewIndex=vi))

        hidden_ids = []
        for p in _list(raw.get("hidden_parts"))[:MAX_HIDDEN]:
            if not isinstance(p, dict) or not _str(p.get("label")):
                continue
            label = _str(p.get("label"), 60)
            k = key_for(label)
            cid = by_label.get(k)
            if cid is None:
                cid = unique(_slug(p.get("id") or label, f"hidden_{len(used_ids) + 1}"))
                ptype = _str(p.get("type"), 30).lower()
                components[cid] = Component(id=cid, label=label, type=ptype if ptype in PART_TYPES else "unknown",
                                            status="inferred", confidence=None,
                                            evidence=[f"Not visible in photo {vi + 1}. {_str(p.get('reason'))}".strip()])
                by_label[k] = cid
            id_map[_str(p.get("id"), 60) or cid] = cid
            id_map.setdefault(_slug(label, cid), cid)
            hidden_ids.append(cid)

        view_id_maps.append(id_map)
        hidden_by_view.append(hidden_ids)
        scene_views.append(SceneView(index=vi, view=view_name, filename=filename, imageWidth=w, imageHeight=h,
                                     plate=plate, plateBbox=plate_bbox, layers=layers))

    # Visible parts first (stable order), then inferred ones.
    comps = sorted(components.values(), key=lambda c: c.status != "observed")
    if not any(c.status == "observed" for c in comps):
        raise AnalysisError("No separable parts were found. Try a closer, well-lit photo of one object on a plain background.")
    ghost_ids = [c.id for c in comps if c.status != "observed"]

    rels: list[Relationship] = []
    for vi, (raw, _, _) in enumerate(views):
        id_map = view_id_maps[vi]
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
    rels, warnings = validate_relationships(comps, rels)
    notes.extend(warnings)

    first_raw = views[0][0]
    v0 = scene_views[0]
    names = [_str(r.get("object_name"), 80) for r, _, _ in views]
    return SystemAnalysis(
        analysisId=f"physical-{image_hash[:12]}",
        domain="physical",
        title=next((n for n in names if n), "Photographed object"),
        source=Source(filename=", ".join(f for _, _, f in views)[:200]),
        assetId=None,
        components=comps,
        relationships=rels,
        summary=_str(first_raw.get("summary"), 600),
        limitations=LIMITATIONS,
        provider=provider,
        scene=Scene(imageWidth=v0.image_width, imageHeight=v0.image_height, plate=v0.plate, plateBbox=v0.plate_bbox,
                    layers=v0.layers, ghostComponentIds=ghost_ids, notes=notes[:30], views=scene_views,
                    product=product),
    )


def build_analysis(raw: dict, img: np.ndarray, filename: str, provider: Provider, image_hash: str) -> SystemAnalysis:
    return build_analysis_multi([(raw, img, filename)], provider, image_hash)


# ---------------------------------------------------------------- entry points

def _ask_model(image_bytes: bytes, vision_client: VisionClient, cache_dir=None) -> tuple[dict, np.ndarray]:
    try:
        img = ops.fit(ops.decode_image(image_bytes))
    except ValueError as exc:
        raise AnalysisError("One of the files is not a readable image.", 400) from exc
    jpeg = ops.encode_jpeg(ops.fit(img, 768))  # smaller upload = faster model call; coords are normalized
    key = hashlib.sha256(jpeg + vision_client.model.encode() + PROMPT.encode()).hexdigest()
    cached = cache_dir / f"raw-{key}.json" if cache_dir else None
    if cached and cached.exists():
        return json.loads(cached.read_text(encoding="utf-8")), img
    t0 = time.perf_counter()
    log.info("physical: calling %s (%d KB)...", vision_client.model, len(jpeg) // 1024)
    text = vision_client.generate_json(jpeg, "image/jpeg", PROMPT)
    log.info("physical: model replied in %.1f s (%d KB)", time.perf_counter() - t0, len(text) // 1024)
    raw = parse_model_json(text)
    if cached:
        cache_dir.mkdir(parents=True, exist_ok=True)
        cached.write_text(json.dumps(raw), encoding="utf-8")
    return raw, img


def _merge_groups(raws: list[dict], vision_client) -> list[list[str]]:
    """One cheap text-only call to match part names across photos (falls back to exact names)."""
    fn = getattr(vision_client, "generate_text_json", None)
    if fn is None or len(raws) < 2:
        return []
    lists = []
    for i, r in enumerate(raws):
        labels = [_str(p.get("label"), 60) for p in _list(r.get("parts")) + _list(r.get("hidden_parts")) if isinstance(p, dict)]
        lists.append(f"Photo {i + 1}: " + json.dumps([l for l in labels if l]))
    try:
        data = parse_model_json(fn(MERGE_PROMPT + "\n".join(lists)))
        return [g for g in _list(data.get("groups")) if isinstance(g, list)]
    except Exception as exc:  # merging is best-effort
        log.warning("physical: label merge skipped (%s)", exc)
        return []


def analyze_physical_images(files: list[tuple[bytes, str]], vision_client: VisionClient, cache_dir=None) -> SystemAnalysis:
    if not files:
        raise AnalysisError("No image uploaded.", 400)
    files = files[:MAX_VIEWS]
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=len(files)) as pool:
        results = list(pool.map(lambda f: _ask_model(f[0], vision_client, cache_dir), files))
    t1 = time.perf_counter()
    groups = _merge_groups([r for r, _ in results], vision_client)
    image_hash = hashlib.sha256(b"".join(hashlib.sha256(b).digest() for b, _ in files)).hexdigest()
    result = build_analysis_multi([(raw, img, name) for (raw, img), (_, name) in zip(results, files)],
                                  Provider(name=vision_client.name, model=vision_client.model), image_hash, groups)
    log.info("physical: %d photos -> %d parts (%d seen), built in %.1f s", len(files), len(result.components),
             len(result.components) - len(result.scene.ghost_component_ids), time.perf_counter() - t1)
    return result


def analyze_physical_image(image_bytes: bytes, filename: str, vision_client: VisionClient, cache_dir=None) -> SystemAnalysis:
    return analyze_physical_images([(image_bytes, filename)], vision_client, cache_dir)

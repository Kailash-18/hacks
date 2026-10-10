"""3D assembly: Gemini describes each part as a simple solid (shape, size, position, colour,
explode direction) so the viewer can render a clean, rotatable exploded view.

Geometry is a model estimate from photos: proportions are approximate, never measured.
The output is treated as untrusted and validated/clamped here.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import re

from ..schemas import AssemblyPart, Assembly, SystemAnalysis
from .vision_client import VisionClient

log = logging.getLogger("uvicorn.error")

SHAPES = ("box", "rounded_box", "cylinder", "disc", "sphere", "ellipsoid", "dome", "capsule", "cone", "torus", "plate")
MATERIALS = ("plastic", "glossy_plastic", "rubber", "metal", "aluminum", "glass", "pcb", "fabric", "screen")

PROMPT = """You are a mechanical design assistant building a simplified 3D CAD-style model of the object in
the photo(s) for an interactive exploded-view diagram. Use these parts (ids are fixed):
{parts}

Return ONLY one JSON object:
{{
  "units": "mm",
  "overall_size": [width_x, height_y, depth_z],
  "parts": [
    {{"id": "<one of the ids above>", "shape": "<shape>", "size": [x, y, z], "position": [x, y, z],
      "rotation": [rx, ry, rz], "color": "#rrggbb", "material": "<material>",
      "explode_dir": [dx, dy, dz], "explode_dist": 1.0}}
  ]
}}

Coordinate system (millimetres, realistic real-world size): origin = centre of the assembled object,
x = right, y = UP (against gravity), z = towards the viewer (front). position = centre of the part when assembled.
Model the object resting in its natural position on a table (a mouse, keyboard or circuit board lies flat:
its large faces are horizontal; a monitor, bottle or handheld console in use stands as it naturally would).
Do NOT copy the photo's camera angle: in a top-down photo, the photo's vertical direction is depth (z), not y.
rotation in degrees (XYZ). Shapes:
- box, rounded_box, plate (thin rounded box): size = [x, y, z]
- cylinder (axis along y; rotate for other axes), disc (short cylinder), cone: size = [diameter, height, diameter]
- sphere, ellipsoid: size = full extents [x, y, z]
- dome = upper half of an ellipsoid, open at the bottom (use for curved shells and covers such as a
  mouse top shell, helmet, lamp shade): size = full extents [x, y, z], the flat open side faces -y
- capsule: size = [diameter, total length, diameter]
- torus: size = [outer diameter, tube thickness, outer diameter]
Materials: {materials}.
Rules:
- Give EVERY listed id exactly one entry, including inferred internal parts (place them where they
  would really sit inside, sized realistically).
- Parts must fit together into one coherent object when assembled: shells enclose internals, buttons sit
  on the shell surface, wheels sit in their slot. Avoid parts floating apart when assembled.
- color: sample the real colour from the photo for visible parts; typical colours for internal parts
  (PCB green #2f6b3a, battery, metal #b8bcc2...).
- explode_dir: unit vector of the direction the part moves when the object is taken apart, like a
  technical exploded-view drawing (top covers up, internal boards up/out, bottom plates down, side
  parts sideways). explode_dist: relative distance 0.3-2.0 (outer parts travel further).
- Keep it compact. No prose.
"""


def _num(v, default=0.0, lo=-1e4, hi=1e4) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return default if math.isnan(f) or math.isinf(f) else max(lo, min(hi, f))


def _vec(v, n=3, default=0.0, lo=-1e4, hi=1e4) -> list[float]:
    v = v if isinstance(v, list) else []
    return [_num(v[i] if i < len(v) else default, default, lo, hi) for i in range(n)]


def parse_assembly(raw: dict, component_ids: set[str]) -> Assembly | None:
    parts: list[AssemblyPart] = []
    seen = set()
    for p in raw.get("parts", []) if isinstance(raw.get("parts"), list) else []:
        if not isinstance(p, dict):
            continue
        cid = str(p.get("id", ""))
        if cid not in component_ids or cid in seen:
            continue
        seen.add(cid)
        shape = str(p.get("shape", "rounded_box")).lower().replace(" ", "_")
        shape = shape if shape in SHAPES else "rounded_box"
        size = [abs(x) for x in _vec(p.get("size"), default=10.0, lo=-5000, hi=5000)]
        size = [s if s > 0.2 else 0.2 for s in size]
        color = str(p.get("color", "#9aa0a6"))
        color = color if re.fullmatch(r"#[0-9a-fA-F]{6}", color) else "#9aa0a6"
        mat = str(p.get("material", "plastic")).lower()
        mat = mat if mat in MATERIALS else "plastic"
        d = _vec(p.get("explode_dir"), default=0.0, lo=-1, hi=1)
        norm = math.sqrt(sum(x * x for x in d))
        d = [x / norm for x in d] if norm > 1e-6 else [0.0, 1.0, 0.0]
        parts.append(AssemblyPart(
            componentId=cid, shape=shape, size=size,
            position=_vec(p.get("position"), lo=-5000, hi=5000),
            rotation=_vec(p.get("rotation"), lo=-360, hi=360),
            color=color, material=mat, explodeDir=d,
            explodeDist=_num(p.get("explode_dist"), 1.0, 0.0, 3.0),
        ))
    if len(parts) < 2:
        return None
    overall = [abs(x) for x in _vec(raw.get("overall_size"), default=0.0, lo=-5000, hi=5000)]
    if min(overall) <= 0:  # derive from the parts
        lo = [min(p.position[i] - p.size[i] / 2 for p in parts) for i in range(3)]
        hi = [max(p.position[i] + p.size[i] / 2 for p in parts) for i in range(3)]
        overall = [max(1.0, hi[i] - lo[i]) for i in range(3)]
    return Assembly(units="mm", overallSize=overall, parts=parts)


def build_assembly(analysis: SystemAnalysis, jpegs: list[bytes], vision_client: VisionClient, cache_dir=None) -> Assembly | None:
    comps = analysis.components
    listing = "\n".join(f'- id "{c.id}": {c.label} ({c.type}; {"visible" if c.status == "observed" else "inferred, not visible"})'
                        for c in comps)
    prompt = PROMPT.format(parts=listing, materials=", ".join(MATERIALS))
    key = hashlib.sha256(b"".join(hashlib.sha256(j).digest() for j in jpegs) + prompt.encode()
                         + vision_client.model.encode()).hexdigest()
    cached = cache_dir / f"asm-{key}.json" if cache_dir else None
    if cached and cached.exists():
        raw = json.loads(cached.read_text(encoding="utf-8"))
    else:
        fn = getattr(vision_client, "generate_json_images", None)
        if fn is None:
            return None
        from .physical_analysis import parse_model_json
        text = fn([(j, "image/jpeg") for j in jpegs], prompt)
        try:
            raw = parse_model_json(text)
        except Exception:
            if cache_dir:  # keep the bad answer for debugging
                (cache_dir / f"asm-bad-{key[:12]}.txt").write_text(text, encoding="utf-8")
            raise
        if cached:
            cache_dir.mkdir(parents=True, exist_ok=True)
            cached.write_text(json.dumps(raw), encoding="utf-8")
    return parse_assembly(raw, {c.id for c in comps})

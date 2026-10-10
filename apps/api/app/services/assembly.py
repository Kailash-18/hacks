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

from ..schemas import Assembly, AssemblyDetail, AssemblyPart, SystemAnalysis
from .vision_client import VisionClient

log = logging.getLogger("uvicorn.error")

SHAPES = ("box", "rounded_box", "cylinder", "disc", "sphere", "ellipsoid", "dome", "capsule", "cone", "torus", "plate")
DETAIL_SHAPES = SHAPES + ("cross", "slots")
MAX_DETAILS = 40
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
  ],
  "details": [
    {{"parent": "<one of the ids above>", "shape": "<detail shape>", "size": [x, y, z], "position": [x, y, z],
      "rotation": [rx, ry, rz], "color": "#rrggbb", "material": "<material>", "count": 1}}
  ]
}}

Coordinate system (millimetres, realistic real-world size): origin = centre of the assembled object,
x = right, y = UP (against gravity), z = towards the viewer (front). position = centre of the part when assembled.
Model the object resting in its natural position on a table (a mouse, keyboard or circuit board lies flat:
its large faces are horizontal; a monitor, bottle or handheld console in use stands as it naturally would).
Do NOT copy the photo's camera angle: in a top-down photo, the photo's vertical direction is depth (z), not y.
rotation in degrees (XYZ). Shapes:
- box, rounded_box, plate (thin rounded box): size = [x, y, z]. A thin part must be thin along the axis
  that points OUT of the face it sits on: a screen on the front face of an upright device is [w, h, 1-2]
  (thin in z); a label on a flat top is [w, 0.5, d] (thin in y); a side button is thin in x.
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
- Parts must fit together into ONE coherent object when assembled: use one consistent scale for every part;
  shells/housings enclose all internal parts (internal parts are smaller than the shell and fully inside it);
  buttons sit on the shell surface, wheels sit in their slot. Nothing sticks out or floats when assembled.
- For a curved top shell use "dome" with the full footprint of the object; buttons on a curved top are thin
  "plate"s (or small "dome"s) lying on the front of the shell, not long bars.
- color: sample the real colour from the photo for visible parts; typical colours for internal parts
  (PCB green #2f6b3a, battery, metal #b8bcc2...).
- explode_dir: unit vector of the direction the part moves when the object is taken apart, like a
  technical exploded-view drawing (top covers up, internal boards up/out, bottom plates down, side
  parts sideways). explode_dist: relative distance 0.3-2.0 (outer parts travel further).
- "details": 12-30 small surface features (more is better, as long as they are real) that make the model
  look like THIS real object and that you can see in the photo or that this kind of object really has: screws, vents and grilles (shape "slots",
  count = number of slots, size = the whole slotted area), ports and sockets (dark rounded_box recesses),
  LEDs, lens rings ("torus"), buttons printed/embossed icons or labels (very thin "plate"), D-pads
  ("cross"), keys, feet, seams. Detail shapes: the part shapes plus "cross" and "slots". Each detail
  belongs to "parent" (it moves with that part when exploded); its position is absolute (same frame as
  parts) and must sit ON the parent's outer surface, slightly proud of it (0.3-1 mm), never floating.
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


def _rot_matrix(deg: list[float]) -> list[list[float]]:
    """XYZ Euler (degrees) -> 3x3 rotation matrix, matching three.js default order."""
    a, b, c = (math.radians(v) for v in deg)
    ca, sa, cb, sb, cc, sc = math.cos(a), math.sin(a), math.cos(b), math.sin(b), math.cos(c), math.sin(c)
    return [[cb * cc, -cb * sc, sb],
            [ca * sc + sa * sb * cc, ca * cc - sa * sb * sc, -sa * cb],
            [sa * sc - ca * sb * cc, sa * cc + ca * sb * sc, ca * cb]]


def _fit_inside_envelope(parts: list[AssemblyPart], types: dict[str, str]) -> None:
    """Make the closed model coherent: the big outer parts (covers, housings, chassis) define an envelope,
    and every other part is shrunk/moved to sit inside it (model coordinates are often inconsistent)."""
    vol = {p.component_id: p.size[0] * p.size[1] * p.size[2] for p in parts}
    biggest = max(vol.values())
    outer = [p for p in parts if vol[p.component_id] >= 0.25 * biggest
             and (types.get(p.component_id) in ("cover", "structure", None) or vol[p.component_id] == biggest)]
    if not outer:
        return
    lo = [min(p.position[i] - p.size[i] / 2 for p in outer) for i in range(3)]
    hi = [max(p.position[i] + p.size[i] / 2 for p in outer) for i in range(3)]
    ext = [hi[i] - lo[i] for i in range(3)]
    for p in parts:
        if p in outer:
            continue
        R = _rot_matrix(p.rotation)
        # world-space half extents of the rotated part
        half = [sum(abs(R[i][j]) * p.size[j] / 2 for j in range(3)) for i in range(3)]
        k = min([1.0] + [ext[i] * 0.92 / (2 * half[i]) for i in range(3) if half[i] > 0])
        if k < 1.0:  # too big to fit: shrink uniformly
            p.size = [max(0.2, v * k) for v in p.size]
            half = [h * k for h in half]
        for i in range(3):
            p.position[i] = min(max(p.position[i], lo[i] + half[i]), hi[i] - half[i])


def parse_assembly(raw: dict, component_ids: set[str], types: dict[str, str] | None = None) -> Assembly | None:
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
    _fit_inside_envelope(parts, types or {})
    part_ids = {p.component_id for p in parts}
    details: list[AssemblyDetail] = []
    for d in raw.get("details", []) if isinstance(raw.get("details"), list) else []:
        if not isinstance(d, dict) or len(details) >= MAX_DETAILS:
            continue
        parent = str(d.get("parent", ""))
        if parent not in part_ids:
            continue
        shape = str(d.get("shape", "rounded_box")).lower().replace(" ", "_")
        color = str(d.get("color", "#30343b"))
        mat = str(d.get("material", "plastic")).lower()
        size = [max(0.1, abs(x)) for x in _vec(d.get("size"), default=2.0, lo=-2000, hi=2000)]
        details.append(AssemblyDetail(
            parentId=parent, shape=shape if shape in DETAIL_SHAPES else "rounded_box", size=size,
            position=_vec(d.get("position"), lo=-5000, hi=5000), rotation=_vec(d.get("rotation"), lo=-360, hi=360),
            color=color if re.fullmatch(r"#[0-9a-fA-F]{6}", color) else "#30343b",
            material=mat if mat in MATERIALS else "plastic",
            count=int(_num(d.get("count"), 1, 1, 24)),
        ))
    overall = [abs(x) for x in _vec(raw.get("overall_size"), default=0.0, lo=-5000, hi=5000)]
    if min(overall) <= 0:  # derive from the parts
        lo = [min(p.position[i] - p.size[i] / 2 for p in parts) for i in range(3)]
        hi = [max(p.position[i] + p.size[i] / 2 for p in parts) for i in range(3)]
        overall = [max(1.0, hi[i] - lo[i]) for i in range(3)]
    return Assembly(units="mm", overallSize=overall, parts=parts, details=details)


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
    return parse_assembly(raw, {c.id for c in comps}, {c.id: c.type for c in comps})

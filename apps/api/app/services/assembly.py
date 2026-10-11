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

SHAPES = ("box", "rounded_box", "cylinder", "disc", "sphere", "ellipsoid", "dome", "capsule", "cone", "torus", "plate", "frame", "arch")
DETAIL_SHAPES = SHAPES + ("cross", "slots")
MAX_DETAILS = 40
MAX_EXTRA = 6
MATERIALS = ("plastic", "glossy_plastic", "rubber", "metal", "aluminum", "glass", "pcb", "fabric", "screen")

PROMPT = """You are a mechanical design assistant building a simplified 3D CAD-style model of the object in
the photo(s) for an interactive exploded-view diagram. Use these parts (ids are fixed):
{parts}

Return ONLY one JSON object:
{{
  "units": "mm",
  "overall_size": [width_x, height_y, depth_z],
  "parts": [
    {{"id": "<one of the ids above, or an extra_parts id>", "shape": "<shape>", "size": [x, y, z], "position": [x, y, z],
      "rotation": [rx, ry, rz], "color": "#rrggbb", "material": "<material>",
      "explode_dir": [dx, dy, dz], "explode_dist": 1.0,
      "function": "what it does, max 12 words", "if_removed": "what stops working without it, max 14 words",
      "importance": 0.0}}
  ],
  "extra_parts": [
    {{"id": "snake_case_id", "label": "Part name", "type": "<part type>", "reason": "why this object has it"}}
  ],
  "relationships": [
    {{"from": "<id>", "to": "<id>", "type": "<relationship type>", "why": "short reason, max 12 words"}}
  ],
  "duplicates": [["<id to keep>", "<id of the same physical part>"]],
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
- frame = a closed band around the edge of a slab-shaped body (the metal side frame of a phone, tablet or
  watch; a bezel; a picture frame): size = outer [x, y, z], "wall" = band thickness in mm.
- arch = a curved band bent into a half ring, ends pointing down (-y): a headphone headband, a bag, kettle or
  bucket handle, a U-shaped bracket. size = [span between the outer ends, rise, band depth z]; "wall" = band
  thickness in mm. Rotate it for other orientations. Never draw a curved band as a straight box.
Optional on box, rounded_box, plate and frame: "corner_radius" in mm = how rounded the corners look when you
face the part's large face (a phone body ~ 15% of its width, a camera plateau, keycaps and cards are rounded).
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
- "extra_parts": up to {max_extra} important INTERNAL parts this kind of object (or this exact product) really
  has that are missing from the list (e.g. optical sensor, microswitches, battery contacts, motor, PCB, antenna).
  Never duplicate a listed part. Give each one a "parts" entry too (geometry inside the housing). [] if none.
  Also use extra_parts for the missing twin of a mirrored pair when only one side is listed (headphones: the
  other ear cup's pad, cover and driver; a bike's other wheel; glasses' other lens): same shape and size,
  mirrored across the centre. Both sides of a symmetric object must look alike when assembled.
  EVERY extra_parts id MUST also have its own "parts" entry with geometry, or it is dropped.
- "relationships": the real system wiring between ALL parts (listed + extra), like an engineer's block diagram.
  Types: {rel_types}. Direction: "from" -> "to" means "to" depends on "from".
  Cover every chain: power (battery powers board, board powers sensor/LEDs/motor), control and signals
  (button/switch controls board input -> use "controls" from the input part to the board; board controls
  outputs), motion (motor drives gear, wheel drives encoder), structure (housing supports/mounts the parts
  it holds; base supports board). EVERY part appears in at least one relationship. 8-30 relationships.
- "duplicates": the list above comes from several photos, so one physical part may appear twice under different
  names (e.g. "Power Plug Pins" and "Power Pins", "Wick" and "Vaporizing Wick"). List each such group once,
  best id first, and give a "parts" entry ONLY for the first id. [] if none.
- Parts that are visible from outside in the photos stay visible when assembled: put them where the photo shows
  them (a refill bottle hangs below the heater unit, a label sits on the outside surface, a switch on the casing).
  Never bury a visible part inside another part.
- Prefer upright shapes: a "dome" opens downwards (do not rotate it 180 degrees; for a cup that opens upwards
  use a cylinder or rounded_box).
- importance: 0-1, how much the object's main function depends on the part (battery/main board ~1, logo ~0.05).
- Round things are round: a round watch case, dial, lens or knob is a disc/cylinder, or a plate/frame with
  corner_radius = half its width (a circle). Never draw a round object as a square.
- Slab devices (phones, tablets, e-readers, square smartwatches): build them like the real teardown, front to back:
  display (thin, front), the side "frame" (an extra part if not listed), internals in one layer inside the
  frame (board, battery, speakers, haptic motor, ports, camera modules), back cover (thin, back). Give the
  display, frame, back cover and camera plateau the real corner_radius. Lenses are "disc"s of glass inside a
  thin metal "torus" ring; the flash is a small disc. Never use a detail as the whole body or to cover a face.
- Over-ear / on-ear headphones (worn upright, as on a head): headband = ONE "arch" with rotation [0, 0, 0] whose
  ends come down onto the two yokes; ear cups = "cylinder"s with rotation [0, 0, 90] (axis along x, the round
  face looks sideways) at x = +/- half the headband span, hanging below the headband ends; ear pads = "torus" with
  rotation [0, 0, 90] on the INNER face of each cup (towards x = 0); yokes = small "arch"es with rotation [0, 90, 0]
  (a U-fork around the top of the cup). Drivers, battery and board sit inside the cups. Both sides alike.
- Everything is connected: each part touches the part that holds it (no gaps between headband, yokes and cups,
  no floating parts).
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


def _radius(v, size: list[float]) -> float | None:
    """Plan-view corner radius, at most half the smaller of the two large sides."""
    r = _num(v, 0.0, 0.0, 5000.0)
    if r <= 0:
        return None
    a, b = sorted(size)[1:]
    return min(r, a / 2, b / 2)


def _too_big(size: list[float], parts: list[AssemblyPart]) -> bool:
    lo = [min(p.position[i] - p.size[i] / 2 for p in parts) for i in range(3)]
    hi = [max(p.position[i] + p.size[i] / 2 for p in parts) for i in range(3)]
    return sum(size[i] >= 0.8 * (hi[i] - lo[i]) for i in range(3)) >= 3


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
            cornerRadius=_radius(p.get("corner_radius"), size),
            wall=_num(p.get("wall"), 0.0, 0.0, 500.0) or None if shape in ("frame", "arch") else None,
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
        if _too_big(size, parts):  # a "detail" the size of the whole object (a body shell) would hide everything
            continue
        details.append(AssemblyDetail(
            parentId=parent, shape=shape if shape in DETAIL_SHAPES else "rounded_box", size=size,
            position=_vec(d.get("position"), lo=-5000, hi=5000), rotation=_vec(d.get("rotation"), lo=-360, hi=360),
            color=color if re.fullmatch(r"#[0-9a-fA-F]{6}", color) else "#30343b",
            material=mat if mat in MATERIALS else "plastic",
            count=int(_num(d.get("count"), 1, 1, 24)),
            cornerRadius=_radius(d.get("corner_radius"), size),
        ))
    overall = [abs(x) for x in _vec(raw.get("overall_size"), default=0.0, lo=-5000, hi=5000)]
    if min(overall) <= 0:  # derive from the parts
        lo = [min(p.position[i] - p.size[i] / 2 for p in parts) for i in range(3)]
        hi = [max(p.position[i] + p.size[i] / 2 for p in parts) for i in range(3)]
        overall = [max(1.0, hi[i] - lo[i]) for i in range(3)]
    return Assembly(units="mm", overallSize=overall, parts=parts, details=details)


def product_context(product) -> str:
    """Known product + real dimensions make the 3D proportions match the actual object."""
    if product is None or not (product.model or product.brand):
        return ""
    b, m = product.brand or "", product.model or ""
    name = m if b and m.lower().startswith(b.lower()) else f"{b} {m}".strip()
    out = f"\nThe object is identified as: {name}. Use your knowledge of this product's real design and internals."
    if product.dimensions_mm:
        w, h, d = product.dimensions_mm
        out += (f" Its published size is about {w:g} x {h:g} x {d:g} mm: map these onto overall_size "
                "(x = width, y = height, z = depth for the object resting in normal use).")
    return out


def build_assembly(analysis: SystemAnalysis, jpegs: list[bytes], vision_client: VisionClient, cache_dir=None,
                   product=None) -> Assembly | None:
    comps = analysis.components
    listing = "\n".join(f'- id "{c.id}": {c.label} ({c.type}; {"visible" if c.status == "observed" else "inferred, not visible"})'
                        for c in comps)
    from .component_graph import ALLOWED_TYPES
    prompt = PROMPT.format(parts=listing, materials=", ".join(MATERIALS), max_extra=MAX_EXTRA,
                           rel_types=", ".join(sorted(ALLOWED_TYPES))) + product_context(product)
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
    merge_duplicates(analysis, raw)
    comps = analysis.components
    extra = parse_extra_parts(raw, {c.id for c in comps})
    ids = {c.id for c in comps} | {c.id for c in extra}
    asm = parse_assembly(raw, ids, {c.id: c.type for c in comps + extra})
    if asm is None:
        return None
    placed = {p.component_id for p in asm.parts}
    extra = [c for c in extra if c.id in placed]  # an extra part without geometry is dropped
    apply_system(analysis, raw, extra, asm)
    return asm


def _txt(v, n=120) -> str:
    return "" if v is None else re.sub(r"\s+", " ", str(v)).strip()[:n]


def parse_extra_parts(raw: dict, existing: set[str]) -> list:
    """Internal parts the 3D step adds from its knowledge of the object (inferred, never seen)."""
    from ..schemas import Component
    from .physical_analysis import PART_TYPES
    out, labels = [], set()
    for e in raw.get("extra_parts", []) if isinstance(raw.get("extra_parts"), list) else []:
        if not isinstance(e, dict) or len(out) >= MAX_EXTRA:
            continue
        cid = re.sub(r"[^a-z0-9_]+", "_", _txt(e.get("id"), 40).lower()).strip("_")
        label = _txt(e.get("label"), 60)
        if not cid or not label or cid in existing or label.lower() in labels:
            continue
        labels.add(label.lower())
        typ = _txt(e.get("type"), 30).lower()
        reason = _txt(e.get("reason"), 200) or "Typical internal part of this kind of object."
        out.append(Component(id=cid, label=label, type=typ if typ in PART_TYPES else "unknown", status="inferred",
                             evidence=[f"Not visible: {reason}"]))
    return out


def apply_system(analysis: SystemAnalysis, raw: dict, extra: list, asm: Assembly) -> None:
    """Merge the 3D step's system knowledge into the analysis: extra internal parts, part functions,
    and a complete relationship graph (the photo-only graph is usually sparse)."""
    from ..schemas import Relationship
    from .component_graph import ALLOWED_TYPES, validate_relationships
    analysis.components.extend(extra)
    if analysis.scene is not None:
        analysis.scene.ghost_component_ids.extend(c.id for c in extra)
    by_id = {c.id: c for c in analysis.components}
    for p in raw.get("parts", []) if isinstance(raw.get("parts"), list) else []:
        c = by_id.get(str(p.get("id", ""))) if isinstance(p, dict) else None
        if c is None:
            continue
        c.function = _txt(p.get("function"), 100) or c.function
        c.if_removed = _txt(p.get("if_removed"), 120) or c.if_removed
        if p.get("importance") is not None:
            c.importance = _num(p.get("importance"), 0.5, 0.0, 1.0)

    observed_pairs = {frozenset((r.from_, r.to)) for r in analysis.relationships if r.status == "observed"}
    sys_rels, pairs = [], set()
    for r in raw.get("relationships", []) if isinstance(raw.get("relationships"), list) else []:
        if not isinstance(r, dict):
            continue
        a, b = str(r.get("from", "")), str(r.get("to", ""))
        if a not in by_id or b not in by_id or a == b or frozenset((a, b)) in pairs:
            continue
        rtype = _txt(r.get("type"), 30).lower()
        rtype = rtype if rtype in ALLOWED_TYPES else "connected_to"
        pairs.add(frozenset((a, b)))
        why = _txt(r.get("why") or r.get("evidence"), 160)
        sys_rels.append(Relationship(**{
            "id": f"{a}--{rtype}--{b}", "from": a, "to": b, "type": rtype,
            "status": "observed" if frozenset((a, b)) in observed_pairs else "inferred",
            "evidence": [why or "System model inference (typical design of this object)."]}))
    merged = sys_rels + [r for r in analysis.relationships if frozenset((r.from_, r.to)) not in pairs]

    # nothing may float: a part with no link at all is held by the main housing
    linked = {x for r in merged for x in (r.from_, r.to)}
    vol = {p.component_id: p.size[0] * p.size[1] * p.size[2] for p in asm.parts}
    housing = max((cid for cid in vol if by_id[cid].type in ("cover", "structure")), key=vol.get, default=None) \
        or max(vol, key=vol.get, default=None)
    for c in analysis.components:
        if c.id not in linked and housing and c.id != housing:
            merged.append(Relationship(**{"id": f"{housing}--supports--{c.id}", "from": housing, "to": c.id,
                                          "type": "supports", "status": "inferred",
                                          "evidence": ["Assumed: held in place by the main housing."]}))
    analysis.relationships, _ = validate_relationships(analysis.components, merged)


GENERIC_WORDS = {"main", "power", "upper", "lower", "left", "right", "front", "back", "rear", "top", "bottom", "side",
                 "inner", "outer", "internal", "external", "cover", "part", "small", "large", "plastic", "unit", "assembly"}


CONTAINER_WORDS = ("casing", "housing", "case", "shell", "enclosure", "frame", "body", "holder", "chassis", "compartment")


def _is_container(label: str) -> bool:
    return any(w in label.lower() for w in CONTAINER_WORDS)


def _words(label: str) -> set[str]:
    return {w[:4] for w in re.findall(r"[a-z]{3,}", label.lower()) if w not in GENERIC_WORDS}


def _aabb(p: dict, k=1.0):
    try:
        size, pos, rot = [abs(float(v)) for v in p["size"][:3]], [float(v) for v in p["position"][:3]], _vec(p.get("rotation"), lo=-360, hi=360)
    except (KeyError, TypeError, ValueError, IndexError):
        return None
    R = _rot_matrix(rot)
    half = [sum(abs(R[i][j]) * size[j] / 2 for j in range(3)) for i in range(3)]
    return [pos[i] - half[i] for i in range(3)], [pos[i] + half[i] for i in range(3)]


def find_duplicates(raw: dict, comps: list) -> dict[str, str]:
    """Map duplicate id -> kept id. Uses the 3D step's own "duplicates" list, then a geometric backstop:
    two parts that occupy the same space and share a name word (or have the same shape and similar size)."""
    by_id = {c.id: c for c in comps}
    dup: dict[str, str] = {}

    def root(x):
        while x in dup:
            x = dup[x]
        return x

    def keep_first(a, b):  # prefer the part seen in a photo, then the AI's order
        ca, cb = by_id[a], by_id[b]
        return (a, b) if (ca.status == "observed") >= (cb.status == "observed") else (b, a)

    for g in raw.get("duplicates", []) if isinstance(raw.get("duplicates"), list) else []:
        ids = [str(x) for x in g if str(x) in by_id] if isinstance(g, list) else []
        for other in ids[1:]:
            a, b = root(ids[0]), root(other)
            if a != b:
                dup[b] = a
    geo = {str(p.get("id")): p for p in raw.get("parts", []) if isinstance(p, dict) and str(p.get("id")) in by_id}
    boxes = {i: _aabb(p) for i, p in geo.items()}
    ids = [i for i in geo if boxes[i]]
    vol = {i: max(1e-6, (boxes[i][1][0] - boxes[i][0][0]) * (boxes[i][1][1] - boxes[i][0][1]) * (boxes[i][1][2] - boxes[i][0][2])) for i in ids}
    for x in range(len(ids)):
        for y in range(x + 1, len(ids)):
            a, b = ids[x], ids[y]
            if root(a) == root(b):
                continue
            (la, ha), (lb, hb) = boxes[a], boxes[b]
            inter = 1.0
            for i in range(3):
                inter *= max(0.0, min(ha[i], hb[i]) - max(la[i], lb[i]))
            contain = inter / min(vol[a], vol[b])
            # a container and what it holds are never the same part (heater casing vs heating element)
            if _is_container(by_id[a].label) != _is_container(by_id[b].label):
                continue
            ratio = min(vol[a], vol[b]) / max(vol[a], vol[b])
            shape_eq = geo[a].get("shape") == geo[b].get("shape")
            # same name = one name's words are all in the other's ("Power Pins" / "Power Plug Pins"); sharing ONE word
            # is not enough: "Ear pad" and "Left ear cup" overlap in space but are different parts
            wa, wb = _words(by_id[a].label), _words(by_id[b].label)
            same_name = bool(wa and wb) and (wa <= wb or wb <= wa)
            if (same_name and contain >= 0.4 and (shape_eq or ratio > 0.25)) or \
                    (shape_eq and ratio > 0.45 and contain >= 0.8 and by_id[a].type == by_id[b].type):
                k, d = keep_first(root(a), root(b))
                dup[d] = k
    return {d: root(d) for d in dup}


def merge_duplicates(analysis: SystemAnalysis, raw: dict) -> None:
    """Fold duplicate parts into one: components, relationships, photo layers and the raw 3D answer."""
    dup = find_duplicates(raw, analysis.components)
    if not dup:
        return
    by_id = {c.id: c for c in analysis.components}
    for d, k in dup.items():
        by_id[k].evidence = list(dict.fromkeys(by_id[k].evidence + by_id[d].evidence))[:6]
        if by_id[d].status == "observed":
            by_id[k].status = "observed"
    analysis.components = [c for c in analysis.components if c.id not in dup]
    m = lambda x: dup.get(x, x)  # noqa: E731
    rels = []
    for r in analysis.relationships:
        a, b = m(r.from_), m(r.to)
        if a != b:
            rels.append(r.model_copy(update={"from_": a, "to": b, "id": f"{a}--{r.type}--{b}"}))
    from .component_graph import validate_relationships
    analysis.relationships, _ = validate_relationships(analysis.components, rels)
    if analysis.scene is not None:
        for v in analysis.scene.views:
            for l in v.layers:
                l.component_id = m(l.component_id)
        for l in analysis.scene.layers:
            l.component_id = m(l.component_id)
        analysis.scene.ghost_component_ids = [g for g in analysis.scene.ghost_component_ids if g not in dup
                                              and any(c.id == g for c in analysis.components)]
        if dup:
            analysis.scene.notes.append(f"Merged {len(dup)} duplicate part(s) seen in several photos.")
    raw["parts"] = [p for p in raw.get("parts", []) if not (isinstance(p, dict) and str(p.get("id")) in dup)]
    for r in raw.get("relationships", []) if isinstance(raw.get("relationships"), list) else []:
        if isinstance(r, dict):
            r["from"], r["to"] = m(str(r.get("from", ""))), m(str(r.get("to", "")))
    for d in raw.get("details", []) if isinstance(raw.get("details"), list) else []:
        if isinstance(d, dict):
            d["parent"] = m(str(d.get("parent", "")))

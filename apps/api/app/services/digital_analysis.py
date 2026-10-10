"""Digital Lab: UI screenshot -> SystemAnalysis (domain="digital").

Pipeline: one vision-model call -> lenient sanitising of the raw JSON -> deterministic
geometry checks on the boxes (containment verification + derived hierarchy) ->
strict Pydantic validation. Invalid items are dropped with a warning, never crash.

Truthfulness: a single screenshot cannot show handlers, API calls or navigation, so
such relationship types are rewritten to `appears_related_to` (status inferred).
"""

from __future__ import annotations

import re
from typing import Any

from ..contract import (
    DIGITAL_VISUAL_EDGE_TYPES,
    STATUSES,
    UNPROVABLE_FROM_PIXELS,
    BBox,
    Component,
    Provider,
    Relationship,
    Source,
    SystemAnalysis,
)
from ..store import image_hash
from .vision_provider import VisionClient, VisionProviderError, parse_model_json

MAX_COMPONENTS = 60
MAX_RELATIONSHIPS = 150
MAX_EVIDENCE = 3
MAX_EVIDENCE_CHARS = 160
MIN_BOX_SIDE = 0.003  # boxes thinner than ~0.3% of the image are treated as invalid

COMPONENT_TYPES = frozenset(
    """navbar header heading text paragraph button link card image icon logo form input textarea
    checkbox radio toggle dropdown select menu menu_item tab tabs list list_item table chart sidebar
    footer modal dialog toolbar search avatar badge section container hero banner video map
    breadcrumb pagination progress notification tooltip divider unknown""".split()
)
_TYPE_ALIASES = {
    "nav": "navbar", "navigation": "navbar", "nav_bar": "navbar", "title": "heading", "h1": "heading",
    "label": "text", "img": "image", "photo": "image", "picture": "image", "textbox": "input",
    "text_field": "input", "textfield": "input", "combobox": "dropdown", "panel": "section",
    "grid": "container", "row": "container", "column": "container", "cta": "button", "graph": "chart",
    "popup": "modal", "switch": "toggle", "hyperlink": "link", "searchbar": "search", "search_bar": "search",
}

BASE_LIMITATIONS = [
    "A single screenshot shows layout and visible text only; it does not reveal event handlers, "
    "API calls, data sources or where any control navigates.",
    "Bounding boxes are model estimates and may be offset slightly from the true element edges.",
    "confidence is null because the model does not produce calibrated probabilities.",
]

PROMPT = """You are analysing ONE screenshot of a software user interface (website, mobile app,
desktop app, dashboard, or other UI). Extract its visible component structure.

Return ONLY a JSON object with this exact shape:
{
  "title": "short name of the screen, e.g. 'Checkout page' (string)",
  "summary": "2-3 sentences describing the screen's visible purpose and layout",
  "components": [
    {
      "id": "kebab-case unique id, e.g. 'hero-cta'",
      "label": "human-readable name; include visible text when present",
      "type": "one of: %(types)s",
      "status": "observed if clearly visible, inferred if partly hidden/ambiguous",
      "evidence": ["short reason, e.g. 'Visible label: Get started'"],
      "box_2d": [ymin, xmin, ymax, xmax],
      "parentId": "id of the smallest component that visually contains this one, or null"
    }
  ],
  "relationships": [
    {"from": "id", "to": "id", "type": "label_for | visually_aligned_with | appears_related_to | adjacent_to | covers",
     "evidence": ["short visual reason"]}
  ],
  "limitations": ["anything about the image that limits the analysis (blur, cropping, etc.)"]
}

Rules:
- box_2d is integers 0-1000 normalised to the image: [ymin, xmin, ymax, xmax], top-left origin. Be precise.
- Boxes must tightly fit what is visible: for text-only elements (headings, labels, links) fit the
  text itself, not the empty row around it; for buttons, inputs and cards fit the visible border.
- If a card or panel exists mainly to hold a chart, table, image or form, give it that type.
- Include major regions (navbar, sidebar, sections, cards, footer) AND meaningful leaf elements
  (headings, buttons, inputs, images, links). At most %(max)d components. Skip decorative noise.
- Containment goes ONLY in parentId (do not also emit 'contains' relationships).
- Relationship direction: "from -> to" means "to depends on from" (e.g. a label 'from' -> its input 'to').
- Use only visual/layout relationship types listed. NEVER claim API calls, event handlers, data flow,
  or navigation targets: the screenshot cannot show them.
- Do not invent components that are not visible. If the image is not a UI, return empty lists and
  explain in limitations.
""" % {"types": ", ".join(sorted(COMPONENT_TYPES)), "max": MAX_COMPONENTS}


# --- helpers -----------------------------------------------------------------
def _slug(value: Any, fallback: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")[:80]
    return s or fallback


def _clean_text(value: Any, limit: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _evidence(raw: Any) -> list[str]:
    items = raw if isinstance(raw, list) else ([raw] if raw else [])
    out = [_clean_text(e, MAX_EVIDENCE_CHARS) for e in items if isinstance(e, (str, int, float))]
    return [e for e in out if e][:MAX_EVIDENCE]


def _normalise_type(raw: Any) -> str:
    t = _slug(raw, "unknown").replace("-", "_")
    t = _TYPE_ALIASES.get(t, t)
    return t if t in COMPONENT_TYPES else "unknown"


def _to_float(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None  # reject NaN


def normalise_box(item: dict[str, Any]) -> tuple[BBox | None, str | None]:
    """Accept Gemini box_2d [ymin,xmin,ymax,xmax] (0-1000) or bbox {x,y,width,height} (0-1).

    Returns (bbox or None, warning or None). Out-of-range values are clamped; degenerate boxes dropped.
    """
    x0 = y0 = x1 = y1 = None
    if isinstance(item.get("box_2d"), (list, tuple)) and len(item["box_2d"]) == 4:
        vals = [_to_float(v) for v in item["box_2d"]]
        if None in vals:
            return None, "non-numeric box"
        ymin, xmin, ymax, xmax = vals
        scale = 1000.0 if max(vals) > 1.5 else 1.0
        x0, y0, x1, y1 = xmin / scale, ymin / scale, xmax / scale, ymax / scale
    elif isinstance(item.get("bbox"), dict):
        b = item["bbox"]
        vals = [_to_float(b.get(k)) for k in ("x", "y", "width", "height")]
        if None in vals:
            return None, "non-numeric box"
        x, y, w, h = vals
        scale = 1000.0 if max(vals) > 1.5 else 1.0
        x0, y0, x1, y1 = x / scale, y / scale, (x + w) / scale, (y + h) / scale
    else:
        return None, None  # no box supplied; not an error

    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    clamped = any(v < -0.01 or v > 1.01 for v in (x0, y0, x1, y1))
    x0, y0, x1, y1 = (min(1.0, max(0.0, v)) for v in (x0, y0, x1, y1))
    w, h = x1 - x0, y1 - y0
    if w < MIN_BOX_SIDE or h < MIN_BOX_SIDE:
        return None, "degenerate box"
    box = BBox(x=round(x0, 4), y=round(y0, 4), width=round(min(w, 1.0 - round(x0, 4)), 4),
               height=round(min(h, 1.0 - round(y0, 4)), 4))
    return box, ("box clamped to image" if clamped else None)


def _area(b: BBox) -> float:
    return b.width * b.height


def _inside_fraction(child: BBox, parent: BBox) -> float:
    ix = max(0.0, min(child.x + child.width, parent.x + parent.width) - max(child.x, parent.x))
    iy = max(0.0, min(child.y + child.height, parent.y + parent.height) - max(child.y, parent.y))
    a = _area(child)
    return (ix * iy) / a if a > 0 else 0.0


def geometrically_contains(parent: BBox, child: BBox) -> bool:
    return _inside_fraction(child, parent) >= 0.85 and _area(parent) > _area(child) * 1.05


def _creates_cycle(parent_of: dict[str, str], parent: str, child: str) -> bool:
    node, seen = parent, set()
    while node in parent_of and node not in seen:
        if node == child:
            return True
        seen.add(node)
        node = parent_of[node]
    return node == child


# --- main sanitiser ----------------------------------------------------------
def build_components_and_relationships(raw: dict[str, Any]) -> tuple[list[Component], list[Relationship], list[str]]:
    warnings: list[str] = []
    dropped_boxes = 0
    raw_components = raw.get("components") if isinstance(raw.get("components"), list) else []
    if len(raw_components) > MAX_COMPONENTS:
        warnings.append(f"Only the first {MAX_COMPONENTS} components were kept.")
        raw_components = raw_components[:MAX_COMPONENTS]

    components: list[Component] = []
    id_map: dict[str, str] = {}  # raw id -> final id
    parent_hint: dict[str, Any] = {}
    for i, item in enumerate(raw_components):
        if not isinstance(item, dict):
            continue
        label = _clean_text(item.get("label") or item.get("text") or item.get("name"), 200)
        if not label:
            continue
        base = _slug(item.get("id") or label, f"component-{i + 1}")
        cid, n = base, 2
        while any(c.id == cid for c in components):
            cid, n = f"{base}-{n}", n + 1
        raw_id = str(item.get("id") or label)
        id_map.setdefault(raw_id, cid)
        id_map.setdefault(_slug(raw_id, cid), cid)
        box, warn = normalise_box(item)
        if warn == "degenerate box" or warn == "non-numeric box":
            dropped_boxes += 1
        status = str(item.get("status", "")).lower()
        components.append(
            Component(
                id=cid, label=label, type=_normalise_type(item.get("type")),
                status=status if status in STATUSES else "inferred",
                confidence=None, evidence=_evidence(item.get("evidence")), bbox=box,
            )
        )
        parent_hint[cid] = item.get("parentId")
    if dropped_boxes:
        warnings.append(f"{dropped_boxes} invalid bounding box(es) were discarded; those components have no box.")

    def resolve(ref: Any) -> str | None:
        if ref is None:
            return None
        ref = str(ref)
        return id_map.get(ref) or id_map.get(_slug(ref, "")) or None

    by_id = {c.id: c for c in components}
    relationships: list[Relationship] = []
    rel_ids: set[str] = set()
    parent_of: dict[str, str] = {}

    def add(frm: str, to: str, typ: str, status: str, evidence: list[str]) -> None:
        rid = f"{frm}--{typ}--{to}"
        if frm == to or rid in rel_ids or len(relationships) >= MAX_RELATIONSHIPS:
            return
        rel_ids.add(rid)
        relationships.append(Relationship(id=rid, **{"from": frm}, to=to, type=typ, status=status,
                                          confidence=None, evidence=evidence[:MAX_EVIDENCE]))

    # 1) Containment from the model's parentId, checked against geometry.
    unconfirmed = 0
    for cid, hint in parent_hint.items():
        pid = resolve(hint)
        if not pid or pid == cid or _creates_cycle(parent_of, pid, cid):
            continue
        p, c = by_id[pid].bbox, by_id[cid].bbox
        if p and c and geometrically_contains(p, c):
            add(pid, cid, "contains", "observed", ["Model-reported parent; child box lies inside parent box"])
        elif p and c:
            unconfirmed += 1
            add(pid, cid, "contains", "inferred", ["Model-reported parent; boxes do not confirm containment"])
        else:
            add(pid, cid, "contains", "inferred", ["Model-reported parent; no boxes to verify"])
        parent_of[cid] = pid
    if unconfirmed:
        warnings.append(f"{unconfirmed} model-reported containment(s) were not confirmed by box geometry (marked inferred).")

    # 2) Derived containment for boxed components the model left without a parent.
    boxed = [c for c in components if c.bbox]
    for c in boxed:
        if c.id in parent_of:
            continue
        candidates = [p for p in boxed if p.id != c.id and geometrically_contains(p.bbox, c.bbox)]
        if not candidates:
            continue
        p = min(candidates, key=lambda p: _area(p.bbox))
        if _creates_cycle(parent_of, p.id, c.id):
            continue
        add(p.id, c.id, "contains", "estimated", ["Derived from bounding-box geometry (smallest enclosing box)"])
        parent_of[c.id] = p.id

    # 3) Other visual relationships from the model.
    rewritten = 0
    raw_rels = raw.get("relationships") if isinstance(raw.get("relationships"), list) else []
    for item in raw_rels:
        if not isinstance(item, dict):
            continue
        frm, to = resolve(item.get("from")), resolve(item.get("to"))
        if not frm or not to:
            continue
        typ = _slug(item.get("type"), "appears_related_to").replace("-", "_")
        evidence = _evidence(item.get("evidence"))
        if typ == "contains":
            continue  # containment handled above via parentId + geometry
        if typ in UNPROVABLE_FROM_PIXELS or typ not in DIGITAL_VISUAL_EDGE_TYPES:
            if typ in UNPROVABLE_FROM_PIXELS:
                rewritten += 1
                evidence = [f"Model suggested '{typ}'; a screenshot cannot prove this"] + evidence
            typ = "appears_related_to"
        add(frm, to, typ, "inferred", evidence or ["Visual proximity/grouping"])
    if rewritten:
        warnings.append(f"{rewritten} behavioural relationship(s) (e.g. navigation/API) were downgraded to 'appears_related_to'.")
    return components, relationships, warnings


def build_digital_analysis(raw: dict[str, Any], *, filename: str, sha256: str, provider: Provider) -> SystemAnalysis:
    components, relationships, warnings = build_components_and_relationships(raw)
    model_limits = [_clean_text(x, 240) for x in raw.get("limitations", []) if isinstance(x, str)][:5]
    summary = _clean_text(raw.get("summary"), 800)
    if not components:
        summary = summary or "No interface components could be identified in this image."
        warnings.insert(0, "No usable components were returned; the image may not be a UI screenshot, or may be too small or blurry.")
    return SystemAnalysis(
        analysisId=f"digital-{sha256[:16]}",
        domain="digital",
        title=_clean_text(raw.get("title"), 120) or "Interface screenshot analysis",
        source=Source(kind="image", filename=filename),
        assetId=None,
        components=components,
        relationships=relationships,
        summary=summary,
        limitations=[x for x in model_limits if x] + warnings + BASE_LIMITATIONS,
        provider=provider,
    )


def analyze_digital_image(image_bytes: bytes, filename: str, vision_client: VisionClient, mime: str = "image/png") -> SystemAnalysis:
    """Same calling convention as Samvit's analyze_physical_image. Raises VisionProviderError on failure."""
    text = vision_client.generate_json(image_bytes, mime, PROMPT)
    raw = parse_model_json(text)
    try:
        return build_digital_analysis(
            raw, filename=filename, sha256=image_hash(image_bytes),
            provider=Provider(name=vision_client.name, model=vision_client.model),
        )
    except ValueError as exc:  # should not happen after sanitising; keep it a controlled error
        raise VisionProviderError("provider_bad_output", "The model output could not be validated.") from exc

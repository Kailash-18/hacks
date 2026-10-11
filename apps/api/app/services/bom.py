"""Verified parts list ("bill of materials") for the identified product.

The photo pass names parts by what it can see and guesses the inside from "what is usually in this kind of
object". Once the exact product is known, this step checks that list against real sources:
  1. iFixit teardown / repair guide steps for the product (free public API; step text names the real parts),
  2. a Google-Search-grounded model call that compares the list with teardowns and spec pages.
It renames parts to what they really are, drops inside guesses this product does not have, adds real inside
parts that were missing, and records where each claim comes from. Visible parts are never removed: the
photo shows them. Best-effort: any failure leaves the analysis unchanged.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re

from ..schemas import Component, Relationship
from .component_graph import ALLOWED_TYPES

log = logging.getLogger("uvicorn.error")
LAST = {"status": "", "error": ""}
MAX_ADD = 8
PART_TYPES = {"power_source", "actuator", "controller", "sensor", "structure", "fastener", "connector", "mechanism",
              "interface", "display", "cover", "wheel", "light", "storage", "cable", "unknown"}

PROMPT = """You are checking a reverse-engineering parts list against the REAL design of one specific product.

Product: {product}
Category: {category}

Parts list from the photo analysis (id | label | type | seen in photo?):
{parts}

{teardown}
Task: using the teardown text above (if any) and Google Search (iFixit teardowns, repair guides, FCC internal
photos, spec sheets, reviews that open the device), produce the parts list of THIS exact product.
- For every listed part decide: "keep" (it really exists; give its accurate real name, e.g. "PixArt PAW3205 optical
  sensor" or "2x AA battery compartment"), or "drop" (only for parts NOT seen in the photo that this product does
  not actually contain, e.g. a Li-ion battery in a mouse that runs on an AA cell).
- Add the real internal parts that are missing (at most {max_add}), only if a source confirms them for this product or
  its direct predecessor. Do not add generic guesses.
- Never drop a part that was seen in the photo; you may only correct its name.
- If you cannot find reliable information, keep the list as is and say so in "note".
Return ONLY one JSON object, no prose:
{{
  "parts": [{{"id": "existing id", "action": "keep" | "drop", "label": "accurate name", "type": "<part type>",
             "detail": "chip / spec / count if known, else empty", "source": "where this is confirmed, e.g. iFixit teardown",
             "confidence": 0.0}}],
  "add": [{{"label": "real part name", "type": "<part type>", "detail": "...", "source": "...", "confidence": 0.0,
           "links": [{{"from": "part id or new label", "to": "part id or new label", "type": "<relationship type>"}}]}}],
  "note": "one short line: how sure this list is and what it is based on"
}}
Part type must be one of: {types}. Relationship type must be one of: {rel_types}.
confidence 0-1: >=0.8 only when a teardown or spec sheet for this exact product confirms the part."""


def _s(v, n=120) -> str:
    return "" if v is None else re.sub(r"\s+", " ", str(v)).strip()[:n]


def _conf(v) -> float | None:
    try:
        return max(0.0, min(1.0, float(v)))
    except (TypeError, ValueError):
        return None


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:40] or "part"


def parse_bom(text: str) -> dict | None:
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", (text or "").strip())
    m = re.search(r"\{.*\}", t, re.S)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    return d if isinstance(d, dict) else None


def teardown_notes(query: str, topic: str, cache_dir=None) -> tuple[str, list[dict]]:
    """Step text from up to two iFixit guides about this product: real part names, in disassembly order."""
    try:
        from .teardown import find_teardowns
        res = find_teardowns(query, cache_dir, 2, topic)
    except Exception as exc:
        log.warning("bom: teardown lookup failed (%s)", str(exc)[:100])
        return "", []
    lines, sources = [], []
    for g in res.get("guides", []):
        steps = [f"step {im['step']}: {im['caption']}" for im in g.get("images", []) if im.get("caption")]
        if steps:
            lines.append(f'iFixit guide "{g["title"]}":\n' + "\n".join(steps[:24]))
            sources.append({"title": f'iFixit: {g["title"]}'[:100], "url": g.get("url", "")})
    text = "\n\n".join(lines)[:5000]
    return (f"Teardown text (real disassembly steps):\n{text}\n" if text else ""), sources


def verify_parts(result, jpegs: list[bytes], vision_client, cache_dir=None) -> dict | None:
    """Ask for the verified parts list. Returns the parsed answer (with sources) or None."""
    fn = getattr(vision_client, "generate_grounded", None)
    pr = result.scene.product if result.scene else None
    if fn is None or pr is None or not (pr.model or pr.user_hint):
        LAST["status"] = "skipped: exact product not identified"
        return None
    name = pr.user_hint or (pr.model if (pr.brand or "").lower() in (pr.model or "").lower() else f"{pr.brand or ''} {pr.model}".strip())
    parts = "\n".join(f"{c.id} | {c.label} | {c.type} | {'seen' if c.status == 'observed' else 'not seen (guess)'}"
                      for c in result.components)
    kind = pr.category or result.title or ""
    tear, tear_sources = teardown_notes(name, kind, cache_dir)
    prompt = PROMPT.format(product=name, category=kind, parts=parts, teardown=tear, max_add=MAX_ADD,
                           types=", ".join(sorted(PART_TYPES)), rel_types=", ".join(sorted(ALLOWED_TYPES)))
    key = hashlib.sha256(prompt.encode() + b"".join(hashlib.sha256(j).digest() for j in jpegs[:2])).hexdigest()
    cached = cache_dir / f"bom-{key}.json" if cache_dir else None
    if cached and cached.exists():
        return json.loads(cached.read_text(encoding="utf-8"))
    try:
        text, sources = fn([(j, "image/jpeg") for j in jpegs[:2]], prompt)
    except Exception as exc:
        LAST["error"] = f"{type(exc).__name__}: {str(exc)[:200]}"
        log.warning("bom: failed (%s)", LAST["error"])
        return None
    out = parse_bom(text)
    if out is None:
        LAST["error"] = "unparseable answer: " + (text or "")[:160]
        log.warning("bom: %s", LAST["error"])
        return None
    out["sources"] = (tear_sources + list(sources or []))[:6]
    out["product"] = name
    out["web_checked"] = bool(out["sources"])
    if cached and out["web_checked"]:
        cache_dir.mkdir(parents=True, exist_ok=True)
        cached.write_text(json.dumps(out), encoding="utf-8")
    return out


def apply_bom(result, bom: dict | None) -> dict:
    """Apply a verified parts list to the analysis in place. Returns counts for the notes."""
    stats = {"renamed": 0, "dropped": 0, "added": 0, "confirmed": 0}
    if not bom or not result.components:
        return stats
    comps = {c.id: c for c in result.components}
    src_line = lambda p: _s(p.get("source"), 90)
    web = bool(bom.get("sources"))  # False when web search was unavailable: the answer is model memory only
    real_source = lambda p: web and bool(src_line(p)) and not re.search(r"visual|photo|image|inspection|appearance|typical|general", src_line(p), re.I)
    unknown_keep = []
    label_to_id = {c.label.lower(): c.id for c in result.components}
    drop = set()
    for p in bom.get("parts") or []:
        if not isinstance(p, dict):
            continue
        c = comps.get(_s(p.get("id"), 80))
        if c is None:  # a real part the photo pass never listed (e.g. the bottom shell): add it below
            if _s(p.get("action"), 10).lower() != "drop" and _s(p.get("label"), 70):
                unknown_keep.append(p)
            continue
        if _s(p.get("action"), 10).lower() == "drop":
            if c.status != "observed":  # the photo is the strongest evidence: never drop what it shows
                drop.add(c.id)
            continue
        label = _s(p.get("label"), 70)
        if label and label.lower() != c.label.lower():
            label_to_id[label.lower()] = c.id
            c.evidence = [f"Was labelled “{c.label}” from the photo; real name per {src_line(p) or 'product sources'}."] + c.evidence
            c.label = label
            stats["renamed"] += 1
        t = _s(p.get("type"), 20)
        if t in PART_TYPES and c.status != "observed":
            c.type = t
        detail, conf = _s(p.get("detail"), 120), _conf(p.get("confidence"))
        if detail and detail.lower() not in c.label.lower():
            c.evidence.insert(0, f"Spec: {detail}")
        if c.status != "observed" and real_source(p) and conf is not None and conf >= 0.6:
            c.evidence.insert(0, f"Confirmed for {bom.get('product', 'this product')}: {src_line(p)}")
            stats["confirmed"] += 1
        if conf is not None and c.status != "observed":
            c.confidence = conf
    # drop inside guesses this product does not have, with their links
    if drop:
        result.components = [c for c in result.components if c.id not in drop]
        result.relationships = [r for r in result.relationships if r.from_ not in drop and r.to not in drop]
        if result.scene:
            result.scene.ghost_component_ids = [i for i in result.scene.ghost_component_ids if i not in drop]
        stats["dropped"] = len(drop)
    # add real inside parts that were missing
    used = {c.id for c in result.components}
    added = []
    for p in ((bom.get("add") or []) + unknown_keep)[:MAX_ADD]:
        if not isinstance(p, dict):
            continue
        label = _s(p.get("label"), 70)
        if not label or label.lower() in label_to_id:
            continue
        cid, n = _slug(label), 2
        while cid in used:
            cid, n = f"{_slug(label)}_{n}", n + 1
        used.add(cid)
        t = _s(p.get("type"), 20)
        conf = _conf(p.get("confidence"))
        ev = [f"Inside this product per {src_line(p) if real_source(p) else 'model knowledge (not web-verified)'} (not visible in the photo)."]
        if real_source(p) and conf is not None and conf >= 0.6:
            ev.insert(0, f"Confirmed for {bom.get('product', 'this product')}: {src_line(p)}")
            stats["confirmed"] += 1
        if _s(p.get("detail"), 120):
            ev.insert(0, f"Spec: {_s(p.get('detail'), 120)}")
        c = Component(id=cid, label=label, type=t if t in PART_TYPES else "unknown", status="inferred",
                      confidence=conf, evidence=ev)
        result.components.append(c)
        label_to_id[label.lower()] = cid
        if result.scene:
            result.scene.ghost_component_ids.append(cid)
        added.append(p)
        stats["added"] += 1
    # links for the added parts (labels or ids), only between known parts and allowed types
    have = {(r.from_, r.to, r.type) for r in result.relationships}
    for p in added:
        for lk in (p.get("links") or [])[:4]:
            if not isinstance(lk, dict):
                continue
            ids = []
            for end in (lk.get("from"), lk.get("to")):
                e = _s(end, 80)
                ids.append(e if e in used else label_to_id.get(e.lower()))
            t = _s(lk.get("type"), 20)
            if None in ids or ids[0] == ids[1] or t not in ALLOWED_TYPES or (ids[0], ids[1], t) in have:
                continue
            have.add((ids[0], ids[1], t))
            result.relationships.append(Relationship(**{"id": f"r_bom_{len(result.relationships) + 1}", "from": ids[0],
                                                        "to": ids[1], "type": t, "status": "inferred",
                                                        "evidence": [f"Per {src_line(p) or 'product sources'}."]}))
    if result.scene is not None:
        note = _s(bom.get("note"), 200)
        srcs = ", ".join(s.get("title", "") for s in (bom.get("sources") or [])[:3] if s.get("title"))
        how = "real sources" if web else "the model's own knowledge only (web search was unavailable, so nothing is marked verified)"
        result.scene.notes.append(
            f"Parts checked against {how} for {bom.get('product', 'this product')}: {stats['renamed']} renamed, "
            f"{stats['dropped']} removed, {stats['added']} added, {stats['confirmed']} confirmed."
            + (f" {note}" if note else "") + (f" Sources: {srcs}." if srcs else ""))
    return stats

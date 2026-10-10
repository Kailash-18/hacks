"""Exact product identification: Gemini looks at the photo(s) and checks its guess with Google Search.

Runs in parallel with the parts analysis. Best-effort: any failure returns None and the
analysis keeps the logo/text-based identification. Output is a model guess plus web evidence,
never a verified fact; the viewer shows confidence and alternatives so the user can correct it.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re

log = logging.getLogger("uvicorn.error")
LAST_ERROR = {"text": ""}

PROMPT = """Identify the EXACT commercial product in the photo(s): brand, product line and model
(e.g. "Logitech M185", "Apple Magic Mouse 2", "Raspberry Pi 4 Model B"), not just the category.
Steps:
1. Read every visible logo, label, sticker, engraving and printed text (model numbers are often on the bottom).
2. Note distinctive design features (shape, button layout, ports, colour, materials).
3. Use Google Search to find products matching those clues and compare them with the photo.
4. Look up the real overall dimensions of the best match from a spec page.
{hint}
Return ONLY one JSON object, no prose:
{{
  "brand": "brand or null",
  "model": "full exact model name or null",
  "category": "generic category",
  "confidence": 0.0,
  "evidence": "short: which text/features/web matches support it",
  "visible_text": "label/logo text you can actually read, or empty",
  "dimensions_mm": [width, height, depth] or null,
  "candidates": [{{"brand": "...", "model": "...", "confidence": 0.0}}],
  "search_query": "best web search query for photos of this exact product"
}}
Rules: confidence is 0-1 (>=0.8 only when printed text or an exact visual match confirms it).
"candidates" holds up to 3 OTHER likely models, most likely first. Never invent a model number."""

USER_HINT = "The user says the product is: \"{hint}\". Verify this and use it unless the photo clearly contradicts it."


def _s(v, n=120) -> str:
    return "" if v is None else re.sub(r"\s+", " ", str(v)).strip()[:n]


def _null(v: str) -> str | None:
    return None if not v or v.lower() in ("null", "none", "unknown", "n/a") else v


def _conf(v) -> float:
    try:
        return max(0.0, min(1.0, float(v)))
    except (TypeError, ValueError):
        return 0.0


def parse_identification(text: str) -> dict | None:
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    m = re.search(r"\{.*\}", t, re.S)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(d, dict):
        return None
    dims = d.get("dimensions_mm")
    try:
        dims = [round(float(x), 1) for x in dims][:3] if isinstance(dims, list) and len(dims) >= 3 else None
        if dims and not all(1 <= x <= 5000 for x in dims):
            dims = None
    except (TypeError, ValueError):
        dims = None
    cands = []
    for c in d.get("candidates") or []:
        if isinstance(c, dict) and _null(_s(c.get("model"), 80)):
            cands.append({"brand": _null(_s(c.get("brand"), 60)), "model": _s(c.get("model"), 80),
                          "confidence": _conf(c.get("confidence"))})
    return {"brand": _null(_s(d.get("brand"), 60)), "model": _null(_s(d.get("model"), 80)),
            "category": _s(d.get("category"), 60), "confidence": _conf(d.get("confidence")),
            "evidence": _s(d.get("evidence"), 240), "visible_text": _s(d.get("visible_text"), 160),
            "dimensions_mm": dims, "candidates": cands[:3], "search_query": _s(d.get("search_query"), 120)}


def identify_product(jpegs: list[bytes], vision_client, cache_dir=None, hint: str = "") -> dict | None:
    fn = getattr(vision_client, "generate_grounded", None)
    if fn is None or not jpegs:
        return None
    hint = _s(hint, 100)
    prompt = PROMPT.format(hint=USER_HINT.format(hint=hint) if hint else "")
    key = hashlib.sha256(b"".join(hashlib.sha256(j).digest() for j in jpegs) + prompt.encode()).hexdigest()
    cached = cache_dir / f"id-{key}.json" if cache_dir else None
    if cached and cached.exists():
        return json.loads(cached.read_text(encoding="utf-8"))
    try:
        text, sources = fn([(j, "image/jpeg") for j in jpegs], prompt)
    except Exception as exc:  # identification is optional
        LAST_ERROR["text"] = f"{type(exc).__name__}: {str(exc)[:300]}"
        log.warning("identify: failed (%s)", LAST_ERROR["text"])
        return None
    out = parse_identification(text or "")
    if out is None:
        LAST_ERROR["text"] = "unparseable answer: " + (text or "")[:200]
        log.warning("identify: %s", LAST_ERROR["text"])
        return None
    out["sources"] = sources[:5]
    out["user_hint"] = hint
    if cached:
        cache_dir.mkdir(parents=True, exist_ok=True)
        cached.write_text(json.dumps(out), encoding="utf-8")
    log.info("identify: %s %s (%.2f)", out["brand"], out["model"], out["confidence"])
    return out

"""Teardown reference photos from iFixit's free public API (https://www.ifixit.com/api/2.0/).

iFixit guide photos are licensed CC BY-NC-SA; we always return the guide URL and author credit so the
UI can attribute them. Photos are fetched only when the user asks, through a small allow-listed proxy.
"""
from __future__ import annotations

import json
import logging
import re
import urllib.parse
import urllib.request
from pathlib import Path

log = logging.getLogger("uvicorn.error")
API = "https://www.ifixit.com/api/2.0"
UA = {"User-Agent": "VisualReverseEngineering/0.1 (hackathon prototype; contact via GitHub)"}
IMAGE_HOSTS = ("guide-images.cdn.ifixit.com", "valkyrie.cdn.ifixit.com", "cdn.ifixit.com")
LICENSE = "iFixit guide photos, CC BY-NC-SA 3.0. Credit the author and link the guide."


def _get_json(url: str, timeout: float = 15) -> dict | list:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# words that say nothing about what kind of object it is
_GENERIC = {"wireless", "wired", "portable", "compact", "digital", "electronic", "device", "the", "and", "with", "for",
            "new", "mini", "pro", "plus", "max", "series", "model", "black", "white", "silver", "grey", "gray", "optical"}


def topic_words(text: str) -> set[str]:
    """Words that name the kind of object ("mouse", "console", "kettle"): a guide must mention one of them."""
    return {w for w in re.findall(r"[a-z]{3,}", (text or "").lower()) if w not in _GENERIC}


def find_teardowns(query: str, cache_dir: Path | None = None, limit: int = 3, topic: str = "") -> dict:
    q = re.sub(r"\s+", " ", query).strip()[:80]
    if not q:
        return {"query": q, "guides": [], "license": LICENSE}
    must = topic_words(topic)
    key = re.sub(r"[^a-z0-9]+", "-", (q + " " + " ".join(sorted(must))).lower())[:60]
    cached = cache_dir / f"ifixit-{key}.json" if cache_dir else None
    if cached and cached.exists():
        return json.loads(cached.read_text(encoding="utf-8"))
    guides = []
    seen = set()
    words = [w for w in re.findall(r"[A-Za-z0-9+\-]+", q)]
    bases = []
    for b in (q, " ".join(words[:3]), " ".join(words[:2])):  # specific first, then broader
        if b and b not in bases:
            bases.append(b)
    terms = [t for b in bases for t in (f"{b} teardown", b)]
    for term in terms:
        try:
            res = _get_json(f"{API}/search/{urllib.parse.quote(term)}?filter=guide&limit=8")
        except Exception as exc:
            log.warning("ifixit: search failed (%s)", str(exc)[:100])
            continue
        for g in res.get("results", []):
            gid = g.get("guideid")
            if not gid or gid in seen:
                continue
            seen.add(gid)
            title = g.get("title", "")
            # a Lenovo mouse must not show a Lenovo laptop teardown: the guide has to be about the same kind of object
            if must and not (must & topic_words(title + " " + str(g.get("category", "")))):
                continue
            score = 2 if re.search(r"teardown|disassembl|replacement", title, re.I) else 1
            guides.append((score, gid, title, g.get("url", "")))
        if len(guides) >= limit * 2:
            break
    guides.sort(key=lambda x: -x[0])
    out = []
    for _, gid, title, url in guides[:limit]:
        try:
            g = _get_json(f"{API}/guides/{gid}")
        except Exception as exc:
            log.warning("ifixit: guide %s failed (%s)", gid, str(exc)[:100])
            continue
        imgs = []
        for i, step in enumerate(g.get("steps", [])[:30]):
            media = step.get("media") or {}
            if media.get("type") != "image":
                continue
            lines = " ".join(re.sub(r"\[[^\]]*\]", "", l.get("text_raw", "")) for l in step.get("lines", [])[:2]).strip()
            for m in (media.get("data") or [])[:1]:
                src = m.get("standard") or m.get("medium") or m.get("large")
                if src:
                    imgs.append({"url": src, "thumb": m.get("thumbnail") or m.get("mini") or src,
                                 "step": i + 1, "caption": lines[:160]})
        author = (g.get("author") or {}).get("username", "iFixit contributor")
        out.append({"title": g.get("title", title), "url": g.get("url", url), "author": author, "images": imgs[:24]})
    result = {"query": q, "guides": out, "license": LICENSE}
    if cached and out:
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_text(json.dumps(result), encoding="utf-8")
    return result


def fetch_image(url: str, max_bytes: int = 8 * 1024 * 1024) -> tuple[bytes, str]:
    host = urllib.parse.urlparse(url).hostname or ""
    if not url.startswith("https://") or not any(host == h or host.endswith("." + h) for h in IMAGE_HOSTS):
        raise ValueError("Only iFixit guide images can be fetched.")
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        data = r.read(max_bytes + 1)
        ctype = r.headers.get("Content-Type", "image/jpeg").split(";")[0]
    if len(data) > max_bytes or not ctype.startswith("image/"):
        raise ValueError("Not a usable image.")
    return data, ctype

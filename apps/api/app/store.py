"""Analysis store shared by both labs (chat looks analyses up here by analysisId).

In memory, optionally mirrored to disk (VRE_CACHE_DIR, default apps/api/.cache; "off" disables)
so a restart never pays for the same image twice. Only the structured analysis and the image's
SHA-256 are kept; raw images are never stored. Not shared across multiple server processes.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
from collections import OrderedDict
from pathlib import Path

from .contract import SystemAnalysis

log = logging.getLogger(__name__)
MAX_ENTRIES = 200
_SAFE = re.compile(r"[^A-Za-z0-9_.-]")


def image_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def default_cache_dir() -> Path | None:
    value = os.getenv("VRE_CACHE_DIR", "").strip()
    if value.lower() == "off":
        return None
    return Path(value) if value else Path(__file__).resolve().parent.parent / ".cache"


class AnalysisStore:
    def __init__(self, max_entries: int = MAX_ENTRIES, cache_dir: Path | None = None) -> None:
        self._by_id: OrderedDict[str, SystemAnalysis] = OrderedDict()
        self._by_hash: dict[str, str] = {}
        self._max = max_entries
        self._lock = threading.Lock()
        self._dir = cache_dir
        if self._dir is not None:
            self._load_disk()

    # --- disk ---------------------------------------------------------------
    def _path(self, domain: str, sha: str) -> Path:
        return self._dir / f"{_SAFE.sub('_', domain)}-{_SAFE.sub('_', sha)}.json"  # type: ignore[operator]

    def _load_disk(self) -> None:
        try:
            files = sorted(self._dir.glob("*.json"), key=lambda p: p.stat().st_mtime)[-self._max:]  # type: ignore[union-attr]
        except OSError:
            return
        for f in files:
            try:
                rec = json.loads(f.read_text(encoding="utf-8"))
                analysis = SystemAnalysis.model_validate(rec["analysis"])
            except Exception:  # corrupt or outdated entry: ignore it, never crash start-up
                log.warning("Ignoring unreadable cache file %s", f.name)
                continue
            self._put_memory(analysis, rec.get("imageSha256"))
        if files:
            log.info("Loaded %d cached analyses from disk", len(self._by_id))

    def _write_disk(self, analysis: SystemAnalysis, sha: str) -> None:
        try:
            self._dir.mkdir(parents=True, exist_ok=True)  # type: ignore[union-attr]
            path = self._path(analysis.domain, sha)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"imageSha256": sha, "analysis": analysis.to_api()}), encoding="utf-8")
            os.replace(tmp, path)
        except OSError as exc:  # cache is best-effort
            log.warning("Could not write analysis cache: %s", type(exc).__name__)

    # --- public API ---------------------------------------------------------
    def _put_memory(self, analysis: SystemAnalysis, sha: str | None) -> None:
        self._by_id[analysis.analysisId] = analysis
        self._by_id.move_to_end(analysis.analysisId)
        if sha:
            self._by_hash[f"{analysis.domain}:{sha}"] = analysis.analysisId
        while len(self._by_id) > self._max:
            old_id, _ = self._by_id.popitem(last=False)
            self._by_hash = {k: v for k, v in self._by_hash.items() if v != old_id}

    def put(self, analysis: SystemAnalysis, image_sha256: str | None = None, persist: bool = True) -> None:
        with self._lock:
            self._put_memory(analysis, image_sha256)
        if persist and image_sha256 and self._dir is not None:
            self._write_disk(analysis, image_sha256)

    def get(self, analysis_id: str) -> SystemAnalysis | None:
        with self._lock:
            return self._by_id.get(analysis_id)

    def get_by_image(self, domain: str, image_sha256: str) -> SystemAnalysis | None:
        with self._lock:
            aid = self._by_hash.get(f"{domain}:{image_sha256}")
            return self._by_id.get(aid) if aid else None

    def clear(self) -> None:
        with self._lock:
            self._by_id.clear()
            self._by_hash.clear()


store = AnalysisStore(cache_dir=default_cache_dir())

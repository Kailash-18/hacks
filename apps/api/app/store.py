"""In-memory analysis store shared by both labs (chat looks analyses up here by analysisId).

Limits: process-local and lost on restart; not shared across multiple server workers.
Raw images are never stored, only the structured analysis and the image hash.
"""

from __future__ import annotations

import hashlib
import threading
from collections import OrderedDict

from .contract import SystemAnalysis

MAX_ENTRIES = 200


def image_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class AnalysisStore:
    def __init__(self, max_entries: int = MAX_ENTRIES) -> None:
        self._by_id: OrderedDict[str, SystemAnalysis] = OrderedDict()
        self._by_hash: dict[str, str] = {}
        self._max = max_entries
        self._lock = threading.Lock()

    def put(self, analysis: SystemAnalysis, image_sha256: str | None = None) -> None:
        with self._lock:
            self._by_id[analysis.analysisId] = analysis
            self._by_id.move_to_end(analysis.analysisId)
            if image_sha256:
                self._by_hash[f"{analysis.domain}:{image_sha256}"] = analysis.analysisId
            while len(self._by_id) > self._max:
                old_id, _ = self._by_id.popitem(last=False)
                self._by_hash = {k: v for k, v in self._by_hash.items() if v != old_id}

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


store = AnalysisStore()

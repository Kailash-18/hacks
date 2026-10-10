"""Digital Lab samples: saved results of REAL model runs, served instantly for the demo.

Layout (created by scripts/save_digital_sample.py):
    apps/api/samples/digital/<sample-id>/analysis.json   # SystemAnalysis from a live run
    apps/api/samples/digital/<sample-id>/image.<ext>     # the screenshot it was produced from
    apps/api/samples/digital/<sample-id>/meta.json       # {"title", "savedAt", "note"}

Every sample response carries a `sample` block so the UI can show a "saved result" badge.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .contract import SystemAnalysis
from .store import image_hash

log = logging.getLogger(__name__)
SAMPLES_DIR = Path(__file__).resolve().parent.parent / "samples" / "digital"
SAMPLE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,60}$")
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}


@dataclass
class Sample:
    id: str
    title: str
    saved_at: str | None
    note: str
    image_path: Path
    image_sha256: str
    analysis: SystemAnalysis
    sample_set: str | None = None   # screens of one app, loaded together by the UI
    order: int | None = None
    compare_with: str | None = None  # sample id of the earlier version of this screen

    def sample_info(self) -> dict[str, Any]:
        return {"id": self.id, "title": self.title, "savedAt": self.saved_at, "note": self.note,
                "imageUrl": f"/api/digital/samples/{self.id}/image", "set": self.sample_set,
                "order": self.order, "compareWith": self.compare_with}

    def summary(self) -> dict[str, Any]:
        a = self.analysis
        return {**self.sample_info(), "analysisId": a.analysisId, "components": len(a.components),
                "relationships": len(a.relationships), "provider": a.provider.model_dump()}

    def to_api(self) -> dict[str, Any]:
        return {**self.analysis.to_api(), "sample": self.sample_info()}

    @property
    def mime(self) -> str:
        return IMAGE_TYPES[self.image_path.suffix.lower()]


def load_samples(directory: Path = SAMPLES_DIR) -> dict[str, Sample]:
    samples: dict[str, Sample] = {}
    if not directory.is_dir():
        return samples
    for d in sorted(p for p in directory.iterdir() if p.is_dir()):
        if not SAMPLE_ID.match(d.name):
            continue
        try:
            images = [p for p in d.iterdir() if p.stem == "image" and p.suffix.lower() in IMAGE_TYPES]
            meta = json.loads((d / "meta.json").read_text(encoding="utf-8")) if (d / "meta.json").exists() else {}
            analysis = SystemAnalysis.model_validate_json((d / "analysis.json").read_text(encoding="utf-8"))
            if not images:
                raise FileNotFoundError("image missing")
            if analysis.provider.name == "fixture":
                raise ValueError("fixture output is not allowed as a sample")
            samples[d.name] = Sample(
                id=d.name, title=str(meta.get("title") or analysis.title), saved_at=meta.get("savedAt"),
                note=str(meta.get("note") or "Saved result of a real model run."),
                image_path=images[0], image_sha256=image_hash(images[0].read_bytes()), analysis=analysis,
                sample_set=meta.get("set") or None, order=meta.get("order") if isinstance(meta.get("order"), int) else None,
                compare_with=meta.get("compareWith") or None,
            )
        except Exception as exc:
            log.warning("Skipping digital sample %s: %s", d.name, exc)
    return samples

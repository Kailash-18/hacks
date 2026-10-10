"""Copy the Build results (code, React version, guide, back end) of the saved Digital samples into the repo.

    cd apps/api
    python scripts/save_build_samples.py            # copies what is already in .cache/build (no model call)
    python scripts/save_build_samples.py --generate # also makes the missing ones with the live model

Saved to samples/digital/<id>/build/*.json, so a fresh server (e.g. the hosted demo) opens the
examples instantly without spending quota. Only real AI output is saved, never the layout fallback.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

API = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(API))

try:
    from dotenv import load_dotenv

    load_dotenv(API / ".env")
except ImportError:
    pass

from app.samples import load_samples  # noqa: E402
from app.services import codegen, digital_extras  # noqa: E402

REACT_CHANGE = "Convert this page to a React component; keep the look identical."  # same text as build.js


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--generate", action="store_true", help="call the live model for missing results")
    ap.add_argument("--all", action="store_true", help="every sample, not only the demo set shown as examples")
    args = ap.parse_args(argv)
    client = None
    if args.generate:
        from app.services.vision_provider import get_vision_client

        client = get_vision_client()
    for s in load_samples().values():
        if not args.all and (not s.sample_set or s.compare_with):
            continue
        a, img = s.analysis, s.image_path.read_bytes()
        out_dir = s.image_path.parent / "build"
        html = None
        for label, name, make in [
            ("html", codegen.code_key(a.analysisId), lambda: codegen.generate_code(a, img, s.mime, client)),
            ("guide", codegen.guide_key(a.analysisId), lambda: codegen.generate_guide(a, img, s.mime, client)),
            ("backend", digital_extras.backend_key(a.analysisId),
             lambda: digital_extras.generate_backend(a, img, s.mime, client)),
        ]:
            got = _save(name, out_dir, make if client else None)
            print(f"{s.id:22} {label:6} {'saved' if got else 'missing'}")
            if label == "html" and got:
                html = got["code"]
        if html:
            name = codegen.code_key(a.analysisId, "react", REACT_CHANGE, html)
            crlf = codegen.code_key(a.analysisId, "react", REACT_CHANGE, html.replace("\n", "\r\n"))
            if not (codegen.CACHE / f"{name}.json").exists() and (codegen.CACHE / f"{crlf}.json").exists():
                shutil.copyfile(codegen.CACHE / f"{crlf}.json", codegen.CACHE / f"{name}.json")  # made before CRLF fix
            got = _save(name, out_dir, (lambda: codegen.generate_code(a, img, s.mime, client, "react", REACT_CHANGE, html)) if client else None)
            print(f"{s.id:22} react  {'saved' if got else 'missing'}")
    return 0


def _save(name: str, out_dir: Path, make) -> dict | None:
    src = codegen.CACHE / f"{name}.json"
    if not src.exists() and make is not None:
        make()
    if not src.exists():
        existing = out_dir / f"{name}.json"
        return json.loads(existing.read_text(encoding="utf-8")) if existing.exists() else None
    data = json.loads(src.read_text(encoding="utf-8"))
    if data.get("source") != "ai":
        return None
    out_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, out_dir / f"{name}.json")
    return data


if __name__ == "__main__":
    sys.exit(main())

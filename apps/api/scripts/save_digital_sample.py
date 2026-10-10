"""Save a REAL Digital Lab result as a demo sample (served by GET /api/digital/samples).

    cd apps/api
    python scripts/save_digital_sample.py path/to/screen.png --title "Checkout page"

If out/<image-stem>.analysis.json exists (written by eval_digital.py) it is reused, so no extra
model call is made; otherwise the image is analysed live. Fixture output is refused.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

API = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(API))

try:
    from dotenv import load_dotenv

    load_dotenv(API / ".env")
except ImportError:
    pass

from app.contract import SystemAnalysis  # noqa: E402
from app.samples import IMAGE_TYPES, SAMPLES_DIR  # noqa: E402
from app.uploads import validate_image  # noqa: E402

OUT = API / "out"


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "sample"


def main(argv: list[str] | None = None, samples_dir: Path = SAMPLES_DIR, out_dir: Path = OUT) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("image", type=Path)
    ap.add_argument("--id", help="sample id (default: image file name)")
    ap.add_argument("--title", help="title shown in the UI (default: analysis title)")
    ap.add_argument("--live", action="store_true", help="ignore out/ and analyse the image again")
    ap.add_argument("--set", dest="sample_set", help="group screens of one app (the UI loads a set together)")
    ap.add_argument("--order", type=int, help="position of this screen inside its set")
    ap.add_argument("--compare-with", help="sample id of the earlier version (Compare pre-selects the pair)")
    args = ap.parse_args(argv)

    if args.image.suffix.lower() not in IMAGE_TYPES or not args.image.is_file():
        print("ERROR: give an existing .png, .jpg or .webp file")
        return 2
    img = validate_image(args.image.read_bytes(), args.image.name)

    saved = out_dir / f"{args.image.stem}.analysis.json"
    if saved.exists() and not args.live:
        analysis = SystemAnalysis.model_validate_json(saved.read_text(encoding="utf-8"))
        print(f"Reusing {saved.name} (no model call)")
    else:
        from app.services.digital_analysis import analyze_digital_image
        from app.services.vision_provider import VisionProviderError, get_vision_client

        try:
            client = get_vision_client()
            if client.name == "fixture":
                print("ERROR: fixture mode is on; samples must come from live inference.")
                return 2
            analysis = analyze_digital_image(img.data, img.filename, client, img.mime)
        except VisionProviderError as exc:
            print(f"ERROR {exc.code}: {exc.message}")
            return 1

    if analysis.provider.name == "fixture":
        print("ERROR: this analysis came from fixture mode; samples must come from live inference.")
        return 2
    sample_id = slug(args.id or args.image.stem)
    dest = samples_dir / sample_id
    dest.mkdir(parents=True, exist_ok=True)
    for old in dest.glob("image.*"):
        old.unlink()
    shutil.copyfile(args.image, dest / f"image{args.image.suffix.lower()}")
    (dest / "analysis.json").write_text(json.dumps(analysis.to_api(), indent=2) + "\n", encoding="utf-8")
    meta = {"title": args.title or analysis.title, "savedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "note": f"Saved result of a real {analysis.provider.name}/{analysis.provider.model} run."}
    if args.sample_set:
        meta["set"] = slug(args.sample_set)
    if args.order is not None:
        meta["order"] = args.order
    if args.compare_with:
        meta["compareWith"] = slug(args.compare_with)
    (dest / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(f"Saved sample '{sample_id}' -> {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

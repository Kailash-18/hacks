"""LIVE evaluation of Digital Lab on the team-made mock screens (calls the real vision model).

    cd apps/api
    python scripts/eval_digital.py                 # 3 mock screens, scored against ground truth
    python scripts/eval_digital.py path/to/any.png # any screenshot, overlay only (no ground truth)
    python scripts/eval_digital.py --chat          # also ask one grounded question per screen (1 extra call each)

Needs GEMINI_API_KEY in apps/api/.env. Refuses fixture mode, so the numbers are always live.
Writes to apps/api/out/ (gitignored): <name>.analysis.json, <name>.overlay.png, eval_summary.json.
Overlay: green = ground truth, orange = model boxes.
Each image costs one model call.
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

API = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(API))

try:
    from dotenv import load_dotenv

    load_dotenv(API / ".env")
except ImportError:
    pass

from PIL import Image, ImageDraw  # noqa: E402

from app.services.box_eval import match_ground_truth  # noqa: E402
from app.services.digital_analysis import analyze_digital_image  # noqa: E402
from app.services.vision_provider import VisionProviderError, get_vision_client  # noqa: E402
from app.uploads import validate_image  # noqa: E402

SCREENS = API / "tests" / "fixtures" / "screens"
OUT = API / "out"


def draw_overlay(png: Path, analysis: dict, gt: list[dict] | None, dest: Path) -> None:
    img = Image.open(png).convert("RGB")
    w, h = img.size
    d = ImageDraw.Draw(img)

    def rect(b, color, width):
        x0, y0 = b["x"] * w, b["y"] * h
        d.rectangle([x0, y0, x0 + b["width"] * w, y0 + b["height"] * h], outline=color, width=width)
        return x0, y0

    for g in gt or []:
        rect(g["bbox"], (22, 163, 74), 4)
    for c in analysis["components"]:
        if c.get("bbox"):
            x0, y0 = rect(c["bbox"], (234, 88, 12), 2)
            d.text((x0 + 3, max(0, y0 - 11)), c["id"][:28], fill=(234, 88, 12))
    img.save(dest)


CHAT_QUESTION = "Which element is the main call to action, and what happens when it is clicked?"


def main(paths: list[str]) -> int:
    ask_chat = "--chat" in paths
    paths = [p for p in paths if p != "--chat"]
    try:
        client = get_vision_client()
    except VisionProviderError as exc:
        print(f"ERROR {exc.code}: {exc.message}")
        return 2
    if client.name == "fixture":
        print("ERROR: fixture mode is on (VRE_FIXTURE_MODE=1). Evaluation must use live inference.")
        return 2

    images = [Path(p) for p in paths] or sorted(SCREENS.glob("*.png"))
    OUT.mkdir(exist_ok=True)
    summary = {"provider": client.name, "model": client.model,
               "thinkingLevel": os.getenv("GEMINI_THINKING_LEVEL", "low"), "ranAt": datetime.now(timezone.utc).isoformat(),
               "note": "Live inference on team-made synthetic screens; small sample, not a benchmark.", "screens": []}
    failures = 0
    for png in images:
        gt_file = png.with_suffix(".gt.json")
        gt = json.loads(gt_file.read_text(encoding="utf-8"))["elements"] if gt_file.exists() else None
        img = validate_image(png.read_bytes(), png.name)
        t0 = time.perf_counter()
        try:
            analysis_obj = analyze_digital_image(img.data, img.filename, client, img.mime)
            analysis = analysis_obj.to_api()
        except VisionProviderError as exc:
            failures += 1
            print(f"{png.name}: FAILED {exc.code}: {exc.message}")
            summary["screens"].append({"image": png.name, "error": exc.code})
            continue
        secs = round(time.perf_counter() - t0, 1)
        (OUT / f"{png.stem}.analysis.json").write_text(json.dumps(analysis, indent=2), encoding="utf-8")
        draw_overlay(png, analysis, gt, OUT / f"{png.stem}.overlay.png")
        row = {"image": png.name, "seconds": secs, "components": len(analysis["components"]),
               "relationships": len(analysis["relationships"]), "call": getattr(client, "last_call", None)}
        if gt:
            m = match_ground_truth(gt, analysis["components"])
            row.update({k: m[k] for k in ("recall", "meanIoUOfHits", "typeAgreementOfHits")}, matches=m["rows"])
            missed = [r["gtId"] for r in m["rows"] if not r["hit"]]
            print(f"{png.name}: {row['components']} comps, {row['relationships']} edges, {secs}s | "
                  f"recall@0.5={m['recall']} meanIoU={m['meanIoUOfHits']} type={m['typeAgreementOfHits']}"
                  + (f" | missed: {', '.join(missed)}" if missed else ""))
        else:
            print(f"{png.name}: {row['components']} comps, {row['relationships']} edges, {secs}s (no ground truth)")
        call = row["call"] or {}
        if call:
            print(f"    tokens: prompt={call.get('promptTokens')} output={call.get('outputTokens')} "
                  f"thinking={call.get('thinkingTokens')} | thinking_level sent={call.get('thinkingSent')}")
        if ask_chat:
            from app.contract import ChatRequest
            from app.services.grounded_chat import answer_question

            try:
                resp = answer_question(analysis_obj, ChatRequest(question=CHAT_QUESTION), client)
                row["chat"] = {"question": CHAT_QUESTION, **resp.model_dump()}
                print(f"    chat: {resp.answer}")
                print(f"    cited: {resp.referencedComponentIds} | caveats: {len(resp.limitations)}")
            except VisionProviderError as exc:
                failures += 1
                print(f"    chat FAILED {exc.code}: {exc.message}")
        summary["screens"].append(row)

    (OUT / "eval_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"\nModel: {client.name}/{client.model} (thinking={summary['thinkingLevel']}). Overlays and JSON in {OUT}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

"""Check the saved Physical samples against the real product (teardowns, spec pages) and update them.

    cd apps/api
    python scripts/verify_samples.py                       # every sample whose exact model is known
    python scripts/verify_samples.py game-boy              # just one
    python scripts/verify_samples.py lenovo-mouse --hint "Lenovo 300 Wireless Mouse"   # name the model yourself

Uses the same check as new uploads (app/services/bom.py): iFixit guide steps + a Google-Search-grounded
Gemini call. Parts get their real names, inside guesses the product does not have are removed, real
missing inside parts are added (with a simple box in the 3D model, fitted inside the housing by the viewer).
Parts seen in the photo are never removed. A backup of each sample is written to .cache/sample-backups/.
Needs GEMINI_API_KEY in apps/api/.env.
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

from app.schemas import SystemAnalysis  # noqa: E402
from app.services import bom  # noqa: E402

SAMPLES = API / "samples"
CACHE = API / ".cache"
COLORS = {"controller": "#1f6f43", "power_source": "#2f6fe0", "sensor": "#3a3f47", "actuator": "#4b5563",
          "display": "#111827", "connector": "#9ca3af", "cable": "#202227", "light": "#e0f2fe", "storage": "#374151"}


def add_boxes(data: dict, new_ids: list[str], comps: dict) -> None:
    """A small box per added inside part, at the centre of the object; the viewer fits it inside the housing."""
    asm = (data.get("scene") or {}).get("assembly")
    if not asm:
        return
    ox, oy, oz = asm.get("overallSize") or [100, 100, 100]
    for i, cid in enumerate(new_ids):
        t = comps[cid]["type"]
        s = [max(3.0, ox * 0.18), max(2.0, oy * 0.12), max(3.0, oz * 0.18)]
        asm["parts"].append({"componentId": cid, "shape": "box", "size": [round(v, 1) for v in s],
                             "position": [round((i % 3 - 1) * ox * 0.15, 1), 0.0, round((i // 3 - 1) * oz * 0.15, 1)],
                             "rotation": [0, 0, 0], "color": COLORS.get(t, "#6b7280"),
                             "material": "pcb" if t == "controller" else "plastic",
                             "explodeDir": [0, 1, 0], "explodeDist": 1.0})


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("samples", nargs="*", help="sample ids (default: all)")
    ap.add_argument("--hint", default="", help="exact product name, for a sample whose model is unknown")
    args = ap.parse_args(argv)
    from app.services.vision_provider import make_shared_client
    client = make_shared_client()
    names = args.samples or sorted(p.stem for p in SAMPLES.glob("*.json"))
    for name in names:
        path = SAMPLES / f"{name}.json"
        if not path.exists():
            print(f"{name}: no such sample"); continue
        data = json.loads(path.read_text(encoding="utf-8"))
        a = SystemAnalysis.model_validate(data)
        if args.hint:
            a.scene.product.user_hint = args.hint
        before = {c.id for c in a.components}
        answer = bom.verify_parts(a, [], client, CACHE)
        if answer is None:
            print(f"{name}: skipped ({bom.LAST['status'] or bom.LAST['error'] or 'no answer'})"); continue
        stats = bom.apply_bom(a, answer)
        out = a.dump() if hasattr(a, "dump") else json.loads(a.model_dump_json(by_alias=True))
        after = {c["id"]: c for c in out["components"]}
        gone = before - set(after)
        asm = (out.get("scene") or {}).get("assembly")
        if asm:
            asm["parts"] = [p for p in asm["parts"] if p.get("componentId") not in gone]
        add_boxes(out, [i for i in after if i not in before], after)
        (CACHE / "sample-backups").mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, CACHE / "sample-backups" / path.name)
        path.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
        print(f"{name}: {stats}  ({answer.get('note', '')})")
        for c in out["components"]:
            ok = any(e.startswith("Confirmed for ") for e in c.get("evidence", []))
            print(f"   {'✓' if ok else ' '} {c['label']}  [{c['status']}]")
    return 0


if __name__ == "__main__":
    sys.exit(main())

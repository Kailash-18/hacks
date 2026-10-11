"""Save your most recent Physical upload as a sample (replaces a curated one with a real AI scan).

    cd apps/api
    python scripts/save_physical_sample.py laptop        # newest physical result -> samples/laptop.json
    python scripts/save_physical_sample.py desktop-pc
    python scripts/save_physical_sample.py --list        # show recent results to pick from
    python scripts/save_physical_sample.py laptop --pick 2

Upload photos of the real object in the app first (top + side or inside shots work best), wait for the
result, then run this. The old sample is backed up to .cache/sample-backups/.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

API = Path(__file__).resolve().parent.parent
CACHE, SAMPLES = API / ".cache", API / "samples"


def recent():
    out = []
    for f in CACHE.glob("*.json"):
        if not re.fullmatch(r"[0-9a-f]{64}", f.stem):
            continue
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if d.get("domain") == "physical" and d.get("components"):
            out.append((f.stat().st_mtime, f, d))
    return sorted(out, key=lambda x: -x[0])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("name", nargs="?", help="sample id, e.g. laptop or desktop-pc")
    ap.add_argument("--pick", type=int, default=1, help="1 = newest result, 2 = the one before, ...")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args(argv)
    items = recent()
    if a.list or not a.name:
        for i, (_, f, d) in enumerate(items[:10], 1):
            print(f"{i}. {d.get('title')}  ({len(d['components'])} parts)  {f.name[:12]}…")
        return 0
    if not re.fullmatch(r"[a-z0-9-]+", a.name):
        print("Use a simple id like laptop or desktop-pc."); return 1
    if len(items) < a.pick:
        print("No physical result found. Upload photos in the app first."); return 1
    _, f, d = items[a.pick - 1]
    dest = SAMPLES / f"{a.name}.json"
    if dest.exists():
        (CACHE / "sample-backups").mkdir(parents=True, exist_ok=True)
        shutil.copyfile(dest, CACHE / "sample-backups" / dest.name)
    dest.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    print(f"Saved “{d.get('title')}” ({len(d['components'])} parts) as samples/{a.name}.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())

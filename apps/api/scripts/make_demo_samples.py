"""Analyse the Nimbus demo app (5 team-made screens) once with the live model and save them as samples.

    cd apps/api
    python scripts/make_demo_samples.py            # 5 live model calls, then the UI's "Load samples" opens this app

Screens in samples/demo-app/*.png (sources in samples/demo-app/src, rendered from HTML we wrote).
Already-saved screens are skipped, so a run that hits the free quota can simply be repeated later.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

API = Path(__file__).resolve().parent.parent
DEMO = API / "samples" / "demo-app"
SET = "nimbus"
# (file, sample id, title, compare-with)
SCREENS = [
    ("landing.png", "nimbus-landing", "Nimbus · Landing page", None),
    ("login.png", "nimbus-login", "Nimbus · Log in", None),
    ("dashboard.png", "nimbus-dashboard", "Nimbus · Dashboard", None),
    ("settings.png", "nimbus-settings", "Nimbus · Settings", None),
    ("dashboard-v2.png", "nimbus-dashboard-v2", "Nimbus · Dashboard (v2 redesign)", "nimbus-dashboard"),
]


def main() -> int:
    spec = importlib.util.spec_from_file_location("save_digital_sample", API / "scripts" / "save_digital_sample.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    failed = 0
    for order, (fname, sid, title, prev) in enumerate(SCREENS, 1):
        if (mod.SAMPLES_DIR / sid / "analysis.json").exists():
            print(f"{sid}: already saved, skipping")
            continue
        args = [str(DEMO / fname), "--id", sid, "--title", title, "--set", SET, "--order", str(order)]
        if prev:
            args += ["--compare-with", prev]
        if mod.main(args) != 0:
            failed += 1
    print("Done." if not failed else f"{failed} screen(s) failed; run again later to retry just those.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

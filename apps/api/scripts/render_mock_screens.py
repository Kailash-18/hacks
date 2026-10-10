"""Render the team-made mock UI screens to PNG and record ground-truth boxes.

Elements tagged with data-gt="<id>" data-gt-type="<type>" become ground truth (optional
data-gt-box="text" uses the tight text box), stored as normalized {x, y, width, height} in <name>.gt.json next to the PNG.

Needs Playwright with Chromium. Run from apps/api:  python scripts/render_mock_screens.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

SCREENS = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "screens"
# data-gt-box="text" -> tight box around the rendered text (for block elements whose box is
# much wider than their visible text, e.g. a full-width <label>); otherwise the element box.
JS = """() => [...document.querySelectorAll('[data-gt]')].map(e => {
  let r = e.getBoundingClientRect();
  if (e.dataset.gtBox === 'text') { const g = document.createRange(); g.selectNodeContents(e); r = g.getBoundingClientRect(); }
  return {id: e.dataset.gt, type: e.dataset.gtType, x: r.x, y: r.y, w: r.width, h: r.height};
})"""


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for html in sorted((SCREENS / "src").glob("*.html")):
            src = html.read_text(encoding="utf-8")
            w = int(re.search(r"body\{[^}]*width:(\d+)px", src).group(1))
            h = int(re.search(r"body\{[^}]*height:(\d+)px", src).group(1))
            page = browser.new_page(viewport={"width": w, "height": h})
            page.goto(html.as_uri())
            png = SCREENS / f"{html.stem}.png"
            page.screenshot(path=str(png), full_page=False)
            gt = [
                {"id": e["id"], "type": e["type"],
                 "bbox": {"x": round(e["x"] / w, 4), "y": round(e["y"] / h, 4),
                          "width": round(min(e["w"], w - e["x"]) / w, 4), "height": round(min(e["h"], h - e["y"]) / h, 4)}}
                for e in page.evaluate(JS)
            ]
            (SCREENS / f"{html.stem}.gt.json").write_text(
                json.dumps({"image": png.name, "width": w, "height": h, "elements": gt}, indent=2) + "\n", encoding="utf-8")
            print(f"{png.name}: {w}x{h}, {len(gt)} ground-truth elements")
            page.close()
        browser.close()


if __name__ == "__main__":
    main()
